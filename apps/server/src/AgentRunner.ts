import type {
  AgentApprovalAction,
  AgentApprovalRequest,
  AgentApprovalResponse,
  AgentFileAccess,
  AgentEvent,
  AgentQuestionAction,
  AgentQuestionRequest,
  AgentQuestionResponse,
  AgentPromptAccess,
  AgentPromptReference,
  AgentProvider,
  AgentSnapshot,
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
import {
  AGENT_CANVAS_POLICY_PROMPT_ID,
  AGENT_CANVAS_POLICY_PROMPT_NAME,
  agentCanvasPolicyPrompt,
} from "./agentCanvasPolicyPrompt.js";

export type AgentEventListener = (event: AgentEvent) => void;

export interface AgentRunnerDeps {
  /** 注入 Claude query（默认用真实 SDK；测试注入假实现）。 */
  query: QueryFn;
  /** 注入 Codex query；未提供时复用 query，便于单测。 */
  codexQuery?: QueryFn;
  now?: () => number;
  resolveFileAccess?: (agentId: string) => AgentFileAccess;
  /** Revalidate asynchronous workspace invariants immediately before queued input is dispatched. */
  prepareFileAccess?: (agentId: string) => Promise<void>;
  resolvePromptAccess?: (agentId: string) => AgentPromptAccess;
  fullPermissionMode?: () => boolean;
  workDocumentationEnabled?: () => boolean;
}

export interface StartExtra {
  /** 续接已有 session。 */
  resumeSessionId?: string;
}

interface PendingQuestion {
  resolve: (response: AgentQuestionResponse) => void;
  cleanup?: () => void;
}

interface PendingApproval {
  resolve: (response: AgentApprovalResponse) => void;
  cleanup?: () => void;
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
  private readonly prepareFileAccess?: (agentId: string) => Promise<void>;
  private readonly resolvePromptAccess?: (agentId: string) => AgentPromptAccess;
  private readonly fullPermissionMode: () => boolean;
  private readonly workDocumentationEnabled: () => boolean;
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
  private policyPromptInjectionPending = false;
  private pendingInjectedPrompts: AgentPromptReference[] = [];
  private pendingQueuedInputs: string[] = [];
  private readonly pendingQuestions = new Map<string, PendingQuestion>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private questionCounter = 0;
  private approvalCounter = 0;
  private interruptedTurnPending = false;
  private suppressAbortStatus = false;
  private suppressNaturalEndStatus = false;
  private createdAt: number;

  constructor(id: string, deps: AgentRunnerDeps) {
    this.id = id;
    this.queries = {
      claude: deps.query,
      codex: deps.codexQuery ?? deps.query,
    };
    this.now = deps.now ?? Date.now;
    this.resolveFileAccess = deps.resolveFileAccess;
    this.prepareFileAccess = deps.prepareFileAccess;
    this.resolvePromptAccess = deps.resolvePromptAccess;
    this.fullPermissionMode = deps.fullPermissionMode ?? (() => false);
    this.workDocumentationEnabled = deps.workDocumentationEnabled ?? (() => false);
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

  restore(snapshot: AgentSnapshot): void {
    this.inputQueue?.close();
    this.abortController?.abort();
    void this.handle?.terminate?.();
    this.status = restorableStatus(snapshot.status);
    this.config = snapshot.config;
    this.sessionId = snapshot.sessionId;
    this.createdAt = snapshot.createdAt;
    this.totalCostUsd = snapshot.totalCostUsd;
    this.usage = snapshot.usage;
    this.abortController = undefined;
    this.inputQueue = undefined;
    this.handle = undefined;
    this.lastAssistantUuid = undefined;
    this.compactPending = false;
    this.promptInjectionPending = false;
    this.policyPromptInjectionPending = true;
    this.pendingInjectedPrompts = [];
    this.pendingQueuedInputs = [];
    this.interruptedTurnPending = false;
    this.cancelPendingQuestions("cancel");
    this.cancelPendingApprovals("cancel");
    if (this.status === "waiting_input" && this.sessionId && !this.config.resume) {
      this.config = { ...this.config, resume: this.sessionId };
    }
  }

  updateSettings(
    settings: Partial<
      Pick<
        AgentStartConfig,
        | "systemPrompt"
        | "branchWorkspaceId"
        | "branch"
        | "cwd"
        | "scratchDirectory"
      >
    > & { model?: string | null; reasoningEffort?: string | null },
    pendingPrompt?: AgentPromptReference,
  ): void {
    this.config = applySettings(this.config ?? { prompt: "" }, settings);
    if (settings.systemPrompt !== undefined && this.status !== "idle") {
      this.promptInjectionPending = true;
    }
    if (settings.model !== undefined && this.status !== "idle") {
      const nextModel = settings.model ?? undefined;
      void this.handle?.setModel?.(nextModel).catch(() => undefined);
      if (!this.handle?.setModel && this.status === "waiting_input" && this.sessionId) {
        this.detachIdleSessionForNextStart();
      }
    }
    if (settings.reasoningEffort !== undefined && this.status !== "idle") {
      const nextReasoningEffort = settings.reasoningEffort ?? undefined;
      void this.handle?.setReasoningEffort?.(nextReasoningEffort).catch(() => undefined);
      if (!this.handle?.setReasoningEffort && this.status === "waiting_input" && this.sessionId) {
        this.detachIdleSessionForNextStart();
      }
    }
    if (pendingPrompt) {
      this.pendingInjectedPrompts.push(pendingPrompt);
      this.policyPromptInjectionPending = true;
    }
    if (
      this.status === "waiting_input" &&
      this.sessionId &&
      (settings.branchWorkspaceId !== undefined ||
        settings.branch !== undefined ||
        settings.cwd !== undefined)
    ) {
      this.detachIdleSessionForNextStart();
    }
  }

  refreshPolicyPrompt(
    pendingPrompt?: AgentPromptReference,
    clearPendingPromptId?: string,
  ): void {
    if (clearPendingPromptId) {
      this.pendingInjectedPrompts = this.pendingInjectedPrompts.filter(
        (prompt) => prompt.id !== clearPendingPromptId,
      );
    }
    if (this.status === "idle") return;
    if (pendingPrompt) {
      this.pendingInjectedPrompts = [
        ...this.pendingInjectedPrompts.filter((prompt) => prompt.id !== pendingPrompt.id),
        pendingPrompt,
      ];
    }
    this.policyPromptInjectionPending = true;
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
    this.policyPromptInjectionPending = true;
    this.pendingQueuedInputs = [];
    this.interruptedTurnPending = false;
    this.cancelPendingQuestions("cancel");
    this.cancelPendingApprovals("cancel");

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
      reasoningEffort: config.reasoningEffort,
      allowedTools: config.allowedTools,
      permissionMode: config.permissionMode,
      maxTurns: config.maxTurns,
      resume: config.resume ?? extra.resumeSessionId,
      resumeSessionAt: config.resumeSessionAt,
      forkSession: config.forkSession,
      abortController: this.abortController,
      fileAccess,
      promptAccess,
      requestUserInput: (request) => this.requestUserInput(request),
      requestApproval: (request) => this.requestApproval(request),
    };

    this.handle = this.queries[provider]({ prompt: this.inputQueue, options });
    // 后台消费消息流（不阻塞调用方）
    void this.consume(this.handle);
  }

  /** 运行中追加一条指令（流式输入干预）。 */
  send(text: string): void {
    if (this.status === "stopped") {
      this.sendAfterStopped(text);
      return;
    }
    if (this.status === "terminated") {
      this.restartAfterClosedTurn(text);
      return;
    }
    if (
      this.status === "waiting_input" &&
      (!this.inputQueue || this.inputQueue.isClosed) &&
      this.config?.resume
    ) {
      this.status = "idle";
      this.start({ ...this.config, prompt: text });
      return;
    }
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
    } else if (this.handle?.interrupt) {
      this.pendingQueuedInputs.unshift(text);
      await this.handle.interrupt().catch(() => undefined);
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
    this.compactPending = false;
    this.pendingQueuedInputs = [];
    this.interruptedTurnPending = true;
    this.cancelPendingQuestions("cancel");
    this.cancelPendingApprovals("cancel");
    this.setStatus("stopped");
    try {
      await this.handle?.interrupt?.();
    } catch {
      // interrupt 尽力而为，忽略错误
    }
  }

  /** 关闭底层 CLI / Query 进程。 */
  async terminate(): Promise<void> {
    if (this.status === "terminated") return;
    this.inputQueue?.close();
    this.inputQueue = undefined;
    this.compactPending = false;
    this.policyPromptInjectionPending = false;
    this.pendingQueuedInputs = [];
    this.interruptedTurnPending = false;
    this.cancelPendingQuestions("cancel");
    this.cancelPendingApprovals("cancel");
    this.setStatus("terminated");
    this.abortController?.abort();
    const handle = this.handle;
    this.handle = undefined;
    try {
      if (handle?.terminate) {
        await handle.terminate();
      } else {
        await handle?.interrupt?.();
      }
    } catch {
      // 终止尽力而为；状态仍保持 terminated
    }
  }

  answerQuestion(requestId: string, response: AgentQuestionResponse): void {
    const pending = this.pendingQuestions.get(requestId);
    if (!pending) throw new Error(`未知或已处理的问题: ${requestId}`);
    this.pendingQuestions.delete(requestId);
    pending.cleanup?.();
    const normalized = normalizeQuestionResponse(response);
    pending.resolve(normalized);
    this.emit({
      kind: "user_question_result",
      requestId,
      action: normalized.action ?? "accept",
      summary: summarizeQuestionResponse(normalized),
    });
  }

  answerApproval(requestId: string, response: AgentApprovalResponse): void {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) throw new Error(`未知或已处理的授权请求: ${requestId}`);
    this.pendingApprovals.delete(requestId);
    pending.cleanup?.();
    pending.resolve(response);
    this.emit({
      kind: "user_approval_result",
      requestId,
      action: response.action,
      summary: summarizeApprovalResponse(response),
    });
  }

  approvePendingApprovals(summary = "完全权限模式已允许"): void {
    for (const [requestId, pending] of this.pendingApprovals) {
      pending.cleanup?.();
      pending.resolve({ action: "approve" });
      this.emit({
        kind: "user_approval_result",
        requestId,
        action: "approve",
        summary,
      });
    }
    this.pendingApprovals.clear();
  }

  // ---- 内部 ----

  private async consume(handle: QueryHandle): Promise<void> {
    try {
      for await (const msg of handle) {
        if (handle !== this.handle) return;
        for (const event of mapSdkMessage(msg)) {
          await this.applyEvent(event);
        }
      }
      if (handle !== this.handle) return;
      // 迭代自然结束：若仍非终态，视为完成
      if (this.suppressNaturalEndStatus) {
        this.suppressNaturalEndStatus = false;
        return;
      }
      this.cancelPendingQuestions("cancel");
      this.cancelPendingApprovals("cancel");
      if (this.status === "stopped") {
        this.inputQueue?.close();
        this.inputQueue = undefined;
        this.handle = undefined;
        this.interruptedTurnPending = false;
        return;
      }
      if (!isTerminalStatus(this.status)) {
        this.setStatus("done");
      }
    } catch (err) {
      if (handle !== this.handle) return;
      if (this.suppressAbortStatus) {
        this.suppressAbortStatus = false;
        return;
      }
      if (this.abortController?.signal.aborted) {
        // 由 stop() 主动中止
        if (!isTerminalStatus(this.status)) this.setStatus("stopped");
        return;
      }
      this.cancelPendingQuestions("cancel");
      this.cancelPendingApprovals("cancel");
      this.emit({ kind: "error", message: errorMessage(err) });
      this.setStatus("error");
    }
  }

  private requestUserInput(request: AgentQuestionRequest): Promise<AgentQuestionResponse> {
    const requestId = request.requestId || `${this.id}:question-${++this.questionCounter}`;
    const normalized: AgentQuestionRequest = { ...request, requestId };
    if (this.abortController?.signal.aborted || isTerminalStatus(this.status)) {
      return Promise.resolve({ action: "cancel" });
    }
    this.emit({ kind: "user_question", request: normalized });
    return new Promise((resolve) => {
      const onAbort = () => {
        const pending = this.pendingQuestions.get(requestId);
        if (!pending) return;
        this.pendingQuestions.delete(requestId);
        pending.cleanup?.();
        resolve({ action: "cancel" });
        this.emit({ kind: "user_question_result", requestId, action: "cancel" });
      };
      this.abortController?.signal.addEventListener("abort", onAbort, { once: true });
      this.pendingQuestions.set(requestId, {
        resolve,
        cleanup: () => this.abortController?.signal.removeEventListener("abort", onAbort),
      });
    });
  }

  private cancelPendingQuestions(action: AgentQuestionAction): void {
    for (const [requestId, pending] of this.pendingQuestions) {
      pending.cleanup?.();
      pending.resolve({ action });
      this.emit({ kind: "user_question_result", requestId, action });
    }
    this.pendingQuestions.clear();
  }

  private requestApproval(request: AgentApprovalRequest): Promise<AgentApprovalResponse> {
    const requestId = request.requestId || `${this.id}:approval-${++this.approvalCounter}`;
    const normalized: AgentApprovalRequest = { ...request, requestId };
    if (this.fullPermissionMode()) {
      return Promise.resolve({ action: "approve" });
    }
    if (this.abortController?.signal.aborted || isTerminalStatus(this.status)) {
      return Promise.resolve({ action: "cancel" });
    }
    this.emit({ kind: "user_approval", request: normalized });
    return new Promise((resolve) => {
      const onAbort = () => {
        const pending = this.pendingApprovals.get(requestId);
        if (!pending) return;
        this.pendingApprovals.delete(requestId);
        pending.cleanup?.();
        resolve({ action: "cancel" });
        this.emit({ kind: "user_approval_result", requestId, action: "cancel" });
      };
      this.abortController?.signal.addEventListener("abort", onAbort, { once: true });
      this.pendingApprovals.set(requestId, {
        resolve,
        cleanup: () => this.abortController?.signal.removeEventListener("abort", onAbort),
      });
    });
  }

  private cancelPendingApprovals(action: AgentApprovalAction): void {
    for (const [requestId, pending] of this.pendingApprovals) {
      pending.cleanup?.();
      pending.resolve({ action });
      this.emit({ kind: "user_approval_result", requestId, action });
    }
    this.pendingApprovals.clear();
  }

  private async applyEvent(event: AgentEvent): Promise<void> {
    if (this.interruptedTurnPending) {
      if (event.kind === "result") this.interruptedTurnPending = false;
      return;
    }
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
        this.policyPromptInjectionPending = true;
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
            // A queued message can sit behind a long-running turn. Revalidate links,
            // markers, tracked paths, and realpaths at the moment access is granted.
            try {
              await this.prepareFileAccess?.(this.id);
            } catch (error) {
              this.pendingQueuedInputs = [];
              inputQueue.close();
              await this.handle?.terminate?.().catch(() => undefined);
              throw error;
            }
            if (
              inputQueue !== this.inputQueue ||
              inputQueue.isClosed ||
              isTerminalStatus(this.status)
            ) {
              return;
            }
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
    const access =
      this.resolvePromptAccess?.(this.id) ?? {
        readablePrompts: [],
        writablePrompts: [],
        writableDirectories: [],
      };
    const includeReadable = this.promptInjectionPending;
    const includePolicy = this.policyPromptInjectionPending || includeReadable;
    const pendingPrompts = this.pendingInjectedPrompts;
    this.pendingInjectedPrompts = [];
    this.promptInjectionPending = false;
    this.policyPromptInjectionPending = false;
    const next = includeReadable
      ? access
      : {
          ...access,
          readablePrompts: [],
        };
    if (!includeReadable && !includePolicy && pendingPrompts.length === 0) return next;
    const readablePrompts = [...next.readablePrompts];
    const systemPrompt = this.config?.systemPrompt?.trim();
    if (includeReadable && systemPrompt) {
      readablePrompts.unshift({
        id: `${this.id}:system-prompt`,
        name: "Agent 私有系统提示词",
        content: systemPrompt,
        kind: "normal",
      });
    }
    if (pendingPrompts.length > 0) {
      readablePrompts.unshift(...pendingPrompts);
    }
    if (includePolicy) {
      readablePrompts.unshift({
        id: AGENT_CANVAS_POLICY_PROMPT_ID,
        name: AGENT_CANVAS_POLICY_PROMPT_NAME,
        content: agentCanvasPolicyPrompt(this.id, {
          workDocumentationEnabled: this.workDocumentationEnabled(),
        }),
        kind: "shared",
      });
    }
    return {
      ...next,
      readablePrompts,
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

  private detachIdleSessionForNextStart(): void {
    const resume = this.sessionId;
    this.inputQueue?.close();
    this.inputQueue = undefined;
    this.compactPending = false;
    this.pendingQueuedInputs = [];
    this.interruptedTurnPending = false;
    this.cancelPendingQuestions("cancel");
    this.cancelPendingApprovals("cancel");
    this.suppressAbortStatus = true;
    this.suppressNaturalEndStatus = true;
    this.abortController?.abort();
    void this.handle?.terminate?.();
    this.handle = undefined;
    this.config = {
      ...(this.config ?? { prompt: "" }),
      resume,
    };
    this.setStatus("waiting_input");
  }

  private sendAfterStopped(text: string): void {
    if (this.interruptedTurnPending) {
      this.closeDetachedHandle();
      this.restartAfterClosedTurn(text);
      return;
    }
    if (this.inputQueue && !this.inputQueue.isClosed && this.handle) {
      this.inputQueue.push(
        toUserInput(
          text,
          this.resolveFileAccess?.(this.id),
          this.promptAccessForNextInput(),
        ),
      );
      this.setStatus("running");
      this.emit({ kind: "user_input", text });
      return;
    }
    this.restartAfterClosedTurn(text);
  }

  private restartAfterClosedTurn(text: string): void {
    const hasCurrentSession = !!this.sessionId;
    const resume = this.sessionId ?? this.config?.resume;
    const next: AgentStartConfig = {
      ...(this.config ?? { prompt: text, provider: this.activeProvider }),
      prompt: text,
    };
    if (resume) next.resume = resume;
    else delete next.resume;
    if (hasCurrentSession) {
      delete next.resumeSessionAt;
      delete next.forkSession;
    }
    this.start(next);
  }

  private closeDetachedHandle(): void {
    const handle = this.handle;
    this.inputQueue?.close();
    this.inputQueue = undefined;
    this.handle = undefined;
    this.interruptedTurnPending = false;
    void handle?.terminate?.()?.catch(() => undefined);
  }
}

function normalizeProvider(provider: AgentProvider | undefined): AgentProvider {
  return provider ?? "claude";
}

function restorableStatus(status: AgentStatus): AgentStatus {
  if (status === "starting" || status === "running") return "stopped";
  return status;
}

function applySettings(
  config: AgentStartConfig,
  settings: Partial<
    Pick<
      AgentStartConfig,
      | "systemPrompt"
        | "branchWorkspaceId"
        | "branch"
        | "cwd"
        | "scratchDirectory"
      >
    > & { model?: string | null; reasoningEffort?: string | null },
): AgentStartConfig {
  const next: AgentStartConfig = { ...config };
  for (const [key, value] of Object.entries(settings) as Array<
    [keyof AgentStartConfig, AgentStartConfig[keyof AgentStartConfig] | null]
  >) {
    if (key === "model" && value === null) {
      delete next.model;
    } else if (key === "reasoningEffort" && value === null) {
      delete next.reasoningEffort;
    } else if (value !== undefined) {
      next[key] = value as never;
    }
  }
  return next;
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

function normalizeQuestionResponse(response: AgentQuestionResponse): AgentQuestionResponse {
  return {
    ...response,
    action: response.action ?? "accept",
  };
}

function summarizeQuestionResponse(response: AgentQuestionResponse): string | undefined {
  if (response.action && response.action !== "accept") return undefined;
  const answerCount = Object.keys(response.answers ?? {}).length;
  if (answerCount > 0) return `已回答 ${answerCount} 个问题`;
  if (response.response?.trim()) return "已回答";
  if (response.content !== undefined) return "已提交内容";
  return undefined;
}

function summarizeApprovalResponse(response: AgentApprovalResponse): string {
  switch (response.action) {
    case "approve":
      return response.remember ? "已允许并记住" : "已允许";
    case "deny":
      return "已拒绝";
    case "cancel":
      return "已取消";
  }
}
