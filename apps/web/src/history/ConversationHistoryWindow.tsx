import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { AgentEvent } from "@agent-canvas/shared";
import { api } from "../api.js";
import {
  buildConversationHistory,
  type HistoryItem,
  type HistoryTurn,
} from "./conversationHistory.js";

export interface HistoryTarget {
  agentId: string;
  turnIndex: number;
  lastSeq: number;
}

export function ConversationHistoryWindow({
  target,
  onClose,
}: {
  target: HistoryTarget;
  onClose: () => void;
}): React.ReactElement {
  const [turns, setTurns] = useState<HistoryTurn[]>([]);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const bodyRef = useRef<HTMLDivElement>(null);
  const loadedTargetRef = useRef<string>();
  const pendingInitialScrollRef = useRef(false);
  const scrollSnapshotRef = useRef<
    | {
        top: number;
        wasNearBottom: boolean;
      }
    | undefined
  >();

  useEffect(() => {
    let active = true;
    const targetKey = `${target.agentId}:${target.turnIndex}`;
    const targetChanged = loadedTargetRef.current !== targetKey;
    const body = bodyRef.current;
    scrollSnapshotRef.current =
      !targetChanged && body
        ? {
            top: body.scrollTop,
            wasNearBottom: body.scrollHeight - body.scrollTop - body.clientHeight < 24,
          }
        : undefined;

    if (targetChanged) {
      pendingInitialScrollRef.current = true;
      setLoading(true);
    }
    setError(undefined);
    void api
      .history(target.agentId)
      .then((events) => {
        if (!active) return;
        loadedTargetRef.current = targetKey;
        setTurns(buildConversationHistory(events, target.turnIndex));
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (active && targetChanged) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [target.agentId, target.turnIndex, target.lastSeq]);

  useLayoutEffect(() => {
    const snapshot = scrollSnapshotRef.current;
    const body = bodyRef.current;
    if (!body) return;

    if (snapshot) {
      body.scrollTop = snapshot.wasNearBottom ? body.scrollHeight : snapshot.top;
      scrollSnapshotRef.current = undefined;
      return;
    }

    if (pendingInitialScrollRef.current && !loading) {
      body.scrollTop = body.scrollHeight;
      pendingInitialScrollRef.current = false;
    }
  }, [loading, turns]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="history-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="history-window"
        role="dialog"
        aria-modal="true"
        aria-label={`${target.agentId} 对话历史`}
      >
        <header className="history-window__header">
          <div>
            <strong>{target.agentId}</strong>
            <span>截至第 {target.turnIndex + 1} 轮</span>
          </div>
          <button className="icon-button" title="关闭历史窗口" onClick={onClose}>
            <X size={17} />
          </button>
        </header>

        <div className="history-window__body" ref={bodyRef}>
          {loading && <div className="history-empty">正在读取历史…</div>}
          {error && <div className="history-error">{error}</div>}
          {!loading && !error && turns.every((turn) => turn.items.length === 0) && (
            <div className="history-empty">这一轮还没有历史事件。</div>
          )}
          {!loading &&
            !error &&
            turns.map((turn) =>
              turn.items.length > 0 ? (
                <section className="history-turn" key={turn.index}>
                  <h2>第 {turn.index + 1} 轮</h2>
                  <div className="history-events">
                    {turn.items.map((item) => (
                      <HistoryEvent key={item.seq} item={item} />
                    ))}
                  </div>
                </section>
              ) : null,
            )}
        </div>
      </section>
    </div>
  );
}

function HistoryEvent({ item }: { item: HistoryItem }): React.ReactElement {
  const event = item.event;
  const time = new Date(item.at).toLocaleTimeString();

  switch (event.kind) {
    case "user_input":
      return (
        <EventBlock
          tone="user"
          label={
            event.mode === "queued"
              ? "用户 · 已排队"
              : event.mode === "steer"
                ? "用户 · 引导"
                : "用户"
          }
          time={time}
          content={event.text}
        />
      );
    case "turn_context":
      return (
        <EventBlock
          tone="system"
          label="Turn context"
          time={time}
          content={turnContextText(event.context)}
        />
      );
    case "thinking":
      return <EventBlock tone="thinking" label="思考" time={time} content={event.text} />;
    case "assistant_text":
      return <EventBlock tone="assistant" label="答复" time={time} content={event.text} />;
    case "user_question":
      return (
        <EventBlock
          tone="system"
          label={event.request.title ?? "交互问题"}
          time={time}
          content={questionText(event.request)}
        />
      );
    case "user_question_result":
      return (
        <EventBlock
          tone="system"
          label="交互问题结果"
          time={time}
          content={event.summary ?? event.action}
        />
      );
    case "user_approval":
      return (
        <EventBlock
          tone="system"
          label={event.request.title}
          time={time}
          content={approvalText(event.request)}
          code
        />
      );
    case "user_approval_result":
      return (
        <EventBlock
          tone="system"
          label="授权结果"
          time={time}
          content={event.summary ?? event.action}
        />
      );
    case "tool_use":
      return (
        <EventBlock
          tone="tool"
          label={`工具调用 · ${event.name}`}
          time={time}
          content={pretty(event.input)}
          code
        />
      );
    case "tool_result":
      return (
        <EventBlock
          tone={event.isError ? "error" : "tool"}
          label={event.isError ? "工具错误" : "工具结果"}
          time={time}
          content={pretty(event.content)}
          code
        />
      );
    case "system_init":
      return (
        <EventBlock
          tone="system"
          label="会话初始化"
          time={time}
          content={`${event.model} · ${event.cwd}\n工具：${event.tools.join(", ") || "无"}`}
        />
      );
    case "result":
      return (
        <EventBlock
          tone={event.isError ? "error" : "result"}
          label="本轮结果"
          time={time}
          content={resultText(event)}
        />
      );
    case "compact":
      return (
        <EventBlock
          tone={event.trigger === "auto" ? "system" : "result"}
          label={event.trigger === "auto" ? "自动 compact" : "手动 compact"}
          time={time}
          content={
            event.preTokens != null && event.postTokens != null
              ? `${event.preTokens} → ${event.postTokens} tokens`
              : "上下文压缩完成"
          }
        />
      );
    case "error":
      return <EventBlock tone="error" label="错误" time={time} content={event.message} />;
    case "status":
      return <EventBlock tone="system" label="状态" time={time} content={event.status} />;
  }
}

function EventBlock({
  tone,
  label,
  time,
  content,
  code = false,
}: {
  tone: string;
  label: string;
  time: string;
  content: string;
  code?: boolean;
}): React.ReactElement {
  return (
    <article className={`history-event history-event--${tone}`}>
      <div className="history-event__meta">
        <strong>{label}</strong>
        <time>{time}</time>
      </div>
      {code ? <pre>{content}</pre> : <div className="history-event__text">{content}</div>}
    </article>
  );
}

function pretty(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function turnContextText(
  context: Extract<AgentEvent, { kind: "turn_context" }>["context"],
): string {
  return [
    `turn: ${context.turnIndex + 1}`,
    `branch: ${context.branch ?? "(unknown)"}`,
    `base: ${context.baseCommitSha ?? "(unknown)"}`,
    context.cwd ? `cwd: ${context.cwd}` : undefined,
  ]
    .filter((line): line is string => !!line)
    .join("\n");
}

function resultText(event: Extract<AgentEvent, { kind: "result" }>): string {
  const details = [event.subtype];
  if (event.costUsd != null) details.push(`$${event.costUsd.toFixed(4)}`);
  if (event.durationMs != null) details.push(`${event.durationMs}ms`);
  if (event.usage?.inputTokens != null || event.usage?.outputTokens != null) {
    details.push(
      `tokens ${event.usage.inputTokens ?? 0} in / ${event.usage.outputTokens ?? 0} out`,
    );
  }
  return details.join(" · ");
}

function questionText(request: Extract<AgentEvent, { kind: "user_question" }>["request"]): string {
  const lines = [
    request.message,
    ...request.questions.map((question) => {
      const options = question.options?.map((option) => option.label).join(" / ");
      return options ? `${question.question}\n选项：${options}` : question.question;
    }),
  ].filter((line): line is string => !!line);
  return lines.length > 0 ? lines.join("\n") : request.requestId;
}

function approvalText(request: Extract<AgentEvent, { kind: "user_approval" }>["request"]): string {
  const lines = [
    request.message,
    request.command ? `command:\n${request.command}` : undefined,
    request.cwd ? `cwd: ${request.cwd}` : undefined,
    request.toolName ? `tool: ${request.toolName}` : undefined,
    request.blockedPath ? `path: ${request.blockedPath}` : undefined,
    request.fileChanges?.length
      ? `files:\n${request.fileChanges
          .map((file) => `${file.status ? `${file.status} ` : ""}${file.path}`)
          .join("\n")}`
      : undefined,
    request.permissions !== undefined ? `permissions:\n${pretty(request.permissions)}` : undefined,
    request.input !== undefined ? `input:\n${pretty(request.input)}` : undefined,
  ].filter((line): line is string => !!line);
  return lines.length > 0 ? lines.join("\n\n") : request.requestId;
}
