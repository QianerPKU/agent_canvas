import { useCallback, useEffect, useRef, useState } from "react";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  SelectionMode,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type ReactFlowInstance,
} from "@xyflow/react";
import {
  FilePlus2,
  FolderOpen,
  GitBranch,
  GitPullRequest,
  Link,
  Hand,
  MessageSquarePlus,
  MousePointer2,
  Plus,
  Settings,
  Trash2,
  X,
} from "lucide-react";
import {
  api,
  type CanvasProjectOpenResult,
  type WorkDocumentationMutationStatus,
} from "./api.js";
import {
  CODEX_MODELS,
  CODEX_REASONING_EFFORTS,
  DEFAULT_CODEX_MODEL,
} from "@agent-canvas/shared";
import type {
  AgentCanvasSettings,
  AgentCanvasConfig,
  AgentCommitSnapshot,
  BranchOption,
  BranchWorkspace,
  CanvasLayoutSnapshot,
  CanvasNodeLayout,
  CanvasProjectSummary,
  CanvasFileConnection,
  CanvasFileNode,
  CanvasPromptConnection,
  CanvasPromptNode,
  CodexUsageSnapshot,
  WorkspaceProject,
  PullRequestFlowSnapshot,
  SyncFlowSnapshot,
} from "@agent-canvas/shared";
import "@xyflow/react/dist/style.css";
import {
  useAgentCanvas,
  workspaceEventIdentity,
  type AgentActions,
  type FileActions,
} from "./useAgentCanvas.js";
import { TurnNode, type TurnNodeType } from "./nodes/TurnNode.js";
import type { AgentMap } from "./agentStore.js";
import {
  ConversationHistoryWindow,
  type HistoryTarget,
} from "./history/ConversationHistoryWindow.js";
import { CreateFileDialog } from "./files/CreateFileDialog.js";
import { FileNode, type FileNodeType } from "./files/FileNode.js";
import { FileContentWindow } from "./files/FileContentWindow.js";
import { AgentSettingsDialog } from "./agents/AgentSettingsDialog.js";
import { CreatePromptDialog } from "./prompts/CreatePromptDialog.js";
import { PromptNode, type PromptNodeType } from "./prompts/PromptNode.js";
import { PullRequestDialog } from "./pullRequests/PullRequestDialog.js";
import {
  PullRequestNode,
  type PullRequestNodeType,
} from "./pullRequests/PullRequestNode.js";
import { PullRequestDetailsWindow } from "./pullRequests/PullRequestDetailsWindow.js";
import { CommitNode, type CommitNodeType } from "./commits/CommitNode.js";
import { CommitDetailsWindow } from "./commits/CommitDetailsWindow.js";
import { SyncFlowDialog } from "./sync/SyncFlowDialog.js";
import { SyncFlowNode, type SyncFlowNodeType } from "./sync/SyncFlowNode.js";
import { SyncFlowDetailsWindow } from "./sync/SyncFlowDetailsWindow.js";
import type { PromptActions } from "./useAgentCanvas.js";
import {
  COMMIT_NODE_DIMENSIONS,
  FILE_NODE_DIMENSIONS,
  PROMPT_NODE_DIMENSIONS,
  PULL_REQUEST_NODE_DIMENSIONS,
  SYNC_FLOW_NODE_DIMENSIONS,
  TURN_NODE_DIMENSIONS,
} from "./nodeDimensions.js";

const nodeTypes = {
  turn: TurnNode,
  file: FileNode,
  prompt: PromptNode,
  commit: CommitNode,
  pullRequest: PullRequestNode,
  syncFlow: SyncFlowNode,
};

const COL_W = 760;
const ROW_H = 360;
const DEFAULT_NODE_WIDTH = TURN_NODE_DIMENSIONS.width;
const DEFAULT_NODE_HEIGHT = TURN_NODE_DIMENSIONS.height;
const FILE_NODE_WIDTH = FILE_NODE_DIMENSIONS.width;
const FILE_NODE_HEIGHT = FILE_NODE_DIMENSIONS.height;
const PROMPT_NODE_WIDTH = PROMPT_NODE_DIMENSIONS.width;
const PROMPT_NODE_HEIGHT = PROMPT_NODE_DIMENSIONS.height;
const COMMIT_NODE_WIDTH = COMMIT_NODE_DIMENSIONS.width;
const COMMIT_NODE_HEIGHT = COMMIT_NODE_DIMENSIONS.height;
const PR_NODE_WIDTH = PULL_REQUEST_NODE_DIMENSIONS.width;
const PR_NODE_HEIGHT = PULL_REQUEST_NODE_DIMENSIONS.height;
const SYNC_NODE_WIDTH = SYNC_FLOW_NODE_DIMENSIONS.width;
const SYNC_NODE_HEIGHT = SYNC_FLOW_NODE_DIMENSIONS.height;
const FILE_ROW_H = FILE_NODE_HEIGHT + 20;
const PROMPT_ROW_H = PROMPT_NODE_HEIGHT + 20;
type CanvasTool = "select" | "hand";

export function canvasInteractionForTool(tool: CanvasTool): {
  panOnDrag: number[];
  selectionOnDrag: boolean;
  selectionMode: SelectionMode;
} {
  return {
    panOnDrag: tool === "hand" ? [0, 1] : [1],
    selectionOnDrag: tool === "select",
    selectionMode: SelectionMode.Partial,
  };
}

export function workDocumentationMutationWarning(
  result: WorkDocumentationMutationStatus,
): string | undefined {
  if (!result.partialSuccess || result.workDocumentation?.ready !== false) return undefined;
  const detail = result.workDocumentation.error?.trim() || "unknown error";
  return `操作已完成，但工作文档初始化失败：${detail}`;
}

export function adoptOpenedProject(
  result: CanvasProjectOpenResult,
  setters: {
    setWorkspace: (workspace: WorkspaceProject) => void;
    setLayoutProjectId: (projectId: string | undefined) => void;
    setProjectError: (error: string | undefined) => void;
  },
): void {
  setters.setWorkspace(result);
  setters.setLayoutProjectId(result.canvasProject?.id);
  setters.setProjectError(workDocumentationMutationWarning(result));
}

export async function resolveCurrentProjectOpenStep<T>(
  operation: Promise<T>,
  isCurrent: () => boolean,
): Promise<T | undefined> {
  const result = await operation;
  return isCurrent() ? result : undefined;
}

export interface ProjectOperationOwnership {
  token: number;
  workspaceEventGeneration: number;
}

export function ownsProjectOperation(
  ownership: ProjectOperationOwnership,
  currentToken: number,
  currentWorkspaceEventGeneration: number,
  currentWorkspaceIdentity?: string,
  expectedWorkspaceIdentity?: string,
): boolean {
  if (ownership.token !== currentToken) return false;
  if (ownership.workspaceEventGeneration === currentWorkspaceEventGeneration) return true;
  return (
    expectedWorkspaceIdentity !== undefined &&
    expectedWorkspaceIdentity === currentWorkspaceIdentity
  );
}

export function isCurrentWorkspaceUpdate(
  workspace: WorkspaceProject | undefined,
  currentWorkspaceIdentity: string | undefined,
): boolean {
  return workspaceEventIdentity(workspace) === currentWorkspaceIdentity;
}

export function adoptDeletedCurrentProject(
  deletedProjectId: string,
  currentWorkspace: WorkspaceProject | undefined,
  setters: {
    setWorkspace: (workspace: WorkspaceProject | undefined) => void;
    setLayoutProjectId: (projectId: string | undefined) => void;
    setProjectError: (error: string | undefined) => void;
  },
): boolean {
  if (currentWorkspace?.canvasProject?.id !== deletedProjectId) return false;
  setters.setWorkspace(undefined);
  setters.setLayoutProjectId(undefined);
  setters.setProjectError(undefined);
  return true;
}

export function isSameBranchWorkspace(
  left: BranchWorkspace,
  right: BranchWorkspace,
): boolean {
  return (
    left.id === right.id &&
    left.repoId === right.repoId &&
    left.branch === right.branch &&
    left.worktreePath === right.worktreePath
  );
}
const X0 = 40;
const Y0 = 40;
const NODE_GAP = 36;
const TURN_VERTICAL_GAP = 24;

type CanvasNode =
  | TurnNodeType
  | FileNodeType
  | PromptNodeType
  | CommitNodeType
  | PullRequestNodeType
  | SyncFlowNodeType;
type AgentSettingsTarget =
  | { mode: "create" }
  | { mode: "edit"; agentId: string };
type NodePosition = { x: number; y: number };
type NodePlacementOverrides = Record<string, NodePosition>;

function nodeId(agentId: string, turnIndex: number): string {
  return `${agentId}#${turnIndex}`;
}

function fileNodeId(fileId: string): string {
  return `file:${fileId}`;
}

function promptNodeId(promptId: string): string {
  return `prompt:${promptId}`;
}

function commitNodeId(commitId: string): string {
  return `commit:${commitId}`;
}

function pullRequestNodeId(flowId: string): string {
  return `pr:${flowId}`;
}

function syncFlowNodeId(flowId: string): string {
  return `sync:${flowId}`;
}

function fallbackSize(node: CanvasNode): { width: number; height: number } {
  switch (node.type) {
    case "file":
      return { width: FILE_NODE_WIDTH, height: FILE_NODE_HEIGHT };
    case "prompt":
      return { width: PROMPT_NODE_WIDTH, height: PROMPT_NODE_HEIGHT };
    case "commit":
      return { width: COMMIT_NODE_WIDTH, height: COMMIT_NODE_HEIGHT };
    case "pullRequest":
      return { width: PR_NODE_WIDTH, height: PR_NODE_HEIGHT };
    case "syncFlow":
      return { width: SYNC_NODE_WIDTH, height: SYNC_NODE_HEIGHT };
    case "turn":
    default:
      return { width: DEFAULT_NODE_WIDTH, height: DEFAULT_NODE_HEIGHT };
  }
}

function nodeWidth(node: CanvasNode): number {
  return node.width ?? node.measured?.width ?? fallbackSize(node).width;
}

function nodeHeight(node: CanvasNode): number {
  return node.height ?? node.measured?.height ?? fallbackSize(node).height;
}

function nodeWindowState(node: CanvasNode): CanvasNodeLayout["windowState"] {
  switch (node.type) {
    case "turn":
    case "file":
    case "prompt":
    case "commit":
    case "pullRequest":
    case "syncFlow":
      return node.data.windowState;
    default:
      return undefined;
  }
}

export function centeredNodePosition(
  center: NodePosition,
  width: number,
  height: number,
): NodePosition {
  return {
    x: center.x - width / 2,
    y: center.y - height / 2,
  };
}

export function centeredNodePositionInViewport(
  bounds: Pick<DOMRect, "left" | "top" | "width" | "height">,
  screenToFlowPosition: (position: NodePosition) => NodePosition,
  width: number,
  height: number,
): NodePosition {
  const center = screenToFlowPosition({
    x: bounds.left + bounds.width / 2,
    y: bounds.top + bounds.height / 2,
  });
  return centeredNodePosition(center, width, height);
}

function positionsMatch(left: NodePosition, right: NodePosition): boolean {
  return left.x === right.x && left.y === right.y;
}

export function canvasLayoutFromNodes(
  nodes: CanvasNode[],
  updatedAt = Date.now(),
): CanvasLayoutSnapshot {
  return {
    updatedAt,
    nodes: nodes.map((node) => ({
      id: node.id,
      type: node.type,
      position: node.position,
      width: node.width ?? node.measured?.width,
      height: node.height ?? node.measured?.height,
      windowState: nodeWindowState(node),
    })),
  };
}

export function canvasLayoutAutosaveReady(
  currentProjectId: string | undefined,
  layoutProjectId: string | undefined,
  layoutReadyProjectId: string | undefined,
): boolean {
  return (
    currentProjectId !== undefined &&
    currentProjectId === layoutProjectId &&
    currentProjectId === layoutReadyProjectId
  );
}

function layoutById(layout: CanvasNodeLayout[]): Map<string, CanvasNodeLayout> {
  return new Map(layout.map((node) => [node.id, node]));
}

function storedLayoutFor(
  layouts: Map<string, CanvasNodeLayout>,
  id: string,
  type: string,
): CanvasNodeLayout | undefined {
  const layout = layouts.get(id);
  if (!layout) return undefined;
  return layout.type === undefined || layout.type === type ? layout : undefined;
}

function turnPosition(
  id: string,
  viewId: string,
  index: number,
  layout: Record<string, NodePosition>,
  placed: Map<string, CanvasNode>,
): NodePosition {
  if (index === 0) return layout[id] ?? { x: X0, y: Y0 };
  const previous = placed.get(nodeId(viewId, index - 1));
  if (!previous) return layout[id] ?? { x: X0, y: Y0 + index * ROW_H };
  const preferred = {
    x: previous.position.x,
    y: previous.position.y + nodeHeight(previous) + TURN_VERTICAL_GAP,
  };
  return preferred;
}

function anchoredSidePosition(
  source: CanvasNode | undefined,
  fallback: NodePosition,
): NodePosition {
  if (!source) return fallback;
  const sourceWidth =
    source.type === "turn"
      ? Math.max(
          nodeWidth(source),
          source.data.windowState?.restoreWidth ?? DEFAULT_NODE_WIDTH,
          DEFAULT_NODE_WIDTH,
        )
      : nodeWidth(source);
  return {
    x: source.position.x + sourceWidth + NODE_GAP,
    y: source.position.y,
  };
}

function autoTurnWindowState(
  existingTurn: TurnNodeType | undefined,
  turnStatus: TurnNodeType["data"]["turn"]["status"],
  isLatest: boolean,
  keepExpandedByDefault: boolean,
  storedState?: CanvasNodeLayout["windowState"],
): TurnNodeType["data"]["windowState"] {
  const existingState = existingTurn?.data.windowState ?? storedState;
  if (existingState) return existingState;
  if (isLatest || keepExpandedByDefault || turnStatus === "idle") return undefined;
  return {
    minimized: true,
    restoreWidth: existingTurn?.width ?? existingTurn?.measured?.width ?? DEFAULT_NODE_WIDTH,
    restoreHeight: existingTurn?.height ?? existingTurn?.measured?.height ?? DEFAULT_NODE_HEIGHT,
  };
}

function turnWidth(windowState: TurnNodeType["data"]["windowState"]): number {
  return windowState?.minimized
    ? TURN_NODE_DIMENSIONS.minimizedWidth
    : DEFAULT_NODE_WIDTH;
}

function turnHeight(windowState: TurnNodeType["data"]["windowState"]): number {
  return windowState?.minimized
    ? TURN_NODE_DIMENSIONS.minimizedHeight
    : DEFAULT_NODE_HEIGHT;
}

function anchorIndex(agents: AgentMap, parentId: string, anchorUuid: string): number {
  const parent = agents[parentId];
  if (!parent) return -1;
  return parent.turns.findIndex((turn) => turn.anchorUuid === anchorUuid);
}

export function computeLayout(agents: AgentMap): Record<string, { x: number; y: number }> {
  const positions: Record<string, { x: number; y: number }> = {};
  const baseY: Record<string, number> = {};
  let column = 0;
  for (const view of Object.values(agents)) {
    const currentColumn = column++;
    let y = 0;
    if (view.forkOrigin) {
      const parentBase = baseY[view.forkOrigin.parentAgentId] ?? 0;
      const index = anchorIndex(
        agents,
        view.forkOrigin.parentAgentId,
        view.forkOrigin.anchorUuid,
      );
      y = parentBase + (index >= 0 ? index : 0) * ROW_H;
    }
    baseY[view.id] = y;
    view.turns.forEach((_, index) => {
      positions[nodeId(view.id, index)] = {
        x: X0 + currentColumn * COL_W,
        y: Y0 + y + index * ROW_H,
      };
    });
  }
  return positions;
}

function computeConversationEdges(agents: AgentMap): Edge[] {
  const edges: Edge[] = [];
  for (const view of Object.values(agents)) {
    for (let index = 1; index < view.turns.length; index++) {
      edges.push({
        id: `${view.id}#${index - 1}->${index}`,
        source: nodeId(view.id, index - 1),
        target: nodeId(view.id, index),
        deletable: false,
      });
    }
    if (view.forkOrigin) {
      const index = anchorIndex(
        agents,
        view.forkOrigin.parentAgentId,
        view.forkOrigin.anchorUuid,
      );
      if (index >= 0) {
        edges.push({
          id: `fork->${view.id}`,
          source: nodeId(view.forkOrigin.parentAgentId, index),
          sourceHandle: "fork",
          target: nodeId(view.id, 0),
          animated: true,
          label: "fork",
          style: { stroke: "#7c3aed" },
          deletable: false,
        });
      }
    }
  }
  return edges;
}

export function computeFileEdges(
  agents: AgentMap,
  connections: CanvasFileConnection[],
): Edge[] {
  const edges: Edge[] = [];
  for (const connection of connections) {
    const agent = agents[connection.agentId];
    if (!agent || !canUseResourceConnections(agent)) continue;
    const activeTurnId = nodeId(agent.id, agent.turns.length - 1);
    if (connection.access === "read") {
      edges.push({
        id: connection.id,
        source: fileNodeId(connection.fileId),
        sourceHandle: "read",
        target: activeTurnId,
        targetHandle: "resource-read",
        animated: true,
        style: { stroke: "#0f766e" },
      });
      continue;
    }
    edges.push({
      id: connection.id,
      source: activeTurnId,
      sourceHandle: "resource-write",
      target: fileNodeId(connection.fileId),
      targetHandle: "write",
      animated: true,
      style: { stroke: "#b45309" },
    });
  }
  return edges;
}

export function computeResultFileEdges(
  agents: AgentMap,
  files: CanvasFileNode[],
): Edge[] {
  const edges: Edge[] = [];
  for (const file of files) {
    if (file.origin?.kind !== "agent_result") continue;
    const source = fixedTurnNodeId(
      agents,
      file.origin.agentId,
      file.origin.sourceTurnIndex,
    );
    if (!source) continue;
    edges.push({
      id: `result-file-edge:${file.id}`,
      source,
      target: fileNodeId(file.id),
      animated: false,
      style: { stroke: "#2563eb" },
      label: "result",
      deletable: false,
    });
  }
  return edges;
}

export function computePromptEdges(
  agents: AgentMap,
  connections: CanvasPromptConnection[],
): Edge[] {
  const edges: Edge[] = [];
  for (const connection of connections) {
    const agent = agents[connection.agentId];
    if (!agent || !canUseResourceConnections(agent)) continue;
    const activeTurnId = nodeId(agent.id, agent.turns.length - 1);
    if (connection.access === "read") {
      edges.push({
        id: connection.id,
        source: promptNodeId(connection.promptId),
        sourceHandle: "read",
        target: activeTurnId,
        targetHandle: "resource-read",
        animated: true,
        style: { stroke: "#7c3aed" },
      });
      continue;
    }
    edges.push({
      id: connection.id,
      source: activeTurnId,
      sourceHandle: "resource-write",
      target: promptNodeId(connection.promptId),
      targetHandle: "write",
      animated: true,
      style: { stroke: "#a21caf" },
    });
  }
  return edges;
}

function canUseResourceConnections(agent: AgentMap[string]): boolean {
  if (agent.status === "done" || agent.status === "error") return false;
  if (agent.status !== "stopped" && agent.status !== "terminated") return true;
  return agent.turns.at(-1)?.status === "idle";
}

export function computeCommitEdges(
  agents: AgentMap,
  commits: AgentCommitSnapshot[],
): Edge[] {
  const edges: Edge[] = [];
  for (const commit of commits) {
    const source = fixedTurnNodeId(agents, commit.agentId, commit.sourceTurnIndex);
    if (!source) continue;
    edges.push({
      id: `commit-edge:${commit.id}`,
      source,
      target: commitNodeId(commit.id),
      animated: false,
      style: { stroke: "#0f766e" },
      label: "commit",
      deletable: false,
    });
  }
  return edges;
}

export function computePullRequestEdges(
  agents: AgentMap,
  flows: PullRequestFlowSnapshot[],
): Edge[] {
  const edges: Edge[] = [];
  for (const flow of flows) {
    const source = fixedTurnNodeId(agents, flow.proposerAgentId, flow.sourceTurnIndex);
    if (!source) continue;
    edges.push({
      id: `pr-edge:${flow.id}`,
      source,
      target: pullRequestNodeId(flow.id),
      animated: !isClosedPrStatus(flow.status),
      style: { stroke: "#7c3aed" },
      label: "PR",
      deletable: false,
    });
  }
  return edges;
}

export function computeSyncFlowEdges(
  agents: AgentMap,
  flows: SyncFlowSnapshot[],
): Edge[] {
  const edges: Edge[] = [];
  for (const flow of flows) {
    const source = fixedTurnNodeId(agents, flow.proposerAgentId, flow.sourceTurnIndex);
    if (!source) continue;
    edges.push({
      id: `sync-edge:${flow.id}`,
      source,
      target: syncFlowNodeId(flow.id),
      animated: !isClosedSyncStatus(flow.status),
      style: { stroke: "#0891b2" },
      label: flow.kind === "cherry_pick" ? "pick" : "pull",
      deletable: false,
    });
  }
  return edges;
}

function fixedTurnNodeId(
  agents: AgentMap,
  agentId: string,
  turnIndex: number | undefined,
): string | undefined {
  const agent = agents[agentId];
  if (!agent) return undefined;
  const index = turnIndex ?? agent.turns.length - 1;
  return agent.turns[index] ? nodeId(agentId, index) : undefined;
}

function isClosedPrStatus(status: PullRequestFlowSnapshot["status"]): boolean {
  return [
    "source_review_failed",
    "target_review_failed",
    "merged",
    "timed_out",
    "cancelled",
    "blocked",
  ].includes(status);
}

function isClosedSyncStatus(status: SyncFlowSnapshot["status"]): boolean {
  return ["review_failed", "applied", "timed_out", "cancelled", "blocked"].includes(status);
}

export function buildNodes(
  agents: AgentMap,
  files: CanvasFileNode[],
  prompts: CanvasPromptNode[],
  commits: AgentCommitSnapshot[],
  prFlows: PullRequestFlowSnapshot[],
  syncFlows: SyncFlowSnapshot[],
  actions: AgentActions,
  fileActions: FileActions,
  promptActions: PromptActions,
  current: CanvasNode[],
  onOpenHistory: (agentId: string, turnIndex: number) => void,
  onOpenAgentSettings: (agentId: string) => void,
  onPreviewFile: (fileId: string) => void,
  onOpenFileEditor: (fileId: string) => void,
  onOpenCommitDetails: (commitId: string) => void,
  onOpenPullRequestDetails: (flowId: string) => void,
  onOpenSyncFlowDetails: (flowId: string) => void,
  savedLayout: CanvasNodeLayout[] = [],
  placementOverrides: NodePlacementOverrides = {},
  branches: BranchOption[] = [],
  codexModels: readonly string[] = CODEX_MODELS,
  defaultCodexModel: string = DEFAULT_CODEX_MODEL,
  codexReasoningEfforts: readonly string[] = CODEX_REASONING_EFFORTS,
  codexModelCapabilities: AgentCanvasConfig["codexModelCapabilities"] = [],
  onCreateBranch?: (branch: string, baseBranch?: string) => Promise<BranchWorkspace>,
): CanvasNode[] {
  const layout = computeLayout(agents);
  const byId = new Map(current.map((node) => [node.id, node]));
  const savedById = layoutById(savedLayout);
  const result: CanvasNode[] = [];
  const placed = new Map<string, CanvasNode>();
  const pushNode = (node: CanvasNode) => {
    result.push(node);
    placed.set(node.id, node);
  };

  for (const view of Object.values(agents)) {
    view.turns.forEach((turn, index) => {
      const id = nodeId(view.id, index);
      const placement =
        index === 0 && !view.forkOrigin ? placementOverrides[id] : undefined;
      const existing = byId.get(id);
      const existingTurn = existing?.type === "turn" ? existing : undefined;
      const stored = storedLayoutFor(savedById, id, "turn");
      const isLatest = index === view.turns.length - 1;
      const keepExpandedByDefault = index >= view.turns.length - 2;
      const windowState = autoTurnWindowState(
        existingTurn,
        turn.status,
        isLatest,
        keepExpandedByDefault,
        stored?.windowState,
      );
      const data = {
        agentId: view.id,
        turn,
        agentStatus: view.status,
        agentBranch: view.branch,
        agentCwd: view.cwd,
        provider: view.provider,
        model: view.model,
        reasoningEffort: view.reasoningEffort,
        providerLocked: !!view.forkOrigin,
        isLatest,
        windowState,
        onOpenHistory,
        onOpenSettings: isLatest ? onOpenAgentSettings : undefined,
        branches,
        codexModels,
        defaultCodexModel,
        codexReasoningEfforts,
        codexModelCapabilities,
        onCreateBranch,
        actions,
      };
      if (existingTurn) {
        pushNode({
          ...existingTurn,
          position: placement ?? existingTurn.position,
          width: windowState?.minimized
            ? TURN_NODE_DIMENSIONS.minimizedWidth
            : existingTurn.width,
          height: windowState?.minimized
            ? TURN_NODE_DIMENSIONS.minimizedHeight
            : existingTurn.height,
          data,
        });
      } else {
        const width = stored?.width ?? turnWidth(windowState);
        const height = stored?.height ?? turnHeight(windowState);
        const forkAnchorIndex =
          index === 0 && view.forkOrigin
            ? anchorIndex(
                agents,
                view.forkOrigin.parentAgentId,
                view.forkOrigin.anchorUuid,
              )
            : -1;
        const forkAnchorId =
          forkAnchorIndex >= 0 && view.forkOrigin
            ? nodeId(view.forkOrigin.parentAgentId, forkAnchorIndex)
            : undefined;
        const forkAnchorNode = forkAnchorId
          ? placed.get(forkAnchorId) ?? byId.get(forkAnchorId)
          : undefined;
        const fallbackPosition =
          index === 0 && forkAnchorNode
            ? anchoredSidePosition(
                forkAnchorNode,
                layout[id] ?? { x: X0, y: Y0 },
              )
            : turnPosition(id, view.id, index, layout, placed);
        pushNode({
          id,
          type: "turn",
          position: placement ?? stored?.position ?? fallbackPosition,
          width,
          height,
          dragHandle: ".drag-handle",
          data,
        });
      }
    });
  }

  const fileX = X0 + Math.max(Object.keys(agents).length, 1) * COL_W;
  files.forEach((file, index) => {
    const id = fileNodeId(file.id);
    const placement = file.origin ? undefined : placementOverrides[id];
    const existing = byId.get(id);
    const existingFile = existing?.type === "file" ? existing : undefined;
    const stored = storedLayoutFor(savedById, id, "file");
    const windowState = existingFile?.data.windowState ?? stored?.windowState;
    const source =
      file.origin?.kind === "agent_result"
        ? fixedTurnNodeId(agents, file.origin.agentId, file.origin.sourceTurnIndex)
        : undefined;
    const sourceNode = source ? placed.get(source) ?? byId.get(source) : undefined;
    const data = {
      file,
      actions: fileActions,
      onPreview: onPreviewFile,
      onOpenEditor: onOpenFileEditor,
      windowState,
    };
    pushNode(
      existingFile
        ? {
            ...existingFile,
            position: placement ?? existingFile.position,
            data,
          }
        : {
            id,
            type: "file",
            position:
              placement ??
              stored?.position ??
              anchoredSidePosition(sourceNode, {
                x: fileX,
                y: Y0 + index * FILE_ROW_H,
              }),
            width:
              stored?.width ??
              (windowState?.minimized
                ? FILE_NODE_DIMENSIONS.minimizedWidth
                : FILE_NODE_WIDTH),
            height:
              stored?.height ??
              (windowState?.minimized
                ? FILE_NODE_DIMENSIONS.minimizedHeight
                : FILE_NODE_HEIGHT),
            dragHandle: ".drag-handle",
            data,
          },
    );
  });

  const promptX = fileX + 340;
  prompts.forEach((prompt, index) => {
    const id = promptNodeId(prompt.id);
    const placement = placementOverrides[id];
    const existing = byId.get(id);
    const existingPrompt = existing?.type === "prompt" ? existing : undefined;
    const stored = storedLayoutFor(savedById, id, "prompt");
    const windowState = existingPrompt?.data.windowState ?? stored?.windowState;
    const data = {
      prompt,
      actions: promptActions,
      windowState,
    };
    pushNode(
      existingPrompt
        ? {
            ...existingPrompt,
            position: placement ?? existingPrompt.position,
            data,
          }
        : {
            id,
            type: "prompt",
            position:
              placement ?? stored?.position ?? { x: promptX, y: Y0 + index * PROMPT_ROW_H },
            width:
              stored?.width ??
              (windowState?.minimized
                ? PROMPT_NODE_DIMENSIONS.minimizedWidth
                : PROMPT_NODE_WIDTH),
            height:
              stored?.height ??
              (windowState?.minimized
                ? PROMPT_NODE_DIMENSIONS.minimizedHeight
                : PROMPT_NODE_HEIGHT),
            dragHandle: ".drag-handle",
            data,
          },
    );
  });

  const commitX = promptX + 360;
  commits.forEach((commit, index) => {
    const id = commitNodeId(commit.id);
    const existing = byId.get(id);
    const existingCommit = existing?.type === "commit" ? existing : undefined;
    const stored = storedLayoutFor(savedById, id, "commit");
    const windowState = existingCommit?.data.windowState ?? stored?.windowState;
    const data = {
      commit,
      onOpenDetails: onOpenCommitDetails,
      windowState,
    };
    const source = fixedTurnNodeId(agents, commit.agentId, commit.sourceTurnIndex);
    pushNode(
      existingCommit
        ? { ...existingCommit, data }
        : {
            id,
            type: "commit",
            position:
              stored?.position ??
              anchoredSidePosition(
                source ? placed.get(source) ?? byId.get(source) : undefined,
                { x: commitX, y: Y0 + index * 210 },
              ),
            width:
              stored?.width ??
              (windowState?.minimized
                ? COMMIT_NODE_DIMENSIONS.minimizedWidth
                : COMMIT_NODE_WIDTH),
            height:
              stored?.height ??
              (windowState?.minimized
                ? COMMIT_NODE_DIMENSIONS.minimizedHeight
                : COMMIT_NODE_HEIGHT),
            dragHandle: ".drag-handle",
            data,
          },
    );
  });

  const prX = commitX + 330;
  prFlows.forEach((flow, index) => {
    const id = pullRequestNodeId(flow.id);
    const existing = byId.get(id);
    const existingPr = existing?.type === "pullRequest" ? existing : undefined;
    const stored = storedLayoutFor(savedById, id, "pullRequest");
    const windowState = existingPr?.data.windowState ?? stored?.windowState;
    const data = {
      flow,
      onOpenDetails: onOpenPullRequestDetails,
      windowState,
    };
    const source = fixedTurnNodeId(agents, flow.proposerAgentId, flow.sourceTurnIndex);
    pushNode(
      existingPr
        ? { ...existingPr, data }
        : {
            id,
            type: "pullRequest",
            position:
              stored?.position ??
              anchoredSidePosition(
                source ? placed.get(source) ?? byId.get(source) : undefined,
                { x: prX, y: Y0 + index * 220 },
              ),
            width:
              stored?.width ??
              (windowState?.minimized
                ? PULL_REQUEST_NODE_DIMENSIONS.minimizedWidth
                : PR_NODE_WIDTH),
            height:
              stored?.height ??
              (windowState?.minimized
                ? PULL_REQUEST_NODE_DIMENSIONS.minimizedHeight
                : PR_NODE_HEIGHT),
            dragHandle: ".drag-handle",
            data,
          },
    );
  });

  const syncX = prX + 350;
  syncFlows.forEach((flow, index) => {
    const id = syncFlowNodeId(flow.id);
    const existing = byId.get(id);
    const existingSync = existing?.type === "syncFlow" ? existing : undefined;
    const stored = storedLayoutFor(savedById, id, "syncFlow");
    const windowState = existingSync?.data.windowState ?? stored?.windowState;
    const data = {
      flow,
      onOpenDetails: onOpenSyncFlowDetails,
      windowState,
    };
    const source = fixedTurnNodeId(agents, flow.proposerAgentId, flow.sourceTurnIndex);
    pushNode(
      existingSync
        ? { ...existingSync, data }
        : {
            id,
            type: "syncFlow",
            position:
              stored?.position ??
              anchoredSidePosition(
                source ? placed.get(source) ?? byId.get(source) : undefined,
                { x: syncX, y: Y0 + index * 220 },
              ),
            width:
              stored?.width ??
              (windowState?.minimized
                ? SYNC_FLOW_NODE_DIMENSIONS.minimizedWidth
                : SYNC_NODE_WIDTH),
            height:
              stored?.height ??
              (windowState?.minimized
                ? SYNC_FLOW_NODE_DIMENSIONS.minimizedHeight
                : SYNC_NODE_HEIGHT),
            dragHandle: ".drag-handle",
            data,
          },
    );
  });
  return result;
}

export default function App(): React.ReactElement {
  const {
    agents,
    files,
    fileConnections,
    prompts,
    promptConnections,
    prFlows,
    syncFlows,
    commits,
    workspaceUpdate,
    currentWorkspaceEventGeneration,
    currentWorkspaceEventIdentity,
    invalidateWorkspaceRefresh,
    connected,
    refresh,
    actions,
    fileActions,
    promptActions,
    prActions,
    syncActions,
  } = useAgentCanvas();
  const flowRef = useRef<ReactFlowInstance<CanvasNode, Edge> | null>(null);
  const canvasWrapRef = useRef<HTMLDivElement | null>(null);
  const projectOperationInvocationRef = useRef(0);
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [savedLayout, setSavedLayout] = useState<CanvasLayoutSnapshot>({
    nodes: [],
    updatedAt: 0,
  });
  const [layoutProjectId, setLayoutProjectId] = useState<string>();
  const [layoutReadyProjectId, setLayoutReadyProjectId] = useState<string>();
  const layoutReadyProjectIdRef = useRef<string>();
  const [historyTarget, setHistoryTarget] = useState<HistoryTarget>();
  const [openFileId, setOpenFileId] = useState<string>();
  const [fileOpenError, setFileOpenError] = useState<string>();
  const [creatingFile, setCreatingFile] = useState(false);
  const [creatingPrompt, setCreatingPrompt] = useState(false);
  const [showingPullRequests, setShowingPullRequests] = useState(false);
  const [showingSyncFlows, setShowingSyncFlows] = useState(false);
  const [showingSettings, setShowingSettings] = useState(false);
  const [openCommitId, setOpenCommitId] = useState<string>();
  const [openPullRequestId, setOpenPullRequestId] = useState<string>();
  const [openSyncFlowId, setOpenSyncFlowId] = useState<string>();
  const [appSettings, setAppSettings] = useState<AgentCanvasSettings>({
    fullPermissionMode: false,
    workDocumentationEnabled: false,
  });
  const [codexUsage, setCodexUsage] = useState<CodexUsageSnapshot>();
  const [codexUsageError, setCodexUsageError] = useState<string>();
  const [serverConfig, setServerConfig] = useState<AgentCanvasConfig>({
    defaultCwd: "",
    projectRoot: "",
    codexModels: [...CODEX_MODELS],
    defaultCodexModel: DEFAULT_CODEX_MODEL,
    codexReasoningEfforts: [...CODEX_REASONING_EFFORTS],
    codexModelCapabilities: [],
  });
  const [agentSettingsTarget, setAgentSettingsTarget] = useState<AgentSettingsTarget>();
  const [projects, setProjects] = useState<CanvasProjectSummary[]>([]);
  const [workspace, setWorkspace] = useState<WorkspaceProject>();
  const workspaceRef = useRef<WorkspaceProject>();
  workspaceRef.current = workspace;
  const [projectError, setProjectError] = useState<string>();
  const [branches, setBranches] = useState<BranchOption[]>([]);
  const [pendingPlacements, setPendingPlacements] = useState<NodePlacementOverrides>({});
  const [canvasTool, setCanvasTool] = useState<CanvasTool>("hand");
  const openFile = files.find((file) => file.id === openFileId);
  const openCommit = commits.find((commit) => commit.id === openCommitId);
  const openPullRequest = prFlows.find((flow) => flow.id === openPullRequestId);
  const openSyncFlow = syncFlows.find((flow) => flow.id === openSyncFlowId);
  const settingsAgent =
    agentSettingsTarget?.mode === "edit" ? agents[agentSettingsTarget.agentId] : undefined;

  const updateLayoutReadyProjectId = useCallback((projectId: string | undefined) => {
    layoutReadyProjectIdRef.current = projectId;
    setLayoutReadyProjectId(projectId);
  }, []);

  const clearProjectScopedUi = useCallback(() => {
    updateLayoutReadyProjectId(undefined);
    setNodes([]);
    setEdges([]);
    setPendingPlacements({});
    setBranches([]);
    setHistoryTarget(undefined);
    setOpenFileId(undefined);
    setOpenCommitId(undefined);
    setOpenPullRequestId(undefined);
    setOpenSyncFlowId(undefined);
    setAgentSettingsTarget(undefined);
    setCreatingFile(false);
    setCreatingPrompt(false);
    setShowingPullRequests(false);
    setShowingSyncFlows(false);
    setShowingSettings(false);
    setFileOpenError(undefined);
  }, [setEdges, setNodes, updateLayoutReadyProjectId]);

  const captureViewportPlacement = useCallback((width: number, height: number) => {
    const flow = flowRef.current;
    const bounds = canvasWrapRef.current?.getBoundingClientRect();
    if (!flow || !bounds) return undefined;
    return centeredNodePositionInViewport(
      bounds,
      (position) => flow.screenToFlowPosition(position),
      width,
      height,
    );
  }, []);

  const rememberNodePlacement = useCallback((id: string, position?: NodePosition) => {
    if (!position) return;
    setPendingPlacements((current) => ({
      ...current,
      [id]: position,
    }));
  }, []);

  const captureProjectOperation = useCallback(
    (): ProjectOperationOwnership => ({
      token: projectOperationInvocationRef.current,
      workspaceEventGeneration: currentWorkspaceEventGeneration(),
    }),
    [currentWorkspaceEventGeneration],
  );

  const beginProjectOperation = useCallback((): ProjectOperationOwnership => {
    invalidateWorkspaceRefresh();
    return {
      token: ++projectOperationInvocationRef.current,
      workspaceEventGeneration: currentWorkspaceEventGeneration(),
    };
  }, [currentWorkspaceEventGeneration, invalidateWorkspaceRefresh]);

  const projectOperationIsCurrent = useCallback(
    (ownership: ProjectOperationOwnership, expectedWorkspaceIdentity?: string) =>
      ownsProjectOperation(
        ownership,
        projectOperationInvocationRef.current,
        currentWorkspaceEventGeneration(),
        currentWorkspaceEventIdentity(),
        expectedWorkspaceIdentity,
      ),
    [currentWorkspaceEventGeneration, currentWorkspaceEventIdentity],
  );

  useEffect(() => {
    let cancelled = false;
    const ownership = captureProjectOperation();
    void api.listCanvasProjects().then(
      (nextProjects) => {
        if (!cancelled && projectOperationIsCurrent(ownership)) setProjects(nextProjects);
      },
      (error) => {
        if (!cancelled && projectOperationIsCurrent(ownership)) {
          setProjectError(error instanceof Error ? error.message : String(error));
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [captureProjectOperation, projectOperationIsCurrent]);

  useEffect(() => {
    let cancelled = false;
    const ownership = captureProjectOperation();
    void api.config().then(
      (config) => {
        if (!cancelled) setServerConfig(config);
      },
      () => undefined,
    );
    void api.settings().then(
      (settings) => {
        if (!cancelled && projectOperationIsCurrent(ownership)) setAppSettings(settings);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [captureProjectOperation, projectOperationIsCurrent]);

  const updateAppSettings = useCallback(
    async (settings: Partial<AgentCanvasSettings>) => {
      const ownership = captureProjectOperation();
      const expectedWorkspaceIdentity = workspaceEventIdentity(workspaceRef.current);
      const expectedProjectId = workspaceRef.current?.canvasProject?.id;
      if (!expectedProjectId) throw new Error("尚未打开 Canvas 项目");
      const updated = await api.updateSettings(settings, expectedProjectId);
      if (projectOperationIsCurrent(ownership, expectedWorkspaceIdentity)) {
        setAppSettings(updated);
      }
    },
    [captureProjectOperation, projectOperationIsCurrent],
  );

  const refreshCodexUsage = useCallback(async () => {
    setCodexUsageError(undefined);
    try {
      setCodexUsage(await api.codexUsage());
    } catch (error) {
      setCodexUsageError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    if (showingSettings) void refreshCodexUsage();
  }, [refreshCodexUsage, showingSettings]);

  const refreshBranchOptions = useCallback(async () => {
    const ownership = captureProjectOperation();
    const expectedWorkspaceIdentity = workspaceEventIdentity(workspaceRef.current);
    const nextBranches = await api.listBranchOptions();
    if (projectOperationIsCurrent(ownership, expectedWorkspaceIdentity)) {
      setBranches(nextBranches);
    }
    return nextBranches;
  }, [captureProjectOperation, projectOperationIsCurrent]);

  useEffect(() => {
    if (
      !workspaceUpdate ||
      !isCurrentWorkspaceUpdate(
        workspaceUpdate.workspace,
        currentWorkspaceEventIdentity(),
      )
    ) {
      return;
    }
    let cancelled = false;
    const ownership = captureProjectOperation();
    const isCurrentWorkspaceEvent = () =>
      !cancelled &&
      projectOperationIsCurrent(ownership);
    clearProjectScopedUi();
    if (!workspaceUpdate.workspace) {
      setWorkspace(undefined);
      setLayoutProjectId(undefined);
      setProjectError(undefined);
      void Promise.all([
        api.canvasLayout(),
        api.settings(),
        api.listCanvasProjects(),
        refresh(),
      ]).then(
        ([nextLayout, nextSettings, nextProjects]) => {
          if (!isCurrentWorkspaceEvent()) return;
          setSavedLayout(nextLayout);
          setAppSettings(nextSettings);
          setProjects(nextProjects);
        },
        (error) => {
          if (isCurrentWorkspaceEvent()) {
            setProjectError(error instanceof Error ? error.message : String(error));
          }
        },
      );
      return () => {
        cancelled = true;
      };
    }
    const nextWorkspace: CanvasProjectOpenResult = {
      ...workspaceUpdate.workspace,
      partialSuccess: workspaceUpdate.partialSuccess,
      workDocumentation: workspaceUpdate.workDocumentation,
    };

    // Project switches are global server state. Adopt the broadcast immediately so every
    // connected client stops displaying the previous project before auxiliary data reloads.
    adoptOpenedProject(nextWorkspace, {
      setWorkspace,
      setLayoutProjectId,
      setProjectError,
    });

    void Promise.all([
      api.canvasLayout(),
      api.settings(),
      api.listCanvasProjects(),
      nextWorkspace.repo ? api.listBranchOptions() : Promise.resolve([]),
      refresh(),
    ]).then(
      ([nextLayout, nextSettings, nextProjects, nextBranches]) => {
        if (!isCurrentWorkspaceEvent()) return;
        setSavedLayout(nextLayout);
        setAppSettings(nextSettings);
        setProjects(nextProjects);
        setBranches(nextBranches);
        updateLayoutReadyProjectId(nextWorkspace.canvasProject?.id);
      },
      (error) => {
        if (isCurrentWorkspaceEvent()) {
          setProjectError(error instanceof Error ? error.message : String(error));
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [
    captureProjectOperation,
    clearProjectScopedUi,
    currentWorkspaceEventIdentity,
    projectOperationIsCurrent,
    refresh,
    updateLayoutReadyProjectId,
    workspaceUpdate,
  ]);

  const openProject = useCallback(
    async (
      id?: string,
      projectRoot?: string,
      trustedExternalResourcePaths?: string[],
      ownership = beginProjectOperation(),
    ) => {
      setProjectError(undefined);
      let expectedWorkspaceIdentity: string | undefined;
      try {
        const nextWorkspace = await api.openCanvasProject({
          id,
          projectRoot,
          trustedExternalResourcePaths,
        });
        expectedWorkspaceIdentity = workspaceEventIdentity(nextWorkspace);
        const isCurrent = () =>
          projectOperationIsCurrent(ownership, expectedWorkspaceIdentity);
        if (!isCurrent()) return;
        api.setWorkspaceContext(nextWorkspace);
        // A 207 response still means the server switched projects. Adopt that authoritative
        // state before auxiliary refreshes so their failure cannot leave the old project visible.
        adoptOpenedProject(nextWorkspace, {
          setWorkspace,
          setLayoutProjectId,
          setProjectError,
        });
        clearProjectScopedUi();
        const auxiliary = await resolveCurrentProjectOpenStep(
          Promise.all([api.canvasLayout(), api.settings()]),
          isCurrent,
        );
        if (!auxiliary) return;
        const [nextLayout, nextSettings] = auxiliary;
        setSavedLayout(nextLayout);
        setAppSettings(nextSettings);
        await refresh();
        if (!isCurrent()) return;
        updateLayoutReadyProjectId(nextWorkspace.canvasProject?.id);
        const projectLists = await resolveCurrentProjectOpenStep(
          Promise.all([
            api.listCanvasProjects(),
            nextWorkspace.repo ? api.listBranchOptions() : Promise.resolve([]),
          ]),
          isCurrent,
        );
        if (!projectLists) return;
        setProjects(projectLists[0]);
        setBranches(projectLists[1]);
      } catch (error) {
        if (projectOperationIsCurrent(ownership, expectedWorkspaceIdentity)) {
          setProjectError(error instanceof Error ? error.message : String(error));
        }
      }
    },
    [
      beginProjectOperation,
      clearProjectScopedUi,
      projectOperationIsCurrent,
      refresh,
      updateLayoutReadyProjectId,
    ],
  );

  const loadProject = useCallback(
    async (projectRoot: string) => {
      const ownership = beginProjectOperation();
      setProjectError(undefined);
      try {
        const inspection = await api.inspectCanvasProject(projectRoot);
        if (!projectOperationIsCurrent(ownership)) return;
        const externalPaths = inspection.externalSharedResources.map(
          (resource) => resource.sourcePath,
        );
        if (externalPaths.length > 0) {
          const approved = window.confirm(
            `该项目引用了项目目录外的共享资源。是否授权加载以下路径？\n\n${externalPaths.join("\n")}`,
          );
          if (!approved) return;
        }
        await openProject(undefined, projectRoot, externalPaths, ownership);
      } catch (error) {
        if (projectOperationIsCurrent(ownership)) {
          setProjectError(error instanceof Error ? error.message : String(error));
        }
      }
    },
    [beginProjectOperation, openProject, projectOperationIsCurrent],
  );

  const deleteProject = useCallback(
    async (id: string) => {
      const ownership = beginProjectOperation();
      const workspaceAtStart = workspaceRef.current;
      const deletingCurrent = workspaceAtStart?.canvasProject?.id === id;
      const expectedWorkspaceIdentity = deletingCurrent
        ? workspaceEventIdentity(undefined)
        : workspaceEventIdentity(workspaceAtStart);
      const isCurrent = () =>
        projectOperationIsCurrent(ownership, expectedWorkspaceIdentity);
      setProjectError(undefined);
      try {
        const deleted = await api.deleteCanvasProject(id);
        if (!isCurrent()) return;

        const clearedCurrent = adoptDeletedCurrentProject(
          deleted.id,
          workspaceRef.current ?? workspaceAtStart,
          { setWorkspace, setLayoutProjectId, setProjectError },
        );
        if (deletingCurrent || clearedCurrent) {
          api.setWorkspaceContext(undefined);
          clearProjectScopedUi();
        }

        const replacement = await resolveCurrentProjectOpenStep(
          Promise.all([
            api.listCanvasProjects(),
            deletingCurrent ? api.canvasLayout() : Promise.resolve(undefined),
            deletingCurrent ? api.settings() : Promise.resolve(undefined),
            deletingCurrent ? refresh() : Promise.resolve(),
          ]),
          isCurrent,
        );
        if (!replacement) return;
        const [nextProjects, nextLayout, nextSettings] = replacement;
        setProjects(nextProjects);
        if (nextLayout) setSavedLayout(nextLayout);
        if (nextSettings) setAppSettings(nextSettings);
      } catch (error) {
        if (isCurrent()) {
          setProjectError(error instanceof Error ? error.message : String(error));
        }
      }
    },
    [
      beginProjectOperation,
      clearProjectScopedUi,
      projectOperationIsCurrent,
      refresh,
    ],
  );

  const createProject = useCallback(
    async (name: string, projectRoot?: string) => {
      const ownership = beginProjectOperation();
      setProjectError(undefined);
      let expectedWorkspaceIdentity: string | undefined;
      try {
        const { workspace: nextWorkspace } = await api.createCanvasProject({
          name,
          projectRoot: projectRoot?.trim() || undefined,
        });
        expectedWorkspaceIdentity = workspaceEventIdentity(nextWorkspace);
        const isCurrent = () =>
          projectOperationIsCurrent(ownership, expectedWorkspaceIdentity);
        if (!isCurrent()) return;
        api.setWorkspaceContext(nextWorkspace);
        clearProjectScopedUi();
        setWorkspace(nextWorkspace);
        setLayoutProjectId(nextWorkspace.canvasProject?.id);
        setProjectError(undefined);
        const auxiliary = await resolveCurrentProjectOpenStep(
          Promise.all([api.canvasLayout(), api.settings(), refresh()]),
          isCurrent,
        );
        if (!auxiliary) return;
        const [nextLayout, nextSettings] = auxiliary;
        setSavedLayout(nextLayout);
        setAppSettings(nextSettings);
        updateLayoutReadyProjectId(nextWorkspace.canvasProject?.id);
        const nextProjects = await resolveCurrentProjectOpenStep(
          api.listCanvasProjects(),
          isCurrent,
        );
        if (nextProjects) setProjects(nextProjects);
      } catch (error) {
        if (projectOperationIsCurrent(ownership, expectedWorkspaceIdentity)) {
          setProjectError(error instanceof Error ? error.message : String(error));
        }
      }
    },
    [
      beginProjectOperation,
      clearProjectScopedUi,
      projectOperationIsCurrent,
      refresh,
      updateLayoutReadyProjectId,
    ],
  );

  const connectRepo = useCallback(
    async (input: { remoteUrl: string; defaultBranch?: string }) => {
      const ownership = beginProjectOperation();
      setProjectError(undefined);
      let expectedWorkspaceIdentity: string | undefined;
      try {
        const result = await api.connectWorkspace(input);
        expectedWorkspaceIdentity = workspaceEventIdentity(result);
        const isCurrent = () =>
          projectOperationIsCurrent(ownership, expectedWorkspaceIdentity);
        if (!isCurrent()) return;
        api.setWorkspaceContext(result);
        const warning = workDocumentationMutationWarning(result);
        // A 207 can also mean the active project changed while documentation was
        // prepared. Refresh authoritative state instead of consuming a stale payload.
        const nextWorkspace = warning ? await api.workspace() : result;
        if (!isCurrent() || workspaceEventIdentity(nextWorkspace) !== expectedWorkspaceIdentity) {
          return;
        }
        api.setWorkspaceContext(nextWorkspace);
        setWorkspace(nextWorkspace);
        const nextBranches = await resolveCurrentProjectOpenStep(
          api.listBranchOptions(),
          isCurrent,
        );
        if (!nextBranches) return;
        setBranches(nextBranches);
        setProjectError(warning);
      } catch (error) {
        if (projectOperationIsCurrent(ownership, expectedWorkspaceIdentity)) {
          setProjectError(error instanceof Error ? error.message : String(error));
        }
      }
    },
    [beginProjectOperation, projectOperationIsCurrent],
  );

  const openFileEditor = useCallback((fileId: string) => {
    setFileOpenError(undefined);
    void api.openFileInVscode(fileId).catch((error: unknown) => {
      setFileOpenError(error instanceof Error ? error.message : String(error));
    });
  }, []);

  const openHistory = useCallback(
    (agentId: string, turnIndex: number) => {
      setHistoryTarget({
        agentId,
        turnIndex,
        lastSeq: agents[agentId]?.lastSeq ?? 0,
      });
    },
    [agents],
  );

  const openAgentSettings = useCallback((agentId: string) => {
    setAgentSettingsTarget({ mode: "edit", agentId });
  }, []);

  const createBranch = useCallback(
    async (branch: string, baseBranch?: string) => {
      const ownership = beginProjectOperation();
      const expectedWorkspaceIdentity = workspaceEventIdentity(workspaceRef.current);
      const isCurrent = () =>
        projectOperationIsCurrent(ownership, expectedWorkspaceIdentity);
      setProjectError(undefined);
      const result = await api.createBranch({ branch, baseBranch });
      if (!isCurrent()) {
        throw new Error("项目已切换；已忽略旧项目的分支创建结果");
      }
      const warning = workDocumentationMutationWarning(result);
      if (!warning) {
        const nextBranches = await resolveCurrentProjectOpenStep(
          api.listBranchOptions(),
          isCurrent,
        );
        if (!nextBranches) throw new Error("项目已切换；已忽略旧项目的分支列表");
        setBranches(nextBranches);
        return result;
      }

      const currentWorkspace = await api.workspace();
      if (!isCurrent() || workspaceEventIdentity(currentWorkspace) !== expectedWorkspaceIdentity) {
        throw new Error("项目已切换；已忽略旧项目的工作区结果");
      }
      setWorkspace(currentWorkspace);
      const nextBranches = await resolveCurrentProjectOpenStep(
        api.listBranchOptions(),
        isCurrent,
      );
      if (!nextBranches) throw new Error("项目已切换；已忽略旧项目的分支列表");
      setBranches(nextBranches);
      setProjectError(warning);
      const currentBranch = currentWorkspace.branches.find((candidate) =>
        isSameBranchWorkspace(candidate, result),
      );
      if (!currentBranch) {
        throw new Error(`${warning}；当前项目已切换，请在原项目中确认该分支。`);
      }
      return currentBranch;
    },
    [beginProjectOperation, projectOperationIsCurrent],
  );

  useEffect(() => {
    setNodes((current) =>
      buildNodes(
        agents,
        files,
        prompts,
        commits,
        prFlows,
        syncFlows,
        actions,
        fileActions,
        promptActions,
        current,
        openHistory,
        openAgentSettings,
        setOpenFileId,
        openFileEditor,
        setOpenCommitId,
        setOpenPullRequestId,
        setOpenSyncFlowId,
        savedLayout.nodes,
        pendingPlacements,
        branches,
        serverConfig.codexModels,
        serverConfig.defaultCodexModel,
        serverConfig.codexReasoningEfforts,
        serverConfig.codexModelCapabilities,
        createBranch,
      ),
    );
    setEdges([
      ...computeConversationEdges(agents),
      ...computeFileEdges(agents, fileConnections),
      ...computeResultFileEdges(agents, files),
      ...computePromptEdges(agents, promptConnections),
      ...computeCommitEdges(agents, commits),
      ...computePullRequestEdges(agents, prFlows),
      ...computeSyncFlowEdges(agents, syncFlows),
    ]);
  }, [
    agents,
    files,
    fileConnections,
    prompts,
    promptConnections,
    commits,
    prFlows,
    syncFlows,
    actions,
    fileActions,
    promptActions,
    branches,
    serverConfig.codexModels,
    serverConfig.defaultCodexModel,
    serverConfig.codexReasoningEfforts,
    serverConfig.codexModelCapabilities,
    createBranch,
    openHistory,
    openAgentSettings,
    openFileEditor,
    savedLayout.nodes,
    pendingPlacements,
    setNodes,
    setEdges,
  ]);

  useEffect(() => {
    if (Object.keys(pendingPlacements).length === 0) return;
    const appliedNodes = nodes.filter((node) => {
      const placement = pendingPlacements[node.id];
      return placement ? positionsMatch(node.position, placement) : false;
    });
    if (appliedNodes.length === 0) return;

    setPendingPlacements((current) => {
      let changed = false;
      const next = { ...current };
      for (const node of appliedNodes) {
        const placement = next[node.id];
        if (placement && positionsMatch(node.position, placement)) {
          delete next[node.id];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [nodes, pendingPlacements]);

  useEffect(() => {
    const canvasProjectId = workspace?.canvasProject?.id;
    if (
      !canvasProjectId ||
      !canvasLayoutAutosaveReady(
        canvasProjectId,
        layoutProjectId,
        layoutReadyProjectId,
      )
    ) {
      return;
    }
    if (nodes.length === 0 && savedLayout.nodes.length > 0) return;
    const ownership = captureProjectOperation();
    const expectedWorkspaceIdentity = workspaceEventIdentity(workspace);
    const timer = window.setTimeout(() => {
      if (layoutReadyProjectIdRef.current !== canvasProjectId) return;
      if (!projectOperationIsCurrent(ownership, expectedWorkspaceIdentity)) return;
      const layout = canvasLayoutFromNodes(nodes);
      void api.saveCanvasLayout(layout, canvasProjectId).catch(() => undefined);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [
    captureProjectOperation,
    layoutProjectId,
    layoutReadyProjectId,
    nodes,
    projectOperationIsCurrent,
    savedLayout.nodes.length,
    workspace,
  ]);

  const connect = useCallback(
    async (connection: Connection) => {
      if (
        connection.source.startsWith("file:") &&
        connection.sourceHandle === "read" &&
        connection.targetHandle === "resource-read"
      ) {
        await fileActions.connect(
          connection.source.slice("file:".length),
          connection.target.split("#")[0]!,
          "read",
        );
        return;
      }
      if (
        connection.target.startsWith("file:") &&
        connection.sourceHandle === "resource-write" &&
        connection.targetHandle === "write"
      ) {
        await fileActions.connect(
          connection.target.slice("file:".length),
          connection.source.split("#")[0]!,
          "write",
        );
        return;
      }
      if (
        connection.source.startsWith("prompt:") &&
        connection.sourceHandle === "read" &&
        connection.targetHandle === "resource-read"
      ) {
        await promptActions.connect(
          connection.source.slice("prompt:".length),
          connection.target.split("#")[0]!,
          "read",
        );
        return;
      }
      if (
        connection.target.startsWith("prompt:") &&
        connection.sourceHandle === "resource-write" &&
        connection.targetHandle === "write"
      ) {
        await promptActions.connect(
          connection.target.slice("prompt:".length),
          connection.source.split("#")[0]!,
          "write",
        );
      }
    },
    [fileActions, promptActions],
  );

  const canvasInteraction = canvasInteractionForTool(canvasTool);

  if (!workspace) {
    return (
      <ProjectGate
        connected={connected}
        projects={projects}
        error={projectError}
        onOpen={(id) => openProject(id)}
        onLoad={loadProject}
        onCreate={createProject}
        onDelete={deleteProject}
      />
    );
  }

  if (!workspace.repo) {
    return (
      <RepoConnectGate
        connected={connected}
        project={workspace.canvasProject}
        projectRoot={workspace.projectRoot}
        error={projectError}
        onConnect={connectRepo}
      />
    );
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <strong>agent_canvas</strong>
        <span className={connected ? "connection-state is-connected" : "connection-state"}>
          {connected ? "● 已连接后端" : "● 未连接"}
        </span>
        <span className="app-header__hint">
          {workspace.canvasProject?.name ?? "未命名项目"} · {workspace.repo.remoteUrl}
        </span>
        <button
          className="header-button header-button--secondary"
          onClick={() => setShowingPullRequests(true)}
        >
          <GitPullRequest size={15} />
          PR
        </button>
        <button
          className="header-button header-button--secondary"
          onClick={() => setShowingSyncFlows(true)}
        >
          <GitBranch size={15} />
          Sync
        </button>
        <button
          className="header-button header-button--secondary"
          onClick={() => setShowingSettings(true)}
        >
          <Settings size={15} />
          设置
        </button>
        <button
          className="header-button header-button--secondary"
          onClick={() => setCreatingPrompt(true)}
        >
          <MessageSquarePlus size={15} />
          新建提示词
        </button>
        <button className="header-button header-button--secondary" onClick={() => setCreatingFile(true)}>
          <FilePlus2 size={15} />
          新建文件
        </button>
        <button className="header-button" onClick={() => setAgentSettingsTarget({ mode: "create" })}>
          新建 Agent
        </button>
      </header>

      <div className="canvas-wrap" ref={canvasWrapRef}>
        <div className="canvas-toolbar" aria-label="Canvas tools">
          <button
            type="button"
            className={canvasTool === "select" ? "is-active" : undefined}
            title="选择"
            aria-label="选择工具"
            aria-pressed={canvasTool === "select"}
            onClick={() => setCanvasTool("select")}
          >
            <MousePointer2 size={18} />
          </button>
          <button
            type="button"
            className={canvasTool === "hand" ? "is-active" : undefined}
            title="拖动画布"
            aria-label="手型工具"
            aria-pressed={canvasTool === "hand"}
            onClick={() => setCanvasTool("hand")}
          >
            <Hand size={18} />
          </button>
        </div>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onInit={(instance) => {
            flowRef.current = instance;
          }}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={(connection) => void connect(connection)}
          onEdgesDelete={(deleted) => {
            for (const edge of deleted) {
              if (edge.id.startsWith("file_connection_")) {
                void fileActions.disconnect(edge.id);
              } else if (edge.id.startsWith("prompt_connection_")) {
                void promptActions.disconnect(edge.id);
              }
            }
          }}
          panOnDrag={canvasInteraction.panOnDrag}
          selectionOnDrag={canvasInteraction.selectionOnDrag}
          selectionMode={canvasInteraction.selectionMode}
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <MiniMap pannable zoomable />
          <Controls />
        </ReactFlow>
      </div>

      {creatingFile && (
        <CreateFileDialog
          onCreate={async (input) => {
            const ownership = captureProjectOperation();
            const expectedWorkspaceIdentity = workspaceEventIdentity(workspaceRef.current);
            const placement = captureViewportPlacement(FILE_NODE_WIDTH, FILE_NODE_HEIGHT);
            const file = await fileActions.create(input);
            if (projectOperationIsCurrent(ownership, expectedWorkspaceIdentity)) {
              rememberNodePlacement(fileNodeId(file.id), placement);
            }
          }}
          onClose={() => setCreatingFile(false)}
        />
      )}
      {agentSettingsTarget?.mode === "create" && (
        <AgentSettingsDialog
          mode="create"
          branches={branches}
          codexModels={serverConfig.codexModels}
          defaultCodexModel={serverConfig.defaultCodexModel}
          codexReasoningEfforts={serverConfig.codexReasoningEfforts}
          codexModelCapabilities={serverConfig.codexModelCapabilities}
          onCreateBranch={createBranch}
          onCreate={async (settings) => {
            const ownership = captureProjectOperation();
            const expectedWorkspaceIdentity = workspaceEventIdentity(workspaceRef.current);
            const placement = captureViewportPlacement(
              DEFAULT_NODE_WIDTH,
              DEFAULT_NODE_HEIGHT,
            );
            const id = await actions.create(settings);
            if (!projectOperationIsCurrent(ownership, expectedWorkspaceIdentity)) return;
            rememberNodePlacement(nodeId(id, 0), placement);
            await refreshBranchOptions();
          }}
          onClose={() => setAgentSettingsTarget(undefined)}
        />
      )}
      {agentSettingsTarget?.mode === "edit" && settingsAgent && (
        <AgentSettingsDialog
          mode="edit"
          agent={settingsAgent}
          branches={branches}
          codexModels={serverConfig.codexModels}
          defaultCodexModel={serverConfig.defaultCodexModel}
          codexReasoningEfforts={serverConfig.codexReasoningEfforts}
          codexModelCapabilities={serverConfig.codexModelCapabilities}
          canChangeBranch={
            settingsAgent.status === "idle" || settingsAgent.status === "waiting_input"
          }
          onCreateBranch={createBranch}
          onUpdate={actions.updateSettings}
          onClose={() => setAgentSettingsTarget(undefined)}
        />
      )}
      {creatingPrompt && (
        <CreatePromptDialog
          onCreate={async (input) => {
            const ownership = captureProjectOperation();
            const expectedWorkspaceIdentity = workspaceEventIdentity(workspaceRef.current);
            const placement = captureViewportPlacement(
              PROMPT_NODE_WIDTH,
              PROMPT_NODE_HEIGHT,
            );
            const prompt = await promptActions.create(input);
            if (projectOperationIsCurrent(ownership, expectedWorkspaceIdentity)) {
              rememberNodePlacement(promptNodeId(prompt.id), placement);
            }
          }}
          onClose={() => setCreatingPrompt(false)}
        />
      )}
      {showingPullRequests && (
        <PullRequestDialog
          agents={agents}
          branches={branches}
          flows={prFlows}
          actions={prActions}
          onClose={() => setShowingPullRequests(false)}
        />
      )}
      {showingSyncFlows && (
        <SyncFlowDialog
          agents={agents}
          branches={branches}
          flows={syncFlows}
          actions={syncActions}
          onClose={() => setShowingSyncFlows(false)}
        />
      )}
      {showingSettings && (
        <AppSettingsDialog
          settings={appSettings}
          codexUsage={codexUsage}
          codexUsageError={codexUsageError}
          onUpdate={updateAppSettings}
          onRefreshCodexUsage={refreshCodexUsage}
          onClose={() => setShowingSettings(false)}
        />
      )}
      {historyTarget && (
        <ConversationHistoryWindow
          target={{
            ...historyTarget,
            lastSeq: agents[historyTarget.agentId]?.lastSeq ?? historyTarget.lastSeq,
          }}
          onClose={() => setHistoryTarget(undefined)}
        />
      )}
      {openFile && (
        <FileContentWindow
          file={openFile}
          onClose={() => setOpenFileId(undefined)}
          onOpenEditor={openFileEditor}
        />
      )}
      {openCommit && (
        <CommitDetailsWindow
          commit={openCommit}
          onClose={() => setOpenCommitId(undefined)}
        />
      )}
      {openPullRequest && (
        <PullRequestDetailsWindow
          flow={openPullRequest}
          onClose={() => setOpenPullRequestId(undefined)}
        />
      )}
      {openSyncFlow && (
        <SyncFlowDetailsWindow
          flow={openSyncFlow}
          onClose={() => setOpenSyncFlowId(undefined)}
        />
      )}
      {fileOpenError && (
        <div className="file-open-error" role="alert">
          <span>{fileOpenError}</span>
          <button className="icon-button" title="关闭错误提示" onClick={() => setFileOpenError(undefined)}>
            <X size={15} />
          </button>
        </div>
      )}
      {projectError && !fileOpenError && (
        <div className="file-open-error" role="alert">
          <span>{projectError}</span>
          <button
            className="icon-button"
            title="关闭项目提示"
            onClick={() => setProjectError(undefined)}
          >
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}

export function ProjectGate({
  connected,
  projects,
  error,
  onOpen,
  onLoad,
  onCreate,
  onDelete,
}: {
  connected: boolean;
  projects: CanvasProjectSummary[];
  error?: string;
  onOpen: (id: string) => Promise<void>;
  onLoad: (projectRoot: string) => Promise<void>;
  onCreate: (name: string, projectRoot?: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}): React.ReactElement {
  const [name, setName] = useState("");
  const [projectRoot, setProjectRoot] = useState("");
  const [loadRoot, setLoadRoot] = useState("");
  const [busy, setBusy] = useState(false);
  const [pickingDirectory, setPickingDirectory] = useState(false);
  const [pickError, setPickError] = useState("");
  const operationRef = useRef(false);
  const runExclusive = async (operation: () => Promise<void>) => {
    if (operationRef.current) return;
    operationRef.current = true;
    setBusy(true);
    try {
      await operation();
    } finally {
      operationRef.current = false;
      setBusy(false);
    }
  };
  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed || pickingDirectory) return;
    await runExclusive(() => onCreate(trimmed, projectRoot));
  };
  const load = async () => {
    const root = loadRoot.trim();
    if (!root || pickingDirectory) return;
    await runExclusive(() => onLoad(root));
  };
  const remove = async (project: CanvasProjectSummary) => {
    const confirmed = window.confirm(
      `确定永久删除项目“${project.name}”及其目录中的全部数据吗？\n\n${project.projectRoot}`,
    );
    if (!confirmed) return;
    await runExclusive(() => onDelete(project.id));
  };
  const browse = async (
    initialDirectory: string,
    setDirectory: (directory: string) => void,
  ) => {
    setPickError("");
    setPickingDirectory(true);
    try {
      const picked = await api.pickDirectory(initialDirectory.trim() || undefined);
      if (picked.path) setDirectory(picked.path);
    } catch (reason) {
      setPickError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPickingDirectory(false);
    }
  };
  return (
    <div className="project-gate">
      <header className="project-gate__header">
        <strong>agent_canvas</strong>
        <span className={connected ? "connection-state is-connected" : "connection-state"}>
          {connected ? "● 已连接后端" : "● 未连接"}
        </span>
      </header>
      <main className="project-gate__panel">
        <section className="project-gate__section">
          <h1>打开 Canvas 项目</h1>
          <div className="project-list">
            {projects.map((project) => (
              <div key={project.id} className="project-row">
                <button
                  className="project-row__open"
                  disabled={busy || pickingDirectory}
                  onClick={() => void runExclusive(() => onOpen(project.id))}
                >
                  <FolderOpen size={18} />
                  <span>
                    <strong>{project.name}</strong>
                    <small>{project.projectRoot}</small>
                  </span>
                </button>
                <button
                  type="button"
                  className="project-row__delete"
                  aria-label={`删除项目 ${project.name}`}
                  title="永久删除项目"
                  disabled={busy || pickingDirectory}
                  onClick={() => void remove(project)}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
            {projects.length === 0 && <p className="project-empty">暂无项目</p>}
          </div>
        </section>
        <section className="project-gate__section">
          <h2>从文件夹加载项目</h2>
          <div className="project-load">
            <input
              aria-label="要加载的 Canvas 项目文件夹"
              value={loadRoot}
              placeholder="选择包含 workspace.json 的项目文件夹"
              onChange={(event) => setLoadRoot(event.target.value)}
            />
            <button
              type="button"
              disabled={busy || pickingDirectory}
              onClick={() => void browse(loadRoot, setLoadRoot)}
            >
              <FolderOpen size={16} />
              浏览
            </button>
            <button
              type="button"
              disabled={busy || pickingDirectory || !loadRoot.trim()}
              onClick={() => void load()}
            >
              加载
            </button>
          </div>
        </section>
        <section className="project-gate__section">
          <h2>新建 Canvas 项目</h2>
          <div className="project-create">
            <input
              aria-label="Canvas 项目名称"
              value={name}
              placeholder="项目名称"
              onChange={(event) => setName(event.target.value)}
            />
            <button disabled={busy || pickingDirectory || !name.trim()} onClick={() => void create()}>
              <Plus size={16} />
              新建
            </button>
            <div className="project-create__path">
              <input
                aria-label="Canvas 项目文件夹"
                value={projectRoot}
                placeholder="项目文件夹，可留空使用默认位置"
                onChange={(event) => setProjectRoot(event.target.value)}
              />
              <button
                type="button"
                disabled={busy || pickingDirectory}
                onClick={() => void browse(projectRoot, setProjectRoot)}
              >
                <FolderOpen size={16} />
                浏览
              </button>
            </div>
          </div>
        </section>
        {(error || pickError) && <div className="file-dialog__error">{error ?? pickError}</div>}
      </main>
      {pickingDirectory && (
        <div className="project-gate__busy" role="status" aria-live="polite">
          <span>请选择目录</span>
        </div>
      )}
    </div>
  );
}

function RepoConnectGate({
  connected,
  project,
  projectRoot,
  error,
  onConnect,
}: {
  connected: boolean;
  project?: CanvasProjectSummary;
  projectRoot: string;
  error?: string;
  onConnect: (input: { remoteUrl: string; defaultBranch?: string }) => Promise<void>;
}): React.ReactElement {
  const [remoteUrl, setRemoteUrl] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("main");
  const [busy, setBusy] = useState(false);
  const connect = async () => {
    const trimmed = remoteUrl.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      await onConnect({
        remoteUrl: trimmed,
        defaultBranch: defaultBranch.trim() || undefined,
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="project-gate">
      <header className="project-gate__header">
        <strong>agent_canvas</strong>
        <span className={connected ? "connection-state is-connected" : "connection-state"}>
          {connected ? "● 已连接后端" : "● 未连接"}
        </span>
      </header>
      <main className="project-gate__panel project-gate__panel--narrow">
        <section className="project-gate__section">
          <h1>{project?.name ?? "Canvas 项目"}</h1>
          <p className="project-path">{projectRoot}</p>
        </section>
        <section className="project-gate__section">
          <h2>连接 GitHub Repo</h2>
          <label className="file-dialog__field">
            <span>Repo URL</span>
            <input
              aria-label="GitHub repo URL"
              value={remoteUrl}
              placeholder="git@github.com:OWNER/REPO.git"
              onChange={(event) => setRemoteUrl(event.target.value)}
            />
          </label>
          <label className="file-dialog__field">
            <span>默认 branch</span>
            <input
              aria-label="默认 branch"
              value={defaultBranch}
              onChange={(event) => setDefaultBranch(event.target.value)}
            />
          </label>
          <button
            className="project-connect-button"
            disabled={busy || !remoteUrl.trim()}
            onClick={() => void connect()}
          >
            <Link size={16} />
            连接
          </button>
        </section>
        {error && <div className="file-dialog__error">{error}</div>}
      </main>
    </div>
  );
}

export function AppSettingsDialog({
  settings,
  codexUsage,
  codexUsageError,
  onUpdate,
  onRefreshCodexUsage,
  onClose,
}: {
  settings: AgentCanvasSettings;
  codexUsage?: CodexUsageSnapshot;
  codexUsageError?: string;
  onUpdate: (settings: Partial<AgentCanvasSettings>) => Promise<void>;
  onRefreshCodexUsage: () => Promise<void>;
  onClose: () => void;
}): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const [usageBusy, setUsageBusy] = useState(false);
  const [error, setError] = useState("");
  const updateSetting = async (input: Partial<AgentCanvasSettings>) => {
    setBusy(true);
    setError("");
    try {
      await onUpdate(input);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const refreshUsage = async () => {
    setUsageBusy(true);
    try {
      await onRefreshCodexUsage();
    } finally {
      setUsageBusy(false);
    }
  };
  return (
    <div className="file-dialog-backdrop" onMouseDown={onClose}>
      <section
        className="file-dialog file-dialog--narrow"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="file-dialog__header">
          <h2>设置</h2>
          <button className="icon-button" title="关闭设置" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={settings.fullPermissionMode}
            disabled={busy}
            onChange={(event) =>
              void updateSetting({ fullPermissionMode: event.target.checked })
            }
          />
          <span>
            <strong>完全权限模式</strong>
            <small>开启后所有授权请求由后端直接允许，不再等待前端审批。</small>
          </span>
        </label>
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={settings.workDocumentationEnabled}
            disabled={busy}
            onChange={(event) =>
              void updateSetting({ workDocumentationEnabled: event.target.checked })
            }
          />
          <span>
            <strong>工作文档维护</strong>
            <small>
              开启后 Agent 会实时维护 branch 隔离文档与共享概要；两份固定索引会作为参考文件，且不会进入 Git。
            </small>
          </span>
        </label>
        {error && <div className="file-dialog__error">{error}</div>}
        <section className="settings-panel">
          <div className="settings-panel__header">
            <strong>Codex 用量</strong>
            <button type="button" disabled={usageBusy} onClick={() => void refreshUsage()}>
              刷新
            </button>
          </div>
          {codexUsageError ? (
            <div className="file-dialog__error">{codexUsageError}</div>
          ) : (
            <dl className="settings-metrics">
              <div>
                <dt>累计 token</dt>
                <dd>{formatMetric(codexUsage?.tokenUsage?.lifetimeTokens)}</dd>
              </div>
              <div>
                <dt>单日峰值</dt>
                <dd>{formatMetric(codexUsage?.tokenUsage?.peakDailyTokens)}</dd>
              </div>
              <div>
                <dt>连续使用</dt>
                <dd>{formatMetric(codexUsage?.tokenUsage?.currentStreakDays, " 天")}</dd>
              </div>
              <div>
                <dt>限额</dt>
                <dd>{rateLimitSummary(codexUsage?.rateLimits)}</dd>
              </div>
            </dl>
          )}
        </section>
      </section>
    </div>
  );
}

function formatMetric(value: number | null | undefined, suffix = ""): string {
  if (value === null || value === undefined) return "未知";
  return `${value.toLocaleString()}${suffix}`;
}

function rateLimitSummary(value: unknown): string {
  const limits = value as
    | {
        rateLimits?: {
          primary?: { usedPercent?: number | null } | null;
          secondary?: { usedPercent?: number | null } | null;
        };
      }
    | undefined;
  const primary = limits?.rateLimits?.primary?.usedPercent;
  const secondary = limits?.rateLimits?.secondary?.usedPercent;
  const parts = [
    typeof primary === "number" ? `primary ${primary}%` : undefined,
    typeof secondary === "number" ? `secondary ${secondary}%` : undefined,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" / ") : "未知";
}
