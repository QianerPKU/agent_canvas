// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationHistoryWindow } from "./ConversationHistoryWindow.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ConversationHistoryWindow", () => {
  it("scrolls to the latest event when opened", async () => {
    let resolveFetch!: (value: unknown) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(
      <ConversationHistoryWindow
        target={{ agentId: "agent_1", turnIndex: 0, lastSeq: 2 }}
        onClose={vi.fn()}
      />,
    );

    const body = container.querySelector(".history-window__body") as HTMLDivElement;
    Object.defineProperty(body, "scrollHeight", { configurable: true, value: 900 });
    Object.defineProperty(body, "clientHeight", { configurable: true, value: 200 });
    body.scrollTop = 0;

    resolveFetch({
      ok: true,
      status: 200,
      json: async () => ({
        events: [
          {
            agentId: "agent_1",
            seq: 1,
            at: 1,
            event: { kind: "user_input", text: "first event" },
          },
          {
            agentId: "agent_1",
            seq: 2,
            at: 2,
            event: { kind: "assistant_text", text: "latest event" },
          },
        ],
      }),
      text: async () => "",
    });

    expect(await screen.findByText("latest event")).toBeTruthy();
    await waitFor(() => expect(body.scrollTop).toBe(900));
  });

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

  it("刷新实时历史时保留滚动位置", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          events: [
            {
              agentId: "agent_1",
              seq: 1,
              at: 1,
              event: { kind: "user_input", text: "开始" },
            },
          ],
        }),
        text: async () => "",
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          events: [
            {
              agentId: "agent_1",
              seq: 1,
              at: 1,
              event: { kind: "user_input", text: "开始" },
            },
            {
              agentId: "agent_1",
              seq: 2,
              at: 2,
              event: { kind: "assistant_text", text: "新增答复" },
            },
          ],
        }),
        text: async () => "",
      });
    vi.stubGlobal("fetch", fetchMock);
    const onClose = vi.fn();
    const target = { agentId: "agent_1", turnIndex: 0, lastSeq: 1 };

    const { container, rerender } = render(
      <ConversationHistoryWindow target={target} onClose={onClose} />,
    );

    expect(await screen.findByText("开始")).toBeTruthy();
    const body = container.querySelector(".history-window__body") as HTMLDivElement;
    Object.defineProperty(body, "scrollHeight", { configurable: true, value: 600 });
    Object.defineProperty(body, "clientHeight", { configurable: true, value: 200 });
    body.scrollTop = 180;

    rerender(
      <ConversationHistoryWindow
        target={{ agentId: "agent_1", turnIndex: 0, lastSeq: 2 }}
        onClose={onClose}
      />,
    );

    await screen.findByText("新增答复");
    await waitFor(() => expect(body.scrollTop).toBe(180));
    expect(screen.queryByText("正在读取历史…")).toBeNull();
  });
});
