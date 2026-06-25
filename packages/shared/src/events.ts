/**
 * 统一事件 / 命令模型 —— 前端画布与后端控制层共用。
 *
 * 设计目标：把 Claude Agent SDK 的原始消息（system/assistant/user/result/...）
 * 归一成一组语义清晰、与具体 SDK 解耦的事件，便于前端渲染、持久化与回放。
 */

/** agent 运行状态机。 */
export type AgentStatus =
  | "idle" // 已创建，未启动
  | "starting" // 已调用 query()，等待 system init
  | "running" // 正在处理（模型输出 / 工具调用中）
  | "waiting_input" // 完成一轮，流式会话保持打开，等待用户追加指令
  | "done" // 收到最终 result，会话结束
  | "stopped" // 被用户中止
  | "terminated" // 底层 CLI / Query 已关闭
  | "error"; // 出错

/** 终态：不会再自动产生新事件的状态。 */
export const TERMINAL_STATUSES: readonly AgentStatus[] = [
  "done",
  "stopped",
  "terminated",
  "error",
];

export function isTerminalStatus(s: AgentStatus): boolean {
  return TERMINAL_STATUSES.includes(s);
}

/** 底层 agent 驱动。未指定时保持向后兼容，默认 Claude。 */
export type AgentProvider = "claude" | "codex";

/** Codex 当前在本项目 UI 中提供的模型。 */
export const CODEX_MODELS = ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"] as const;
export type CodexModel = (typeof CODEX_MODELS)[number];
export const DEFAULT_CODEX_MODEL: CodexModel = "gpt-5.5";

export function isCodexModel(model: string | undefined): model is CodexModel {
  return CODEX_MODELS.some((candidate) => candidate === model);
}

export interface AgentSettings {
  provider?: AgentProvider;
  model?: string;
  /** Branch workspace id；新工作流中由它决定 cwd。 */
  branchWorkspaceId?: string;
  /** 展示用 branch 名称，由后端根据 branchWorkspaceId 填充。 */
  branch?: string;
  cwd?: string;
  /** 当前 Agent 的临时文件目录，通常为 <worktree>/.agent-tmp/<agent-id>。 */
  scratchDirectory?: string;
  /** 当前 agent 私有的系统提示词；按提示词节点一样拼接进业务输入。 */
  systemPrompt?: string;
}

export interface CreateAgentInput extends AgentSettings {}

export interface UpdateAgentSettingsInput {
  /** 已创建 agent 可调整私有系统提示词；branch 只允许在当前最新活跃对话上切换。 */
  systemPrompt?: string;
  /** string = switch model for later responses; null = use provider default. */
  model?: string | null;
  branchWorkspaceId?: string;
  branch?: string;
  cwd?: string;
  scratchDirectory?: string;
}

/** token 使用量（来自 SDK result.usage）。 */
export interface UsageInfo {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

export type CompactTrigger = "manual" | "auto";
export type UserInputMode = "queued" | "steer";
export type AgentQuestionKind = "ask_user_question" | "mcp_elicitation";
export type AgentQuestionAction = "accept" | "decline" | "cancel";
export type AgentApprovalKind =
  | "command"
  | "file_change"
  | "permissions"
  | "tool";
export type AgentApprovalAction = "approve" | "deny" | "cancel";

export interface AgentCanvasSettings {
  /** 开启后后端直接允许所有 provider 授权请求，不再等待前端审批。 */
  fullPermissionMode: boolean;
}

export interface AgentQuestionOption {
  label: string;
  description?: string;
  preview?: string;
}

export interface AgentQuestionItem {
  id: string;
  header?: string;
  question: string;
  options?: AgentQuestionOption[];
  multiSelect?: boolean;
  isOther?: boolean;
  isSecret?: boolean;
}

export interface AgentQuestionRequest {
  requestId: string;
  kind: AgentQuestionKind;
  title?: string;
  message?: string;
  questions: AgentQuestionItem[];
  autoResolutionMs?: number | null;
  requestedSchema?: unknown;
  url?: string;
}

export interface AgentQuestionResponse {
  action?: AgentQuestionAction;
  answers?: Record<string, string | string[]>;
  response?: string;
  content?: unknown;
}

export interface AgentApprovalRequest {
  requestId: string;
  kind: AgentApprovalKind;
  title: string;
  message?: string;
  command?: string;
  cwd?: string;
  toolName?: string;
  input?: unknown;
  fileChanges?: Array<{ path: string; status?: string; summary?: string }>;
  permissions?: unknown;
  suggestions?: unknown;
  blockedPath?: string;
  raw?: unknown;
}

export interface AgentApprovalResponse {
  action: AgentApprovalAction;
  remember?: boolean;
  message?: string;
}

export interface AgentTurnContext {
  turnIndex: number;
  branch?: string;
  cwd?: string;
  baseCommitSha?: string;
  baseShortSha?: string;
}

/**
 * 归一化后的 agent 事件（后端 → 前端，单向流）。
 * `kind` 作为可辨识联合的判别字段。
 */
export type AgentEvent =
  | { kind: "status"; status: AgentStatus }
  | { kind: "user_input"; text: string; mode?: UserInputMode }
  | { kind: "turn_context"; context: AgentTurnContext }
  | { kind: "user_question"; request: AgentQuestionRequest }
  | {
      kind: "user_question_result";
      requestId: string;
      action: AgentQuestionAction;
      summary?: string;
    }
  | { kind: "user_approval"; request: AgentApprovalRequest }
  | {
      kind: "user_approval_result";
      requestId: string;
      action: AgentApprovalAction;
      summary?: string;
    }
  | {
      kind: "compact";
      trigger: CompactTrigger;
      preTokens?: number;
      postTokens?: number;
      durationMs?: number;
    }
  | {
      kind: "system_init";
      sessionId: string;
      model: string;
      cwd: string;
      tools: string[];
      permissionMode?: string;
    }
  // messageUuid = 该 assistant 消息的 uuid，作为"从此轮 fork"的锚点
  | { kind: "assistant_text"; text: string; messageUuid?: string }
  | { kind: "thinking"; text: string; messageUuid?: string }
  | { kind: "tool_use"; toolUseId: string; name: string; input: unknown; messageUuid?: string }
  | { kind: "tool_result"; toolUseId: string; isError: boolean; content: unknown }
  | {
      kind: "result";
      subtype: string;
      isError: boolean;
      costUsd?: number;
      usage?: UsageInfo;
      durationMs?: number;
      numTurns?: number;
      sessionId?: string;
      // 本轮最后一条 assistant 消息的 uuid —— 从该轮 fork 时的 resumeSessionAt 锚点
      anchorUuid?: string;
    }
  | { kind: "error"; message: string };

export type AgentEventKind = AgentEvent["kind"];

/** 传输信封：在事件外包一层 agent 归属、单调序号与时间戳，便于前端寻址与回放。 */
export interface AgentEventEnvelope {
  agentId: string;
  seq: number;
  at: number; // epoch ms
  event: AgentEvent;
}

/** 权限模式（对齐 Agent SDK 的 permissionMode）。 */
export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan";

/** 启动一个 agent 所需的配置。 */
export interface AgentStartConfig {
  /** 底层 agent 驱动：Claude SDK 或 Codex CLI/app-server。 */
  provider?: AgentProvider;
  /** 首条任务/提示词。 */
  prompt: string;
  /** 工作目录（M2 起由"区域=分支"的 worktree 决定）。 */
  cwd?: string;
  branchWorkspaceId?: string;
  branch?: string;
  scratchDirectory?: string;
  model?: string;
  /** 当前 agent 私有的系统提示词；由 AgentRunner 按提示词节点方式拼接。 */
  systemPrompt?: string;
  allowedTools?: string[];
  permissionMode?: PermissionMode;
  maxTurns?: number;
  /** 该 agent 所属画布区域（=分支）的 id，M1 仅占位、暂不驱动隔离。 */
  zoneId?: string;

  // ---- 续接 / fork（对话历史分叉）----
  /** 要恢复/分叉的源会话 id。 */
  resume?: string;
  /** 只恢复到该 assistant 消息 uuid（含）为止 —— 用于从对话中间某轮 fork。 */
  resumeSessionAt?: string;
  /** true = 恢复时分叉成新会话（与 resume 配合），而非续接原会话。 */
  forkSession?: boolean;
}

/** 一个 agent 的 fork 来源（用于前端画 fork 连线）。 */
export interface ForkOrigin {
  parentAgentId: string;
  /** 从父 agent 第几轮（assistant uuid 锚点）分叉。 */
  anchorUuid: string;
}

/** 客户端 → 服务端命令。 */
export type ClientCommand =
  | { type: "start"; config: AgentStartConfig }
  | { type: "stop" }
  | { type: "compact" }
  | { type: "terminate" }
  | { type: "send"; text: string } // 中途追加指令（流式输入干预）
  | { type: "steer"; text: string } // 尽快引导当前 in-flight turn
  | { type: "resume"; sessionId: string; text: string };

/** agent 当前快照（REST 列表 / 重连补齐用）。 */
export interface AgentSnapshot {
  id: string;
  provider?: AgentProvider;
  status: AgentStatus;
  sessionId?: string;
  config: AgentStartConfig;
  createdAt: number;
  lastEventSeq: number;
  totalCostUsd?: number;
  usage?: UsageInfo;
  /** 若该 agent 由 fork 产生，记录其来源（供前端画 fork 连线）。 */
  forkOrigin?: ForkOrigin;
}
