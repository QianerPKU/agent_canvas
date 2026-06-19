/**
 * 纯函数 store：把后端的统一事件流"折叠"成每个 agent 的视图状态。
 *
 * 与 React 解耦、无副作用 —— 是前端单测的主要对象。
 * UI 层（useAgentCanvas）只负责把 WebSocket 帧喂进这些函数。
 */
import type {
  AgentEvent,
  AgentEventEnvelope,
  AgentSnapshot,
  AgentStatus,
} from "@agent-canvas/shared";

export type OutputLine =
  | { kind: "assistant"; text: string }
  | { kind: "tool_use"; name: string; input: unknown }
  | { kind: "tool_result"; isError: boolean; content: unknown }
  | { kind: "system"; text: string }
  | { kind: "result"; text: string }
  | { kind: "error"; text: string };

export interface AgentView {
  id: string;
  status: AgentStatus;
  sessionId?: string;
  model?: string;
  cwd?: string;
  costUsd?: number;
  lines: OutputLine[];
  lastSeq: number;
  createdAt?: number;
}

export type AgentMap = Record<string, AgentView>;

/** 单个 agent 保留的最大输出行数，超出丢弃最旧的。 */
export const MAX_LINES = 500;

export function emptyMap(): AgentMap {
  return {};
}

export function newAgentView(id: string, partial: Partial<AgentView> = {}): AgentView {
  return { id, status: "idle", lines: [], lastSeq: 0, ...partial };
}

/** hello 帧：用后端快照重建整张表（不含历史行）。 */
export function applyHello(agents: AgentSnapshot[]): AgentMap {
  const map: AgentMap = {};
  for (const a of agents) {
    map[a.id] = newAgentView(a.id, {
      status: a.status,
      sessionId: a.sessionId,
      costUsd: a.totalCostUsd,
      lastSeq: a.lastEventSeq,
      createdAt: a.createdAt,
    });
  }
  return map;
}

/** 应用一条事件信封，返回新表（不可变更新）。乱序/重复的旧 seq 会被忽略。 */
export function applyEnvelope(map: AgentMap, env: AgentEventEnvelope): AgentMap {
  const prev = map[env.agentId] ?? newAgentView(env.agentId);
  if (env.seq <= prev.lastSeq && prev.lastSeq > 0) {
    return map; // 已处理过更新的事件，忽略
  }
  const folded = foldEvent(prev, env.event);
  return { ...map, [env.agentId]: { ...folded, lastSeq: env.seq } };
}

function foldEvent(view: AgentView, event: AgentEvent): AgentView {
  switch (event.kind) {
    case "status":
      return { ...view, status: event.status };
    case "system_init":
      return {
        ...view,
        sessionId: event.sessionId,
        model: event.model,
        cwd: event.cwd,
        lines: pushLine(view.lines, { kind: "system", text: `会话建立 · ${event.model}` }),
      };
    case "assistant_text":
      return { ...view, lines: pushLine(view.lines, { kind: "assistant", text: event.text }) };
    case "tool_use":
      return {
        ...view,
        lines: pushLine(view.lines, { kind: "tool_use", name: event.name, input: event.input }),
      };
    case "tool_result":
      return {
        ...view,
        lines: pushLine(view.lines, {
          kind: "tool_result",
          isError: event.isError,
          content: event.content,
        }),
      };
    case "result": {
      const cost = event.costUsd != null ? ` · $${event.costUsd.toFixed(4)}` : "";
      return {
        ...view,
        costUsd: event.costUsd ?? view.costUsd,
        lines: pushLine(view.lines, { kind: "result", text: `本轮完成 · ${event.subtype}${cost}` }),
      };
    }
    case "error":
      return { ...view, lines: pushLine(view.lines, { kind: "error", text: event.message }) };
    default:
      return view;
  }
}

function pushLine(lines: OutputLine[], line: OutputLine): OutputLine[] {
  const next = [...lines, line];
  return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
}
