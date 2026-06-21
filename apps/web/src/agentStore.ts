/**
 * 纯函数 store：把后端统一事件流折叠成"对话树"视图。
 *
 * 模型：节点 = 一轮对话。一个 agent = 一条轮次链（turns）。
 *  - 末尾通常是一个 idle 轮（"待输入"节点）；用户输入并启动后它变 running。
 *  - 一轮以 result 收尾：该轮 done 并携 anchorUuid（fork 锚点），随后自动追加一个新的 idle 轮。
 *  - fork 产生的新 agent 带 forkOrigin，供画布画 fork 连线。
 *
 * 与 React 解耦、无副作用，是前端单测的主要对象。
 */
import type {
  AgentEvent,
  AgentEventEnvelope,
  AgentProvider,
  AgentSnapshot,
  AgentStatus,
  ForkOrigin,
} from "@agent-canvas/shared";

export type OutputLine =
  | { kind: "assistant"; text: string; messageUuid?: string }
  | { kind: "thinking"; text: string; messageUuid?: string }
  | { kind: "tool_use"; name: string; input: unknown }
  | { kind: "tool_result"; isError: boolean; content: unknown }
  | { kind: "system"; text: string }
  | { kind: "result"; text: string }
  | { kind: "error"; text: string };

export type TurnStatus =
  | "idle"
  | "running"
  | "done"
  | "error"
  | "stopped"
  | "terminated";

export interface Turn {
  index: number;
  /** 该轮的用户输入（前端乐观记录，后端 user_input 事件确认）。 */
  userInput?: string;
  lines: OutputLine[];
  status: TurnStatus;
  /** fork 锚点：该轮最后一条 assistant 消息 uuid。 */
  anchorUuid?: string;
  costUsd?: number;
}

export interface AgentView {
  id: string;
  provider?: AgentProvider;
  sessionId?: string;
  model?: string;
  status: AgentStatus;
  turns: Turn[];
  forkOrigin?: ForkOrigin;
  createdAt?: number;
  lastSeq: number;
}

export type AgentMap = Record<string, AgentView>;

export const MAX_LINES = 500;

export function emptyMap(): AgentMap {
  return {};
}

function idleTurn(index: number): Turn {
  return { index, lines: [], status: "idle" };
}

export function newAgentView(id: string, partial: Partial<AgentView> = {}): AgentView {
  return { id, status: "idle", turns: [idleTurn(0)], lastSeq: 0, ...partial };
}

/** hello 帧：用快照重建表（每个 agent 仅含一个 idle 轮，不重建历史行）。 */
export function applyHello(agents: AgentSnapshot[]): AgentMap {
  const map: AgentMap = {};
  for (const a of agents) {
    map[a.id] = newAgentView(a.id, {
      provider: a.provider ?? a.config.provider,
      status: a.status,
      sessionId: a.sessionId,
      model: a.config.model,
      forkOrigin: a.forkOrigin,
      createdAt: a.createdAt,
      lastSeq: a.lastEventSeq,
    });
  }
  return map;
}

/** 乐观插入一个 fork 出来的新 agent。 */
export function insertForked(
  map: AgentMap,
  id: string,
  origin: ForkOrigin,
  model?: string,
): AgentMap {
  if (map[id]) return map;
  const parent = map[origin.parentAgentId];
  return {
    ...map,
    [id]: newAgentView(id, {
      provider: parent?.provider,
      model: model ?? parent?.model,
      forkOrigin: origin,
    }),
  };
}

/** 用户在末尾 idle 轮提交输入：记录输入并把该轮置 running（乐观）。 */
export function recordInput(
  map: AgentMap,
  agentId: string,
  text: string,
  provider?: AgentProvider,
  model?: string,
): AgentMap {
  const prev = map[agentId] ?? newAgentView(agentId);
  const next = withLastTurn(prev, (t) => ({ ...t, userInput: text, status: "running" }));
  return {
    ...map,
    [agentId]: {
      ...next,
      provider: provider ?? prev.provider,
      model: model ?? prev.model,
    },
  };
}

/** 手动 compact 占用末尾 idle 轮，并作为一轮运行。 */
export function recordCompact(map: AgentMap, agentId: string): AgentMap {
  const prev = map[agentId] ?? newAgentView(agentId);
  const next = withLastTurn(prev, (turn) => ({
    ...turn,
    userInput: "/compact",
    status: "running",
  }));
  return { ...map, [agentId]: { ...next, status: "running" } };
}

/** 应用一条事件信封；旧/重复 seq 忽略。 */
export function applyEnvelope(map: AgentMap, env: AgentEventEnvelope): AgentMap {
  const prev = map[env.agentId] ?? newAgentView(env.agentId);
  if (env.seq <= prev.lastSeq && prev.lastSeq > 0) return map;
  const folded = foldEvent(prev, env.event);
  return { ...map, [env.agentId]: { ...folded, lastSeq: env.seq } };
}

function foldEvent(view: AgentView, event: AgentEvent): AgentView {
  switch (event.kind) {
    case "status": {
      const v: AgentView = { ...view, status: event.status };
      if (event.status === "error") return markLastTurn(v, "error");
      if (event.status === "stopped") return markLastTurn(v, "stopped");
      if (event.status === "terminated") return markLastTurn(v, "terminated");
      if (event.status === "running") return markLastTurnIfIdle(v, "running");
      return v;
    }
    case "compact": {
      const tokenText =
        event.preTokens != null && event.postTokens != null
          ? ` · ${event.preTokens} → ${event.postTokens} tokens`
          : "";
      if (event.trigger === "auto") {
        return pushLineToLast(view, {
          kind: "system",
          text: `自动 compact 完成${tokenText}`,
        });
      }
      const finalized = withLastTurn(view, (turn) => ({
        ...turn,
        status: "done",
        lines: pushLine(turn.lines, {
          kind: "result",
          text: `手动 compact 完成${tokenText}`,
        }),
      }));
      return {
        ...finalized,
        turns: [...finalized.turns, idleTurn(finalized.turns.length)],
      };
    }
    case "user_input":
      if (event.mode === "queued") {
        return pushLineToLast(view, {
          kind: "system",
          text: `已排队下一轮：${event.text}`,
        });
      }
      if (event.mode === "steer") {
        return pushLineToLast(view, {
          kind: "system",
          text: `引导：${event.text}`,
        });
      }
      return withLastTurn(view, (turn) => ({
        ...turn,
        userInput: event.text,
        status: turn.status === "idle" ? "running" : turn.status,
      }));
    case "system_init":
      return pushLineToLast(
        { ...view, sessionId: event.sessionId, model: event.model },
        { kind: "system", text: `会话建立 · ${event.model}` },
      );
    case "assistant_text":
      return appendAssistantText(view, event.text, event.messageUuid);
    case "thinking":
      return appendThinking(view, event.text, event.messageUuid);
    case "tool_use":
      return pushLineToLast(view, { kind: "tool_use", name: event.name, input: event.input });
    case "tool_result":
      return pushLineToLast(view, {
        kind: "tool_result",
        isError: event.isError,
        content: event.content,
      });
    case "result": {
      const cost = event.costUsd != null ? ` · $${event.costUsd.toFixed(4)}` : "";
      const finalized = withLastTurn(view, (t) => ({
        ...t,
        status: event.isError ? "error" : "done",
        anchorUuid: event.anchorUuid ?? t.anchorUuid,
        costUsd: event.costUsd ?? t.costUsd,
        lines: pushLine(t.lines, { kind: "result", text: `本轮完成 · ${event.subtype}${cost}` }),
      }));
      // 自动延伸一个新的 idle 轮（待输入节点）
      return { ...finalized, turns: [...finalized.turns, idleTurn(finalized.turns.length)] };
    }
    case "error":
      return pushLineToLast(view, { kind: "error", text: event.message });
    default:
      return view;
  }
}

// ---- turn 辅助（不可变） ----

function withLastTurn(view: AgentView, fn: (t: Turn) => Turn): AgentView {
  const turns = view.turns.slice();
  const i = turns.length - 1;
  const last = turns[i] ?? idleTurn(0);
  turns[i] = fn(last);
  return { ...view, turns };
}

function pushLineToLast(view: AgentView, line: OutputLine): AgentView {
  return withLastTurn(view, (t) => ({
    ...t,
    lines: pushLine(t.lines, line),
    status: t.status === "idle" ? "running" : t.status,
  }));
}

function appendAssistantText(
  view: AgentView,
  text: string,
  messageUuid: string | undefined,
): AgentView {
  return withLastTurn(view, (turn) => {
    const lines = turn.lines.slice();
    const last = lines.at(-1);
    if (messageUuid && last?.kind === "assistant" && last.messageUuid === messageUuid) {
      lines[lines.length - 1] = { ...last, text: last.text + text };
    } else {
      lines.push({ kind: "assistant", text, messageUuid });
    }
    return {
      ...turn,
      lines: lines.length > MAX_LINES ? lines.slice(lines.length - MAX_LINES) : lines,
      status: turn.status === "idle" ? "running" : turn.status,
    };
  });
}

function appendThinking(
  view: AgentView,
  text: string,
  messageUuid: string | undefined,
): AgentView {
  return withLastTurn(view, (turn) => {
    const lines = turn.lines.slice();
    const last = lines.at(-1);
    if (messageUuid && last?.kind === "thinking" && last.messageUuid === messageUuid) {
      lines[lines.length - 1] = { ...last, text: last.text + text };
    } else {
      lines.push({ kind: "thinking", text, messageUuid });
    }
    return {
      ...turn,
      lines: lines.length > MAX_LINES ? lines.slice(lines.length - MAX_LINES) : lines,
      status: turn.status === "idle" ? "running" : turn.status,
    };
  });
}

function markLastTurn(view: AgentView, status: TurnStatus): AgentView {
  return withLastTurn(view, (t) => ({ ...t, status }));
}

function markLastTurnIfIdle(view: AgentView, status: TurnStatus): AgentView {
  return withLastTurn(view, (t) => (t.status === "idle" ? { ...t, status } : t));
}

function pushLine(lines: OutputLine[], line: OutputLine): OutputLine[] {
  const next = [...lines, line];
  return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
}
