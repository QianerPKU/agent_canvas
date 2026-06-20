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
});
