import { useEffect, useRef, useState } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { AgentProvider, AgentStatus } from "@agent-canvas/shared";
import type { OutputLine, Turn, TurnStatus } from "../agentStore.js";
import type { AgentActions } from "../useAgentCanvas.js";

export interface TurnNodeData {
  agentId: string;
  turn: Turn;
  agentStatus: AgentStatus;
  provider?: AgentProvider;
  providerLocked?: boolean;
  actions: AgentActions;
  [key: string]: unknown;
}

export type TurnNodeType = Node<TurnNodeData, "turn">;

const TURN_META: Record<TurnStatus, { label: string; color: string }> = {
  idle: { label: "待输入", color: "#6b7280" },
  running: { label: "运行中", color: "#2563eb" },
  done: { label: "完成", color: "#16a34a" },
  error: { label: "错误", color: "#dc2626" },
  stopped: { label: "已停止", color: "#6b7280" },
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

export function TurnNode({ data }: NodeProps<TurnNodeType>): React.ReactElement {
  const { agentId, turn, agentStatus, provider: agentProvider, providerLocked, actions } = data;
  const [text, setText] = useState("");
  const [provider, setProvider] = useState<AgentProvider>(agentProvider ?? "claude");
  const logRef = useRef<HTMLDivElement>(null);

  const meta = TURN_META[turn.status];
  // 末尾 idle 轮且可输入：首轮看 agent idle，续轮看 agent waiting_input
  const isActiveInput =
    turn.status === "idle" &&
    (turn.index === 0 ? agentStatus === "idle" : agentStatus === "waiting_input");
  const canFork = turn.status === "done" && !!turn.anchorUuid;
  const isRunning = turn.status === "running";

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turn.lines.length]);

  useEffect(() => {
    setProvider(agentProvider ?? "claude");
  }, [agentProvider]);

  return (
    <div
      style={{
        width: 300,
        background: "#fff",
        border: "1px solid #e5e7eb",
        borderTop: `3px solid ${meta.color}`,
        borderRadius: 8,
        boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
        fontSize: 12,
        overflow: "hidden",
      }}
    >
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />

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
        <span style={{ fontWeight: 600 }}>第 {turn.index + 1} 轮</span>
        <span style={{ color: "#9ca3af", fontSize: 10 }}>{agentId}</span>
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

      {/* 该轮用户输入 */}
      {turn.userInput && (
        <div style={{ padding: "4px 10px", color: "#374151", background: "#eef2ff" }}>
          <span style={{ color: "#6366f1" }}>你：</span>
          {short(turn.userInput, 140)}
        </div>
      )}

      {/* 输出行（idle 轮且无输出时不显示日志区） */}
      {(turn.lines.length > 0 || isRunning) && (
        <div
          ref={logRef}
          className="nodrag nowheel"
          style={{
            height: 140,
            overflowY: "auto",
            padding: "6px 10px",
            borderTop: "1px solid #f3f4f6",
            background: "#fff",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {turn.lines.length === 0 ? (
            <span style={{ color: "#9ca3af" }}>（运行中…）</span>
          ) : (
            turn.lines.map((line, i) => (
              <div
                key={i}
                style={lineStyle(line.kind, line.kind === "tool_result" ? line.isError : undefined)}
              >
                {renderLine(line)}
              </div>
            ))
          )}
          {turn.costUsd != null && (
            <div style={{ color: "#9ca3af", marginTop: 4 }}>花费 ${turn.costUsd.toFixed(4)}</div>
          )}
        </div>
      )}

      {/* 控制区 */}
      <div className="nodrag" style={{ padding: 10, display: "flex", flexDirection: "column", gap: 6 }}>
        {isActiveInput ? (
          <>
            {turn.index === 0 && (
              <select
                aria-label="agent provider"
                value={provider}
                disabled={providerLocked}
                onChange={(e) => setProvider(e.target.value as AgentProvider)}
                style={selectStyle}
              >
                <option value="claude">Claude</option>
                <option value="codex">Codex</option>
              </select>
            )}
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={turn.index === 0 ? "输入任务/提示词…" : "输入下一轮指令…"}
              rows={3}
              style={textareaStyle}
            />
            <button
              style={btn("#2563eb")}
              disabled={!text.trim()}
              onClick={() => {
                void actions.submit(agentId, text.trim(), turn.index === 0 ? provider : undefined);
                setText("");
              }}
            >
              {turn.index === 0 ? "▶ 启动" : "▶ 发送本轮"}
            </button>
          </>
        ) : isRunning ? (
          <button style={btn("#dc2626")} onClick={() => void actions.stop(agentId)}>
            停止
          </button>
        ) : canFork ? (
          <button
            style={btn("#7c3aed")}
            title="从这一轮的对话状态分叉出一个新 agent"
            onClick={() => void actions.fork(agentId, turn.anchorUuid!)}
          >
            ⑂ 从此轮 fork
          </button>
        ) : (
          <span style={{ color: "#9ca3af", fontSize: 11 }}>（本轮已结束）</span>
        )}
      </div>

      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
      <Handle id="fork" type="source" position={Position.Right} style={{ background: "#7c3aed" }} />
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

const selectStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  fontSize: 12,
  padding: 6,
  border: "1px solid #d1d5db",
  borderRadius: 6,
  fontFamily: "inherit",
  background: "#fff",
};

function btn(color: string): React.CSSProperties {
  return {
    background: color,
    color: "#fff",
    border: "none",
    borderRadius: 6,
    padding: "6px 10px",
    cursor: "pointer",
    fontSize: 12,
  };
}
