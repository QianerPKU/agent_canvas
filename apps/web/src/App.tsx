import { useEffect } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useAgentCanvas } from "./useAgentCanvas.js";
import { TurnNode, type TurnNodeType } from "./nodes/TurnNode.js";
import type { AgentMap } from "./agentStore.js";
import type { AgentActions } from "./useAgentCanvas.js";

const nodeTypes = { turn: TurnNode };

const COL_W = 430;
const ROW_H = 280;
const X0 = 40;
const Y0 = 40;

function nodeId(agentId: string, turnIndex: number): string {
  return `${agentId}#${turnIndex}`;
}

/** 找到父 agent 中锚点 uuid 对应的轮次 index。 */
function anchorIndex(agents: AgentMap, parentId: string, anchorUuid: string): number {
  const parent = agents[parentId];
  if (!parent) return -1;
  return parent.turns.findIndex((t) => t.anchorUuid === anchorUuid);
}

/** 计算每个轮次节点的初始位置：每个 agent 一列，轮次向下；fork 出来的 agent 另起一列、对齐到锚点轮的高度。 */
function computeLayout(agents: AgentMap): Record<string, { x: number; y: number }> {
  const pos: Record<string, { x: number; y: number }> = {};
  const baseY: Record<string, number> = {};
  let col = 0;
  for (const view of Object.values(agents)) {
    const c = col++;
    let by = 0;
    if (view.forkOrigin) {
      const pBase = baseY[view.forkOrigin.parentAgentId] ?? 0;
      const ai = anchorIndex(agents, view.forkOrigin.parentAgentId, view.forkOrigin.anchorUuid);
      by = pBase + (ai >= 0 ? ai : 0) * ROW_H;
    }
    baseY[view.id] = by;
    view.turns.forEach((_, i) => {
      pos[nodeId(view.id, i)] = { x: X0 + c * COL_W, y: Y0 + by + i * ROW_H };
    });
  }
  return pos;
}

function computeEdges(agents: AgentMap): Edge[] {
  const edges: Edge[] = [];
  for (const view of Object.values(agents)) {
    // 轮次链
    for (let i = 1; i < view.turns.length; i++) {
      edges.push({ id: `${view.id}#${i - 1}->${i}`, source: nodeId(view.id, i - 1), target: nodeId(view.id, i) });
    }
    // fork 连线（父某轮 → 子第 0 轮）
    if (view.forkOrigin) {
      const ai = anchorIndex(agents, view.forkOrigin.parentAgentId, view.forkOrigin.anchorUuid);
      if (ai >= 0) {
        edges.push({
          id: `fork->${view.id}`,
          source: nodeId(view.forkOrigin.parentAgentId, ai),
          sourceHandle: "fork",
          target: nodeId(view.id, 0),
          animated: true,
          label: "fork",
          style: { stroke: "#7c3aed" },
        });
      }
    }
  }
  return edges;
}

function buildNodes(agents: AgentMap, actions: AgentActions, cur: TurnNodeType[]): TurnNodeType[] {
  const layout = computeLayout(agents);
  const byId = new Map(cur.map((n) => [n.id, n]));
  const result: TurnNodeType[] = [];
  for (const view of Object.values(agents)) {
    view.turns.forEach((turn, i) => {
      const id = nodeId(view.id, i);
      const data = {
        agentId: view.id,
        turn,
        agentStatus: view.status,
        provider: view.provider,
        model: view.model,
        providerLocked: !!view.forkOrigin,
        actions,
      };
      const existing = byId.get(id);
      if (existing) {
        result.push({ ...existing, data }); // 保留已拖动位置，仅更新数据
      } else {
        result.push({
          id,
          type: "turn",
          position: layout[id] ?? { x: X0, y: Y0 },
          dragHandle: ".drag-handle",
          data,
        });
      }
    });
  }
  return result;
}

export default function App(): React.ReactElement {
  const { agents, connected, actions } = useAgentCanvas();
  const [nodes, setNodes, onNodesChange] = useNodesState<TurnNodeType>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  useEffect(() => {
    setNodes((cur) => buildNodes(agents, actions, cur));
    setEdges(computeEdges(agents));
  }, [agents, actions, setNodes, setEdges]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", width: "100vw" }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "10px 16px",
          borderBottom: "1px solid #e5e7eb",
          background: "#fff",
        }}
      >
        <strong style={{ fontSize: 15 }}>agent_canvas</strong>
        <span style={{ fontSize: 12, color: connected ? "#16a34a" : "#dc2626" }}>
          {connected ? "● 已连接后端" : "○ 未连接"}
        </span>
        <span style={{ fontSize: 12, color: "#9ca3af" }}>
          节点=一轮对话 · 完成后自动延伸待输入轮 · 可从任意完成轮 fork
        </span>
        <button
          onClick={() => void actions.create()}
          style={{
            marginLeft: "auto",
            background: "#2563eb",
            color: "#fff",
            border: "none",
            borderRadius: 6,
            padding: "6px 14px",
            cursor: "pointer",
            fontSize: 13,
          }}
        >
          ＋ 新建 agent
        </button>
      </header>

      <div style={{ flex: 1, minHeight: 0 }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <MiniMap pannable zoomable />
          <Controls />
        </ReactFlow>
      </div>
    </div>
  );
}
