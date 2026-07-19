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

  it("auto compact 记录在当前运行轮，不延伸新轮", () => {
    seq = 0;
    let map: AgentMap = { a1: newAgentView("a1") };
    map = recordInput(map, "a1", "run long task");
    map = applyEnvelope(
      map,
      env("a1", {
        kind: "compact",
        trigger: "auto",
        preTokens: 2000,
        postTokens: 800,
      }),
    );

    const v = get(map);
    expect(v.turns).toHaveLength(1);
    expect(v.turns[0]).toMatchObject({ status: "running" });
    expect(v.turns[0]!.lines).toContainEqual({
      kind: "system",
      text: "自动 compact 完成 · 2000 → 800 tokens",
    });
  });

  it("运行中 queued/steer 输入不覆盖当前轮，queued 在 result 后成为下一轮输入", () => {
    seq = 0;
    let map: AgentMap = { a1: newAgentView("a1") };
    map = recordInput(map, "a1", "run long task");

    map = applyEnvelope(
      map,
      env("a1", { kind: "user_input", text: "下一轮继续整理", mode: "queued" }),
    );
    map = applyEnvelope(
      map,
      env("a1", { kind: "user_input", text: "先看失败测试", mode: "steer" }),
    );

    expect(get(map).turns[0]).toMatchObject({
      userInput: "run long task",
      status: "running",
    });
    expect(get(map).turns[0]!.lines).toContainEqual({
      kind: "system",
      text: "已排队下一轮：下一轮继续整理",
    });
    expect(get(map).turns[0]!.lines).toContainEqual({
      kind: "system",
      text: "引导：先看失败测试",
    });

    map = applyEnvelope(
      map,
      env("a1", { kind: "result", subtype: "success", isError: false }),
    );
    map = applyEnvelope(map, env("a1", { kind: "user_input", text: "下一轮继续整理" }));

    expect(get(map).turns).toHaveLength(2);
    expect(get(map).turns[1]).toMatchObject({
      userInput: "下一轮继续整理",
      status: "running",
    });
  });

  it("交互问题作为当前轮输出行，回答后更新状态", () => {
    seq = 0;
    let map: AgentMap = { a1: newAgentView("a1") };
    map = recordInput(map, "a1", "需要先问我");
    map = applyEnvelope(
      map,
      env("a1", {
        kind: "user_question",
        request: {
          requestId: "codex:7",
          kind: "ask_user_question",
          title: "Codex 需要确认",
          questions: [
            {
              id: "choice",
              question: "怎么处理？",
              options: [{ label: "继续", description: "继续执行" }],
            },
          ],
        },
      }),
    );

    expect(get(map).turns[0]!.lines).toContainEqual({
      kind: "question",
      status: "pending",
      request: {
        requestId: "codex:7",
        kind: "ask_user_question",
        title: "Codex 需要确认",
        questions: [
          {
            id: "choice",
            question: "怎么处理？",
            options: [{ label: "继续", description: "继续执行" }],
          },
        ],
      },
    });

    map = applyEnvelope(
      map,
      env("a1", {
        kind: "user_question_result",
        requestId: "codex:7",
        action: "accept",
        summary: "已回答 1 个问题",
      }),
    );
    expect(get(map).turns[0]!.lines.at(-1)).toMatchObject({
      kind: "question",
      status: "accepted",
      summary: "已回答 1 个问题",
    });
  });

  it("授权请求作为当前轮输出行，处理后更新状态", () => {
    seq = 0;
    let map: AgentMap = { a1: newAgentView("a1") };
    map = recordInput(map, "a1", "运行测试");
    map = applyEnvelope(
      map,
      env("a1", {
        kind: "user_approval",
        request: {
          requestId: "approval-1",
          kind: "command",
          title: "Codex 请求执行命令",
          command: "npm test",
        },
      }),
    );

    expect(get(map).turns[0]!.lines.at(-1)).toMatchObject({
      kind: "approval",
      status: "pending",
      request: {
        requestId: "approval-1",
        kind: "command",
        title: "Codex 请求执行命令",
        command: "npm test",
      },
    });

    map = applyEnvelope(
      map,
      env("a1", {
        kind: "user_approval_result",
        requestId: "approval-1",
        action: "approve",
        summary: "已允许",
      }),
    );
    expect(get(map).turns[0]!.lines.at(-1)).toMatchObject({
      kind: "approval",
      status: "approved",
      summary: "已允许",
    });
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

  it("turn_context 按 turnIndex 写入对应历史轮", () => {
    seq = 0;
    let map: AgentMap = { a1: newAgentView("a1") };
    map = recordInput(map, "a1", "t1");
    map = applyEnvelope(
      map,
      env("a1", { kind: "result", subtype: "success", isError: false, anchorUuid: "u1" }),
    );
    map = applyEnvelope(
      map,
      env("a1", {
        kind: "turn_context",
        context: {
          turnIndex: 0,
          branch: "feature/a",
          cwd: "/repo-a",
          baseCommitSha: "abcdef1234567890",
          baseShortSha: "abcdef1",
        },
      }),
    );

    const v = get(map);
    expect(v.turns[0]).toMatchObject({
      branch: "feature/a",
      cwd: "/repo-a",
      baseCommitSha: "abcdef1234567890",
      baseShortSha: "abcdef1",
    });
    expect(v.turns[1]!.branch).toBeUndefined();
    expect(v.turns[1]!.baseCommitSha).toBeUndefined();
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

  it("status=stopped 把当前轮标记 stopped，并延伸新的 idle 输入轮", () => {
    seq = 0;
    let map: AgentMap = { a1: newAgentView("a1") };
    map = recordInput(map, "a1", "x");
    map = applyEnvelope(map, env("a1", SYS));
    map = applyEnvelope(map, env("a1", { kind: "status", status: "stopped" }));
    expect(get(map).turns).toHaveLength(2);
    expect(get(map).turns[0]!.status).toBe("stopped");
    expect(get(map).turns[1]).toMatchObject({ index: 1, status: "idle" });
    expect(get(map).status).toBe("stopped");

    map = applyEnvelope(map, env("a1", { kind: "user_input", text: "继续" }));
    expect(get(map).turns[1]).toMatchObject({ userInput: "继续", status: "running" });
  });

  it("status=terminated 把当前轮标记 terminated，并延伸新的 idle 输入轮", () => {
    let map: AgentMap = {
      a1: newAgentView("a1", {
        status: "waiting_input",
        turns: [{ index: 0, status: "idle", lines: [] }],
      }),
    };
    map = applyEnvelope(map, env("a1", { kind: "status", status: "terminated" }));
    expect(get(map).turns).toHaveLength(2);
    expect(get(map).turns[0]!.status).toBe("terminated");
    expect(get(map).turns[1]).toMatchObject({ index: 1, status: "idle" });
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
      { model: "gpt-5.5" },
    );
    const v = get(map, "a2");
    expect(v.forkOrigin).toEqual({ parentAgentId: "a1", anchorUuid: "u1" });
    expect(v.provider).toBe("codex");
    expect(v.model).toBe("gpt-5.5");
    expect(v.turns).toHaveLength(1);
    expect(v.turns[0]!.status).toBe("idle");
  });

  it("insertForked 可以覆盖 fork 子 agent 的 branch", () => {
    let map: AgentMap = {
      a1: newAgentView("a1", {
        provider: "claude",
        branchWorkspaceId: "branch_1",
        branch: "main",
        cwd: "E:\\repo\\main",
      }),
    };
    map = insertForked(map, "a2", { parentAgentId: "a1", anchorUuid: "u1" }, {
      branchWorkspaceId: "branch_2",
      branch: "feature/a",
      cwd: "E:\\repo\\feature-a",
    });
    const v = get(map, "a2");
    expect(v.branchWorkspaceId).toBe("branch_2");
    expect(v.branch).toBe("feature/a");
    expect(v.cwd).toBe("E:\\repo\\feature-a");
  });

  it("insertForked 为早到的 live fork 节点补元数据而不覆盖运行态", () => {
    const liveTurns = [
      {
        index: 0,
        status: "running" as const,
        lines: [{ kind: "system" as const, text: "会话建立 · runtime-model" }],
      },
    ];
    let map: AgentMap = {
      a1: newAgentView("a1", {
        provider: "codex",
        model: "parent-model",
        reasoningEffort: "high",
        branchWorkspaceId: "branch_main",
        branch: "main",
        cwd: "E:\\repo\\main",
        scratchDirectory: "E:\\repo\\main\\.agent-tmp\\a1",
        systemPrompt: "parent policy",
      }),
      a2: newAgentView("a2", {
        status: "running",
        sessionId: "session-a2",
        model: "runtime-model",
        turns: liveTurns,
        lastSeq: 3,
      }),
    };

    map = insertForked(map, "a2", { parentAgentId: "a1", anchorUuid: "u1" }, {
      model: "requested-model",
      reasoningEffort: "medium",
      branchWorkspaceId: "branch_feature",
      branch: "feature/a",
      cwd: "E:\\repo\\feature-a",
      scratchDirectory: "E:\\repo\\feature-a\\.agent-tmp\\a2",
    });

    expect(get(map, "a2")).toMatchObject({
      status: "running",
      sessionId: "session-a2",
      model: "runtime-model",
      lastSeq: 3,
      provider: "codex",
      reasoningEffort: "medium",
      branchWorkspaceId: "branch_feature",
      branch: "feature/a",
      cwd: "E:\\repo\\feature-a",
      scratchDirectory: "E:\\repo\\feature-a\\.agent-tmp\\a2",
      systemPrompt: "parent policy",
      forkOrigin: { parentAgentId: "a1", anchorUuid: "u1" },
    });
    expect(get(map, "a2").turns).toBe(liveTurns);
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

  it("applyHello 携带 histories 时恢复多轮对话节点", () => {
    seq = 0;
    const history = [
      env("a1", { kind: "user_input", text: "first" }),
      env("a1", SYS),
      env("a1", { kind: "assistant_text", text: "done", messageUuid: "u1" }),
      env("a1", { kind: "result", subtype: "success", isError: false, anchorUuid: "u1" }),
    ];
    const map = applyHello(
      [
        {
          id: "a1",
          status: "waiting_input",
          config: { prompt: "", provider: "claude", systemPrompt: "private" },
          createdAt: 1,
          lastEventSeq: history.at(-1)!.seq,
        },
      ],
      { a1: history },
    );

    expect(get(map).turns).toHaveLength(2);
    expect(get(map).turns[0]).toMatchObject({
      userInput: "first",
      status: "done",
      anchorUuid: "u1",
    });
    expect(get(map).turns[1]).toMatchObject({ status: "idle" });
    expect(get(map)).toMatchObject({
      status: "waiting_input",
      systemPrompt: "private",
      lastSeq: history.at(-1)!.seq,
    });
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
