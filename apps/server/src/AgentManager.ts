import type {
  AgentFileAccess,
  AgentEvent,
  AgentEventEnvelope,
  AgentPromptReference,
  AgentSettings,
  AgentSnapshot,
  AgentStartConfig,
  AgentPromptAccess,
  ForkOrigin,
  UpdateAgentSettingsInput,
} from "@agent-canvas/shared";
import { AgentRunner } from "./AgentRunner.js";
import type { QueryFn } from "./sdk/types.js";

export type EnvelopeListener = (envelope: AgentEventEnvelope) => void;

export interface AgentManagerDeps {
  query: QueryFn;
  codexQuery?: QueryFn;
  defaultCwd?: string;
  now?: () => number;
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
  private readonly query: QueryFn;
  private readonly codexQuery?: QueryFn;
  private readonly defaultCwd: string;
  private readonly now: () => number;
  private resolveFileAccess?: (agentId: string) => AgentFileAccess;
  private resolvePromptAccess?: (agentId: string) => AgentPromptAccess;
  private counter = 0;

  constructor(deps: AgentManagerDeps) {
    this.query = deps.query;
    this.codexQuery = deps.codexQuery;
    this.defaultCwd = deps.defaultCwd ?? process.cwd();
    this.now = deps.now ?? Date.now;
    this.resolveFileAccess = deps.resolveFileAccess;
    this.resolvePromptAccess = deps.resolvePromptAccess;
  }

  onEvent(listener: EnvelopeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  create(settings: AgentSettings = {}): AgentRunner {
    const id = `agent_${++this.counter}`;
    const runner = new AgentRunner(id, {
      query: this.query,
      codexQuery: this.codexQuery,
      now: this.now,
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
    this.draftConfigs.set(id, normalizeSettings(settings, this.defaultCwd));
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

  list(): AgentSnapshot[] {
    return [...this.runners.keys()].map((id) => this.snapshotOf(id));
  }

  historyOf(id: string): AgentEventEnvelope[] {
    return this.history.get(id) ?? [];
  }

  private broadcast(agentId: string, event: AgentEvent): void {
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
