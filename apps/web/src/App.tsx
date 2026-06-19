import { useEffect } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useAgentCanvas } from "./useAgentCanvas.js";
import { AgentNode, type AgentNodeType } from "./nodes/AgentNode.js";

const nodeTypes = { agent: AgentNode };

function gridPos(index: number) {
  return { x: 40 + (index % 3) * 360, y: 40 + Math.floor(index / 3) * 320 };
}

export default function App(): React.ReactElement {
  const { agents, connected, actions } = useAgentCanvas();
  const [nodes, setNodes, onNodesChange] = useNodesState<AgentNodeType>([]);

  // 把 agents 视图表同步进 React Flow 节点：更新已有节点的 data、为新 agent 建节点（保留拖动位置）
  useEffect(() => {
    setNodes((cur) => {
      const byId = new Map(cur.map((n) => [n.id, n]));
      const result: AgentNodeType[] = [];
      let added = 0;
      for (const view of Object.values(agents)) {
        const existing = byId.get(view.id);
        if (existing) {
          result.push({ ...existing, data: { ...existing.data, view } });
        } else {
          result.push({
            id: view.id,
            type: "agent",
            position: gridPos(cur.length + added++),
            dragHandle: ".drag-handle",
            data: { view, actions },
          });
        }
      }
      return result;
    });
  }, [agents, actions, setNodes]);

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
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
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
