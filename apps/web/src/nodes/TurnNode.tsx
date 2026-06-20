import { useEffect, useRef, useState } from "react";
import {
  Handle,
  NodeResizer,
  Position,
  useReactFlow,
  useUpdateNodeInternals,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { MessageSquare, Minimize2 } from "lucide-react";
import {
  CODEX_MODELS,
  DEFAULT_CODEX_MODEL,
  isCodexModel,
  type AgentProvider,
  type AgentStatus,
  type CodexModel,
} from "@agent-canvas/shared";
import type { OutputLine, Turn, TurnStatus } from "../agentStore.js";
import type { AgentActions } from "../useAgentCanvas.js";

export interface TurnNodeData {
  agentId: string;
  turn: Turn;
  agentStatus: AgentStatus;
  provider?: AgentProvider;
  model?: string;
  providerLocked?: boolean;
  isLatest: boolean;
  windowState?: {
    minimized: boolean;
    restoreWidth?: number;
    restoreHeight?: number;
  };
  onOpenHistory: (agentId: string, turnIndex: number) => void;
  actions: AgentActions;
  [key: string]: unknown;
}

export type TurnNodeType = Node<TurnNodeData, "turn">;

export function toggleTurnNodeWindow(node: TurnNodeType): Partial<TurnNodeType> {
  const state = node.data.windowState;
  if (state?.minimized) {
    return {
      width: state.restoreWidth ?? 360,
      height: state.restoreHeight ?? 300,
      data: {
        ...node.data,
        windowState: { ...state, minimized: false },
      },
    };
  }
  return {
    width: 68,
    height: 48,
    data: {
      ...node.data,
      windowState: {
        minimized: true,
        restoreWidth: node.width ?? node.measured?.width ?? 360,
        restoreHeight: node.height ?? node.measured?.height ?? 300,
      },
    },
  };
}

const TURN_META: Record<TurnStatus, { label: string; color: string }> = {
  idle: { label: "待输入", color: "#6b7280" },
  running: { label: "运行中", color: "#2563eb" },
  done: { label: "完成", color: "#16a34a" },
  error: { label: "错误", color: "#dc2626" },
  stopped: { label: "已停止", color: "#6b7280" },
  terminated: { label: "已终止", color: "#111827" },
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
    case "thinking":
      return { color: "#64748b", fontStyle: "italic" };
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
    case "thinking":
      return `思考：${line.text}`;
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

export function TurnNode({
  id,
  data,
}: NodeProps<TurnNodeType>): React.ReactElement {
  const {
    agentId,
    turn,
    agentStatus,
    provider: agentProvider,
    model: agentModel,
    providerLocked,
    isLatest,
    actions,
  } = data;
  const reactFlow = useReactFlow<TurnNodeType>();
  const updateNodeInternals = useUpdateNodeInternals();
  const [text, setText] = useState("");
  const [provider, setProvider] = useState<AgentProvider>(agentProvider ?? "claude");
  const [model, setModel] = useState<CodexModel>(codexModel(agentModel));
  const logRef = useRef<HTMLDivElement>(null);

  const meta = TURN_META[turn.status];
  // 末尾 idle 轮且可输入：首轮看 agent idle，续轮看 agent waiting_input
  const isActiveInput =
    turn.status === "idle" &&
    (turn.index === 0 ? agentStatus === "idle" : agentStatus === "waiting_input");
  const canFork = turn.status === "done" && !!turn.anchorUuid;
  const isRunning = turn.status === "running";
  const canCompact = isLatest && agentStatus === "waiting_input";
  const canTerminate =
    isLatest &&
    (agentStatus === "starting" ||
      agentStatus === "running" ||
      agentStatus === "waiting_input");
  const hasFileHandles =
    isLatest &&
    agentStatus !== "done" &&
    agentStatus !== "stopped" &&
    agentStatus !== "terminated" &&
    agentStatus !== "error";
  const minimized = data.windowState?.minimized === true;

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turn.lines.length]);

  useEffect(() => {
    setProvider(agentProvider ?? "claude");
  }, [agentProvider]);

  useEffect(() => {
    setModel(codexModel(agentModel));
  }, [agentModel]);

  const toggleMinimized = (event: React.MouseEvent) => {
    event.stopPropagation();
    reactFlow.updateNode(id, toggleTurnNodeWindow);
    requestAnimationFrame(() => updateNodeInternals(id));
  };

  const openHistory = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("button, textarea, select, input, .react-flow__resize-control")) return;
    data.onOpenHistory(agentId, turn.index);
  };

  if (minimized) {
    return (
      <div className="turn-node turn-node--minimized">
        <button
          className="turn-node__restore drag-handle"
          title={`恢复 ${agentId} 第 ${turn.index + 1} 轮`}
          onClick={toggleMinimized}
        >
          <MessageSquare size={17} />
          <span>{turn.index + 1}</span>
        </button>
        <NodeHandles fileAccess={hasFileHandles} />
      </div>
    );
  }

  return (
    <div
      className="turn-node"
      onClick={openHistory}
      style={{
        width: "100%",
        height: "100%",
        fontSize: 12,
      }}
    >
      <NodeResizer
        isVisible
        minWidth={280}
        minHeight={260}
        maxWidth={900}
        maxHeight={800}
        color="#94a3b8"
        lineStyle={{ opacity: 0.55 }}
        handleStyle={{ width: 8, height: 8, borderRadius: 2 }}
      />
      <NodeHandles fileAccess={hasFileHandles} />
      <div
        className="turn-node__surface"
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          background: "#fff",
          border: "1px solid #e5e7eb",
          borderTop: `3px solid ${meta.color}`,
          borderRadius: 8,
          boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
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
        <span style={{ fontWeight: 600 }}>第 {turn.index + 1} 轮</span>
        <span style={{ color: "#9ca3af", fontSize: 10 }}>{agentId}</span>
        <button
          className="icon-button nodrag"
          title="最小化节点"
          onClick={toggleMinimized}
          style={{ marginLeft: "auto" }}
        >
          <Minimize2 size={14} />
        </button>
        <span
          style={{
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
            flex: "1 1 140px",
            minHeight: 72,
            overflowY: "auto",
            padding: "6px 10px",
            borderTop: "1px solid #f3f4f6",
            background: "#fff",
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
            lineHeight: 1.55,
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
      <div
        className="nodrag"
        onClick={(event) => event.stopPropagation()}
        style={{ padding: 10, display: "flex", flexDirection: "column", gap: 6 }}
      >
        {isLatest && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            <button
              style={btn("#475569")}
              disabled={!canCompact}
              title="手动压缩当前上下文，并记为一轮完成的对话"
              onClick={() => void actions.compact(agentId)}
            >
              Compact
            </button>
            <button
              style={btn("#111827")}
              disabled={!canTerminate}
              title="关闭这个 agent 的底层 CLI"
              onClick={() => void actions.terminate(agentId)}
            >
              Terminate
            </button>
          </div>
        )}
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
            {turn.index === 0 && provider === "codex" && (
              <CodexModelSelect
                ariaLabel="codex model"
                value={model}
                onChange={setModel}
              />
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
                void actions.submit(
                  agentId,
                  text.trim(),
                  turn.index === 0 ? provider : undefined,
                  turn.index === 0 && provider === "codex" ? model : undefined,
                );
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
          <>
            {agentProvider === "codex" && (
              <CodexModelSelect
                ariaLabel="fork model"
                value={model}
                onChange={setModel}
              />
            )}
            <button
              style={btn("#7c3aed")}
              title="从这一轮的对话状态分叉出一个新 agent"
              onClick={() =>
                void actions.fork(
                  agentId,
                  turn.anchorUuid!,
                  agentProvider === "codex" ? model : undefined,
                )
              }
            >
              ⑂ 从此轮 fork
            </button>
          </>
        ) : (
          <span style={{ color: "#9ca3af", fontSize: 11 }}>（本轮已结束）</span>
        )}
      </div>
      </div>
    </div>
  );
}

function NodeHandles({ fileAccess }: { fileAccess: boolean }): React.ReactElement {
  return (
    <>
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
      <Handle
        id="fork"
        type="source"
        position={Position.Right}
        style={{ top: "24%", background: "#7c3aed" }}
      />
      {fileAccess && (
        <>
          <Handle
            id="file-read"
            type="target"
            position={Position.Left}
            className="turn-node__file-handle turn-node__file-handle--read"
            title="连接文件输出：允许 Agent 读取"
          />
          <span className="turn-node__file-label turn-node__file-label--read">读入</span>
          <Handle
            id="file-write"
            type="source"
            position={Position.Right}
            className="turn-node__file-handle turn-node__file-handle--write"
            title="连接到文件输入：允许 Agent 写入"
          />
          <span className="turn-node__file-label turn-node__file-label--write">写出</span>
        </>
      )}
    </>
  );
}

function CodexModelSelect({
  ariaLabel,
  value,
  onChange,
}: {
  ariaLabel: string;
  value: CodexModel;
  onChange: (model: CodexModel) => void;
}): React.ReactElement {
  return (
    <select
      aria-label={ariaLabel}
      value={value}
      onChange={(event) => onChange(event.target.value as CodexModel)}
      style={selectStyle}
    >
      {CODEX_MODELS.map((candidate) => (
        <option key={candidate} value={candidate}>
          {candidate}
        </option>
      ))}
    </select>
  );
}

function codexModel(model: string | undefined): CodexModel {
  return isCodexModel(model) ? model : DEFAULT_CODEX_MODEL;
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
