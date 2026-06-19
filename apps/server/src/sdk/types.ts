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
export interface SdkAssistantMessage {
  type: "assistant";
  message: SdkApiMessage;
  session_id: string;
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
  | SdkAssistantMessage
  | SdkUserMessage
  | SdkResultMessage
  | SdkStreamEventMessage
  | { type: string; [k: string]: unknown };

// ---- query 的输入与函数签名（供依赖注入）----

/** 流式输入模式下推给 SDK 的用户消息。 */
export interface SdkUserInput {
  type: "user";
  message: { role: "user"; content: string | SdkContentBlock[] };
  parent_tool_use_id?: string | null;
  session_id?: string;
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
  abortController?: AbortController;
  [k: string]: unknown;
}

/** query 返回值：可异步迭代的消息流，可选 interrupt。 */
export interface QueryHandle extends AsyncIterable<SdkMessage> {
  interrupt?(): Promise<void>;
}

export type QueryFn = (args: {
  prompt: QueryPrompt;
  options?: QueryOptions;
}) => QueryHandle;
