/**
 * 对 `@anthropic-ai/claude-agent-sdk` 的**最小本地类型映射**。
 *
 * 只声明我们实际消费的字段，目的：
 *  1. 让 eventMapper / AgentRunner 强类型，不直接耦合 SDK 的庞大类型；
 *  2. 单测可注入一个产出这些形状的假 `query`，无需真实调用模型。
 *
 * 真实 SDK 的 `query` 在 AgentRunner 默认依赖里以一次 `as` 适配进来。
 */

// ---- 消息内容块 ----
export interface SdkTextBlock {
  type: "text";
  text: string;
}
export interface SdkToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}
export interface SdkToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: unknown;
  is_error?: boolean;
}
export interface SdkThinkingBlock {
  type: "thinking";
  thinking: string;
}
export type SdkContentBlock =
  | SdkTextBlock
  | SdkToolUseBlock
  | SdkToolResultBlock
  | SdkThinkingBlock
  | { type: string; [k: string]: unknown };

export interface SdkApiMessage {
  role: string;
  content: SdkContentBlock[] | string;
}

// ---- 顶层流式消息（SDKMessage 子集）----
export interface SdkSystemInitMessage {
  type: "system";
  subtype: "init";
  session_id: string;
  model: string;
  cwd: string;
  tools: string[];
  permissionMode?: string;
}
export interface SdkCompactBoundaryMessage {
  type: "system";
  subtype: "compact_boundary";
  compact_metadata: {
    trigger: "manual" | "auto";
    pre_tokens?: number;
    post_tokens?: number;
    duration_ms?: number;
  };
  uuid: string;
  session_id: string;
}
export interface SdkStatusMessage {
  type: "system";
  subtype: "status";
  status: "compacting" | "requesting" | null;
  compact_result?: "success" | "failed";
  compact_error?: string;
  session_id: string;
}
export interface SdkAssistantMessage {
  type: "assistant";
  message: SdkApiMessage;
  session_id: string;
  uuid?: string; // SDKAssistantMessage.uuid —— fork 锚点
}
export interface SdkUserMessage {
  type: "user";
  message: SdkApiMessage;
  session_id: string;
}
export interface SdkUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}
export interface SdkResultMessage {
  type: "result";
  subtype: string;
  is_error: boolean;
  result?: string;
  total_cost_usd?: number;
  usage?: SdkUsage;
  duration_ms?: number;
  num_turns?: number;
  session_id: string;
}
export interface SdkStreamEventMessage {
  type: "stream_event";
  event: unknown;
  session_id: string;
}

export type SdkMessage =
  | SdkSystemInitMessage
  | SdkCompactBoundaryMessage
  | SdkStatusMessage
  | SdkAssistantMessage
  | SdkUserMessage
  | SdkResultMessage
  | SdkStreamEventMessage
  | { type: string; [k: string]: unknown };

// ---- query 的输入与函数签名（供依赖注入）----

export type SdkRequestUserInput = (
  request: import("@agent-canvas/shared").AgentQuestionRequest,
) => Promise<import("@agent-canvas/shared").AgentQuestionResponse>;

export type SdkRequestApproval = (
  request: import("@agent-canvas/shared").AgentApprovalRequest,
) => Promise<import("@agent-canvas/shared").AgentApprovalResponse>;

/** 流式输入模式下推给 SDK 的用户消息（对齐 SDKUserMessage 必填字段）。 */
export interface SdkUserInput {
  type: "user";
  message: { role: "user"; content: string | SdkContentBlock[] };
  parent_tool_use_id: string | null; // SDK 要求必填，顶层用户消息填 null
  session_id?: string;
  fileAccess?: import("@agent-canvas/shared").AgentFileAccess;
  promptAccess?: import("@agent-canvas/shared").AgentPromptAccess;
}

export type QueryPrompt = string | AsyncIterable<SdkUserInput>;

export interface QueryOptions {
  cwd?: string;
  model?: string;
  systemPrompt?: string | { type: "preset"; preset: string; append?: string };
  allowedTools?: string[];
  permissionMode?: string;
  maxTurns?: number;
  resume?: string;
  resumeSessionAt?: string;
  forkSession?: boolean;
  abortController?: AbortController;
  fileAccess?: import("@agent-canvas/shared").AgentFileAccess;
  promptAccess?: import("@agent-canvas/shared").AgentPromptAccess;
  requestUserInput?: SdkRequestUserInput;
  requestApproval?: SdkRequestApproval;
  [k: string]: unknown;
}

/** query 返回值：可异步迭代的消息流，可选 interrupt。 */
export interface QueryHandle extends AsyncIterable<SdkMessage> {
  interrupt?(): Promise<void>;
  /** 追加输入到当前正在运行的一轮；provider 不支持时由 AgentRunner 回退到流式输入队列。 */
  steer?(input: SdkUserInput): Promise<void>;
  /** Change the model used by later provider responses when the transport supports it. */
  setModel?(model?: string): Promise<void>;
  /** 关闭底层 CLI / transport，不再保留会话进程。 */
  terminate?(): Promise<void>;
}

export type QueryFn = (args: {
  prompt: QueryPrompt;
  options?: QueryOptions;
}) => QueryHandle;
