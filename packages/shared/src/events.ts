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
  | "error"; // 出错

/** 终态：不会再自动产生新事件的状态。 */
export const TERMINAL_STATUSES: readonly AgentStatus[] = ["done", "stopped", "error"];

export function isTerminalStatus(s: AgentStatus): boolean {
  return TERMINAL_STATUSES.includes(s);
}

/** 底层 agent 驱动。未指定时保持向后兼容，默认 Claude。 */
export type AgentProvider = "claude" | "codex";

/** token 使用量（来自 SDK result.usage）。 */
export interface UsageInfo {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

/**
 * 归一化后的 agent 事件（后端 → 前端，单向流）。
 * `kind` 作为可辨识联合的判别字段。
 */
export type AgentEvent =
  | { kind: "status"; status: AgentStatus }
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
  model?: string;
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
  | { type: "send"; text: string } // 中途追加指令（流式输入干预）
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
