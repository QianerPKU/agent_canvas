import { useEffect, useRef, useState } from "react";
import type { Node, NodeProps } from "@xyflow/react";
import type { AgentStatus } from "@agent-canvas/shared";
import type { AgentView, OutputLine } from "../agentStore.js";
import type { AgentActions } from "../useAgentCanvas.js";

export interface AgentNodeData {
  view: AgentView;
  actions: AgentActions;
  [key: string]: unknown;
}

export type AgentNodeType = Node<AgentNodeData, "agent">;

const STATUS_META: Record<AgentStatus, { label: string; color: string }> = {
  idle: { label: "空闲", color: "#6b7280" },
  starting: { label: "启动中", color: "#d97706" },
  running: { label: "运行中", color: "#2563eb" },
  waiting_input: { label: "待输入", color: "#0d9488" },
  done: { label: "完成", color: "#16a34a" },
  stopped: { label: "已停止", color: "#6b7280" },
  error: { label: "错误", color: "#dc2626" },
};

function short(v: unknown, n = 120): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function lineStyle(kind: OutputLine["kind"], isError?: boolean): React.CSSProperties {
  if (isError) return { color: "#dc2626" };
  switch (kind) {
    case "assistant":
      return { color: "#111827" };
    case "tool_use":
      return { color: "#7c3aed", fontFamily: "monospace" };
    case "tool_result":
      return { color: "#374151", fontFamily: "monospace" };
    case "system":
      return { color: "#6b7280", fontStyle: "italic" };
    case "result":
      return { color: "#16a34a" };
    case "error":
      return { color: "#dc2626" };
  }
}

function renderLine(line: OutputLine): string {
  switch (line.kind) {
    case "assistant":
      return line.text;
    case "tool_use":
      return `🔧 ${line.name}(${short(line.input)})`;
    case "tool_result":
      return `↩ ${short(line.content)}`;
    case "system":
      return line.text;
    case "result":
      return `✅ ${line.text}`;
    case "error":
      return `❌ ${line.text}`;
  }
}

export function AgentNode({ data }: NodeProps<AgentNodeType>): React.ReactElement {
  const { view, actions } = data;
  const [prompt, setPrompt] = useState("");
  const [intervene, setIntervene] = useState("");
  const logRef = useRef<HTMLDivElement>(null);

  const meta = STATUS_META[view.status];
  const active = view.status === "starting" || view.status === "running" || view.status === "waiting_input";
  const canSend = view.status === "running" || view.status === "waiting_input";

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [view.lines.length]);

  return (
    <div
      style={{
        width: 320,
        background: "#fff",
        border: `1px solid #e5e7eb`,
        borderTop: `3px solid ${meta.color}`,
        borderRadius: 8,
        boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
        fontSize: 12,
        overflow: "hidden",
      }}
    >
      {/* 头部 */}
      <div
        className="drag-handle"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 10px",
          background: "#f9fafb",
          cursor: "grab",
        }}
      >
        <span style={{ fontWeight: 600 }}>{view.id}</span>
        <span
          style={{
            marginLeft: "auto",
            color: "#fff",
            background: meta.color,
            borderRadius: 10,
            padding: "1px 8px",
            fontSize: 11,
          }}
        >
          {meta.label}
        </span>
      </div>

      {/* 元信息 */}
      <div style={{ padding: "4px 10px", color: "#6b7280", fontSize: 11, display: "flex", gap: 10 }}>
        {view.model && <span>模型 {view.model}</span>}
        {view.costUsd != null && <span>花费 ${view.costUsd.toFixed(4)}</span>}
      </div>

      {/* 实时输出 */}
      <div
        ref={logRef}
        className="nodrag nowheel"
        style={{
          height: 160,
          overflowY: "auto",
          padding: "6px 10px",
          borderTop: "1px solid #f3f4f6",
          borderBottom: "1px solid #f3f4f6",
          background: "#fff",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {view.lines.length === 0 ? (
          <span style={{ color: "#9ca3af" }}>（暂无输出）</span>
        ) : (
          view.lines.map((line, i) => (
            <div key={i} style={lineStyle(line.kind, line.kind === "tool_result" ? line.isError : undefined)}>
              {renderLine(line)}
            </div>
          ))
        )}
      </div>

      {/* 控制区 */}
      <div className="nodrag" style={{ padding: 10, display: "flex", flexDirection: "column", gap: 6 }}>
        {canSend ? (
          <>
            <textarea
              value={intervene}
              onChange={(e) => setIntervene(e.target.value)}
              placeholder="追加指令（中途干预）…"
              rows={2}
              style={textareaStyle}
            />
            <div style={{ display: "flex", gap: 6 }}>
              <button
                style={btn("#0d9488")}
                disabled={!intervene.trim()}
                onClick={() => {
                  void actions.send(view.id, intervene.trim());
                  setIntervene("");
                }}
              >
                发送
              </button>
              <button style={btn("#dc2626")} onClick={() => void actions.stop(view.id)}>
                停止
              </button>
            </div>
          </>
        ) : active ? (
          <button style={btn("#dc2626")} onClick={() => void actions.stop(view.id)}>
            停止
          </button>
        ) : (
          <>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="输入任务/提示词…"
              rows={3}
              style={textareaStyle}
            />
            <button
              style={btn("#2563eb")}
              disabled={!prompt.trim()}
              onClick={() => void actions.start(view.id, { prompt: prompt.trim() })}
            >
              ▶ 启动
            </button>
          </>
        )}
      </div>
    </div>
  );
}

const textareaStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  resize: "vertical",
  fontSize: 12,
  padding: 6,
  border: "1px solid #d1d5db",
  borderRadius: 6,
  fontFamily: "inherit",
};

function btn(color: string): React.CSSProperties {
  return {
    flex: 1,
    background: color,
    color: "#fff",
    border: "none",
    borderRadius: 6,
    padding: "6px 10px",
    cursor: "pointer",
    fontSize: 12,
  };
}
