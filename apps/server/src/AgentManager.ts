import type {
  AgentApprovalResponse,
  AgentCanvasSettings,
  AgentFileAccess,
  AgentEvent,
  AgentEventEnvelope,
  AgentPromptReference,
  AgentQuestionResponse,
  AgentSettings,
  AgentSnapshot,
  AgentStartConfig,
  AgentPromptAccess,
  ForkOrigin,
  PersistedAgentState,
  UpdateAgentSettingsInput,
} from "@agent-canvas/shared";
import { execFile } from "node:child_process";
import { AgentRunner } from "./AgentRunner.js";
import type { QueryFn } from "./sdk/types.js";

export type EnvelopeListener = (envelope: AgentEventEnvelope) => void;

export interface AgentTurnContextMetadata {
  branch?: string;
  cwd?: string;
  baseCommitSha?: string;
  baseShortSha?: string;
}

export interface AgentTurnContextRequest {
  agentId: string;
  turnIndex: number;
  config: Pick<AgentStartConfig, "cwd" | "branch"> | undefined;
}

export interface AgentManagerDeps {
  query: QueryFn;
  codexQuery?: QueryFn;
  defaultCwd?: string;
  now?: () => number;
  resolveTurnContext?: (
    config: Pick<AgentStartConfig, "cwd" | "branch"> | undefined,
  ) => Promise<AgentTurnContextMetadata>;
  resolveFileAccess?: (agentId: string) => AgentFileAccess;
  resolvePromptAccess?: (agentId: string) => AgentPromptAccess;
}

/**
 * 管理多个 AgentRunner：分配 id、为每个 agent 维护单调 seq、
 * 把 runner 的事件包成 `AgentEventEnvelope` 广播给所有订阅者，
 * 并在内存中保留事件历史（M1；M2 改 SQLite）以支持新连接补齐。
 */
export class AgentManager {
  private readonly runners = new Map<string, AgentRunner>();
  private readonly seqs = new Map<string, number>();
  private readonly history = new Map<string, AgentEventEnvelope[]>();
  private readonly listeners = new Set<EnvelopeListener>();
  // fork 产生的 agent：来源（展示用）与启动时要合并的 fork 配置
  private readonly forkOrigins = new Map<string, ForkOrigin>();
  private readonly forkConfigs = new Map<string, Partial<AgentStartConfig>>();
  private readonly draftConfigs = new Map<string, Partial<AgentStartConfig>>();
  private readonly appSettingsState: AgentCanvasSettings = { fullPermissionMode: false };
  private readonly query: QueryFn;
  private readonly codexQuery?: QueryFn;
  private readonly defaultCwd: string;
  private readonly now: () => number;
  private readonly resolveTurnContext: (
    config: Pick<AgentStartConfig, "cwd" | "branch"> | undefined,
  ) => Promise<AgentTurnContextMetadata>;
  private resolveFileAccess?: (agentId: string) => AgentFileAccess;
  private resolvePromptAccess?: (agentId: string) => AgentPromptAccess;
  private counter = 0;
  private suppressEvents = false;

  constructor(deps: AgentManagerDeps) {
    this.query = deps.query;
    this.codexQuery = deps.codexQuery;
    this.defaultCwd = deps.defaultCwd ?? process.cwd();
    this.now = deps.now ?? Date.now;
    this.resolveTurnContext = deps.resolveTurnContext ?? defaultResolveTurnContext;
    this.resolveFileAccess = deps.resolveFileAccess;
    this.resolvePromptAccess = deps.resolvePromptAccess;
  }

  onEvent(listener: EnvelopeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  create(settings: AgentSettings = {}): AgentRunner {
    const id = `agent_${++this.counter}`;
    return this.createRunner(id, normalizeSettings(settings, this.defaultCwd));
  }

  exportState(): PersistedAgentState {
    return {
      agents: this.list(),
      histories: Object.fromEntries(
        [...this.history.entries()].map(([id, history]) => [id, [...history]]),
      ),
      appSettings: this.appSettings(),
    };
  }

  importState(state: PersistedAgentState | undefined): void {
    this.suppressEvents = true;
    for (const runner of this.runners.values()) {
      void runner.terminate();
    }
    this.runners.clear();
    this.seqs.clear();
    this.history.clear();
    this.forkOrigins.clear();
    this.forkConfigs.clear();
    this.draftConfigs.clear();
    this.appSettingsState.fullPermissionMode = state?.appSettings?.fullPermissionMode ?? false;
    this.counter = 0;

    const agents = state?.agents ?? [];
    for (const snapshot of agents) {
      const restoredSnapshot = { ...snapshot, status: restorableStatus(snapshot.status) };
      const runner = this.createRunner(snapshot.id, snapshot.config);
      runner.restore(restoredSnapshot);
      if (snapshot.forkOrigin) this.forkOrigins.set(snapshot.id, snapshot.forkOrigin);
      const history = [...(state?.histories[snapshot.id] ?? [])].sort(
        (left, right) => left.seq - right.seq,
      );
      let lastSeq = Math.max(
        snapshot.lastEventSeq,
        ...history.map((envelope) => envelope.seq),
        0,
      );
      if (restoredSnapshot.status !== snapshot.status) {
        lastSeq++;
        history.push({
          agentId: snapshot.id,
          seq: lastSeq,
          at: this.now(),
          event: { kind: "status", status: restoredSnapshot.status },
        });
      }
      this.history.set(snapshot.id, history);
      this.seqs.set(snapshot.id, lastSeq);
    }
    this.counter = maxNumericSuffix(agents.map((agent) => agent.id));
    this.suppressEvents = false;
  }

  private createRunner(
    id: string,
    draftConfig: Partial<AgentStartConfig>,
  ): AgentRunner {
    const runner = new AgentRunner(id, {
      query: this.query,
      codexQuery: this.codexQuery,
      now: this.now,
      fullPermissionMode: () => this.appSettingsState.fullPermissionMode,
      resolveFileAccess: (agentId) =>
        this.resolveFileAccess?.(agentId) ?? {
          readableFiles: [],
          readableDirectories: [],
          writableFiles: [],
          writableDirectories: [],
          sharedResources: [],
        },
      resolvePromptAccess: (agentId) =>
        this.resolvePromptAccess?.(agentId) ?? {
          readablePrompts: [],
          writablePrompts: [],
          writableDirectories: [],
        },
    });
    this.runners.set(id, runner);
    this.seqs.set(id, 0);
    this.history.set(id, []);
    this.draftConfigs.set(id, draftConfig);
    runner.on((event) => this.broadcast(id, event));
    return runner;
  }

  get(id: string): AgentRunner | undefined {
    return this.runners.get(id);
  }

  setFileAccessResolver(resolveFileAccess: (agentId: string) => AgentFileAccess): void {
    this.resolveFileAccess = resolveFileAccess;
  }

  setPromptAccessResolver(resolvePromptAccess: (agentId: string) => AgentPromptAccess): void {
    this.resolvePromptAccess = resolvePromptAccess;
  }

  configOf(id: string): AgentStartConfig | undefined {
    const runnerConfig = this.runners.get(id)?.snapshot().config;
    const draftConfig = this.draftConfigs.get(id);
    const forkConfig = this.forkConfigs.get(id);
    const merged = mergeDefined(draftConfig, forkConfig, runnerConfig);
    return merged ? ({ ...merged, prompt: runnerConfig?.prompt ?? "" } as AgentStartConfig) : undefined;
  }

  snapshot(id: string): AgentSnapshot | undefined {
    return this.runners.has(id) ? this.snapshotOf(id) : undefined;
  }

  updateSettings(
    id: string,
    input: UpdateAgentSettingsInput,
    options: { branchSwitchPrompt?: AgentPromptReference } = {},
  ): AgentSnapshot {
    const runner = this.runners.get(id);
    if (!runner) throw new Error(`未知 agent: ${id}`);
    const changesBranch = input.branchWorkspaceId !== undefined || input.branch !== undefined;
    if (changesBranch && runner.getStatus() !== "idle" && runner.getStatus() !== "waiting_input") {
      throw new Error("只有待输入或尚未启动的活跃 agent 可以切换 branch");
    }
    const draft = this.draftConfigs.get(id) ?? {};
    const next = {
      ...draft,
      ...definedSettings(input),
    };
    this.draftConfigs.set(id, next);
    if (Object.keys(input).length > 0 || options.branchSwitchPrompt) {
      runner.updateSettings(definedSettings(input), options.branchSwitchPrompt);
    }
    return this.snapshotOf(id);
  }

  /**
   * 从某 agent 的某一轮（anchorUuid）fork 出一个新 agent。
   * 记录其来源与启动时要合并的 fork 配置（model/resume/resumeSessionAt/forkSession）。
   * 父会话尚未建立（无 sessionId）时返回 undefined。
   */
  fork(
    parentId: string,
    anchorUuid: string,
    model?: string,
  ): { id: string; origin: ForkOrigin } | undefined {
    const parent = this.runners.get(parentId);
    if (!parent) return undefined;
    const parentSnapshot = parent.snapshot();
    const parentSession = parentSnapshot.sessionId;
    if (!parentSession) return undefined;
    const parentProvider = parentSnapshot.config?.provider;
    const parentCwd = parentSnapshot.config?.cwd;
    const parentBranchWorkspaceId = parentSnapshot.config?.branchWorkspaceId;
    const parentBranch = parentSnapshot.config?.branch;
    const parentSystemPrompt = parentSnapshot.config?.systemPrompt;

    const runner = this.create();
    const origin: ForkOrigin = { parentAgentId: parentId, anchorUuid };
    this.forkOrigins.set(runner.id, origin);
    this.forkConfigs.set(runner.id, {
      provider: parentProvider,
      model: model ?? parentSnapshot.config?.model,
      cwd: parentCwd,
      branchWorkspaceId: parentBranchWorkspaceId,
      branch: parentBranch,
      systemPrompt: parentSystemPrompt,
      resume: parentSession,
      resumeSessionAt: anchorUuid,
      forkSession: true,
    });
    return { id: runner.id, origin };
  }

  /** 启动一个 agent；若它是 fork 产生的，合并其 fork 配置。 */
  startAgent(id: string, config: AgentStartConfig): void {
    const runner = this.runners.get(id);
    if (!runner) throw new Error(`未知 agent: ${id}`);
    const forkCfg = this.forkConfigs.get(id);
    const draftCfg = this.draftConfigs.get(id);
    const merged = mergeDefined(draftCfg, forkCfg, config);
    if (!merged?.prompt) throw new Error("缺少 prompt");
    runner.start(merged as AgentStartConfig);
  }

  answerQuestion(id: string, requestId: string, response: AgentQuestionResponse): void {
    const runner = this.runners.get(id);
    if (!runner) throw new Error(`未知 agent: ${id}`);
    runner.answerQuestion(requestId, response);
  }

  answerApproval(id: string, requestId: string, response: AgentApprovalResponse): void {
    const runner = this.runners.get(id);
    if (!runner) throw new Error(`未知 agent: ${id}`);
    runner.answerApproval(requestId, response);
  }

  appSettings(): AgentCanvasSettings {
    return { ...this.appSettingsState };
  }

  updateAppSettings(input: Partial<AgentCanvasSettings>): AgentCanvasSettings {
    const wasFullPermission = this.appSettingsState.fullPermissionMode;
    if (input.fullPermissionMode !== undefined) {
      this.appSettingsState.fullPermissionMode = input.fullPermissionMode;
    }
    if (!wasFullPermission && this.appSettingsState.fullPermissionMode) {
      for (const runner of this.runners.values()) {
        runner.approvePendingApprovals();
      }
    }
    return this.appSettings();
  }

  list(): AgentSnapshot[] {
    return [...this.runners.keys()].map((id) => this.snapshotOf(id));
  }

  historyOf(id: string): AgentEventEnvelope[] {
    return this.history.get(id) ?? [];
  }

  currentTurnIndex(id: string): number {
    if (!this.runners.has(id)) throw new Error(`未知 agent: ${id}`);
    let index = 0;
    for (const envelope of this.historyOf(id)) {
      if (isTurnBoundaryEvent(envelope.event)) {
        index++;
      }
    }
    return index;
  }

  private broadcast(agentId: string, event: AgentEvent): void {
    if (this.suppressEvents) return;
    const turnContextRequest = this.turnContextRequest(agentId, event);
    const seq = (this.seqs.get(agentId) ?? 0) + 1;
    this.seqs.set(agentId, seq);
    const envelope: AgentEventEnvelope = {
      agentId,
      seq,
      at: this.now(),
      event,
    };
    this.history.get(agentId)?.push(envelope);
    for (const listener of this.listeners) {
      try {
        listener(envelope);
      } catch {
        // 忽略单个订阅者异常
      }
    }
    if (turnContextRequest) {
      void this.emitTurnContext(turnContextRequest);
    }
  }

  private turnContextRequest(
    agentId: string,
    event: AgentEvent,
  ): AgentTurnContextRequest | undefined {
    if (event.kind !== "user_input" || event.mode) return undefined;
    if (!this.runners.has(agentId)) return undefined;
    return {
      agentId,
      turnIndex: this.currentTurnIndex(agentId),
      config: this.configOf(agentId),
    };
  }

  private async emitTurnContext(request: AgentTurnContextRequest): Promise<void> {
    try {
      const metadata = await this.resolveTurnContext(request.config);
      this.broadcast(request.agentId, {
        kind: "turn_context",
        context: {
          turnIndex: request.turnIndex,
          branch: metadata.branch ?? request.config?.branch,
          cwd: metadata.cwd ?? request.config?.cwd,
          baseCommitSha: metadata.baseCommitSha,
          baseShortSha:
            metadata.baseShortSha ??
            (metadata.baseCommitSha ? metadata.baseCommitSha.slice(0, 7) : undefined),
        },
      });
    } catch {
      this.broadcast(request.agentId, {
        kind: "turn_context",
        context: {
          turnIndex: request.turnIndex,
          branch: request.config?.branch,
          cwd: request.config?.cwd,
        },
      });
    }
  }

  private snapshotOf(id: string): AgentSnapshot {
    const runner = this.runners.get(id);
    if (!runner) throw new Error(`未知 agent: ${id}`);
    const s = runner.snapshot();
    const config: AgentStartConfig = {
      ...this.draftConfigs.get(id),
      ...this.forkConfigs.get(id),
      ...s.config,
      prompt: s.config?.prompt ?? "",
    };
    return {
      id,
      provider: config.provider,
      status: s.status,
      sessionId: s.sessionId,
      config,
      createdAt: s.createdAt,
      lastEventSeq: this.seqs.get(id) ?? 0,
      totalCostUsd: s.totalCostUsd,
      usage: s.usage,
      forkOrigin: this.forkOrigins.get(id),
    };
  }
}

function isTurnBoundaryEvent(event: AgentEvent): boolean {
  return (
    event.kind === "result" ||
    (event.kind === "compact" && event.trigger === "manual") ||
    (event.kind === "status" &&
      (event.status === "stopped" || event.status === "terminated"))
  );
}

function restorableStatus(status: AgentSnapshot["status"]): AgentSnapshot["status"] {
  if (status === "starting" || status === "running") return "stopped";
  return status;
}

function maxNumericSuffix(ids: string[]): number {
  let max = 0;
  for (const id of ids) {
    const match = id.match(/_(\d+)$/u);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max;
}

function normalizeSettings(
  settings: AgentSettings,
  defaultCwd: string,
): Partial<AgentStartConfig> {
  return {
    provider: settings.provider ?? "claude",
    model: settings.model,
    branchWorkspaceId: settings.branchWorkspaceId,
    branch: settings.branch,
    cwd: settings.cwd?.trim() || defaultCwd,
    scratchDirectory: settings.scratchDirectory,
    systemPrompt: settings.systemPrompt ?? "",
  };
}

function definedSettings(input: UpdateAgentSettingsInput): Partial<AgentStartConfig> {
  const next: Partial<AgentStartConfig> = {};
  if (input.systemPrompt !== undefined) next.systemPrompt = input.systemPrompt;
  if (input.branchWorkspaceId !== undefined) next.branchWorkspaceId = input.branchWorkspaceId;
  if (input.branch !== undefined) next.branch = input.branch;
  if (input.cwd !== undefined) next.cwd = input.cwd;
  if (input.scratchDirectory !== undefined) next.scratchDirectory = input.scratchDirectory;
  return next;
}

function mergeDefined(
  ...configs: Array<Partial<AgentStartConfig> | undefined>
): Partial<AgentStartConfig> | undefined {
  const merged: Partial<AgentStartConfig> = {};
  for (const config of configs) {
    if (!config) continue;
    for (const [key, value] of Object.entries(config) as Array<
      [keyof AgentStartConfig, AgentStartConfig[keyof AgentStartConfig]]
    >) {
      if (value !== undefined) merged[key] = value as never;
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

async function defaultResolveTurnContext(
  config: Pick<AgentStartConfig, "cwd" | "branch"> | undefined,
): Promise<AgentTurnContextMetadata> {
  const cwd = config?.cwd?.trim();
  if (!cwd) return { branch: config?.branch };
  const [shaResult, branchResult] = await Promise.allSettled([
    runGit(["rev-parse", "--verify", "HEAD"], cwd),
    runGit(["branch", "--show-current"], cwd),
  ]);
  const baseCommitSha =
    shaResult.status === "fulfilled" ? shaResult.value.trim() || undefined : undefined;
  const gitBranch =
    branchResult.status === "fulfilled" ? branchResult.value.trim() || undefined : undefined;
  return {
    cwd,
    branch: gitBranch ?? config?.branch,
    baseCommitSha,
    baseShortSha: baseCommitSha?.slice(0, 7),
  };
}

async function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || error.message).trim()));
        return;
      }
      resolve(stdout.trimEnd());
    });
  });
}
