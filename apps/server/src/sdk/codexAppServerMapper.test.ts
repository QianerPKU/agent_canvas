import { describe, expect, it } from "vitest";
import {
  createCodexAppServerMapState,
  mapCodexNotification,
  mapCodexThreadInit,
} from "./codexAppServerMapper.js";

describe("codex app-server mapper", () => {
  it("thread start response → system init", () => {
    const msg = mapCodexThreadInit(
      {
        thread: { id: "thr_1", cwd: "/repo" },
        model: "gpt-5.4",
        cwd: "/repo",
      },
      { permissionMode: "acceptEdits" },
    );

    expect(msg).toEqual({
      type: "system",
      subtype: "init",
      session_id: "thr_1",
      model: "gpt-5.4",
      cwd: "/repo",
      tools: ["codex-app-server"],
      permissionMode: "acceptEdits",
    });
  });

  it("agent message deltas stream as assistant text and suppress duplicate completion", () => {
    const state = createCodexAppServerMapState();
    state.threadId = "thr_1";

    expect(
      mapCodexNotification(
        {
          method: "item/agentMessage/delta",
          params: { threadId: "thr_1", turnId: "turn_1", itemId: "item_1", delta: "hello" },
        },
        state,
      ),
    ).toEqual([
      {
        type: "assistant",
        session_id: "thr_1",
        uuid: "item_1",
        message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
      },
    ]);

    expect(
      mapCodexNotification(
        {
          method: "item/completed",
          params: {
            threadId: "thr_1",
            turnId: "turn_1",
            item: { type: "agentMessage", id: "item_1", text: "hello", phase: null },
          },
        },
        state,
      ),
    ).toEqual([]);
  });

  it("command items map to tool_use and tool_result", () => {
    const state = createCodexAppServerMapState();
    state.threadId = "thr_1";

    expect(
      mapCodexNotification(
        {
          method: "item/started",
          params: {
            threadId: "thr_1",
            turnId: "turn_1",
            item: {
              type: "commandExecution",
              id: "cmd_1",
              command: "npm test",
              cwd: "/repo",
            },
          },
        },
        state,
      ),
    ).toEqual([
      {
        type: "assistant",
        session_id: "thr_1",
        uuid: "cmd_1",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "cmd_1",
              name: "command",
              input: { command: "npm test", cwd: "/repo" },
            },
          ],
        },
      },
    ]);

    expect(
      mapCodexNotification(
        {
          method: "item/completed",
          params: {
            threadId: "thr_1",
            turnId: "turn_1",
            item: {
              type: "commandExecution",
              id: "cmd_1",
              command: "npm test",
              aggregatedOutput: "ok",
              exitCode: 0,
              status: "completed",
            },
          },
        },
        state,
      ),
    ).toEqual([
      {
        type: "user",
        session_id: "thr_1",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "cmd_1",
              content: {
                command: "npm test",
                output: "ok",
                exitCode: 0,
                status: "completed",
              },
              is_error: false,
            },
          ],
        },
      },
    ]);
  });

  it("token usage is attached to turn result", () => {
    const state = createCodexAppServerMapState();
    state.threadId = "thr_1";

    expect(
      mapCodexNotification(
        {
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thr_1",
            turnId: "turn_1",
            tokenUsage: {
              last: {
                inputTokens: 10,
                cachedInputTokens: 4,
                outputTokens: 3,
                totalTokens: 17,
                reasoningOutputTokens: 0,
              },
            },
          },
        },
        state,
      ),
    ).toEqual([]);

    expect(
      mapCodexNotification(
        {
          method: "turn/completed",
          params: {
            threadId: "thr_1",
            turn: { id: "turn_1", status: "completed", durationMs: 123 },
          },
        },
        state,
      ),
    ).toEqual([
      {
        type: "result",
        subtype: "completed",
        is_error: false,
        session_id: "thr_1",
        usage: {
          input_tokens: 10,
          output_tokens: 3,
          cache_read_input_tokens: 4,
        },
        duration_ms: 123,
        num_turns: 1,
      },
    ]);
  });
});
