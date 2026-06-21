/**
 * WebSocket 传输帧（服务端 → 前端）。命令仍走 REST（见 ClientCommand）。
 */
import type { AgentEventEnvelope, AgentSnapshot } from "./events.js";
import type { AgentCommitSnapshot } from "./commits.js";
import type { PullRequestFlowSnapshot } from "./pullRequests.js";

export type ServerFrame =
  | {
      type: "hello";
      agents: AgentSnapshot[];
      prFlows?: PullRequestFlowSnapshot[];
      commits?: AgentCommitSnapshot[];
    } // 连接建立时下发当前全部 agent / PR / commit 快照
  | { type: "event"; envelope: AgentEventEnvelope } // 实时事件
  | { type: "commit"; commit: AgentCommitSnapshot } // Agent 上报的 commit 记录
  | { type: "pr_flow"; flow: PullRequestFlowSnapshot }; // PR 流程状态
