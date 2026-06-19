import type {
  AgentEvent,
  AgentEventEnvelope,
  AgentSnapshot,
} from "@agent-canvas/shared";
import { AgentRunner } from "./AgentRunner.js";
import type { QueryFn } from "./sdk/types.js";

export type EnvelopeListener = (envelope: AgentEventEnvelope) => void;

export interface AgentManagerDeps {
  query: QueryFn;
  now?: () => number;
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
  private readonly query: QueryFn;
  private readonly now: () => number;
  private counter = 0;

  constructor(deps: AgentManagerDeps) {
    this.query = deps.query;
    this.now = deps.now ?? Date.now;
  }

  onEvent(listener: EnvelopeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  create(): AgentRunner {
    const id = `agent_${++this.counter}`;
    const runner = new AgentRunner(id, { query: this.query, now: this.now });
    this.runners.set(id, runner);
    this.seqs.set(id, 0);
    this.history.set(id, []);
    runner.on((event) => this.broadcast(id, event));
    return runner;
  }

  get(id: string): AgentRunner | undefined {
    return this.runners.get(id);
  }

  list(): AgentSnapshot[] {
    return [...this.runners.entries()].map(([id, runner]) => {
      const s = runner.snapshot();
      return {
        id,
        status: s.status,
        sessionId: s.sessionId,
        config: s.config ?? { prompt: "" },
        createdAt: s.createdAt,
        lastEventSeq: this.seqs.get(id) ?? 0,
        totalCostUsd: s.totalCostUsd,
        usage: s.usage,
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
