import type {
  AgentFileAccess,
  AgentEvent,
  AgentPromptAccess,
  AgentProvider,
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
  /** 注入 Claude query（默认用真实 SDK；测试注入假实现）。 */
  query: QueryFn;
  /** 注入 Codex query；未提供时复用 query，便于单测。 */
  codexQuery?: QueryFn;
  now?: () => number;
  resolveFileAccess?: (agentId: string) => AgentFileAccess;
  resolvePromptAccess?: (agentId: string) => AgentPromptAccess;
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
  private readonly queries: Record<AgentProvider, QueryFn>;
  private readonly now: () => number;
  private readonly resolveFileAccess?: (agentId: string) => AgentFileAccess;
  private readonly resolvePromptAccess?: (agentId: string) => AgentPromptAccess;
  private readonly listeners = new Set<AgentEventListener>();

  private status: AgentStatus = "idle";
  private config?: AgentStartConfig;
  private sessionId?: string;
  private abortController?: AbortController;
  private inputQueue?: AsyncMessageQueue<SdkUserInput>;
  private handle?: QueryHandle;
  private activeProvider: AgentProvider = "claude";
  private totalCostUsd?: number;
  private usage?: UsageInfo;
  private lastAssistantUuid?: string; // 本轮最后一条 assistant 消息 uuid（fork 锚点）
  private compactPending = false;
  private promptInjectionPending = false;
  private pendingQueuedInputs: string[] = [];
  private readonly createdAt: number;

  constructor(id: string, deps: AgentRunnerDeps) {
    this.id = id;
    this.queries = {
      claude: deps.query,
      codex: deps.codexQuery ?? deps.query,
    };
    this.now = deps.now ?? Date.now;
    this.resolveFileAccess = deps.resolveFileAccess;
    this.resolvePromptAccess = deps.resolvePromptAccess;
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
    const provider = normalizeProvider(config.provider);
    this.activeProvider = provider;
    this.config = { ...config, provider };
    this.totalCostUsd = undefined;
    this.usage = undefined;
    this.sessionId = undefined;
    this.lastAssistantUuid = undefined;
    this.compactPending = false;
    this.promptInjectionPending = !config.resume && !extra.resumeSessionId;
    this.pendingQueuedInputs = [];

    this.abortController = new AbortController();
    this.inputQueue = new AsyncMessageQueue<SdkUserInput>();
    // 首条任务作为第一条用户消息
    const fileAccess = this.resolveFileAccess?.(this.id);
    const promptAccess = this.promptAccessForNextInput();
    this.inputQueue.push(toUserInput(config.prompt, fileAccess, promptAccess));

    this.setStatus("starting");
    this.emit({ kind: "user_input", text: config.prompt });

    const options: QueryOptions = {
      cwd: config.cwd,
      model: config.model,
      systemPrompt: config.systemPrompt,
      allowedTools: config.allowedTools,
      permissionMode: config.permissionMode,
      maxTurns: config.maxTurns,
      resume: config.resume ?? extra.resumeSessionId,
      resumeSessionAt: config.resumeSessionAt,
      forkSession: config.forkSession,
      abortController: this.abortController,
      fileAccess,
      promptAccess,
    };

    this.handle = this.queries[provider]({ prompt: this.inputQueue, options });
    // 后台消费消息流（不阻塞调用方）
    void this.consume(this.handle);
  }

  /** 运行中追加一条指令（流式输入干预）。 */
  send(text: string): void {
    if (!this.inputQueue || this.inputQueue.isClosed || isTerminalStatus(this.status)) {
      throw new Error(`agent ${this.id} 当前不可接收输入（${this.status}）`);
    }
    const isQueuedInput = this.status === "starting" || this.status === "running";
    if (isQueuedInput) {
      this.pendingQueuedInputs.push(text);
      this.emit({ kind: "user_input", text, mode: "queued" });
      return;
    }
    this.inputQueue.push(
      toUserInput(
        text,
        this.resolveFileAccess?.(this.id),
        this.promptAccessForNextInput(),
      ),
    );
    this.setStatus("running");
    this.emit({ kind: "user_input", text });
  }

  /** 尽快把输入追加到当前正在运行的一轮；Codex 使用 turn/steer，Claude 回退到流式输入通道。 */
  async steer(text: string): Promise<void> {
    if (
      !this.inputQueue ||
      this.inputQueue.isClosed ||
      isTerminalStatus(this.status) ||
      this.status !== "running"
    ) {
      throw new Error(`agent ${this.id} 当前不可引导（${this.status}）`);
    }
    const input = toUserInput(
      text,
      this.resolveFileAccess?.(this.id),
      this.promptAccessWithoutReadablePrompts(),
    );
    if (this.handle?.steer) {
      await this.handle.steer(input);
    } else {
      this.inputQueue.push(input);
    }
    this.emit({ kind: "user_input", text, mode: "steer" });
  }

  /** 手动压缩当前会话上下文；压缩本身作为独立一轮。 */
  compact(): void {
    if (!this.inputQueue || this.inputQueue.isClosed || this.status !== "waiting_input") {
      throw new Error(`agent ${this.id} 当前不可 compact（${this.status}）`);
    }
    this.inputQueue.push(toUserInput("/compact"));
    this.compactPending = true;
    this.setStatus("running");
    this.emit({ kind: "user_input", text: "/compact" });
  }

  /** 中止会话。 */
  async stop(): Promise<void> {
    if (isTerminalStatus(this.status) || this.status === "idle") return;
    this.inputQueue?.close();
    this.compactPending = false;
    this.pendingQueuedInputs = [];
    this.abortController?.abort();
    try {
      await this.handle?.interrupt?.();
    } catch {
      // interrupt 尽力而为，忽略错误
    }
    this.setStatus("stopped");
  }

  /** 关闭底层 CLI / Query 进程。 */
  async terminate(): Promise<void> {
    if (this.status === "terminated") return;
    this.inputQueue?.close();
    this.compactPending = false;
    this.pendingQueuedInputs = [];
    this.setStatus("terminated");
    this.abortController?.abort();
    try {
      if (this.handle?.terminate) {
        await this.handle.terminate();
      } else {
        await this.handle?.interrupt?.();
      }
    } catch {
      // 终止尽力而为；状态仍保持 terminated
    }
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
      case "assistant_text":
      case "tool_use":
        if (event.messageUuid) this.lastAssistantUuid = event.messageUuid;
        if (this.status === "starting") this.setStatus("running");
        this.emit(event);
        break;
      case "compact":
        this.compactPending = false;
        this.promptInjectionPending = true;
        this.emit(event);
        this.lastAssistantUuid = undefined;
        if (event.trigger === "manual") {
          this.setStatus("waiting_input");
        } else if (this.status === "starting") {
          this.setStatus("running");
        }
        break;
      case "result": {
        if (event.costUsd !== undefined) this.totalCostUsd = event.costUsd;
        if (event.usage) this.usage = event.usage;
        // 用本轮最后一条 assistant 消息 uuid 作为 fork 锚点
        const enriched: AgentEvent = {
          ...event,
          anchorUuid: event.anchorUuid ?? this.lastAssistantUuid,
        };
        this.lastAssistantUuid = undefined; // 下一轮重新累积
        this.emit(enriched);
        // 一轮结束：输入流仍开则等待下一条指令，否则完成
        const inputQueue = this.inputQueue;
        if (!inputQueue || inputQueue.isClosed) {
          this.pendingQueuedInputs = [];
          this.setStatus("done");
        } else {
          const queuedInput = this.pendingQueuedInputs.shift();
          if (queuedInput) {
            inputQueue.push(
              toUserInput(
                queuedInput,
                this.resolveFileAccess?.(this.id),
                this.promptAccessForNextInput(),
              ),
            );
            this.emit({ kind: "user_input", text: queuedInput });
            this.setStatus("running");
          } else {
            this.setStatus("waiting_input");
          }
        }
        break;
      }
      case "error":
        this.emit(event);
        if (this.compactPending) {
          this.compactPending = false;
          this.setStatus("waiting_input");
        }
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

  private promptAccessForNextInput(): AgentPromptAccess | undefined {
    const access = this.resolvePromptAccess?.(this.id);
    if (!access) return undefined;
    const includeReadable = this.promptInjectionPending;
    this.promptInjectionPending = false;
    return includeReadable
      ? access
      : {
          ...access,
          readablePrompts: [],
        };
  }

  private promptAccessWithoutReadablePrompts(): AgentPromptAccess | undefined {
    const access = this.resolvePromptAccess?.(this.id);
    if (!access) return undefined;
    return {
      ...access,
      readablePrompts: [],
    };
  }
}

function normalizeProvider(provider: AgentProvider | undefined): AgentProvider {
  return provider ?? "claude";
}

function toUserInput(
  text: string,
  fileAccess?: AgentFileAccess,
  promptAccess?: AgentPromptAccess,
): SdkUserInput {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    fileAccess,
    promptAccess,
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
