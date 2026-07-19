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

  it("usage 实时更新当前轮，并在 result 后延续到新的 idle/running 轮", () => {
    seq = 0;
    let map: AgentMap = { a1: newAgentView("a1") };
    map = recordInput(map, "a1", "长任务");
    map = applyEnvelope(
      map,
      env("a1", {
        kind: "usage",
        usage: { contextTokens: 4096, contextWindow: 128000 },
      }),
    );

    expect(get(map).latestUsage).toEqual({
      contextTokens: 4096,
      contextWindow: 128000,
    });
    expect(get(map).turns[0]!.usage?.contextTokens).toBe(4096);

    map = applyEnvelope(
      map,
      env("a1", { kind: "result", subtype: "success", isError: false }),
    );
    expect(get(map).turns[0]!.usage?.contextTokens).toBe(4096);
    expect(get(map).turns[1]).toMatchObject({
      status: "idle",
      usage: { contextTokens: 4096, contextWindow: 128000 },
    });

    map = recordInput(map, "a1", "继续");
    expect(get(map).turns[1]).toMatchObject({
      status: "running",
      usage: { contextTokens: 4096, contextWindow: 128000 },
    });
  });

  it("新 session 初始化时清除当前轮继承的旧线程 usage", () => {
    seq = 0;
    let map: AgentMap = { a1: newAgentView("a1") };
    map = recordInput(map, "a1", "旧会话");
    map = applyEnvelope(map, env("a1", SYS));
    map = applyEnvelope(
      map,
      env("a1", {
        kind: "usage",
        usage: { contextTokens: 4096, contextWindow: 128000 },
      }),
    );
    map = applyEnvelope(
      map,
      env("a1", { kind: "result", subtype: "success", isError: false }),
    );
    map = recordInput(map, "a1", "新会话");

    map = applyEnvelope(
      map,
      env("a1", {
        kind: "system_init",
        sessionId: "s2",
        model: "gpt-5.5",
        cwd: "/tmp",
        tools: [],
      }),
    );

    expect(get(map).latestUsage).toBeUndefined();
    expect(get(map).turns[0]!.usage?.contextTokens).toBe(4096);
    expect(get(map).turns[1]!.usage).toBeUndefined();
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

  it("insertForked 继承锚点轮 usage，而不是父线程最新 usage", () => {
    let map: AgentMap = {
      a1: newAgentView("a1", {
        latestUsage: { contextTokens: 8192, contextWindow: 128000 },
        turns: [
          {
            index: 0,
            status: "done",
            lines: [],
            anchorUuid: "u1",
            usage: { contextTokens: 2048, contextWindow: 128000 },
          },
          {
            index: 1,
            status: "done",
            lines: [],
            anchorUuid: "u2",
            usage: { contextTokens: 8192, contextWindow: 128000 },
          },
          { index: 2, status: "idle", lines: [] },
        ],
      }),
    };

    map = insertForked(map, "from-old-anchor", {
      parentAgentId: "a1",
      anchorUuid: "u1",
    });
    expect(get(map, "from-old-anchor").latestUsage?.contextTokens).toBe(2048);
    expect(get(map, "from-old-anchor").turns[0]!.usage?.contextTokens).toBe(2048);

    map = insertForked(map, "missing-anchor", {
      parentAgentId: "a1",
      anchorUuid: "unknown",
    });
    expect(get(map, "missing-anchor").latestUsage).toBeUndefined();
    expect(get(map, "missing-anchor").turns[0]!.usage).toBeUndefined();
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

  it("insertForked 为早到的 live fork 节点补元数据和锚点 usage 而不覆盖运行态", () => {
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
        latestUsage: { contextTokens: 8192, contextWindow: 128000 },
        turns: [
          {
            index: 0,
            status: "done",
            lines: [],
            anchorUuid: "u1",
            usage: { contextTokens: 2048, contextWindow: 128000 },
          },
          {
            index: 1,
            status: "idle",
            lines: [],
            usage: { contextTokens: 8192, contextWindow: 128000 },
          },
        ],
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
      latestUsage: { contextTokens: 2048, contextWindow: 128000 },
      forkOrigin: { parentAgentId: "a1", anchorUuid: "u1" },
    });
    expect(get(map, "a2").turns[0]).toMatchObject({
      status: "running",
      usage: { contextTokens: 2048, contextWindow: 128000 },
    });
    expect(get(map, "a2").turns[0]!.lines).toBe(liveTurns[0]!.lines);
  });

  it("insertForked 不会用父锚点覆盖早到 child 的自身 usage", () => {
    let map: AgentMap = {
      a1: newAgentView("a1", {
        turns: [
          {
            index: 0,
            status: "done",
            lines: [],
            anchorUuid: "u1",
            usage: { contextTokens: 2048, contextWindow: 128000 },
          },
        ],
      }),
      a2: newAgentView("a2", {
        status: "running",
        latestUsage: { contextTokens: 3072, contextWindow: 128000 },
        turns: [
          {
            index: 0,
            status: "running",
            lines: [],
            usage: { contextTokens: 3072, contextWindow: 128000 },
          },
        ],
        lastSeq: 4,
      }),
    };

    map = insertForked(map, "a2", { parentAgentId: "a1", anchorUuid: "u1" });

    expect(get(map, "a2")).toMatchObject({
      status: "running",
      latestUsage: { contextTokens: 3072, contextWindow: 128000 },
      lastSeq: 4,
      forkOrigin: { parentAgentId: "a1", anchorUuid: "u1" },
    });
    expect(get(map, "a2").turns[0]!.usage?.contextTokens).toBe(3072);
  });

  it("insertForked 不会在 child 新 session 后复活父锚点 usage", () => {
    let map: AgentMap = {
      a1: newAgentView("a1", {
        turns: [
          {
            index: 0,
            status: "done",
            lines: [],
            anchorUuid: "u1",
            usage: { contextTokens: 2048, contextWindow: 128000 },
          },
        ],
      }),
      a2: newAgentView("a2", {
        status: "running",
        latestUsage: undefined,
        turns: [
          {
            index: 0,
            status: "done",
            lines: [],
            usage: { contextTokens: 3072, contextWindow: 128000 },
          },
          { index: 1, status: "running", lines: [] },
        ],
        lastSeq: 5,
      }),
    };

    map = insertForked(map, "a2", { parentAgentId: "a1", anchorUuid: "u1" });

    expect(get(map, "a2").latestUsage).toBeUndefined();
    expect(get(map, "a2").turns[0]!.usage?.contextTokens).toBe(3072);
    expect(get(map, "a2").turns[1]!.usage).toBeUndefined();
    expect(get(map, "a2")).toMatchObject({
      status: "running",
      lastSeq: 5,
      forkOrigin: { parentAgentId: "a1", anchorUuid: "u1" },
    });
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
          config: {
            prompt: "",
            provider: "claude",
            model: "snapshot-model",
            systemPrompt: "private",
          },
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
      model: "snapshot-model",
      systemPrompt: "private",
      lastSeq: history.at(-1)!.seq,
    });
  });

  it("applyHello 在 history 缺失时从 snapshot 恢复最新 usage", () => {
    const map = applyHello([
      {
        id: "a1",
        status: "waiting_input",
        config: { prompt: "", provider: "codex" },
        createdAt: 1,
        lastEventSeq: 7,
        usage: { contextTokens: 8192, contextWindow: 128000 },
      },
    ]);

    expect(get(map).latestUsage).toEqual({
      contextTokens: 8192,
      contextWindow: 128000,
    });
    expect(get(map).turns[0]).toMatchObject({
      status: "idle",
      usage: { contextTokens: 8192, contextWindow: 128000 },
    });
  });

  it("applyHello 用 snapshot usage 补齐 history 回放后的最新 idle 轮", () => {
    seq = 0;
    const history = [
      env("a1", { kind: "user_input", text: "first" }),
      env("a1", { kind: "result", subtype: "success", isError: false }),
    ];
    const map = applyHello(
      [
        {
          id: "a1",
          status: "waiting_input",
          config: { prompt: "", provider: "codex" },
          createdAt: 1,
          lastEventSeq: history.at(-1)!.seq,
          usage: { contextTokens: 16384, contextWindow: 128000 },
        },
      ],
      { a1: history },
    );

    expect(get(map).turns[0]!.usage).toBeUndefined();
    expect(get(map).turns[1]).toMatchObject({
      status: "idle",
      usage: { contextTokens: 16384, contextWindow: 128000 },
    });
  });

  it("applyHello keeps newer history state over a stale snapshot", () => {
    seq = 0;
    const history = [
      env("a1", { kind: "user_input", text: "old session" }),
      env("a1", {
        kind: "system_init",
        sessionId: "s1",
        model: "old-history-model",
        cwd: "/tmp",
        tools: [],
      }),
      env("a1", {
        kind: "usage",
        usage: { contextTokens: 4096, contextWindow: 128000 },
      }),
      env("a1", { kind: "result", subtype: "success", isError: false }),
      env("a1", { kind: "user_input", text: "new session" }),
      env("a1", {
        kind: "system_init",
        sessionId: "s2",
        model: "runtime-model",
        cwd: "/tmp",
        tools: [],
      }),
      env("a1", {
        kind: "usage",
        usage: { contextTokens: 8192, contextWindow: 128000 },
      }),
      env("a1", { kind: "status", status: "running" }),
    ];

    const map = applyHello(
      [
        {
          id: "a1",
          status: "waiting_input",
          sessionId: "s1",
          config: { prompt: "", provider: "codex", model: "stale-model" },
          createdAt: 1,
          lastEventSeq: 4,
          usage: { contextTokens: 4096, contextWindow: 128000 },
        },
      ],
      { a1: history },
    );

    expect(get(map)).toMatchObject({
      status: "running",
      sessionId: "s2",
      model: "runtime-model",
      lastInitializedSessionId: "s2",
      latestUsage: { contextTokens: 8192, contextWindow: 128000 },
      lastSeq: history.at(-1)!.seq,
    });
    expect(get(map).turns.at(-1)!.usage).toEqual({
      contextTokens: 8192,
      contextWindow: 128000,
    });
  });

  it("applyHello keeps a snapshot model when only ordinary history is newer", () => {
    seq = 0;
    const history = [
      env("a1", {
        kind: "system_init",
        sessionId: "s1",
        model: "old-runtime-model",
        cwd: "/tmp",
        tools: [],
      }),
      env("a1", { kind: "status", status: "running" }),
    ];

    const map = applyHello(
      [
        {
          id: "a1",
          status: "waiting_input",
          sessionId: "s1",
          config: { prompt: "", provider: "codex", model: "updated-model" },
          createdAt: 1,
          lastEventSeq: 1,
        },
      ],
      { a1: history },
    );

    expect(get(map)).toMatchObject({
      status: "running",
      model: "updated-model",
      lastSeq: 2,
    });
  });

  it("applyHello 在所有 history 回放后从父锚点恢复 fork usage", () => {
    seq = 0;
    const parentHistory = [
      env("parent", { kind: "user_input", text: "first" }),
      env("parent", SYS),
      env("parent", {
        kind: "usage",
        usage: { contextTokens: 2048, contextWindow: 128000 },
      }),
      env("parent", { kind: "assistant_text", text: "one", messageUuid: "u1" }),
      env("parent", {
        kind: "result",
        subtype: "success",
        isError: false,
        anchorUuid: "u1",
      }),
      env("parent", { kind: "user_input", text: "second" }),
      env("parent", {
        kind: "usage",
        usage: { contextTokens: 8192, contextWindow: 128000 },
      }),
      env("parent", { kind: "assistant_text", text: "two", messageUuid: "u2" }),
      env("parent", {
        kind: "result",
        subtype: "success",
        isError: false,
        anchorUuid: "u2",
      }),
    ];

    const map = applyHello(
      [
        {
          id: "child",
          status: "waiting_input",
          config: { prompt: "", provider: "codex" },
          createdAt: 2,
          lastEventSeq: 0,
          forkOrigin: { parentAgentId: "parent", anchorUuid: "u1" },
        },
        {
          id: "parent",
          status: "waiting_input",
          sessionId: "s1",
          config: { prompt: "", provider: "codex" },
          createdAt: 1,
          lastEventSeq: parentHistory.at(-1)!.seq,
          usage: { contextTokens: 8192, contextWindow: 128000 },
        },
      ],
      { parent: parentHistory },
    );

    expect(get(map, "parent").latestUsage?.contextTokens).toBe(8192);
    expect(get(map, "child").latestUsage?.contextTokens).toBe(2048);
    expect(get(map, "child").turns[0]!.usage?.contextTokens).toBe(2048);
  });

  it("applyHello 不会为已切换 session 的 fork 重新回填父锚点 usage", () => {
    seq = 0;
    const parentHistory = [
      env("parent", { kind: "user_input", text: "parent" }),
      env("parent", SYS),
      env("parent", {
        kind: "usage",
        usage: { contextTokens: 2048, contextWindow: 128000 },
      }),
      env("parent", {
        kind: "result",
        subtype: "success",
        isError: false,
        anchorUuid: "u1",
      }),
    ];
    const childHistory = [
      env("child", { kind: "user_input", text: "first child session" }),
      env("child", {
        kind: "system_init",
        sessionId: "child-s1",
        model: "gpt-5.5",
        cwd: "/tmp",
        tools: [],
      }),
      env("child", { kind: "result", subtype: "success", isError: false }),
      env("child", { kind: "user_input", text: "second child session" }),
      env("child", {
        kind: "system_init",
        sessionId: "child-s2",
        model: "gpt-5.5",
        cwd: "/tmp",
        tools: [],
      }),
    ];

    const map = applyHello(
      [
        {
          id: "parent",
          status: "waiting_input",
          sessionId: "s1",
          config: { prompt: "", provider: "codex" },
          createdAt: 1,
          lastEventSeq: parentHistory.at(-1)!.seq,
          usage: { contextTokens: 2048, contextWindow: 128000 },
        },
        {
          id: "child",
          status: "running",
          sessionId: "child-s2",
          config: { prompt: "", provider: "codex" },
          createdAt: 2,
          lastEventSeq: childHistory.at(-1)!.seq,
          forkOrigin: { parentAgentId: "parent", anchorUuid: "u1" },
        },
      ],
      { parent: parentHistory, child: childHistory },
    );

    expect(get(map, "child").latestUsage).toBeUndefined();
    expect(get(map, "child").turns.at(-1)!.usage).toBeUndefined();
  });

  it("新 session 启动窗口重连后仍在 system_init 清除旧 usage", () => {
    seq = 0;
    const history = [
      env("a1", { kind: "user_input", text: "old session" }),
      env("a1", SYS),
      env("a1", {
        kind: "usage",
        usage: { contextTokens: 4096, contextWindow: 128000 },
      }),
      env("a1", { kind: "result", subtype: "success", isError: false }),
      env("a1", { kind: "user_input", text: "new session" }),
    ];
    let map = applyHello(
      [
        {
          id: "a1",
          status: "starting",
          config: { prompt: "new session", provider: "codex" },
          createdAt: 1,
          lastEventSeq: history.at(-1)!.seq,
        },
      ],
      { a1: history },
    );

    expect(get(map).sessionId).toBeUndefined();
    expect(get(map).latestUsage?.contextTokens).toBe(4096);

    map = applyEnvelope(
      map,
      env("a1", {
        kind: "system_init",
        sessionId: "s2",
        model: "gpt-5.5",
        cwd: "/tmp",
        tools: [],
      }),
    );

    expect(get(map).latestUsage).toBeUndefined();
    expect(get(map).turns.at(-1)!.usage).toBeUndefined();
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
