/**
 * Server-to-client WebSocket frames. Commands still use REST.
 */
import type { AgentCommitSnapshot } from "./commits.js";
import type { AgentEventEnvelope, AgentSnapshot } from "./events.js";
import type { CanvasFileNode } from "./files.js";
import type { PullRequestFlowSnapshot } from "./pullRequests.js";
import type { SyncFlowSnapshot } from "./syncFlows.js";
import type { WorkspaceProject } from "./workspaces.js";

export type ServerFrame =
  | {
      type: "hello";
      agents: AgentSnapshot[];
      prFlows?: PullRequestFlowSnapshot[];
      commits?: AgentCommitSnapshot[];
      syncFlows?: SyncFlowSnapshot[];
      histories?: Record<string, AgentEventEnvelope[]>;
    }
  | { type: "event"; envelope: AgentEventEnvelope }
  | { type: "commit"; commit: AgentCommitSnapshot }
  | { type: "file"; file: CanvasFileNode }
  | {
      type: "workspace";
      workspace?: WorkspaceProject;
      partialSuccess?: boolean;
      workDocumentation?: { ready: boolean; error?: string };
    }
  | { type: "pr_flow"; flow: PullRequestFlowSnapshot }
  | { type: "sync_flow"; flow: SyncFlowSnapshot };
