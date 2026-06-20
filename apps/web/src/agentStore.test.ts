import { describe, it, expect } from "vitest";
import type { AgentEvent, AgentEventEnvelope } from "@agent-canvas/shared";
import {
  applyEnvelope,
  applyHello,
  insertForked,
  newAgentView,
  recordCompact,
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

  it("recordInput 记录 provider 与模型", () => {
    let map: AgentMap = { a1: newAgentView("a1") };
    map = recordInput(map, "a1", "扫描项目", "codex", "gpt-5.4-mini");
    expect(get(map)).toMatchObject({
      provider: "codex",
      model: "gpt-5.4-mini",
    });
  });

  it("compact 占用一轮，完成后自动延伸 idle 轮", () => {
    seq = 0;
    let map: AgentMap = {
      a1: newAgentView("a1", { status: "waiting_input" }),
    };
    map = recordCompact(map, "a1");
    expect(get(map).turns[0]).toMatchObject({
      userInput: "/compact",
      status: "running",
    });

    map = applyEnvelope(
      map,
      env("a1", {
        kind: "compact",
        trigger: "manual",
        preTokens: 1000,
        postTokens: 250,
      }),
    );
    expect(get(map).turns).toHaveLength(2);
    expect(get(map).turns[0]).toMatchObject({ status: "done" });
    expect(get(map).turns[0]!.lines).toContainEqual({
      kind: "result",
      text: "手动 compact 完成 · 1000 → 250 tokens",
    });
    expect(get(map).turns[1]).toMatchObject({ status: "idle" });
  });

  it("同一 assistant 消息的流式片段合并为一行", () => {
    seq = 0;
    let map: AgentMap = { a1: newAgentView("a1") };
    map = applyEnvelope(
      map,
      env("a1", { kind: "assistant_text", text: "你好，", messageUuid: "message-1" }),
    );
    map = applyEnvelope(
      map,
      env("a1", { kind: "assistant_text", text: "这是完整句子。", messageUuid: "message-1" }),
    );
    map = applyEnvelope(
      map,
      env("a1", { kind: "assistant_text", text: "新消息", messageUuid: "message-2" }),
    );

    expect(get(map).turns[0]!.lines).toEqual([
      {
        kind: "assistant",
        text: "你好，这是完整句子。",
        messageUuid: "message-1",
      },
      { kind: "assistant", text: "新消息", messageUuid: "message-2" },
    ]);
  });

  it("同一 thinking 消息的流式片段合并为一行", () => {
    seq = 0;
    let map: AgentMap = { a1: newAgentView("a1") };
    map = applyEnvelope(
      map,
      env("a1", { kind: "thinking", text: "先检查", messageUuid: "thinking-1" }),
    );
    map = applyEnvelope(
      map,
      env("a1", { kind: "thinking", text: "文件", messageUuid: "thinking-1" }),
    );

    expect(get(map).turns[0]!.lines).toEqual([
      {
        kind: "thinking",
        text: "先检查文件",
        messageUuid: "thinking-1",
      },
    ]);
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

  it("status=terminated 把当前轮和 agent 标记为 terminated", () => {
    let map: AgentMap = {
      a1: newAgentView("a1", {
        status: "waiting_input",
        turns: [{ index: 0, status: "idle", lines: [] }],
      }),
    };
    map = applyEnvelope(map, env("a1", { kind: "status", status: "terminated" }));
    expect(get(map).turns[0]!.status).toBe("terminated");
    expect(get(map).status).toBe("terminated");
  });

  it("insertForked 插入带 forkOrigin 与模型的新 agent", () => {
    let map: AgentMap = {
      a1: newAgentView("a1", { provider: "codex", model: "gpt-5.4" }),
    };
    map = insertForked(
      map,
      "a2",
      { parentAgentId: "a1", anchorUuid: "u1" },
      "gpt-5.5",
    );
    const v = get(map, "a2");
    expect(v.forkOrigin).toEqual({ parentAgentId: "a1", anchorUuid: "u1" });
    expect(v.provider).toBe("codex");
    expect(v.model).toBe("gpt-5.5");
    expect(v.turns).toHaveLength(1);
    expect(v.turns[0]!.status).toBe("idle");
  });

  it("applyHello 携带 forkOrigin", () => {
    const map = applyHello([
      {
        id: "a2",
        status: "idle",
        config: { prompt: "", provider: "codex", model: "gpt-5.4-mini" },
        createdAt: 1,
        lastEventSeq: 0,
        forkOrigin: { parentAgentId: "a1", anchorUuid: "u1" },
      },
    ]);
    expect(get(map, "a2").forkOrigin).toEqual({ parentAgentId: "a1", anchorUuid: "u1" });
    expect(get(map, "a2").model).toBe("gpt-5.4-mini");
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
