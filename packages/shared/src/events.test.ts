import { describe, it, expect } from "vitest";
import {
  CODEX_MODELS,
  CODEX_REASONING_EFFORTS,
  DEFAULT_CODEX_MODEL,
  isCodexModel,
  isTerminalStatus,
  TERMINAL_STATUSES,
  type AgentStatus,
  type AgentEvent,
} from "./events.js";

describe("isTerminalStatus", () => {
  it("终态返回 true", () => {
    for (const s of TERMINAL_STATUSES) {
      expect(isTerminalStatus(s)).toBe(true);
    }
  });

  it("非终态返回 false", () => {
    const nonTerminal: AgentStatus[] = [
      "idle",
      "starting",
      "running",
      "waiting_input",
    ];
    for (const s of nonTerminal) {
      expect(isTerminalStatus(s)).toBe(false);
    }
  });
});

describe("AgentEvent 联合类型", () => {
  it("可按 kind 收窄", () => {
    const ev: AgentEvent = { kind: "assistant_text", text: "hi" };
    if (ev.kind === "assistant_text") {
      expect(ev.text).toBe("hi");
    } else {
      throw new Error("收窄失败");
    }
  });

  it("包含交互问题事件", () => {
    const ev: AgentEvent = {
      kind: "user_question",
      request: {
        requestId: "q1",
        kind: "ask_user_question",
        questions: [{ id: "choice", question: "选哪个？" }],
      },
    };
    expect(ev.request.requestId).toBe("q1");
  });

  it("包含授权请求事件", () => {
    const ev: AgentEvent = {
      kind: "user_approval",
      request: {
        requestId: "approval1",
        kind: "command",
        title: "执行命令",
        command: "npm test",
      },
    };
    expect(ev.request.command).toBe("npm test");
  });

  it("包含独立 usage 事件", () => {
    const ev: AgentEvent = {
      kind: "usage",
      usage: { contextTokens: 4096, contextWindow: 128000 },
    };
    expect(ev.usage.contextTokens).toBe(4096);
  });
});

describe("Codex models", () => {
  it("包含当前可选模型并以 gpt-5.5 为默认值", () => {
    expect(CODEX_MODELS).toEqual(["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"]);
    expect(DEFAULT_CODEX_MODEL).toBe("gpt-5.5");
    expect(CODEX_REASONING_EFFORTS).toEqual(["low", "medium", "high", "xhigh"]);
    expect(isCodexModel("gpt-5.4-mini")).toBe(true);
    expect(isCodexModel("claude-opus-4-8")).toBe(false);
  });
});
