import { describe, it, expect } from "vitest";
import type { AgentEvent, AgentEventEnvelope } from "@agent-canvas/shared";
import {
  applyEnvelope,
  applyHello,
  emptyMap,
  insertForked,
  newAgentView,
  recordInput,
  type AgentMap,
  type AgentView,
} from "./agentStore.js";

let seq = 0;
function env(agentId: string, event: AgentEvent): AgentEventEnvelope {
  return { agentId, seq: ++seq, at: Date.now(), event };
}
function get(m: AgentMap, id = "a1"): AgentView {
  const v = m[id];
  if (!v) throw new Error(`缺少 ${id}`);
  return v;
}

const SYS: AgentEvent = {
  kind: "system_init",
  sessionId: "s1",
  model: "haiku",
  cwd: "/r",
  tools: [],
};

describe("agentStore 轮次模型", () => {
  it("新建 agent 有一个 idle 轮", () => {
    const v = newAgentView("a1");
    expect(v.turns).toHaveLength(1);
    expect(v.turns[0]).toMatchObject({ index: 0, status: "idle" });
  });

  it("recordInput 把末尾轮置 running 并记录输入", () => {
    seq = 0;
    let map: AgentMap = { a1: newAgentView("a1") };
    map = recordInput(map, "a1", "写个 a+b");
    const t0 = get(map).turns[0]!;
    expect(t0.status).toBe("running");
    expect(t0.userInput).toBe("写个 a+b");
  });

  it("一轮以 result 收尾：定格 done + anchorUuid，并自动延伸新 idle 轮", () => {
    seq = 0;
    let map: AgentMap = { a1: newAgentView("a1") };
    map = recordInput(map, "a1", "做 x");
    map = applyEnvelope(map, env("a1", SYS));
    map = applyEnvelope(map, env("a1", { kind: "assistant_text", text: "好的", messageUuid: "u1" }));
    map = applyEnvelope(
      map,
      env("a1", { kind: "result", subtype: "success", isError: false, costUsd: 0.01, anchorUuid: "u1" }),
    );

    const v = get(map);
    expect(v.turns).toHaveLength(2);
    const t0 = v.turns[0]!;
    expect(t0.status).toBe("done");
    expect(t0.anchorUuid).toBe("u1");
    expect(t0.costUsd).toBe(0.01);
    expect(t0.lines.some((l) => l.kind === "assistant")).toBe(true);
    expect(v.turns[1]).toMatchObject({ index: 1, status: "idle" });
  });

  it("多轮：第二轮输入折叠进新轮，再 result 又延伸第三轮", () => {
    seq = 0;
    let map: AgentMap = { a1: newAgentView("a1") };
    // 第一轮
    map = recordInput(map, "a1", "t1");
    map = applyEnvelope(map, env("a1", SYS));
    map = applyEnvelope(map, env("a1", { kind: "result", subtype: "success", isError: false, anchorUuid: "u1" }));
    // 第二轮
    map = recordInput(map, "a1", "t2");
    map = applyEnvelope(map, env("a1", { kind: "assistant_text", text: "第二轮答复", messageUuid: "u2" }));
    map = applyEnvelope(map, env("a1", { kind: "result", subtype: "success", isError: false, anchorUuid: "u2" }));

    const v = get(map);
    expect(v.turns).toHaveLength(3);
    expect(v.turns[1]!.userInput).toBe("t2");
    expect(v.turns[1]!.status).toBe("done");
    expect(v.turns[1]!.anchorUuid).toBe("u2");
    expect(v.turns[2]!.status).toBe("idle");
  });

  it("status=stopped 把当前轮标记 stopped", () => {
    seq = 0;
    let map: AgentMap = { a1: newAgentView("a1") };
    map = recordInput(map, "a1", "x");
    map = applyEnvelope(map, env("a1", SYS));
    map = applyEnvelope(map, env("a1", { kind: "status", status: "stopped" }));
    expect(get(map).turns[0]!.status).toBe("stopped");
    expect(get(map).status).toBe("stopped");
  });

  it("insertForked 插入带 forkOrigin 的新 agent", () => {
    let map = emptyMap();
    map = insertForked(map, "a2", { parentAgentId: "a1", anchorUuid: "u1" });
    const v = get(map, "a2");
    expect(v.forkOrigin).toEqual({ parentAgentId: "a1", anchorUuid: "u1" });
    expect(v.turns).toHaveLength(1);
    expect(v.turns[0]!.status).toBe("idle");
  });

  it("applyHello 携带 forkOrigin", () => {
    const map = applyHello([
      {
        id: "a2",
        status: "idle",
        config: { prompt: "" },
        createdAt: 1,
        lastEventSeq: 0,
        forkOrigin: { parentAgentId: "a1", anchorUuid: "u1" },
      },
    ]);
    expect(get(map, "a2").forkOrigin).toEqual({ parentAgentId: "a1", anchorUuid: "u1" });
  });

  it("忽略旧 seq", () => {
    let map: AgentMap = { a1: newAgentView("a1", { lastSeq: 5 }) };
    map = applyEnvelope(map, {
      agentId: "a1",
      seq: 3,
      at: 0,
      event: { kind: "status", status: "running" },
    });
    expect(get(map).status).toBe("idle");
  });
});
