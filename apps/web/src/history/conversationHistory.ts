import type { AgentEvent, AgentEventEnvelope } from "@agent-canvas/shared";

export interface HistoryItem {
  seq: number;
  at: number;
  event: AgentEvent;
}

export interface HistoryTurn {
  index: number;
  items: HistoryItem[];
}

/** 把完整事件流截断到目标轮，并合并同一消息的流式文本片段。 */
export function buildConversationHistory(
  events: AgentEventEnvelope[],
  throughTurnIndex: number,
): HistoryTurn[] {
  const turns: HistoryTurn[] = [{ index: 0, items: [] }];
  let turnIndex = 0;

  for (const envelope of events) {
    if (turnIndex > throughTurnIndex) break;
    const turn = turns[turns.length - 1]!;
    appendItem(turn.items, {
      seq: envelope.seq,
      at: envelope.at,
      event: envelope.event,
    });

    if (isTurnBoundary(envelope.event)) {
      if (turnIndex === throughTurnIndex) break;
      turnIndex += 1;
      turns.push({ index: turnIndex, items: [] });
    }
  }

  return turns.filter((turn) => turn.index <= throughTurnIndex);
}

function appendItem(items: HistoryItem[], item: HistoryItem): void {
  const previous = items.at(-1);
  if (!previous) {
    items.push(item);
    return;
  }

  const merged = mergeTextEvent(previous.event, item.event);
  if (merged) {
    items[items.length - 1] = { ...item, event: merged };
  } else {
    items.push(item);
  }
}

function mergeTextEvent(previous: AgentEvent, next: AgentEvent): AgentEvent | undefined {
  if (
    previous.kind === "assistant_text" &&
    next.kind === "assistant_text" &&
    previous.messageUuid &&
    previous.messageUuid === next.messageUuid
  ) {
    return { ...next, text: previous.text + next.text };
  }
  if (
    previous.kind === "thinking" &&
    next.kind === "thinking" &&
    previous.messageUuid &&
    previous.messageUuid === next.messageUuid
  ) {
    return { ...next, text: previous.text + next.text };
  }
  return undefined;
}

function isTurnBoundary(event: AgentEvent): boolean {
  return event.kind === "result" || event.kind === "compact";
}
