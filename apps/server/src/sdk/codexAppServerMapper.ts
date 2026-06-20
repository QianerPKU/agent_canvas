import type {
  QueryOptions,
  SdkMessage,
  SdkResultMessage,
  SdkUsage,
} from "./types.js";

export interface CodexAppServerMapState {
  threadId?: string;
  usage?: SdkUsage;
  agentMessageDeltaItemIds: Set<string>;
  reasoningDeltaItemIds: Set<string>;
}

export function createCodexAppServerMapState(): CodexAppServerMapState {
  return {
    agentMessageDeltaItemIds: new Set(),
    reasoningDeltaItemIds: new Set(),
  };
}

export function mapCodexThreadInit(
  result: unknown,
  options: QueryOptions | undefined,
): SdkMessage {
  const r = asRecord(result);
  const thread = asRecord(r?.thread);
  const threadId = stringValue(thread?.id);
  return {
    type: "system",
    subtype: "init",
    session_id: threadId,
    model: stringValue(r?.model) || stringValue(options?.model) || "codex",
    cwd: stringValue(r?.cwd) || stringValue(thread?.cwd) || stringValue(options?.cwd),
    tools: ["codex-app-server"],
    permissionMode: stringValue(options?.permissionMode),
  };
}

export function mapCodexNotification(
  message: unknown,
  state: CodexAppServerMapState,
): SdkMessage[] {
  const msg = asRecord(message);
  const method = stringValue(msg?.method);
  const params = asRecord(msg?.params);

  if (method === "thread/tokenUsage/updated") {
    state.usage = mapUsage(asRecord(params?.tokenUsage));
    return [];
  }

  if (method === "item/agentMessage/delta") {
    const itemId = stringValue(params?.itemId);
    const delta = stringValue(params?.delta);
    if (!itemId || !delta) return [];
    state.agentMessageDeltaItemIds.add(itemId);
    return [assistantMessage(delta, itemId, state.threadId ?? stringValue(params?.threadId))];
  }

  if (
    method === "item/reasoning/textDelta" ||
    method === "item/reasoning/summaryTextDelta"
  ) {
    const itemId = stringValue(params?.itemId);
    const delta = stringValue(params?.delta);
    if (!itemId || !delta) return [];
    state.reasoningDeltaItemIds.add(itemId);
    return [thinkingMessage(delta, itemId, state.threadId ?? stringValue(params?.threadId))];
  }

  if (method === "item/started") {
    return mapItemStarted(asRecord(params?.item), state.threadId ?? stringValue(params?.threadId));
  }

  if (method === "item/completed") {
    return mapItemCompleted(
      asRecord(params?.item),
      state.threadId ?? stringValue(params?.threadId),
      state,
    );
  }

  if (method === "turn/completed") {
    const turn = asRecord(params?.turn);
    return [
      {
        type: "result",
        subtype: stringValue(turn?.status) || "completed",
        is_error: stringValue(turn?.status) !== "completed",
        session_id: state.threadId ?? stringValue(params?.threadId),
        usage: state.usage,
        duration_ms: numberValue(turn?.durationMs),
        num_turns: 1,
      } satisfies SdkResultMessage,
    ];
  }

  if (method === "error") {
    const err = asRecord(params?.error);
    const messageText = stringValue(err?.message) || "Codex app-server error";
    return [assistantMessage(`Codex error: ${messageText}`, undefined, stringValue(params?.threadId))];
  }

  return [];
}

function mapItemStarted(item: Record<string, unknown> | undefined, sessionId: string): SdkMessage[] {
  if (!item) return [];
  const id = stringValue(item.id);
  switch (stringValue(item.type)) {
    case "commandExecution":
      return [
        toolUse(id, "command", {
          command: stringValue(item.command),
          cwd: stringValue(item.cwd),
        }, sessionId),
      ];
    case "fileChange":
      return [toolUse(id, "fileChange", { changes: item.changes }, sessionId)];
    case "mcpToolCall":
      return [
        toolUse(
          id,
          `mcp:${stringValue(item.server)}.${stringValue(item.tool)}`,
          item.arguments,
          sessionId,
        ),
      ];
    case "dynamicToolCall":
      return [toolUse(id, stringValue(item.tool) || "dynamicToolCall", item.arguments, sessionId)];
    case "webSearch":
      return [toolUse(id, "webSearch", { query: stringValue(item.query) }, sessionId)];
    default:
      return [];
  }
}

function mapItemCompleted(
  item: Record<string, unknown> | undefined,
  sessionId: string,
  state: CodexAppServerMapState,
): SdkMessage[] {
  if (!item) return [];
  const id = stringValue(item.id);
  switch (stringValue(item.type)) {
    case "agentMessage":
      if (state.agentMessageDeltaItemIds.has(id)) return [];
      return [assistantMessage(stringValue(item.text), id, sessionId)];
    case "commandExecution":
      return [
        toolResult(
          id,
          {
            command: stringValue(item.command),
            output: item.aggregatedOutput ?? "",
            exitCode: item.exitCode ?? null,
            status: item.status,
          },
          item.exitCode !== null && item.exitCode !== undefined && numberValue(item.exitCode) !== 0,
          sessionId,
        ),
      ];
    case "fileChange":
      return [toolResult(id, { status: item.status, changes: item.changes }, false, sessionId)];
    case "mcpToolCall":
      return [
        toolResult(
          id,
          item.error ? { error: item.error } : { result: item.result },
          item.error !== null && item.error !== undefined,
          sessionId,
        ),
      ];
    case "dynamicToolCall":
      return [
        toolResult(
          id,
          { contentItems: item.contentItems, success: item.success },
          item.success === false,
          sessionId,
        ),
      ];
    case "webSearch":
      return [toolResult(id, { query: item.query, action: item.action }, false, sessionId)];
    case "plan":
      return [assistantMessage(stringValue(item.text), id, sessionId)];
    case "reasoning": {
      if (state.reasoningDeltaItemIds.has(id)) return [];
      const text = [...stringArray(item.summary), ...stringArray(item.content)].join("\n");
      return text ? [thinkingMessage(text, id, sessionId)] : [];
    }
    default:
      return [];
  }
}

function assistantMessage(text: string, uuid: string | undefined, sessionId: string): SdkMessage {
  return {
    type: "assistant",
    session_id: sessionId,
    uuid,
    message: {
      role: "assistant",
      content: text ? [{ type: "text", text }] : [],
    },
  };
}

function thinkingMessage(text: string, uuid: string | undefined, sessionId: string): SdkMessage {
  return {
    type: "assistant",
    session_id: sessionId,
    uuid,
    message: {
      role: "assistant",
      content: text ? [{ type: "thinking", thinking: text }] : [],
    },
  };
}

function toolUse(id: string, name: string, input: unknown, sessionId: string): SdkMessage {
  return {
    type: "assistant",
    session_id: sessionId,
    uuid: id,
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id, name, input }],
    },
  };
}

function toolResult(
  id: string,
  content: unknown,
  isError: boolean,
  sessionId: string,
): SdkMessage {
  return {
    type: "user",
    session_id: sessionId,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }],
    },
  };
}

function mapUsage(tokenUsage: Record<string, unknown> | undefined): SdkUsage | undefined {
  const last = asRecord(tokenUsage?.last);
  if (!last) return undefined;
  return {
    input_tokens: numberValue(last.inputTokens),
    output_tokens: numberValue(last.outputTokens),
    cache_read_input_tokens: numberValue(last.cachedInputTokens),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}
