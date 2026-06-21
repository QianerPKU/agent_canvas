// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationHistoryWindow } from "./ConversationHistoryWindow.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ConversationHistoryWindow", () => {
  it("加载并展示思考、工具调用和完整结果", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        events: [
          {
            agentId: "agent_1",
            seq: 1,
            at: 1,
            event: { kind: "user_input", text: "检查项目" },
          },
          {
            agentId: "agent_1",
            seq: 2,
            at: 2,
            event: { kind: "thinking", text: "先读取配置", messageUuid: "thinking-1" },
          },
          {
            agentId: "agent_1",
            seq: 3,
            at: 3,
            event: {
              kind: "tool_use",
              toolUseId: "tool-1",
              name: "Read",
              input: { path: "package.json" },
            },
          },
          {
            agentId: "agent_1",
            seq: 4,
            at: 4,
            event: {
              kind: "tool_result",
              toolUseId: "tool-1",
              isError: false,
              content: { output: "完整工具结果" },
            },
          },
          {
            agentId: "agent_1",
            seq: 5,
            at: 5,
            event: {
              kind: "compact",
              trigger: "auto",
              preTokens: 2000,
              postTokens: 800,
            },
          },
        ],
      }),
      text: async () => "",
    });
    vi.stubGlobal("fetch", fetchMock);
    const onClose = vi.fn();

    render(
      <ConversationHistoryWindow
        target={{ agentId: "agent_1", turnIndex: 0, lastSeq: 5 }}
        onClose={onClose}
      />,
    );

    expect(await screen.findByText("先读取配置")).toBeTruthy();
    expect(screen.getByText("工具调用 · Read")).toBeTruthy();
    expect(screen.getByText(/完整工具结果/)).toBeTruthy();
    expect(screen.getByText("自动 compact")).toBeTruthy();
    expect(screen.getByText("2000 → 800 tokens")).toBeTruthy();

    fireEvent.click(screen.getByTitle("关闭历史窗口"));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
