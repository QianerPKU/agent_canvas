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
import {
  Check,
  FolderOpen,
  HelpCircle,
  MessageSquare,
  Minimize2,
  Plus,
  Send,
  Settings,
  ShieldAlert,
  Square,
  X,
  Zap,
} from "lucide-react";
import {
  CODEX_MODELS,
  CODEX_REASONING_EFFORTS,
  DEFAULT_CODEX_MODEL,
  isCodexModel,
  type AgentApprovalResponse,
  type AgentQuestionItem,
  type AgentQuestionResponse,
  type AgentProvider,
  type AgentStatus,
  type BranchOption,
  type BranchWorkspace,
  type CodexModel,
  type ForkAgentInput,
} from "@agent-canvas/shared";
import type { OutputLine, Turn, TurnStatus } from "../agentStore.js";
import type { AgentActions } from "../useAgentCanvas.js";

export interface TurnNodeData {
  agentId: string;
  turn: Turn;
  agentStatus: AgentStatus;
  agentBranch?: string;
  agentCwd?: string;
  provider?: AgentProvider;
  model?: string;
  reasoningEffort?: string;
  providerLocked?: boolean;
  isLatest: boolean;
  windowState?: {
    minimized: boolean;
    restoreWidth?: number;
    restoreHeight?: number;
  };
  onOpenHistory: (agentId: string, turnIndex: number) => void;
  onOpenSettings?: (agentId: string) => void;
  branches?: BranchOption[];
  codexModels?: readonly string[];
  defaultCodexModel?: string;
  onCreateBranch?: (branch: string, baseBranch?: string) => Promise<BranchWorkspace>;
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
  stopped: { label: "中断", color: "#6b7280" },
  terminated: { label: "terminated", color: "#111827" },
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
    case "question":
      return { color: "#111827" };
    case "approval":
      return { color: "#111827" };
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
    case "question":
      return line.request.title ?? "需要回答";
    case "approval":
      return line.request.title;
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
    reasoningEffort: agentReasoningEffort,
    isLatest,
    actions,
  } = data;
  const reactFlow = useReactFlow<TurnNodeType>();
  const updateNodeInternals = useUpdateNodeInternals();
  const codexModels = data.codexModels?.length ? data.codexModels : CODEX_MODELS;
  const defaultCodexModel = data.defaultCodexModel ?? DEFAULT_CODEX_MODEL;
  const [text, setText] = useState("");
  const [model, setModel] = useState<CodexModel>(
    codexModel(agentModel, codexModels, defaultCodexModel),
  );
  const [reasoningEffort, setReasoningEffort] = useState(agentReasoningEffort ?? "");
  const [forkBranchName, setForkBranchName] = useState(
    data.agentBranch ?? data.branches?.[0]?.branch ?? "",
  );
  const [forkNewBranch, setForkNewBranch] = useState("");
  const [forkBaseBranch, setForkBaseBranch] = useState(
    data.agentBranch ?? data.branches?.[0]?.branch ?? "",
  );
  const [forkExtraBranches, setForkExtraBranches] = useState<BranchOption[]>([]);
  const [creatingForkBranch, setCreatingForkBranch] = useState(false);
  const [forkError, setForkError] = useState("");
  const [workspaceOpenError, setWorkspaceOpenError] = useState("");
  const logRef = useRef<HTMLDivElement>(null);

  const meta = TURN_META[turn.status];
  const forkBranches = mergeBranchOptions(data.branches ?? [], forkExtraBranches);
  const selectedForkBranch = forkBranches.find((branch) => branch.branch === forkBranchName);
  const displayBranch = turn.branch ?? data.agentBranch;
  const workspacePath = data.agentCwd;
  const displayShortSha = turn.baseShortSha ?? turn.baseCommitSha?.slice(0, 7);
  const contextTitle = [
    displayBranch ? `branch: ${displayBranch}` : undefined,
    turn.baseCommitSha ? `base commit: ${turn.baseCommitSha}` : undefined,
    turn.cwd ? `cwd: ${turn.cwd}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
  // 末尾 idle 轮且可输入：首轮看 agent idle，续轮看 agent waiting_input
  const isResumableClosedAgent = agentStatus === "stopped" || agentStatus === "terminated";
  const isActiveInput =
    turn.status === "idle" &&
    (turn.index === 0
      ? agentStatus === "idle"
      : agentStatus === "waiting_input" || isResumableClosedAgent);
  const canFork = turn.status === "done" && !!turn.anchorUuid;
  const isRunning = turn.status === "running";
  const canGuideRunningTurn = isLatest && isRunning && agentStatus === "running";
  const canCompact = isLatest && agentStatus === "waiting_input";
  const canTerminate =
    isLatest &&
    (agentStatus === "starting" ||
      agentStatus === "running" ||
      agentStatus === "waiting_input");
  const hasResourceHandles =
    isLatest &&
    (isActiveInput ||
      (agentStatus !== "done" &&
        agentStatus !== "stopped" &&
        agentStatus !== "terminated" &&
        agentStatus !== "error"));
  const minimized = data.windowState?.minimized === true;
  const hasPendingInteraction = turn.lines.some(
    (line) =>
      (line.kind === "question" || line.kind === "approval") && line.status === "pending",
  );

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turn.lines.length]);

  useEffect(() => {
    setModel(codexModel(agentModel, codexModels, defaultCodexModel));
  }, [agentModel, codexModels, defaultCodexModel]);

  useEffect(() => {
    setReasoningEffort(agentReasoningEffort ?? "");
  }, [agentReasoningEffort]);

  useEffect(() => {
    if (forkBranches.length === 0) return;
    const preferred = data.agentBranch && forkBranches.some((branch) => branch.branch === data.agentBranch)
      ? data.agentBranch
      : forkBranches[0]!.branch;
    if (!forkBranchName || !forkBranches.some((branch) => branch.branch === forkBranchName)) {
      setForkBranchName(preferred);
    }
    if (!forkBaseBranch || !forkBranches.some((branch) => branch.branch === forkBaseBranch)) {
      setForkBaseBranch(preferred);
    }
  }, [data.agentBranch, forkBaseBranch, forkBranchName, forkBranches]);

  const createForkBranch = async () => {
    const branch = forkNewBranch.trim();
    if (!branch || !data.onCreateBranch) return;
    setCreatingForkBranch(true);
    setForkError("");
    try {
      const created = await data.onCreateBranch(branch, forkBaseBranch || undefined);
      const option = branchOptionFromWorkspace(created);
      setForkExtraBranches((current) =>
        current.some((candidate) => candidate.branch === option.branch)
          ? current
          : [...current, option],
      );
      setForkBranchName(option.branch);
      setForkNewBranch("");
    } catch (reason) {
      setForkError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setCreatingForkBranch(false);
    }
  };

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

  const openWorkspace = async (event: React.MouseEvent) => {
    event.stopPropagation();
    setWorkspaceOpenError("");
    try {
      await actions.openWorkspace(agentId);
    } catch (reason) {
      setWorkspaceOpenError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  if (minimized) {
    return (
      <div className="turn-node turn-node--minimized">
        {hasPendingInteraction && <span className="turn-node__interaction-dot" />}
        <button
          className="turn-node__restore drag-handle"
          title={
            contextTitle
              ? `恢复 ${agentId} 第 ${turn.index + 1} 轮\n${contextTitle}`
              : `恢复 ${agentId} 第 ${turn.index + 1} 轮`
          }
          onClick={toggleMinimized}
        >
          <MessageSquare size={17} />
          <span className="turn-node__restore-text">
            <span>{turn.index + 1}</span>
            {displayShortSha && <small>{displayShortSha}</small>}
          </span>
        </button>
        <NodeHandles resourceAccess={hasResourceHandles} />
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
      <NodeHandles resourceAccess={hasResourceHandles} />
      {hasPendingInteraction && <span className="turn-node__interaction-dot" />}
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
        <div style={{ marginLeft: "auto", display: "inline-flex", gap: 4 }}>
          <button
            className="icon-button nodrag"
            title={workspacePath ? `用 VS Code 打开 ${workspacePath}` : "该 agent 尚未绑定工作目录"}
            disabled={!workspacePath}
            onClick={(event) => void openWorkspace(event)}
          >
            <FolderOpen size={14} />
          </button>
          {isLatest && data.onOpenSettings && (
            <button
              className="icon-button nodrag"
              title="Agent 设置"
              onClick={(event) => {
                event.stopPropagation();
                data.onOpenSettings?.(agentId);
              }}
            >
              <Settings size={14} />
            </button>
          )}
          <button
            className="icon-button nodrag"
            title="最小化节点"
            onClick={toggleMinimized}
          >
            <Minimize2 size={14} />
          </button>
        </div>
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

      <div className="turn-node__context nodrag" title={contextTitle || undefined}>
        <span>
          branch <strong>{displayBranch ?? "(none)"}</strong>
        </span>
        <span>
          base <strong>{displayShortSha ?? "(pending)"}</strong>
        </span>
        {turn.usage?.contextTokens != null && (
          <span>
            context{" "}
            <strong>
              {formatTokens(turn.usage.contextTokens)}
              {turn.usage.contextWindow ? ` / ${formatTokens(turn.usage.contextWindow)}` : ""}
            </strong>
          </span>
        )}
      </div>
      {workspaceOpenError && (
        <div className="turn-node__context nodrag" style={{ color: "#dc2626" }}>
          {workspaceOpenError}
        </div>
      )}

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
            turn.lines.map((line, i) =>
              line.kind === "question" ? (
                <QuestionLine
                  key={i}
                  agentId={agentId}
                  line={line}
                  actions={actions}
                />
              ) : line.kind === "approval" ? (
                <ApprovalLine
                  key={i}
                  agentId={agentId}
                  line={line}
                  actions={actions}
                />
              ) : (
                <div
                  key={i}
                  style={lineStyle(
                    line.kind,
                    line.kind === "tool_result" ? line.isError : undefined,
                  )}
                >
                  {renderLine(line)}
                </div>
              ),
            )
          )}
          {turn.costUsd != null && (
            <div style={{ color: "#9ca3af", marginTop: 4 }}>花费 ${turn.costUsd.toFixed(4)}</div>
          )}
        </div>
      )}

      {/* 控制区 */}
      <div
        className="nodrag nowheel"
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
                void actions.submit(agentId, text.trim());
                setText("");
              }}
            >
              {turn.index === 0 ? "▶ 启动" : "▶ 发送本轮"}
            </button>
          </>
        ) : isRunning && canGuideRunningTurn ? (
          <>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="运行中追加提示词…"
              rows={3}
              style={textareaStyle}
            />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
              <button
                style={iconBtn("#2563eb")}
                disabled={!text.trim()}
                title="排队到当前轮完成后执行"
                onClick={() => {
                  void actions.submit(agentId, text.trim());
                  setText("");
                }}
              >
                <Send size={14} />
                排队
              </button>
              <button
                style={iconBtn("#7c3aed")}
                disabled={!text.trim()}
                title="尽快引导当前运行轮"
                onClick={() => {
                  void actions.steer(agentId, text.trim());
                  setText("");
                }}
              >
                <Zap size={14} />
                引导
              </button>
              <button style={iconBtn("#dc2626")} onClick={() => void actions.stop(agentId)}>
                <Square size={13} />
                停止
              </button>
            </div>
          </>
        ) : isRunning ? (
          <button style={iconBtn("#dc2626")} onClick={() => void actions.stop(agentId)}>
            <Square size={13} />
            停止
          </button>
        ) : canFork ? (
          <>
            {forkBranches.length > 0 && (
              <div style={forkGridStyle}>
                <select
                  aria-label="fork branch"
                  value={forkBranchName}
                  onChange={(event) => setForkBranchName(event.target.value)}
                  style={miniSelectStyle}
                >
                  {forkBranches.map((branch) => (
                    <option key={branch.branch} value={branch.branch}>
                      {branch.branch}
                      {branch.hasWorkspace ? "" : "（未拉取）"}
                    </option>
                  ))}
                </select>
                <input
                  aria-label="fork new branch"
                  value={forkNewBranch}
                  placeholder="new branch"
                  onChange={(event) => setForkNewBranch(event.target.value)}
                  style={miniInputStyle}
                />
                <select
                  aria-label="fork branch base"
                  value={forkBaseBranch}
                  onChange={(event) => setForkBaseBranch(event.target.value)}
                  style={miniSelectStyle}
                >
                  {forkBranches.map((branch) => (
                    <option key={branch.branch} value={branch.branch}>
                      {branch.branch}
                    </option>
                  ))}
                </select>
                <button
                  style={iconOnlyBtn("#475569")}
                  disabled={
                    creatingForkBranch ||
                    !data.onCreateBranch ||
                    !forkNewBranch.trim() ||
                    forkBranches.length === 0
                  }
                  title="创建 fork branch"
                  onClick={() => void createForkBranch()}
                >
                  <Plus size={13} />
                </button>
              </div>
            )}
            {agentProvider === "codex" && (
              <>
                <CodexModelSelect
                  ariaLabel="fork model"
                  value={model}
                  models={codexModels}
                  onChange={setModel}
                />
                <ReasoningEffortSelect
                  value={reasoningEffort}
                  onChange={setReasoningEffort}
                />
              </>
            )}
            {forkError && <span style={{ color: "#dc2626", fontSize: 11 }}>{forkError}</span>}
            <button
              style={btn("#7c3aed")}
              title="从这一轮的对话状态分叉出一个新 agent"
              onClick={() =>
                void actions.fork(
                  agentId,
                  turn.anchorUuid!,
                  forkOptionsFor(
                    agentProvider === "codex" ? model : undefined,
                    agentProvider === "codex" ? reasoningEffort : undefined,
                    selectedForkBranch,
                    forkBranchName,
                  ),
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

function QuestionLine({
  agentId,
  line,
  actions,
}: {
  agentId: string;
  line: Extract<OutputLine, { kind: "question" }>;
  actions: AgentActions;
}): React.ReactElement {
  const { request } = line;
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [contentText, setContentText] = useState("");
  const [error, setError] = useState("");
  const disabled = line.status !== "pending";
  const canSubmit =
    !disabled &&
    (request.kind === "mcp_elicitation" ||
      request.questions.every((question) => hasAnswer(answers[question.id])));

  const setAnswer = (id: string, value: string | string[]) => {
    setError("");
    setAnswers((current) => ({ ...current, [id]: value }));
  };

  const submit = () => {
    const response: AgentQuestionResponse = { action: "accept", answers };
    if (request.kind === "mcp_elicitation") {
      const trimmed = contentText.trim();
      if (trimmed) {
        try {
          response.content = JSON.parse(trimmed) as unknown;
        } catch {
          setError("JSON 格式错误");
          return;
        }
      } else if (Object.keys(answers).length > 0) {
        response.content = answers;
      } else {
        response.content = null;
      }
    }
    void actions.answerQuestion(agentId, request.requestId, response);
  };

  const decline = () => {
    void actions.answerQuestion(agentId, request.requestId, { action: "decline" });
  };

  return (
    <div
      className="nodrag nowheel"
      style={questionPanelStyle}
      onClick={(event) => event.stopPropagation()}
    >
      <div style={questionHeaderStyle}>
        <HelpCircle size={14} />
        <span style={{ fontWeight: 700 }}>{request.title ?? "需要回答"}</span>
        <span style={questionStatusStyle(line.status)}>{questionStatusLabel(line.status)}</span>
      </div>
      {request.message && <div style={questionMessageStyle}>{request.message}</div>}
      {request.url && (
        <a style={questionLinkStyle} href={request.url} target="_blank" rel="noreferrer">
          {request.url}
        </a>
      )}
      {request.questions.map((question) => (
        <QuestionItem
          key={question.id}
          question={question}
          value={answers[question.id]}
          disabled={disabled}
          onChange={(value) => setAnswer(question.id, value)}
        />
      ))}
      {request.kind === "mcp_elicitation" && (
        <textarea
          value={contentText}
          disabled={disabled}
          onChange={(event) => {
            setError("");
            setContentText(event.target.value);
          }}
          placeholder="JSON 内容"
          rows={3}
          style={questionTextareaStyle}
        />
      )}
      {error && <div style={questionErrorStyle}>{error}</div>}
      {line.summary && <div style={questionMessageStyle}>{line.summary}</div>}
      {!disabled && (
        <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
          <button
            style={iconBtn("#2563eb")}
            disabled={!canSubmit}
            onClick={submit}
            title="提交回答"
          >
            <Check size={13} />
            回答
          </button>
          <button style={iconBtn("#64748b")} onClick={decline} title="拒绝回答">
            <X size={13} />
            拒绝
          </button>
        </div>
      )}
    </div>
  );
}

function ApprovalLine({
  agentId,
  line,
  actions,
}: {
  agentId: string;
  line: Extract<OutputLine, { kind: "approval" }>;
  actions: AgentActions;
}): React.ReactElement {
  const { request } = line;
  const [remember, setRemember] = useState(false);
  const disabled = line.status !== "pending";
  const answer = (response: AgentApprovalResponse) => {
    void actions.answerApproval(agentId, request.requestId, response);
  };
  return (
    <div
      className="nodrag nowheel"
      style={approvalPanelStyle}
      onClick={(event) => event.stopPropagation()}
    >
      <div style={questionHeaderStyle}>
        <ShieldAlert size={14} />
        <span style={{ fontWeight: 700 }}>{request.title}</span>
        <span style={approvalStatusStyle(line.status)}>{approvalStatusLabel(line.status)}</span>
      </div>
      {request.message && <div style={questionMessageStyle}>{request.message}</div>}
      {request.command && <pre style={approvalCodeStyle}>{request.command}</pre>}
      {request.cwd && <div style={questionMessageStyle}>cwd: {request.cwd}</div>}
      {request.toolName && <div style={questionMessageStyle}>tool: {request.toolName}</div>}
      {request.blockedPath && <div style={questionMessageStyle}>path: {request.blockedPath}</div>}
      {request.fileChanges && request.fileChanges.length > 0 && (
        <div style={approvalListStyle}>
          {request.fileChanges.map((change, index) => (
            <div key={`${change.path}-${index}`}>
              {change.status ? `${change.status} ` : ""}
              {change.path}
              {change.summary ? ` · ${change.summary}` : ""}
            </div>
          ))}
        </div>
      )}
      {request.permissions !== undefined && (
        <pre style={approvalCodeStyle}>{prettyShort(request.permissions)}</pre>
      )}
      {request.input !== undefined && <pre style={approvalCodeStyle}>{prettyShort(request.input)}</pre>}
      {line.summary && <div style={questionMessageStyle}>{line.summary}</div>}
      {!disabled && (
        <>
          <label style={approvalRememberStyle}>
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
            />
            本会话记住
          </label>
          <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
            <button
              style={iconBtn("#2563eb")}
              onClick={() => answer({ action: "approve", remember })}
              title="允许本次授权请求"
            >
              <Check size={13} />
              允许
            </button>
            <button
              style={iconBtn("#64748b")}
              onClick={() => answer({ action: "deny" })}
              title="拒绝本次授权请求"
            >
              <X size={13} />
              拒绝
            </button>
            <button
              style={iconBtn("#dc2626")}
              onClick={() => answer({ action: "cancel" })}
              title="取消并尽量中断当前请求"
            >
              <Square size={13} />
              取消
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function QuestionItem({
  question,
  value,
  disabled,
  onChange,
}: {
  question: AgentQuestionItem;
  value: string | string[] | undefined;
  disabled: boolean;
  onChange: (value: string | string[]) => void;
}): React.ReactElement {
  const options = question.options ?? [];
  const selected = new Set(Array.isArray(value) ? value : value ? [value] : []);
  const optionLabels = new Set(options.map((option) => option.label));
  const customValue =
    typeof value === "string" && !optionLabels.has(value) ? value : "";

  return (
    <div style={questionItemStyle}>
      <div style={questionPromptStyle}>
        {question.header && <span style={questionChipStyle}>{question.header}</span>}
        <span>{question.question}</span>
      </div>
      {options.length > 0 && (
        <div style={questionOptionsStyle}>
          {options.map((option) => {
            const isSelected = selected.has(option.label);
            return (
              <button
                key={option.label}
                disabled={disabled}
                style={questionOptionStyle(isSelected)}
                onClick={() => {
                  if (question.multiSelect) {
                    const next = new Set(selected);
                    if (isSelected) next.delete(option.label);
                    else next.add(option.label);
                    onChange([...next]);
                  } else {
                    onChange(option.label);
                  }
                }}
                title={option.description}
              >
                <span style={{ fontWeight: 600 }}>{option.label}</span>
                {option.description && (
                  <span style={{ color: "#64748b", fontSize: 10 }}>
                    {option.description}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
      {(question.isOther || options.length === 0) && !question.multiSelect && (
        <input
          type={question.isSecret ? "password" : "text"}
          disabled={disabled}
          value={customValue}
          onChange={(event) => onChange(event.target.value)}
          placeholder={options.length > 0 ? "其他回答" : "回答"}
          style={questionInputStyle}
        />
      )}
    </div>
  );
}

function NodeHandles({ resourceAccess }: { resourceAccess: boolean }): React.ReactElement {
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
      {resourceAccess && (
        <>
          <Handle
            id="resource-read"
            type="target"
            position={Position.Left}
            className="turn-node__file-handle turn-node__file-handle--read"
            title="连接资源输出：允许 Agent 读取"
          />
          <span className="turn-node__file-label turn-node__file-label--read">读入</span>
          <Handle
            id="resource-write"
            type="source"
            position={Position.Right}
            className="turn-node__file-handle turn-node__file-handle--write"
            title="连接到资源输入：允许 Agent 写入"
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
  models,
  onChange,
}: {
  ariaLabel: string;
  value: CodexModel;
  models: readonly string[];
  onChange: (model: CodexModel) => void;
}): React.ReactElement {
  return (
    <select
      aria-label={ariaLabel}
      value={value}
      onChange={(event) => onChange(event.target.value as CodexModel)}
      style={selectStyle}
    >
      {models.map((candidate) => (
        <option key={candidate} value={candidate}>
          {candidate}
        </option>
      ))}
    </select>
  );
}

function ReasoningEffortSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (reasoningEffort: string) => void;
}): React.ReactElement {
  return (
    <select
      aria-label="fork reasoning effort"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      style={selectStyle}
    >
      <option value="">默认推理强度</option>
      {CODEX_REASONING_EFFORTS.map((candidate) => (
        <option key={candidate} value={candidate}>
          {candidate}
        </option>
      ))}
    </select>
  );
}

function codexModel(
  model: string | undefined,
  models: readonly string[],
  defaultModel: string,
): CodexModel {
  return isCodexModel(model, models) ? model : defaultModel;
}

function hasAnswer(value: string | string[] | undefined): boolean {
  if (Array.isArray(value)) return value.some((item) => item.trim().length > 0);
  return typeof value === "string" && value.trim().length > 0;
}

function questionStatusLabel(status: Extract<OutputLine, { kind: "question" }>["status"]): string {
  switch (status) {
    case "pending":
      return "待回答";
    case "accepted":
      return "已回答";
    case "declined":
      return "已拒绝";
    case "cancelled":
      return "已取消";
  }
}

function questionStatusStyle(
  status: Extract<OutputLine, { kind: "question" }>["status"],
): React.CSSProperties {
  const color =
    status === "pending"
      ? "#2563eb"
      : status === "accepted"
        ? "#16a34a"
        : "#64748b";
  return {
    marginLeft: "auto",
    color,
    border: `1px solid ${color}`,
    borderRadius: 6,
    padding: "1px 6px",
    fontSize: 10,
    whiteSpace: "nowrap",
  };
}

function approvalStatusLabel(status: Extract<OutputLine, { kind: "approval" }>["status"]): string {
  switch (status) {
    case "pending":
      return "待授权";
    case "approved":
      return "已允许";
    case "denied":
      return "已拒绝";
    case "cancelled":
      return "已取消";
  }
}

function approvalStatusStyle(
  status: Extract<OutputLine, { kind: "approval" }>["status"],
): React.CSSProperties {
  const color =
    status === "pending"
      ? "#dc2626"
      : status === "approved"
        ? "#16a34a"
        : "#64748b";
  return {
    marginLeft: "auto",
    color,
    border: `1px solid ${color}`,
    borderRadius: 6,
    padding: "1px 6px",
    fontSize: 10,
    whiteSpace: "nowrap",
  };
}

function prettyShort(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return text && text.length > 1400 ? `${text.slice(0, 1400)}...` : text || "";
}

function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(tokens >= 10000 ? 0 : 1)}k` : String(tokens);
}

const questionPanelStyle: React.CSSProperties = {
  border: "1px solid #bfdbfe",
  borderRadius: 8,
  padding: 8,
  margin: "4px 0 6px",
  background: "#f8fbff",
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const approvalPanelStyle: React.CSSProperties = {
  ...questionPanelStyle,
  border: "1px solid #fecaca",
  background: "#fffafa",
};

const approvalCodeStyle: React.CSSProperties = {
  margin: 0,
  padding: 6,
  border: "1px solid #e2e8f0",
  borderRadius: 6,
  background: "#fff",
  color: "#111827",
  fontSize: 11,
  lineHeight: 1.45,
  overflowX: "auto",
  whiteSpace: "pre-wrap",
};

const approvalListStyle: React.CSSProperties = {
  display: "grid",
  gap: 3,
  color: "#334155",
  fontFamily: "monospace",
  fontSize: 11,
};

const approvalRememberStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  color: "#475569",
  fontSize: 11,
};

const questionHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  color: "#1e3a8a",
};

const questionMessageStyle: React.CSSProperties = {
  color: "#475569",
  fontSize: 11,
};

const questionLinkStyle: React.CSSProperties = {
  color: "#2563eb",
  overflowWrap: "anywhere",
};

const questionItemStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 5,
};

const questionPromptStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  color: "#111827",
};

const questionChipStyle: React.CSSProperties = {
  color: "#1e40af",
  background: "#dbeafe",
  borderRadius: 6,
  padding: "1px 5px",
  fontSize: 10,
  maxWidth: 90,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const questionOptionsStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(92px, 1fr))",
  gap: 5,
};

function questionOptionStyle(selected: boolean): React.CSSProperties {
  return {
    border: selected ? "1px solid #2563eb" : "1px solid #cbd5e1",
    background: selected ? "#eff6ff" : "#fff",
    color: "#111827",
    borderRadius: 6,
    padding: "5px 6px",
    minHeight: 30,
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: 2,
    cursor: "pointer",
    overflow: "hidden",
  };
}

const questionInputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  fontSize: 12,
  padding: 6,
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontFamily: "inherit",
};

const questionTextareaStyle: React.CSSProperties = {
  ...questionInputStyle,
  resize: "vertical",
};

const questionErrorStyle: React.CSSProperties = {
  color: "#dc2626",
  fontSize: 11,
};

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

const forkGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr) 92px 30px",
  gap: 5,
};

const miniInputStyle: React.CSSProperties = {
  minWidth: 0,
  height: 30,
  boxSizing: "border-box",
  fontSize: 11,
  padding: "4px 6px",
  border: "1px solid #d1d5db",
  borderRadius: 6,
  fontFamily: "inherit",
  background: "#fff",
};

const miniSelectStyle: React.CSSProperties = {
  ...miniInputStyle,
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

function iconOnlyBtn(color: string): React.CSSProperties {
  return {
    ...btn(color),
    minHeight: 30,
    padding: "4px 6px",
    display: "inline-grid",
    placeItems: "center",
  };
}

function iconBtn(color: string): React.CSSProperties {
  return {
    ...btn(color),
    minHeight: 30,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  };
}

function branchOptionFromWorkspace(workspace: BranchWorkspace): BranchOption {
  return {
    branch: workspace.branch,
    branchWorkspaceId: workspace.id,
    worktreePath: workspace.worktreePath,
    hasWorkspace: true,
    isDefault: workspace.isDefault,
  };
}

function mergeBranchOptions(
  primary: BranchOption[],
  extra: BranchOption[],
): BranchOption[] {
  const byBranch = new Map<string, BranchOption>();
  for (const option of [...primary, ...extra]) {
    const current = byBranch.get(option.branch);
    if (!current || shouldPreferBranchOption(option, current)) {
      byBranch.set(option.branch, option);
    }
  }
  return [...byBranch.values()];
}

function shouldPreferBranchOption(
  candidate: BranchOption,
  current: BranchOption,
): boolean {
  if (candidate.hasWorkspace !== current.hasWorkspace) return candidate.hasWorkspace;
  if (!!candidate.branchWorkspaceId !== !!current.branchWorkspaceId) {
    return !!candidate.branchWorkspaceId;
  }
  return false;
}

function forkOptionsFor(
  model: string | undefined,
  reasoningEffort: string | undefined,
  branch: BranchOption | undefined,
  branchName: string,
): Omit<ForkAgentInput, "anchorUuid"> | undefined {
  const options: Omit<ForkAgentInput, "anchorUuid"> = {};
  if (model) options.model = model;
  if (reasoningEffort?.trim()) options.reasoningEffort = reasoningEffort.trim();
  if (branch) {
    options.branchWorkspaceId = branch.branchWorkspaceId;
    options.branch = branch.branch;
    options.cwd = branch.worktreePath;
  } else if (branchName) {
    options.branch = branchName;
  }
  return Object.keys(options).length > 0 ? options : undefined;
}
