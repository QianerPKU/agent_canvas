import type {
  AgentEvent,
  AgentStartConfig,
  AgentStatus,
  UsageInfo,
} from "@agent-canvas/shared";
import { isTerminalStatus } from "@agent-canvas/shared";
import { mapSdkMessage } from "./eventMapper.js";
import { AsyncMessageQueue } from "./util/AsyncMessageQueue.js";
import type {
  QueryFn,
  QueryHandle,
  QueryOptions,
  SdkUserInput,
} from "./sdk/types.js";

export type AgentEventListener = (event: AgentEvent) => void;

export interface AgentRunnerDeps {
  /** 注入 query（默认用真实 SDK；测试注入假实现）。 */
  query: QueryFn;
  now?: () => number;
}

export interface StartExtra {
  /** 续接已有 session。 */
  resumeSessionId?: string;
}

/**
 * 单个 agent 的生命周期管理：封装 Agent SDK 的一次 query，
 * 驱动流式输入（用于中途干预），把 SDK 消息归一为统一事件向外广播，
 * 并维护一个清晰的状态机。
 *
 * 状态：idle → starting → running ↔ waiting_input → done/stopped/error
 */
export class AgentRunner {
  readonly id: string;
  private readonly queryFn: QueryFn;
  private readonly now: () => number;
  private readonly listeners = new Set<AgentEventListener>();

  private status: AgentStatus = "idle";
  private config?: AgentStartConfig;
  private sessionId?: string;
  private abortController?: AbortController;
  private inputQueue?: AsyncMessageQueue<SdkUserInput>;
  private handle?: QueryHandle;
  private totalCostUsd?: number;
  private usage?: UsageInfo;
  private readonly createdAt: number;

  constructor(id: string, deps: AgentRunnerDeps) {
    this.id = id;
    this.queryFn = deps.query;
    this.now = deps.now ?? Date.now;
    this.createdAt = this.now();
  }

  // ---- 订阅 ----
  on(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getStatus(): AgentStatus {
    return this.status;
  }

  snapshot() {
    return {
      id: this.id,
      status: this.status,
      sessionId: this.sessionId,
      config: this.config,
      createdAt: this.createdAt,
      totalCostUsd: this.totalCostUsd,
      usage: this.usage,
    };
  }

  // ---- 生命周期 ----

  /** 启动（或以 resumeSessionId 续接）一次会话。 */
  start(config: AgentStartConfig, extra: StartExtra = {}): void {
    if (this.status === "starting" || this.status === "running" || this.status === "waiting_input") {
      throw new Error(`agent ${this.id} 已在运行（${this.status}），不能重复 start`);
    }
    this.config = config;
    this.totalCostUsd = undefined;
    this.usage = undefined;
    this.sessionId = undefined;

    this.abortController = new AbortController();
    this.inputQueue = new AsyncMessageQueue<SdkUserInput>();
    // 首条任务作为第一条用户消息
    this.inputQueue.push(toUserInput(config.prompt));

    this.setStatus("starting");

    const options: QueryOptions = {
      cwd: config.cwd,
      model: config.model,
      systemPrompt: config.systemPrompt,
      allowedTools: config.allowedTools,
      permissionMode: config.permissionMode,
      maxTurns: config.maxTurns,
      resume: extra.resumeSessionId,
      abortController: this.abortController,
    };

    this.handle = this.queryFn({ prompt: this.inputQueue, options });
    // 后台消费消息流（不阻塞调用方）
    void this.consume(this.handle);
  }

  /** 运行中追加一条指令（流式输入干预）。 */
  send(text: string): void {
    if (!this.inputQueue || this.inputQueue.isClosed || isTerminalStatus(this.status)) {
      throw new Error(`agent ${this.id} 当前不可接收输入（${this.status}）`);
    }
    this.inputQueue.push(toUserInput(text));
    this.setStatus("running");
  }

  /** 中止会话。 */
  async stop(): Promise<void> {
    if (isTerminalStatus(this.status) || this.status === "idle") return;
    this.inputQueue?.close();
    try {
      await this.handle?.interrupt?.();
    } catch {
      // interrupt 尽力而为，忽略错误
    }
    this.abortController?.abort();
    this.setStatus("stopped");
  }

  // ---- 内部 ----

  private async consume(handle: QueryHandle): Promise<void> {
    try {
      for await (const msg of handle) {
        for (const event of mapSdkMessage(msg)) {
          this.applyEvent(event);
        }
      }
      // 迭代自然结束：若仍非终态，视为完成
      if (!isTerminalStatus(this.status)) {
        this.setStatus("done");
      }
    } catch (err) {
      if (this.abortController?.signal.aborted) {
        // 由 stop() 主动中止
        if (!isTerminalStatus(this.status)) this.setStatus("stopped");
        return;
      }
      this.emit({ kind: "error", message: errorMessage(err) });
      this.setStatus("error");
    }
  }

  private applyEvent(event: AgentEvent): void {
    switch (event.kind) {
      case "system_init":
        this.sessionId = event.sessionId;
        this.emit(event);
        this.setStatus("running");
        break;
      case "result":
        if (event.costUsd !== undefined) this.totalCostUsd = event.costUsd;
        if (event.usage) this.usage = event.usage;
        this.emit(event);
        // 一轮结束：输入流仍开则等待下一条指令，否则完成
        this.setStatus(this.inputQueue?.isClosed ? "done" : "waiting_input");
        break;
      default:
        // 收到实质内容却仍处于 starting，则补一个 running
        if (this.status === "starting") this.setStatus("running");
        this.emit(event);
        break;
    }
  }

  private setStatus(status: AgentStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit({ kind: "status", status });
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // 单个监听器异常不影响其他监听器
      }
    }
  }
}

function toUserInput(text: string): SdkUserInput {
  return { type: "user", message: { role: "user", content: text } };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
