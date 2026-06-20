import type {
  AgentFileAccess,
  AgentEvent,
  AgentEventEnvelope,
  AgentSnapshot,
  AgentStartConfig,
  AgentPromptAccess,
  ForkOrigin,
} from "@agent-canvas/shared";
import { AgentRunner } from "./AgentRunner.js";
import type { QueryFn } from "./sdk/types.js";

export type EnvelopeListener = (envelope: AgentEventEnvelope) => void;

export interface AgentManagerDeps {
  query: QueryFn;
  codexQuery?: QueryFn;
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
  private readonly query: QueryFn;
  private readonly codexQuery?: QueryFn;
  private readonly now: () => number;
  private resolveFileAccess?: (agentId: string) => AgentFileAccess;
  private resolvePromptAccess?: (agentId: string) => AgentPromptAccess;
  private counter = 0;

  constructor(deps: AgentManagerDeps) {
    this.query = deps.query;
    this.codexQuery = deps.codexQuery;
    this.now = deps.now ?? Date.now;
    this.resolveFileAccess = deps.resolveFileAccess;
    this.resolvePromptAccess = deps.resolvePromptAccess;
  }

  onEvent(listener: EnvelopeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  create(): AgentRunner {
    const id = `agent_${++this.counter}`;
    const runner = new AgentRunner(id, {
      query: this.query,
      codexQuery: this.codexQuery,
      now: this.now,
      resolveFileAccess: (agentId) =>
        this.resolveFileAccess?.(agentId) ?? {
          readableFiles: [],
          writableFiles: [],
          writableDirectories: [],
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

    const runner = this.create();
    const origin: ForkOrigin = { parentAgentId: parentId, anchorUuid };
    this.forkOrigins.set(runner.id, origin);
    this.forkConfigs.set(runner.id, {
      provider: parentProvider,
      model: model ?? parentSnapshot.config?.model,
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
    runner.start(forkCfg ? { ...forkCfg, ...config, provider: forkCfg.provider } : config);
  }

  list(): AgentSnapshot[] {
    return [...this.runners.entries()].map(([id, runner]) => {
      const s = runner.snapshot();
      const config: AgentStartConfig =
        s.config ?? { ...this.forkConfigs.get(id), prompt: "" };
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
    });
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
}
