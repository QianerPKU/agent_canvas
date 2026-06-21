import { describe, it, expect, vi } from "vitest";
import type { AgentEvent, AgentStatus } from "@agent-canvas/shared";
import { AgentRunner } from "./AgentRunner.js";
import { AsyncMessageQueue } from "./util/AsyncMessageQueue.js";
import type {
  QueryFn,
  QueryHandle,
  QueryOptions,
  SdkMessage,
  SdkUserInput,
} from "./sdk/types.js";
import { agentCanvasPolicyPrompt } from "./agentCanvasPolicyPrompt.js";

/** 让微任务与队列 resolver 跑完。 */
const flush = () => new Promise((r) => setTimeout(r, 0));

const SYSTEM_INIT: SdkMessage = {
  type: "system",
  subtype: "init",
  session_id: "s1",
  model: "claude-opus-4-8",
  cwd: "/repo",
  tools: ["Read"],
};

function resultMsg(extra: Partial<Record<string, unknown>> = {}): SdkMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: "s1",
    ...extra,
  };
}

/** 可手动驱动的假 query：emit 推消息，finish 关闭输出，记录收到的输入与 interrupt。 */
function makeControllableQuery() {
  const out = new AsyncMessageQueue<SdkMessage>();
  const inputs: SdkUserInput[] = [];
  const steeredInputs: SdkUserInput[] = [];
  let interrupted = false;
  let terminated = false;
  let lastOptions: QueryOptions | undefined;

  const query: QueryFn = ({ prompt, options }) => {
    lastOptions = options;
    options?.abortController?.signal.addEventListener("abort", () => out.close());
    if (typeof prompt !== "string") {
      void (async () => {
        for await (const inp of prompt) inputs.push(inp);
      })();
    }
    const handle: QueryHandle = {
      [Symbol.asyncIterator]: () => out[Symbol.asyncIterator](),
      interrupt: async () => {
        interrupted = true;
      },
      steer: async (input) => {
        steeredInputs.push(input);
      },
      terminate: async () => {
        terminated = true;
        out.close();
      },
    };
    return handle;
  };

  return {
    query,
    emit: (m: SdkMessage) => out.push(m),
    finish: () => out.close(),
    inputs,
    steeredInputs,
    wasInterrupted: () => interrupted,
    wasTerminated: () => terminated,
    getOptions: () => lastOptions,
  };
}

function collectStatuses(events: AgentEvent[]): AgentStatus[] {
  return events
    .filter((e): e is Extract<AgentEvent, { kind: "status" }> => e.kind === "status")
    .map((e) => e.status);
}

function readablePromptContents(input: SdkUserInput | undefined): string[] {
  return input?.promptAccess?.readablePrompts.map((prompt) => prompt.content) ?? [];
}

describe("AgentRunner 生命周期", () => {
  it("start→running→result→waiting_input，再 send 干预→running→result", async () => {
    const ctl = makeControllableQuery();
    const events: AgentEvent[] = [];
    const runner = new AgentRunner("a1", { query: ctl.query });
    runner.on((e) => events.push(e));

    runner.start({ prompt: "做 x" });
    expect(runner.getStatus()).toBe("starting");

    ctl.emit(SYSTEM_INIT);
    await flush();
    expect(runner.getStatus()).toBe("running");
    expect(runner.snapshot().sessionId).toBe("s1");

    ctl.emit(resultMsg({ total_cost_usd: 0.01, usage: { input_tokens: 5 } }));
    await flush();
    expect(runner.getStatus()).toBe("waiting_input");
    expect(runner.snapshot().totalCostUsd).toBe(0.01);

    // 中途干预
    runner.send("再做 y");
    expect(runner.getStatus()).toBe("running");
    await flush();

    ctl.emit(resultMsg({ total_cost_usd: 0.02 }));
    await flush();
    expect(runner.getStatus()).toBe("waiting_input");
    expect(runner.snapshot().totalCostUsd).toBe(0.02);

    // 两条用户输入都被送进了 SDK
    expect(ctl.inputs.map((i) => i.message.content)).toEqual(["做 x", "再做 y"]);
    expect(
      events
        .filter((event): event is Extract<AgentEvent, { kind: "user_input" }> =>
          event.kind === "user_input"
        )
        .map((event) => event.text),
    ).toEqual(["做 x", "再做 y"]);

    // 状态变迁序列
    expect(collectStatuses(events)).toEqual([
      "starting",
      "running",
      "waiting_input",
      "running",
      "waiting_input",
    ]);

    await runner.stop();
  });

  it("运行中 send 先排队，当前轮 result 后再作为下一轮用户输入", async () => {
    const ctl = makeControllableQuery();
    const events: AgentEvent[] = [];
    const runner = new AgentRunner("queued-agent", { query: ctl.query });
    runner.on((event) => events.push(event));

    runner.start({ prompt: "先做 x" });
    ctl.emit(SYSTEM_INIT);
    await flush();

    runner.send("下一轮做 y");
    await flush();
    expect(runner.getStatus()).toBe("running");
    expect(ctl.inputs.map((input) => input.message.content)).toEqual(["先做 x"]);
    expect(events).toContainEqual({
      kind: "user_input",
      text: "下一轮做 y",
      mode: "queued",
    });

    ctl.emit(resultMsg());
    await flush();
    expect(runner.getStatus()).toBe("running");
    expect(ctl.inputs.map((input) => input.message.content)).toEqual(["先做 x", "下一轮做 y"]);
    expect(
      events.filter(
        (event): event is Extract<AgentEvent, { kind: "user_input" }> =>
          event.kind === "user_input",
      ),
    ).toEqual([
      { kind: "user_input", text: "先做 x" },
      { kind: "user_input", text: "下一轮做 y", mode: "queued" },
      { kind: "user_input", text: "下一轮做 y" },
    ]);

    ctl.emit(resultMsg());
    await flush();
    expect(runner.getStatus()).toBe("waiting_input");
  });

  it("steer 优先调用底层 handle 的引导能力，并记录 steer 事件", async () => {
    const ctl = makeControllableQuery();
    const events: AgentEvent[] = [];
    const runner = new AgentRunner("steer-agent", { query: ctl.query });
    runner.on((event) => events.push(event));

    runner.start({ prompt: "长任务" });
    ctl.emit(SYSTEM_INIT);
    await flush();

    await runner.steer("请优先看失败测试");
    expect(ctl.steeredInputs.map((input) => input.message.content)).toEqual([
      "请优先看失败测试",
    ]);
    expect(events).toContainEqual({
      kind: "user_input",
      text: "请优先看失败测试",
      mode: "steer",
    });
  });

  it("stop → stopped，调用 interrupt，且之后不可再 send", async () => {
    const ctl = makeControllableQuery();
    const runner = new AgentRunner("a2", { query: ctl.query });
    runner.start({ prompt: "x" });
    ctl.emit(SYSTEM_INIT);
    await flush();

    await runner.stop();
    expect(runner.getStatus()).toBe("stopped");
    expect(ctl.wasInterrupted()).toBe(true);
    expect(() => runner.send("y")).toThrow();
  });

  it("compact 作为独立一轮，完成后回到 waiting_input", async () => {
    const ctl = makeControllableQuery();
    const events: AgentEvent[] = [];
    const runner = new AgentRunner("compact-agent", { query: ctl.query });
    runner.on((event) => events.push(event));
    runner.start({ prompt: "x" });
    ctl.emit(SYSTEM_INIT);
    ctl.emit(resultMsg());
    await flush();

    runner.compact();
    await flush();
    expect(runner.getStatus()).toBe("running");
    expect(ctl.inputs.map((input) => input.message.content)).toEqual(["x", "/compact"]);

    ctl.emit({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "manual", pre_tokens: 100, post_tokens: 30 },
      uuid: "compact-1",
      session_id: "s1",
    });
    await flush();

    expect(runner.getStatus()).toBe("waiting_input");
    expect(events).toContainEqual({
      kind: "compact",
      trigger: "manual",
      preTokens: 100,
      postTokens: 30,
      durationMs: undefined,
    });
  });

  it("compact 失败后恢复 waiting_input", async () => {
    const ctl = makeControllableQuery();
    const runner = new AgentRunner("compact-failed", { query: ctl.query });
    runner.start({ prompt: "x" });
    ctl.emit(SYSTEM_INIT);
    ctl.emit(resultMsg());
    await flush();

    runner.compact();
    ctl.emit({
      type: "system",
      subtype: "status",
      status: null,
      compact_result: "failed",
      compact_error: "上下文过短",
      session_id: "s1",
    });
    await flush();
    expect(runner.getStatus()).toBe("waiting_input");
  });

  it("terminate → terminated，并关闭底层 handle", async () => {
    const ctl = makeControllableQuery();
    const runner = new AgentRunner("terminate-agent", { query: ctl.query });
    runner.start({ prompt: "x" });
    ctl.emit(SYSTEM_INIT);
    await flush();

    await runner.terminate();
    await flush();
    expect(runner.getStatus()).toBe("terminated");
    expect(ctl.wasTerminated()).toBe(true);
    expect(() => runner.send("y")).toThrow();
  });

  it("built-in workspace policy is injected without user configured prompts and after compact", async () => {
    const ctl = makeControllableQuery();
    const runner = new AgentRunner("policy-agent", { query: ctl.query });

    runner.start({ prompt: "x" });
    await flush();
    expect(readablePromptContents(ctl.inputs[0])).toEqual([
      agentCanvasPolicyPrompt("policy-agent"),
    ]);

    ctl.emit(SYSTEM_INIT);
    ctl.emit(resultMsg());
    await flush();
    runner.send("y");
    await flush();
    expect(readablePromptContents(ctl.inputs[1])).toEqual([]);

    ctl.emit(resultMsg());
    await flush();
    runner.compact();
    ctl.emit({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "manual" },
      uuid: "compact-policy",
      session_id: "s1",
    });
    await flush();
    runner.send("after compact");
    await flush();
    expect(readablePromptContents(ctl.inputs.at(-1))).toEqual([
      agentCanvasPolicyPrompt("policy-agent"),
    ]);
  });

  it("输入关闭后消息流自然结束 → done", async () => {
    const ctl = makeControllableQuery();
    const runner = new AgentRunner("a3", { query: ctl.query });
    runner.start({ prompt: "x" });
    ctl.emit(SYSTEM_INIT);
    await flush();

    ctl.finish(); // SDK 消息流结束
    await flush();
    expect(runner.getStatus()).toBe("done");
  });

  it("private system prompt is injected like readable prompt nodes", async () => {
    const promptAccess = {
      readablePrompts: [
        { id: "prompt_1", name: "规范", content: "先写测试", kind: "shared" as const },
      ],
      writablePrompts: [],
      writableDirectories: [],
    };
    const ctl = makeControllableQuery();
    const runner = new AgentRunner("private-prompt-agent", {
      query: ctl.query,
      resolvePromptAccess: () => promptAccess,
    });

    runner.start({ prompt: "first", systemPrompt: "private rules" });
    await flush();
    expect(readablePromptContents(ctl.inputs[0])).toEqual([
      agentCanvasPolicyPrompt("private-prompt-agent"),
      "private rules",
      "先写测试",
    ]);

    ctl.emit(SYSTEM_INIT);
    ctl.emit(resultMsg());
    await flush();
    runner.send("second");
    await flush();
    expect(readablePromptContents(ctl.inputs[1])).toEqual([]);

    ctl.emit(resultMsg());
    await flush();
    runner.updateSettings({ systemPrompt: "new private rules" });
    runner.send("after settings");
    await flush();
    expect(readablePromptContents(ctl.inputs.at(-1))).toEqual([
      agentCanvasPolicyPrompt("private-prompt-agent"),
      "new private rules",
      "先写测试",
    ]);
  });

  it("消息流抛错 → error 事件 + error 状态", async () => {
    const query: QueryFn = () => ({
      // eslint-disable-next-line require-yield
      async *[Symbol.asyncIterator]() {
        throw new Error("boom");
      },
    });
    const events: AgentEvent[] = [];
    const runner = new AgentRunner("a4", { query });
    runner.on((e) => events.push(e));

    runner.start({ prompt: "x" });
    await flush();

    expect(runner.getStatus()).toBe("error");
    expect(
      events.some((e) => e.kind === "error" && e.message === "boom"),
    ).toBe(true);
  });

  it("运行中重复 start 抛错", () => {
    const ctl = makeControllableQuery();
    const runner = new AgentRunner("a5", { query: ctl.query });
    runner.start({ prompt: "x" });
    expect(() => runner.start({ prompt: "y" })).toThrow();
  });

  it("result 携带本轮最后一条 assistant 的 uuid 作为 anchorUuid", async () => {
    const ctl = makeControllableQuery();
    const events: AgentEvent[] = [];
    const runner = new AgentRunner("a6", { query: ctl.query });
    runner.on((e) => events.push(e));

    runner.start({ prompt: "x" });
    ctl.emit(SYSTEM_INIT);
    ctl.emit({
      type: "assistant",
      session_id: "s1",
      uuid: "u-1",
      message: { role: "assistant", content: [{ type: "text", text: "第一段" }] },
    });
    ctl.emit({
      type: "assistant",
      session_id: "s1",
      uuid: "u-2",
      message: { role: "assistant", content: [{ type: "text", text: "最终答复" }] },
    });
    ctl.emit(resultMsg());
    await flush();

    const result = events.find((e) => e.kind === "result");
    expect(result).toBeDefined();
    expect(result && result.kind === "result" && result.anchorUuid).toBe("u-2");
  });

  it("fork 启动选项（resume/resumeSessionAt/forkSession）传透给 query", () => {
    const ctl = makeControllableQuery();
    const runner = new AgentRunner("a7", { query: ctl.query });
    runner.start({
      prompt: "继续",
      resume: "src-session",
      resumeSessionAt: "u-anchor",
      forkSession: true,
    });
    const opts = ctl.getOptions();
    expect(opts?.resume).toBe("src-session");
    expect(opts?.resumeSessionAt).toBe("u-anchor");
    expect(opts?.forkSession).toBe(true);
  });

  it("按 provider 选择底层 query，默认 provider 为 claude", () => {
    const claudeQuery: QueryFn = vi.fn(() => ({
      async *[Symbol.asyncIterator]() {
        // empty
      },
    }));
    const codexQuery: QueryFn = vi.fn(() => ({
      async *[Symbol.asyncIterator]() {
        // empty
      },
    }));

    const runner = new AgentRunner("a8", { query: claudeQuery, codexQuery });
    runner.start({ prompt: "x", provider: "codex" });

    expect(claudeQuery).not.toHaveBeenCalled();
    expect(codexQuery).toHaveBeenCalledOnce();
    expect(runner.snapshot().config?.provider).toBe("codex");

    const runner2 = new AgentRunner("a9", { query: claudeQuery, codexQuery });
    runner2.start({ prompt: "x" });
    expect(runner2.snapshot().config?.provider).toBe("claude");
  });

  it("把当前文件读写权限传给 query，并在后续轮次重新解析", async () => {
    const ctl = makeControllableQuery();
    let revision = 0;
    const runner = new AgentRunner("file-agent", {
      query: ctl.query,
      resolveFileAccess: () => ({
        readableFiles: [
          {
            name: `input-${revision}.txt`,
            path: `/files/input-${revision}.txt`,
            previewKind: "text",
          },
        ],
        writableFiles: [],
        writableDirectories: [`/files/write-${revision}`],
      }),
    });

    runner.start({ prompt: "first" });
    expect(ctl.getOptions()?.fileAccess).toEqual({
      readableFiles: [
        {
          name: "input-0.txt",
          path: "/files/input-0.txt",
          previewKind: "text",
        },
      ],
      writableFiles: [],
      writableDirectories: ["/files/write-0"],
    });

    revision = 1;
    ctl.emit(SYSTEM_INIT);
    ctl.emit(resultMsg());
    await flush();
    runner.send("second");
    await flush();
    expect(ctl.inputs.at(-1)?.fileAccess?.readableFiles[0]?.name).toBe("input-1.txt");
  });

  it("auto compact 保持当前轮运行，并在下一条业务输入重新注入提示词", async () => {
    const promptAccess = {
      readablePrompts: [
        { id: "prompt_1", name: "规范", content: "先写测试", kind: "shared" as const },
      ],
      writablePrompts: [],
      writableDirectories: [],
    };
    const ctl = makeControllableQuery();
    const events: AgentEvent[] = [];
    const runner = new AgentRunner("auto-compact-agent", {
      query: ctl.query,
      resolvePromptAccess: () => promptAccess,
    });
    runner.on((event) => events.push(event));

    runner.start({ prompt: "first" });
    ctl.emit(SYSTEM_INIT);
    ctl.emit(resultMsg());
    await flush();

    runner.send("second");
    await flush();
    expect(readablePromptContents(ctl.inputs[1])).toEqual([]);
    expect(runner.getStatus()).toBe("running");

    ctl.emit({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto" },
      uuid: "compact-auto-1",
      session_id: "s1",
    });
    await flush();
    expect(runner.getStatus()).toBe("running");
    expect(events).toContainEqual({
      kind: "compact",
      trigger: "auto",
      preTokens: undefined,
      postTokens: undefined,
      durationMs: undefined,
    });

    ctl.emit(resultMsg());
    await flush();
    expect(runner.getStatus()).toBe("waiting_input");

    runner.send("after auto compact");
    await flush();
    expect(readablePromptContents(ctl.inputs.at(-1))).toEqual([
      agentCanvasPolicyPrompt("auto-compact-agent"),
      "先写测试",
    ]);
  });

  it("运行中已排队输入遇到 auto compact 时，在正式入队下一轮时重新注入提示词", async () => {
    const promptAccess = {
      readablePrompts: [
        { id: "prompt_1", name: "规范", content: "先写测试", kind: "shared" as const },
      ],
      writablePrompts: [],
      writableDirectories: [],
    };
    const ctl = makeControllableQuery();
    const runner = new AgentRunner("queued-auto-compact-agent", {
      query: ctl.query,
      resolvePromptAccess: () => promptAccess,
    });

    runner.start({ prompt: "first" });
    ctl.emit(SYSTEM_INIT);
    await flush();

    runner.send("queued after current turn");
    await flush();
    expect(ctl.inputs).toHaveLength(1);

    ctl.emit({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto" },
      uuid: "compact-auto-queued",
      session_id: "s1",
    });
    ctl.emit(resultMsg());
    await flush();

    expect(ctl.inputs).toHaveLength(2);
    expect(readablePromptContents(ctl.inputs.at(-1))).toEqual([
      agentCanvasPolicyPrompt("queued-auto-compact-agent"),
      "先写测试",
    ]);
  });

  it("提示词只在新 Agent 首轮和 compact 后下一轮注入，fork 首轮仅保留内置规则", async () => {
    const promptAccess = {
      readablePrompts: [
        { id: "prompt_1", name: "规范", content: "先写测试", kind: "shared" as const },
      ],
      writablePrompts: [
        { id: "prompt_2", name: "可维护规则", path: "/prompts/prompt_2.txt" },
      ],
      writableDirectories: ["/prompts"],
    };
    const ctl = makeControllableQuery();
    const runner = new AgentRunner("prompt-agent", {
      query: ctl.query,
      resolvePromptAccess: () => promptAccess,
    });

    runner.start({ prompt: "first" });
    await flush();
    expect(readablePromptContents(ctl.inputs[0])).toEqual([
      agentCanvasPolicyPrompt("prompt-agent"),
      "先写测试",
    ]);

    ctl.emit(SYSTEM_INIT);
    ctl.emit(resultMsg());
    await flush();
    runner.send("second");
    await flush();
    expect(ctl.inputs[1]?.promptAccess).toMatchObject({
      readablePrompts: [],
      writablePrompts: promptAccess.writablePrompts,
    });

    ctl.emit(resultMsg());
    await flush();
    runner.compact();
    ctl.emit({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "manual" },
      uuid: "compact-1",
      session_id: "s1",
    });
    await flush();
    runner.send("after compact");
    await flush();
    expect(readablePromptContents(ctl.inputs.at(-1))).toEqual([
      agentCanvasPolicyPrompt("prompt-agent"),
      "先写测试",
    ]);

    const forkCtl = makeControllableQuery();
    const fork = new AgentRunner("fork-agent", {
      query: forkCtl.query,
      resolvePromptAccess: () => promptAccess,
    });
    fork.start({
      prompt: "fork first",
      resume: "source-session",
      forkSession: true,
    });
    await flush();
    expect(readablePromptContents(forkCtl.inputs[0])).toEqual([
      agentCanvasPolicyPrompt("fork-agent"),
    ]);
    expect(forkCtl.inputs[0]?.promptAccess?.writablePrompts).toEqual(
      promptAccess.writablePrompts,
    );
  });
});
