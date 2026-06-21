/**
 * WebSocket 传输帧（服务端 → 前端）。命令仍走 REST（见 ClientCommand）。
 */
import type { AgentEventEnvelope, AgentSnapshot } from "./events.js";
import type { PullRequestFlowSnapshot } from "./pullRequests.js";

export type ServerFrame =
  | { type: "hello"; agents: AgentSnapshot[]; prFlows?: PullRequestFlowSnapshot[] } // 连接建立时下发当前全部 agent 快照
  | { type: "event"; envelope: AgentEventEnvelope } // 实时事件
  | { type: "pr_flow"; flow: PullRequestFlowSnapshot }; // PR 流程状态
