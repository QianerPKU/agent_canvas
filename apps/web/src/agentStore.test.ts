import { describe, it, expect } from "vitest";
import type { AgentEvent, AgentEventEnvelope } from "@agent-canvas/shared";
import {
  applyEnvelope,
  applyHello,
  emptyMap,
  MAX_LINES,
  newAgentView,
  type AgentMap,
  type AgentView,
} from "./agentStore.js";

let seq = 0;
function env(agentId: string, event: AgentEvent): AgentEventEnvelope {
  return { agentId, seq: ++seq, at: Date.now(), event };
}

/** 取出 a1（带断言，避免 noUncheckedIndexedAccess 噪声）。 */
function a1(m: AgentMap): AgentView {
  const v = m.a1;
  if (!v) throw new Error("缺少 a1");
  return v;
}

describe("agentStore", () => {
  it("applyHello 用快照重建表", () => {
    const map = applyHello([
      {
        id: "a1",
        status: "running",
        sessionId: "s1",
        config: { prompt: "x" },
        createdAt: 1,
        lastEventSeq: 7,
        totalCostUsd: 0.5,
      },
    ]);
    expect(a1(map).status).toBe("running");
    expect(a1(map).lastSeq).toBe(7);
    expect(a1(map).costUsd).toBe(0.5);
  });

  it("status 事件更新状态", () => {
    seq = 0;
    let map: AgentMap = { a1: newAgentView("a1") };
    map = applyEnvelope(map, env("a1", { kind: "status", status: "running" }));
    expect(a1(map).status).toBe("running");
  });

  it("system_init 记录 session/model 并加一行", () => {
    seq = 0;
    let map = emptyMap();
    map = applyEnvelope(
      map,
      env("a1", {
        kind: "system_init",
        sessionId: "s1",
        model: "haiku",
        cwd: "/r",
        tools: [],
      }),
    );
    expect(a1(map).sessionId).toBe("s1");
    expect(a1(map).model).toBe("haiku");
    expect(a1(map).lines).toHaveLength(1);
    expect(a1(map).lines[0]).toMatchObject({ kind: "system" });
  });

  it("assistant/tool_use/tool_result 累积成行", () => {
    seq = 0;
    let map = emptyMap();
    map = applyEnvelope(map, env("a1", { kind: "assistant_text", text: "hi" }));
    map = applyEnvelope(map, env("a1", { kind: "tool_use", toolUseId: "t", name: "Read", input: {} }));
    map = applyEnvelope(map, env("a1", { kind: "tool_result", toolUseId: "t", isError: false, content: "ok" }));
    expect(a1(map).lines.map((l) => l.kind)).toEqual(["assistant", "tool_use", "tool_result"]);
  });

  it("result 更新累计花费", () => {
    seq = 0;
    let map = emptyMap();
    map = applyEnvelope(
      map,
      env("a1", { kind: "result", subtype: "success", isError: false, costUsd: 0.0123 }),
    );
    expect(a1(map).costUsd).toBeCloseTo(0.0123);
    expect(a1(map).lines[0]).toMatchObject({ kind: "result" });
  });

  it("忽略已处理过的旧 seq", () => {
    let map: AgentMap = { a1: newAgentView("a1", { lastSeq: 5 }) };
    const stale: AgentEventEnvelope = {
      agentId: "a1",
      seq: 3,
      at: 0,
      event: { kind: "status", status: "running" },
    };
    map = applyEnvelope(map, stale);
    expect(a1(map).status).toBe("idle"); // 未被旧事件改动
  });

  it("不可变更新：返回新引用", () => {
    seq = 0;
    const map: AgentMap = { a1: newAgentView("a1") };
    const next = applyEnvelope(map, env("a1", { kind: "status", status: "done" }));
    expect(next).not.toBe(map);
    expect(a1(next)).not.toBe(a1(map));
    expect(a1(map).status).toBe("idle"); // 原对象不变
  });

  it("输出行数封顶 MAX_LINES", () => {
    seq = 0;
    let map = emptyMap();
    for (let i = 0; i < MAX_LINES + 50; i++) {
      map = applyEnvelope(map, env("a1", { kind: "assistant_text", text: `${i}` }));
    }
    const lines = a1(map).lines;
    expect(lines).toHaveLength(MAX_LINES);
    expect(lines[lines.length - 1]).toMatchObject({ text: `${MAX_LINES + 49}` });
  });
});
