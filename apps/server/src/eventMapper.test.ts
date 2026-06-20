import { describe, it, expect } from "vitest";
import { mapSdkMessage } from "./eventMapper.js";
import type { SdkMessage } from "./sdk/types.js";

describe("mapSdkMessage", () => {
  it("system/init → system_init", () => {
    const msg: SdkMessage = {
      type: "system",
      subtype: "init",
      session_id: "s1",
      model: "claude-opus-4-8",
      cwd: "/repo",
      tools: ["Read", "Edit"],
      permissionMode: "default",
    };
    expect(mapSdkMessage(msg)).toEqual([
      {
        kind: "system_init",
        sessionId: "s1",
        model: "claude-opus-4-8",
        cwd: "/repo",
        tools: ["Read", "Edit"],
        permissionMode: "default",
      },
    ]);
  });

  it("manual compact boundary → compact", () => {
    const msg: SdkMessage = {
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: {
        trigger: "manual",
        pre_tokens: 12000,
        post_tokens: 3200,
        duration_ms: 900,
      },
      uuid: "compact-1",
      session_id: "s1",
    };
    expect(mapSdkMessage(msg)).toEqual([
      {
        kind: "compact",
        trigger: "manual",
        preTokens: 12000,
        postTokens: 3200,
        durationMs: 900,
      },
    ]);
  });

  it("auto compact boundary 不生成手动轮次，失败状态生成错误", () => {
    expect(
      mapSdkMessage({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto" },
        uuid: "compact-2",
        session_id: "s1",
      }),
    ).toEqual([]);
    expect(
      mapSdkMessage({
        type: "system",
        subtype: "status",
        status: null,
        compact_result: "failed",
        compact_error: "上下文过短",
        session_id: "s1",
      }),
    ).toEqual([{ kind: "error", message: "上下文过短" }]);
  });

  it("assistant 含 text + tool_use → 两个事件，顺序保持", () => {
    const msg: SdkMessage = {
      type: "assistant",
      session_id: "s1",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "我来读文件" },
          { type: "tool_use", id: "t1", name: "Read", input: { path: "a.ts" } },
        ],
      },
    };
    expect(mapSdkMessage(msg)).toEqual([
      { kind: "assistant_text", text: "我来读文件" },
      { kind: "tool_use", toolUseId: "t1", name: "Read", input: { path: "a.ts" } },
    ]);
  });

  it("捕获 assistant 消息 uuid 到 messageUuid", () => {
    const msg: SdkMessage = {
      type: "assistant",
      session_id: "s1",
      uuid: "u-123",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "答复" },
          { type: "tool_use", id: "t1", name: "Read", input: {} },
        ],
      },
    };
    const events = mapSdkMessage(msg);
    expect(events[0]).toMatchObject({ kind: "assistant_text", messageUuid: "u-123" });
    expect(events[1]).toMatchObject({ kind: "tool_use", messageUuid: "u-123" });
  });

  it("空白 text 块被跳过", () => {
    const msg: SdkMessage = {
      type: "assistant",
      session_id: "s1",
      message: { role: "assistant", content: [{ type: "text", text: "" }] },
    };
    expect(mapSdkMessage(msg)).toEqual([]);
  });

  it("thinking 块 → thinking", () => {
    const msg: SdkMessage = {
      type: "assistant",
      session_id: "s1",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "嗯..." }],
      },
    };
    expect(mapSdkMessage(msg)).toEqual([
      { kind: "thinking", text: "嗯...", messageUuid: undefined },
    ]);
  });

  it("user/tool_result → tool_result（含 is_error）", () => {
    const msg: SdkMessage = {
      type: "user",
      session_id: "s1",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "boom", is_error: true },
        ],
      },
    };
    expect(mapSdkMessage(msg)).toEqual([
      { kind: "tool_result", toolUseId: "t1", isError: true, content: "boom" },
    ]);
  });

  it("result → result（映射 cost/usage/驼峰）", () => {
    const msg: SdkMessage = {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "done",
      total_cost_usd: 0.0123,
      duration_ms: 4200,
      num_turns: 3,
      session_id: "s1",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 10,
      },
    };
    expect(mapSdkMessage(msg)).toEqual([
      {
        kind: "result",
        subtype: "success",
        isError: false,
        costUsd: 0.0123,
        durationMs: 4200,
        numTurns: 3,
        sessionId: "s1",
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheCreationInputTokens: undefined,
          cacheReadInputTokens: 10,
        },
      },
    ]);
  });

  it("未知/不关心的消息 → 空数组", () => {
    expect(mapSdkMessage({ type: "stream_event", event: {}, session_id: "s1" })).toEqual([]);
    expect(mapSdkMessage({ type: "whatever" })).toEqual([]);
  });
});
