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
  X,
} from "lucide-react";
import { api } from "./api.js";
import type {
  AgentCanvasSettings,
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
  WorkspaceProject,
  PullRequestFlowSnapshot,
  SyncFlowSnapshot,
} from "@agent-canvas/shared";
import "@xyflow/react/dist/style.css";
import { useAgentCanvas, type AgentActions, type FileActions } from "./useAgentCanvas.js";
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
const FILE_ROW_H = 280;
const DEFAULT_NODE_WIDTH = 360;
const DEFAULT_NODE_HEIGHT = 300;
const FILE_NODE_WIDTH = 280;
const FILE_NODE_HEIGHT = 240;
const PROMPT_NODE_WIDTH = 300;
const PROMPT_NODE_HEIGHT = 260;
const COMMIT_NODE_WIDTH = 270;
const COMMIT_NODE_HEIGHT = 170;
const PR_NODE_WIDTH = 290;
const PR_NODE_HEIGHT = 180;
const SYNC_NODE_WIDTH = 290;
const SYNC_NODE_HEIGHT = 180;
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
const X0 = 40;
const Y0 = 40;
const NODE_GAP = 36;
const TURN_VERTICAL_GAP = 24;
const DERIVED_NODE_GAP = 24;

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
type NodeRect = NodePosition & { width: number; height: number };
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

function nodeRect(node: CanvasNode): NodeRect {
  return {
    ...node.position,
    width: nodeWidth(node),
    height: nodeHeight(node),
  };
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

function intersects(a: NodeRect, b: NodeRect): boolean {
  return (
    a.x < b.x + b.width + DERIVED_NODE_GAP &&
    a.x + a.width + DERIVED_NODE_GAP > b.x &&
    a.y < b.y + b.height + DERIVED_NODE_GAP &&
    a.y + a.height + DERIVED_NODE_GAP > b.y
  );
}

function isFree(position: NodePosition, width: number, height: number, occupied: NodeRect[]): boolean {
  const candidate = { ...position, width, height };
  return !occupied.some((rect) => intersects(candidate, rect));
}

function findFreePosition(
  preferred: NodePosition,
  width: number,
  height: number,
  occupied: NodeRect[],
): NodePosition {
  for (let column = 0; column < 8; column++) {
    for (let row = 0; row < 10; row++) {
      const candidate = {
        x: preferred.x + column * (width + NODE_GAP),
        y: preferred.y + row * (height + NODE_GAP),
      };
      if (isFree(candidate, width, height, occupied)) return candidate;
    }
  }
  return preferred;
}

function turnPosition(
  id: string,
  viewId: string,
  index: number,
  layout: Record<string, NodePosition>,
  placed: Map<string, CanvasNode>,
  occupied: NodeRect[],
): NodePosition {
  if (index === 0) return layout[id] ?? { x: X0, y: Y0 };
  const previous = placed.get(nodeId(viewId, index - 1));
  if (!previous) return layout[id] ?? { x: X0, y: Y0 + index * ROW_H };
  const preferred = {
    x: previous.position.x,
    y: previous.position.y + nodeHeight(previous) + TURN_VERTICAL_GAP,
  };
  return findFreePosition(preferred, DEFAULT_NODE_WIDTH, DEFAULT_NODE_HEIGHT, occupied);
}

function anchoredSidePosition(
  source: CanvasNode | undefined,
  fallback: NodePosition,
  width: number,
  height: number,
  occupied: NodeRect[],
): NodePosition {
  if (!source) return findFreePosition(fallback, width, height, occupied);
  const sourceWidth =
    source.type === "turn"
      ? Math.max(
          nodeWidth(source),
          source.data.windowState?.restoreWidth ?? DEFAULT_NODE_WIDTH,
          DEFAULT_NODE_WIDTH,
        )
      : nodeWidth(source);
  return findFreePosition(
    {
      x: source.position.x + sourceWidth + NODE_GAP,
      y: source.position.y,
    },
    width,
    height,
    occupied,
  );
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
  return windowState?.minimized ? 68 : DEFAULT_NODE_WIDTH;
}

function turnHeight(windowState: TurnNodeType["data"]["windowState"]): number {
  return windowState?.minimized ? 48 : DEFAULT_NODE_HEIGHT;
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
  onCreateBranch?: (branch: string, baseBranch?: string) => Promise<BranchWorkspace>,
): CanvasNode[] {
  const layout = computeLayout(agents);
  const byId = new Map(current.map((node) => [node.id, node]));
  const savedById = layoutById(savedLayout);
  const result: CanvasNode[] = [];
  const placed = new Map<string, CanvasNode>();
  const occupied: NodeRect[] = [];
  const pushNode = (node: CanvasNode) => {
    result.push(node);
    placed.set(node.id, node);
    occupied.push(nodeRect(node));
  };

  for (const view of Object.values(agents)) {
    view.turns.forEach((turn, index) => {
      const id = nodeId(view.id, index);
      const placement = placementOverrides[id];
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
        providerLocked: !!view.forkOrigin,
        isLatest,
        windowState,
        onOpenHistory,
        onOpenSettings: isLatest ? onOpenAgentSettings : undefined,
        branches,
        onCreateBranch,
        actions,
      };
      if (existingTurn) {
        pushNode({
          ...existingTurn,
          position: placement
            ? findFreePosition(
                placement,
                nodeWidth(existingTurn),
                nodeHeight(existingTurn),
                occupied,
              )
            : existingTurn.position,
          width: windowState?.minimized ? 68 : existingTurn.width,
          height: windowState?.minimized ? 48 : existingTurn.height,
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
                width,
                height,
                occupied,
              )
            : turnPosition(id, view.id, index, layout, placed, occupied);
        const positionedAt =
          index === 0 && placement
            ? findFreePosition(
                placement,
                width,
                height,
                occupied,
              )
            : fallbackPosition;
        pushNode({
          id,
          type: "turn",
          position: stored?.position ?? positionedAt,
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
    const placement = placementOverrides[id];
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
            position: placement
              ? findFreePosition(
                  placement,
                  nodeWidth(existingFile),
                  nodeHeight(existingFile),
                  occupied,
                )
              : existingFile.position,
            data,
          }
        : {
            id,
            type: "file",
            position:
              stored?.position ??
              (placement
                ? findFreePosition(
                    placement,
                    FILE_NODE_WIDTH,
                    FILE_NODE_HEIGHT,
                    occupied,
                  )
                : sourceNode
                  ? anchoredSidePosition(
                      sourceNode,
                      { x: fileX, y: Y0 + index * FILE_ROW_H },
                      FILE_NODE_WIDTH,
                      FILE_NODE_HEIGHT,
                      occupied,
                    )
                  : findFreePosition(
                      { x: fileX, y: Y0 + index * FILE_ROW_H },
                      FILE_NODE_WIDTH,
                      FILE_NODE_HEIGHT,
                      occupied,
                    )),
            width: stored?.width ?? (windowState?.minimized ? 68 : FILE_NODE_WIDTH),
            height: stored?.height ?? (windowState?.minimized ? 48 : FILE_NODE_HEIGHT),
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
            position: placement
              ? findFreePosition(
                  placement,
                  nodeWidth(existingPrompt),
                  nodeHeight(existingPrompt),
                  occupied,
                )
              : existingPrompt.position,
            data,
          }
        : {
            id,
            type: "prompt",
            position:
              stored?.position ??
              findFreePosition(
                placement ?? { x: promptX, y: Y0 + index * FILE_ROW_H },
                PROMPT_NODE_WIDTH,
                PROMPT_NODE_HEIGHT,
                occupied,
              ),
            width: stored?.width ?? (windowState?.minimized ? 68 : PROMPT_NODE_WIDTH),
            height: stored?.height ?? (windowState?.minimized ? 48 : PROMPT_NODE_HEIGHT),
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
                COMMIT_NODE_WIDTH,
                COMMIT_NODE_HEIGHT,
                occupied,
              ),
            width: stored?.width ?? (windowState?.minimized ? 76 : COMMIT_NODE_WIDTH),
            height: stored?.height ?? (windowState?.minimized ? 48 : COMMIT_NODE_HEIGHT),
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
                PR_NODE_WIDTH,
                PR_NODE_HEIGHT,
                occupied,
              ),
            width: stored?.width ?? (windowState?.minimized ? 76 : PR_NODE_WIDTH),
            height: stored?.height ?? (windowState?.minimized ? 48 : PR_NODE_HEIGHT),
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
                SYNC_NODE_WIDTH,
                SYNC_NODE_HEIGHT,
                occupied,
              ),
            width: stored?.width ?? (windowState?.minimized ? 76 : SYNC_NODE_WIDTH),
            height: stored?.height ?? (windowState?.minimized ? 48 : SYNC_NODE_HEIGHT),
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
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [savedLayout, setSavedLayout] = useState<CanvasLayoutSnapshot>({
    nodes: [],
    updatedAt: 0,
  });
  const [layoutProjectId, setLayoutProjectId] = useState<string>();
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
  });
  const [agentSettingsTarget, setAgentSettingsTarget] = useState<AgentSettingsTarget>();
  const [projects, setProjects] = useState<CanvasProjectSummary[]>([]);
  const [workspace, setWorkspace] = useState<WorkspaceProject>();
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

  const rememberNodePlacement = useCallback((id: string, width: number, height: number) => {
    const flow = flowRef.current;
    const bounds = canvasWrapRef.current?.getBoundingClientRect();
    if (!flow || !bounds) return;
    const center = flow.screenToFlowPosition({
      x: bounds.left + bounds.width / 2,
      y: bounds.top + bounds.height / 2,
    });
    const position = centeredNodePosition(center, width, height);
    setPendingPlacements((current) => ({
      ...current,
      [id]: position,
    }));
  }, []);

  useEffect(() => {
    let cancelled = false;
    void api.listCanvasProjects().then(
      (nextProjects) => {
        if (!cancelled) setProjects(nextProjects);
      },
      (error) => {
        if (!cancelled) setProjectError(error instanceof Error ? error.message : String(error));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void api.settings().then(
      (settings) => {
        if (!cancelled) setAppSettings(settings);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const updateAppSettings = useCallback(async (settings: Partial<AgentCanvasSettings>) => {
    const updated = await api.updateSettings(settings);
    setAppSettings(updated);
  }, []);

  const refreshBranchOptions = useCallback(async () => {
    const nextBranches = await api.listBranchOptions();
    setBranches(nextBranches);
    return nextBranches;
  }, []);

  const openProject = useCallback(
    async (id: string) => {
      setProjectError(undefined);
      try {
        setLayoutProjectId(undefined);
        const nextWorkspace = await api.openCanvasProject(id);
        const nextLayout = await api.canvasLayout();
        setNodes([]);
        setEdges([]);
        setPendingPlacements({});
        setSavedLayout(nextLayout);
        await refresh();
        setWorkspace(nextWorkspace);
        setLayoutProjectId(nextWorkspace.canvasProject?.id);
        setProjects(await api.listCanvasProjects());
        setBranches(nextWorkspace.repo ? await api.listBranchOptions() : []);
      } catch (error) {
        setProjectError(error instanceof Error ? error.message : String(error));
      }
    },
    [refresh, setEdges, setNodes],
  );

  const createProject = useCallback(
    async (name: string, projectRoot?: string) => {
      setProjectError(undefined);
      try {
        setLayoutProjectId(undefined);
        const { workspace: nextWorkspace } = await api.createCanvasProject({
          name,
          projectRoot: projectRoot?.trim() || undefined,
        });
        const nextLayout = await api.canvasLayout();
        setNodes([]);
        setEdges([]);
        setPendingPlacements({});
        setSavedLayout(nextLayout);
        await refresh();
        setWorkspace(nextWorkspace);
        setLayoutProjectId(nextWorkspace.canvasProject?.id);
        setProjects(await api.listCanvasProjects());
        setBranches([]);
      } catch (error) {
        setProjectError(error instanceof Error ? error.message : String(error));
      }
    },
    [refresh, setEdges, setNodes],
  );

  const connectRepo = useCallback(
    async (input: { remoteUrl: string; defaultBranch?: string }) => {
      setProjectError(undefined);
      try {
        const nextWorkspace = await api.connectWorkspace(input);
        setWorkspace(nextWorkspace);
        await refreshBranchOptions();
      } catch (error) {
        setProjectError(error instanceof Error ? error.message : String(error));
      }
    },
    [refreshBranchOptions],
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

  const createBranch = useCallback(async (branch: string, baseBranch?: string) => {
    const created = await api.createBranch({ branch, baseBranch });
    await refreshBranchOptions();
    return created;
  }, [refreshBranchOptions]);

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
    setPendingPlacements((current) => {
      let changed = false;
      const next = { ...current };
      for (const node of nodes) {
        if (next[node.id]) {
          delete next[node.id];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [nodes, pendingPlacements]);

  useEffect(() => {
    if (!workspace?.canvasProject?.id || workspace.canvasProject.id !== layoutProjectId) return;
    if (nodes.length === 0 && savedLayout.nodes.length > 0) return;
    const timer = window.setTimeout(() => {
      const layout = canvasLayoutFromNodes(nodes);
      void api.saveCanvasLayout(layout).catch(() => undefined);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [layoutProjectId, nodes, savedLayout.nodes.length, workspace?.canvasProject?.id]);

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
        onOpen={openProject}
        onCreate={createProject}
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
            const file = await fileActions.create(input);
            rememberNodePlacement(fileNodeId(file.id), FILE_NODE_WIDTH, FILE_NODE_HEIGHT);
          }}
          onClose={() => setCreatingFile(false)}
        />
      )}
      {agentSettingsTarget?.mode === "create" && (
        <AgentSettingsDialog
          mode="create"
          branches={branches}
          onCreateBranch={createBranch}
          onCreate={async (settings) => {
            const id = await actions.create(settings);
            rememberNodePlacement(nodeId(id, 0), DEFAULT_NODE_WIDTH, DEFAULT_NODE_HEIGHT);
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
            const prompt = await promptActions.create(input);
            rememberNodePlacement(promptNodeId(prompt.id), PROMPT_NODE_WIDTH, PROMPT_NODE_HEIGHT);
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
          onUpdate={updateAppSettings}
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
    </div>
  );
}

export function ProjectGate({
  connected,
  projects,
  error,
  onOpen,
  onCreate,
}: {
  connected: boolean;
  projects: CanvasProjectSummary[];
  error?: string;
  onOpen: (id: string) => Promise<void>;
  onCreate: (name: string, projectRoot?: string) => Promise<void>;
}): React.ReactElement {
  const [name, setName] = useState("");
  const [projectRoot, setProjectRoot] = useState("");
  const [busy, setBusy] = useState(false);
  const [pickingDirectory, setPickingDirectory] = useState(false);
  const [pickError, setPickError] = useState("");
  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed || pickingDirectory) return;
    setBusy(true);
    try {
      await onCreate(trimmed, projectRoot);
    } finally {
      setBusy(false);
    }
  };
  const browse = async () => {
    setPickError("");
    setPickingDirectory(true);
    try {
      const picked = await api.pickDirectory(projectRoot.trim() || undefined);
      if (picked.path) setProjectRoot(picked.path);
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
              <button
                key={project.id}
                className="project-row"
                disabled={busy || pickingDirectory}
                onClick={() => void onOpen(project.id)}
              >
                <FolderOpen size={18} />
                <span>
                  <strong>{project.name}</strong>
                  <small>{project.projectRoot}</small>
                </span>
              </button>
            ))}
            {projects.length === 0 && <p className="project-empty">暂无项目</p>}
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
              <button type="button" disabled={busy || pickingDirectory} onClick={() => void browse()}>
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

function AppSettingsDialog({
  settings,
  onUpdate,
  onClose,
}: {
  settings: AgentCanvasSettings;
  onUpdate: (settings: Partial<AgentCanvasSettings>) => Promise<void>;
  onClose: () => void;
}): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const toggleFullPermission = async (fullPermissionMode: boolean) => {
    setBusy(true);
    try {
      await onUpdate({ fullPermissionMode });
    } finally {
      setBusy(false);
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
            onChange={(event) => void toggleFullPermission(event.target.checked)}
          />
          <span>
            <strong>完全权限模式</strong>
            <small>开启后所有授权请求由后端直接允许，不再等待前端审批。</small>
          </span>
        </label>
      </section>
    </div>
  );
}
