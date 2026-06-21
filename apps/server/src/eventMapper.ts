import type { AgentEvent, UsageInfo } from "@agent-canvas/shared";
import type {
  SdkApiMessage,
  SdkContentBlock,
  SdkMessage,
  SdkResultMessage,
  SdkUsage,
} from "./sdk/types.js";

/**
 * 把一条 SDK 流式消息归一成 0..N 个统一 `AgentEvent`。
 *
 * 纯函数、无副作用 —— 是单测的主要对象。
 * 一条 assistant 消息可能含多个内容块（text + tool_use），故返回数组。
 */
export function mapSdkMessage(msg: SdkMessage): AgentEvent[] {
  switch (msg.type) {
    case "system":
      return mapSystem(msg);
    case "assistant":
      return mapAssistant(
        (msg as { message: SdkApiMessage }).message,
        (msg as { uuid?: string }).uuid,
      );
    case "user":
      return mapUser((msg as { message: SdkApiMessage }).message);
    case "result":
      return [mapResult(msg as SdkResultMessage)];
    // stream_event（partial）等暂不投影成统一事件
    default:
      return [];
  }
}

function mapSystem(msg: SdkMessage): AgentEvent[] {
  const m = msg as {
    subtype?: string;
    session_id?: string;
    model?: string;
    cwd?: string;
    tools?: string[];
    permissionMode?: string;
    compact_metadata?: {
      trigger?: string;
      pre_tokens?: number;
      post_tokens?: number;
      duration_ms?: number;
    };
    compact_result?: string;
    compact_error?: string;
  };
  if (m.subtype === "compact_boundary") {
    const metadata = m.compact_metadata;
    if (!metadata || (metadata.trigger !== "manual" && metadata.trigger !== "auto")) return [];
    return [
      {
        kind: "compact",
        trigger: metadata.trigger,
        preTokens: metadata.pre_tokens,
        postTokens: metadata.post_tokens,
        durationMs: metadata.duration_ms,
      },
    ];
  }
  if (m.subtype === "status" && m.compact_result === "failed") {
    return [{ kind: "error", message: m.compact_error ?? "compact 失败" }];
  }
  if (m.subtype !== "init") return [];
  return [
    {
      kind: "system_init",
      sessionId: m.session_id ?? "",
      model: m.model ?? "",
      cwd: m.cwd ?? "",
      tools: m.tools ?? [],
      permissionMode: m.permissionMode,
    },
  ];
}

function mapAssistant(message: SdkApiMessage, uuid?: string): AgentEvent[] {
  // 少数情况下 content 直接是字符串
  if (typeof message?.content === "string") {
    return message.content.length > 0
      ? [{ kind: "assistant_text", text: message.content, messageUuid: uuid }]
      : [];
  }
  return forEachBlock(message, (block) => {
    if (block.type === "text" && typeof (block as { text?: unknown }).text === "string") {
      const text = (block as { text: string }).text;
      // 跳过空白文本块，减少噪声
      return text.length > 0 ? { kind: "assistant_text", text, messageUuid: uuid } : null;
    }
    if (block.type === "thinking") {
      const thinking = (block as { thinking?: unknown }).thinking;
      return typeof thinking === "string" && thinking.length > 0
        ? { kind: "thinking", text: thinking, messageUuid: uuid }
        : null;
    }
    if (block.type === "tool_use") {
      const b = block as { id?: string; name?: string; input?: unknown };
      return {
        kind: "tool_use",
        toolUseId: b.id ?? "",
        name: b.name ?? "",
        input: b.input,
        messageUuid: uuid,
      };
    }
    return null;
  });
}

function mapUser(message: SdkApiMessage): AgentEvent[] {
  return forEachBlock(message, (block) => {
    if (block.type === "tool_result") {
      const b = block as {
        tool_use_id?: string;
        content?: unknown;
        is_error?: boolean;
      };
      return {
        kind: "tool_result",
        toolUseId: b.tool_use_id ?? "",
        isError: b.is_error === true,
        content: b.content,
      };
    }
    return null;
  });
}

function mapResult(msg: SdkResultMessage): AgentEvent {
  return {
    kind: "result",
    subtype: msg.subtype,
    isError: msg.is_error === true,
    costUsd: msg.total_cost_usd,
    usage: mapUsage(msg.usage),
    durationMs: msg.duration_ms,
    numTurns: msg.num_turns,
    sessionId: msg.session_id,
  };
}

function mapUsage(u: SdkUsage | undefined): UsageInfo | undefined {
  if (!u) return undefined;
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheCreationInputTokens: u.cache_creation_input_tokens,
    cacheReadInputTokens: u.cache_read_input_tokens,
  };
}

/** 遍历消息的块数组（非数组 content 不在此处理），收集非空映射结果。 */
function forEachBlock(
  message: SdkApiMessage,
  fn: (block: SdkContentBlock) => AgentEvent | null,
): AgentEvent[] {
  const content = message?.content;
  if (!Array.isArray(content)) return [];
  const events: AgentEvent[] = [];
  for (const block of content) {
    const ev = fn(block);
    if (ev) events.push(ev);
  }
  return events;
}
