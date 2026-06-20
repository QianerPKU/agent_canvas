import { useCallback, useEffect, useState } from "react";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
} from "@xyflow/react";
import { FilePlus2, MessageSquarePlus, X } from "lucide-react";
import { api } from "./api.js";
import type {
  CanvasFileConnection,
  CanvasFileNode,
  CanvasPromptConnection,
  CanvasPromptNode,
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
import { CreatePromptDialog } from "./prompts/CreatePromptDialog.js";
import { PromptNode, type PromptNodeType } from "./prompts/PromptNode.js";
import type { PromptActions } from "./useAgentCanvas.js";

const nodeTypes = { turn: TurnNode, file: FileNode, prompt: PromptNode };

const COL_W = 430;
const ROW_H = 360;
const FILE_ROW_H = 280;
const DEFAULT_NODE_WIDTH = 360;
const DEFAULT_NODE_HEIGHT = 300;
const FILE_NODE_WIDTH = 280;
const FILE_NODE_HEIGHT = 240;
const PROMPT_NODE_WIDTH = 300;
const PROMPT_NODE_HEIGHT = 260;
const X0 = 40;
const Y0 = 40;

type CanvasNode = TurnNodeType | FileNodeType | PromptNodeType;

function nodeId(agentId: string, turnIndex: number): string {
  return `${agentId}#${turnIndex}`;
}

function fileNodeId(fileId: string): string {
  return `file:${fileId}`;
}

function promptNodeId(promptId: string): string {
  return `prompt:${promptId}`;
}

function anchorIndex(agents: AgentMap, parentId: string, anchorUuid: string): number {
  const parent = agents[parentId];
  if (!parent) return -1;
  return parent.turns.findIndex((turn) => turn.anchorUuid === anchorUuid);
}

function computeLayout(agents: AgentMap): Record<string, { x: number; y: number }> {
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
    if (!agent || ["done", "stopped", "terminated", "error"].includes(agent.status)) continue;
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

export function computePromptEdges(
  agents: AgentMap,
  connections: CanvasPromptConnection[],
): Edge[] {
  const edges: Edge[] = [];
  for (const connection of connections) {
    const agent = agents[connection.agentId];
    if (!agent || ["done", "stopped", "terminated", "error"].includes(agent.status)) continue;
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

function buildNodes(
  agents: AgentMap,
  files: CanvasFileNode[],
  prompts: CanvasPromptNode[],
  actions: AgentActions,
  fileActions: FileActions,
  promptActions: PromptActions,
  current: CanvasNode[],
  onOpenHistory: (agentId: string, turnIndex: number) => void,
  onPreviewFile: (fileId: string) => void,
  onOpenFileEditor: (fileId: string) => void,
): CanvasNode[] {
  const layout = computeLayout(agents);
  const byId = new Map(current.map((node) => [node.id, node]));
  const result: CanvasNode[] = [];
  for (const view of Object.values(agents)) {
    view.turns.forEach((turn, index) => {
      const id = nodeId(view.id, index);
      const existing = byId.get(id);
      const existingTurn = existing?.type === "turn" ? existing : undefined;
      const data = {
        agentId: view.id,
        turn,
        agentStatus: view.status,
        provider: view.provider,
        model: view.model,
        providerLocked: !!view.forkOrigin,
        isLatest: index === view.turns.length - 1,
        windowState: existingTurn?.data.windowState,
        onOpenHistory,
        actions,
      };
      if (existingTurn) {
        result.push({ ...existingTurn, data });
      } else {
        result.push({
          id,
          type: "turn",
          position: layout[id] ?? { x: X0, y: Y0 },
          width: DEFAULT_NODE_WIDTH,
          height: DEFAULT_NODE_HEIGHT,
          dragHandle: ".drag-handle",
          data,
        });
      }
    });
  }

  const fileX = X0 + Math.max(Object.keys(agents).length, 1) * COL_W;
  files.forEach((file, index) => {
    const id = fileNodeId(file.id);
    const existing = byId.get(id);
    const existingFile = existing?.type === "file" ? existing : undefined;
    const data = {
      file,
      actions: fileActions,
      onPreview: onPreviewFile,
      onOpenEditor: onOpenFileEditor,
    };
    result.push(
      existingFile
        ? { ...existingFile, data }
        : {
            id,
            type: "file",
            position: { x: fileX, y: Y0 + index * FILE_ROW_H },
            width: FILE_NODE_WIDTH,
            height: FILE_NODE_HEIGHT,
            dragHandle: ".drag-handle",
            data,
          },
    );
  });

  const promptX = fileX + 340;
  prompts.forEach((prompt, index) => {
    const id = promptNodeId(prompt.id);
    const existing = byId.get(id);
    const existingPrompt = existing?.type === "prompt" ? existing : undefined;
    const data = { prompt, actions: promptActions };
    result.push(
      existingPrompt
        ? { ...existingPrompt, data }
        : {
            id,
            type: "prompt",
            position: { x: promptX, y: Y0 + index * FILE_ROW_H },
            width: PROMPT_NODE_WIDTH,
            height: PROMPT_NODE_HEIGHT,
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
    connected,
    actions,
    fileActions,
    promptActions,
  } = useAgentCanvas();
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [historyTarget, setHistoryTarget] = useState<HistoryTarget>();
  const [openFileId, setOpenFileId] = useState<string>();
  const [fileOpenError, setFileOpenError] = useState<string>();
  const [creatingFile, setCreatingFile] = useState(false);
  const [creatingPrompt, setCreatingPrompt] = useState(false);
  const openFile = files.find((file) => file.id === openFileId);

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

  useEffect(() => {
    setNodes((current) =>
      buildNodes(
        agents,
        files,
        prompts,
        actions,
        fileActions,
        promptActions,
        current,
        openHistory,
        setOpenFileId,
        openFileEditor,
      ),
    );
    setEdges([
      ...computeConversationEdges(agents),
      ...computeFileEdges(agents, fileConnections),
      ...computePromptEdges(agents, promptConnections),
    ]);
  }, [
    agents,
    files,
    fileConnections,
    prompts,
    promptConnections,
    actions,
    fileActions,
    promptActions,
    openHistory,
    openFileEditor,
    setNodes,
    setEdges,
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

  return (
    <div className="app-shell">
      <header className="app-header">
        <strong>agent_canvas</strong>
        <span className={connected ? "connection-state is-connected" : "connection-state"}>
          {connected ? "● 已连接后端" : "● 未连接"}
        </span>
        <span className="app-header__hint">
          节点代表一轮对话，资源连线控制当前 Agent 的读写权限
        </span>
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
        <button className="header-button" onClick={() => void actions.create()}>
          新建 Agent
        </button>
      </header>

      <div className="canvas-wrap">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
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
          agents={agents}
          onCreate={async (input) => {
            await fileActions.create(input);
          }}
          onClose={() => setCreatingFile(false)}
        />
      )}
      {creatingPrompt && (
        <CreatePromptDialog
          onCreate={async (input) => {
            await promptActions.create(input);
          }}
          onClose={() => setCreatingPrompt(false)}
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
