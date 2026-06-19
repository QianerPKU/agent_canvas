import { describe, it, expect } from "vitest";
import {
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
});
