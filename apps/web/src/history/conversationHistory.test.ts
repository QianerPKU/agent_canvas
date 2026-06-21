import { describe, expect, it } from "vitest";
import type { AgentEventEnvelope } from "@agent-canvas/shared";
import { buildConversationHistory } from "./conversationHistory.js";

function envelope(seq: number, event: AgentEventEnvelope["event"]): AgentEventEnvelope {
  return { agentId: "a1", seq, at: seq, event };
}

describe("buildConversationHistory", () => {
  it("截断到目标轮，并合并流式答复与思考", () => {
    const turns = buildConversationHistory(
      [
        envelope(1, { kind: "user_input", text: "第一问" }),
        envelope(2, { kind: "thinking", text: "先想", messageUuid: "t1" }),
        envelope(3, { kind: "thinking", text: "一下", messageUuid: "t1" }),
        envelope(4, { kind: "assistant_text", text: "答", messageUuid: "a1" }),
        envelope(5, { kind: "assistant_text", text: "案", messageUuid: "a1" }),
        envelope(6, { kind: "result", subtype: "success", isError: false }),
        envelope(7, { kind: "status", status: "waiting_input" }),
        envelope(8, { kind: "user_input", text: "第二问" }),
      ],
      0,
    );

    expect(turns).toHaveLength(1);
    expect(turns[0]!.items.map((item) => item.event)).toEqual([
      { kind: "user_input", text: "第一问" },
      { kind: "thinking", text: "先想一下", messageUuid: "t1" },
      { kind: "assistant_text", text: "答案", messageUuid: "a1" },
      { kind: "result", subtype: "success", isError: false },
    ]);
  });

  it("选择当前未完成轮时包含此前所有轮次和当前事件", () => {
    const turns = buildConversationHistory(
      [
        envelope(1, { kind: "user_input", text: "第一问" }),
        envelope(2, { kind: "result", subtype: "success", isError: false }),
        envelope(3, { kind: "status", status: "waiting_input" }),
        envelope(4, { kind: "user_input", text: "第二问" }),
        envelope(5, { kind: "tool_use", toolUseId: "x", name: "Read", input: {} }),
      ],
      1,
    );

    expect(turns).toHaveLength(2);
    expect(turns[1]!.items.map((item) => item.event.kind)).toEqual([
      "status",
      "user_input",
      "tool_use",
    ]);
  });

  it("自动 compact 不作为轮次边界，手动 compact 仍然作为独立轮结束", () => {
    const turns = buildConversationHistory(
      [
        envelope(1, { kind: "user_input", text: "长任务" }),
        envelope(2, { kind: "compact", trigger: "auto" }),
        envelope(3, { kind: "assistant_text", text: "继续执行", messageUuid: "a1" }),
        envelope(4, { kind: "result", subtype: "success", isError: false }),
        envelope(5, { kind: "status", status: "waiting_input" }),
        envelope(6, { kind: "user_input", text: "/compact" }),
        envelope(7, { kind: "compact", trigger: "manual" }),
        envelope(8, { kind: "status", status: "waiting_input" }),
        envelope(9, { kind: "user_input", text: "下一问" }),
      ],
      1,
    );

    expect(turns).toHaveLength(2);
    expect(turns[0]!.items.map((item) => item.event.kind)).toEqual([
      "user_input",
      "compact",
      "assistant_text",
      "result",
    ]);
    expect(turns[1]!.items.map((item) => item.event)).toEqual([
      { kind: "status", status: "waiting_input" },
      { kind: "user_input", text: "/compact" },
      { kind: "compact", trigger: "manual" },
    ]);
  });
});
