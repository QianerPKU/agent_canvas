import type { AgentCanvasSettings, AgentEventEnvelope, AgentSnapshot } from "./events.js";
import type {
  CanvasFileConnection,
  CanvasFileNode,
} from "./files.js";
import type {
  CanvasPromptConnection,
  CanvasPromptNode,
} from "./prompts.js";
import type { AgentCommitSnapshot } from "./commits.js";
import type { PullRequestFlowSnapshot } from "./pullRequests.js";
import type { SyncFlowSnapshot } from "./syncFlows.js";

export interface CanvasNodeLayout {
  id: string;
  type?: string;
  position: { x: number; y: number };
  width?: number;
  height?: number;
  windowState?: {
    minimized: boolean;
    restoreWidth?: number;
    restoreHeight?: number;
  };
}

export interface CanvasLayoutSnapshot {
  nodes: CanvasNodeLayout[];
  updatedAt: number;
}

export interface PersistedAgentState {
  agents: AgentSnapshot[];
  histories: Record<string, AgentEventEnvelope[]>;
  appSettings?: AgentCanvasSettings;
}

export interface PersistedFileState {
  files: CanvasFileNode[];
  connections: CanvasFileConnection[];
}

export interface PersistedPromptState {
  prompts: CanvasPromptNode[];
  connections: CanvasPromptConnection[];
}

export interface CanvasProjectState {
  version: 1;
  updatedAt: number;
  agents?: PersistedAgentState;
  files?: PersistedFileState;
  prompts?: PersistedPromptState;
  commits?: AgentCommitSnapshot[];
  prFlows?: PullRequestFlowSnapshot[];
  syncFlows?: SyncFlowSnapshot[];
  layout?: CanvasLayoutSnapshot;
}
