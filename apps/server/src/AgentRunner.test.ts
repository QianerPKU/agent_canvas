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
import { workDocumentationDisabledPrompt } from "./workspaces/workDocumentation.js";

/** 让微任务与队列 resolver 跑完。 */
const flush = () => new Promise((r) => setTimeout(r, 0));

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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
function makeControllableQuery(handleOptions: { nativeSteer?: boolean } = {}) {
  let out = new AsyncMessageQueue<SdkMessage>();
  const inputs: SdkUserInput[] = [];
  const steeredInputs: SdkUserInput[] = [];
  const modelUpdates: Array<string | undefined> = [];
  let interrupted = false;
  let terminated = false;
  let steerAvailable = handleOptions.nativeSteer !== false;
  let steerDelay: Promise<void> | undefined;
  let steerCalls = 0;
  let lastOptions: QueryOptions | undefined;

  const query: QueryFn = ({ prompt, options }) => {
    out = new AsyncMessageQueue<SdkMessage>();
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
    if (handleOptions.nativeSteer !== false) {
      handle.steer = async (input) => {
        steerCalls += 1;
        await steerDelay;
        if (!steerAvailable) throw new Error("turn is not active");
        steeredInputs.push(input);
      };
      handle.canSteerNow = () => steerAvailable;
    }
    handle.setModel = async (model) => {
      modelUpdates.push(model);
    };
    return handle;
  };

  return {
    query,
    emit: (m: SdkMessage) => out.push(m),
    finish: () => out.close(),
    inputs,
    steeredInputs,
    modelUpdates,
    wasInterrupted: () => interrupted,
    wasTerminated: () => terminated,
    setSteerAvailable: (available: boolean) => {
      steerAvailable = available;
    },
    setSteerDelay: (delay: Promise<void> | undefined) => {
      steerDelay = delay;
    },
    steerCalls: () => steerCalls,
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

  it("stop 后仍保留独立 usage 更新，不依赖被抑制的 result", async () => {
    const ctl = makeControllableQuery();
    const events: AgentEvent[] = [];
    const runner = new AgentRunner("usage-after-stop", { query: ctl.query });
    runner.on((event) => events.push(event));

    runner.start({ prompt: "长任务", provider: "codex" });
    ctl.emit(SYSTEM_INIT);
    await flush();
    await runner.stop();

    ctl.emit({
      type: "usage",
      session_id: "s1",
      usage: { context_tokens: 4096, context_window: 128000 },
    });
    ctl.emit(resultMsg({ usage: { context_tokens: 4096, context_window: 128000 } }));
    await flush();

    expect(runner.getStatus()).toBe("stopped");
    expect(runner.snapshot().usage).toMatchObject({
      contextTokens: 4096,
      contextWindow: 128000,
    });
    expect(events).toContainEqual({
      kind: "usage",
      usage: {
        inputTokens: undefined,
        outputTokens: undefined,
        totalTokens: undefined,
        reasoningOutputTokens: undefined,
        cacheCreationInputTokens: undefined,
        cacheReadInputTokens: undefined,
        contextTokens: 4096,
        contextWindow: 128000,
      },
    });

    await runner.terminate();
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

  it("revalidates file access when a queued input is actually dispatched", async () => {
    const ctl = makeControllableQuery();
    const events: AgentEvent[] = [];
    let unsafe = false;
    const prepareFileAccess = vi.fn(async () => {
      if (unsafe) throw new Error("work documentation path changed");
    });
    const runner = new AgentRunner("queued-path-agent", {
      query: ctl.query,
      prepareFileAccess,
    });
    runner.on((event) => events.push(event));

    await runner.start({ prompt: "first" });
    ctl.emit(SYSTEM_INIT);
    await flush();
    runner.send("queued second");
    unsafe = true;

    ctl.emit(resultMsg());
    await flush();
    await flush();

    expect(prepareFileAccess).toHaveBeenCalledTimes(2);
    expect(ctl.inputs.map((input) => input.message.content)).toEqual(["first"]);
    expect(events).toContainEqual({
      kind: "error",
      message: "work documentation path changed",
    });
    expect(ctl.wasTerminated()).toBe(true);
    expect(runner.getStatus()).toBe("error");
  });

  it("keeps a queued-dispatch snapshot unsettled when exact transport termination rejects", async () => {
    const outputs: AsyncMessageQueue<SdkMessage>[] = [];
    let queryCalls = 0;
    let preparationCalls = 0;
    let terminationAttempts = 0;
    const query: QueryFn = () => {
      const callIndex = queryCalls++;
      const output = new AsyncMessageQueue<SdkMessage>();
      outputs.push(output);
      return {
        [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
        terminate: async () => {
          if (callIndex === 0) {
            terminationAttempts += 1;
            if (terminationAttempts === 1) throw new Error("provider still owns snapshot");
          }
          output.close();
        },
      };
    };
    const onProviderTurnSettled = vi.fn();
    const events: AgentEvent[] = [];
    const runner = new AgentRunner("queued-termination-ledger-agent", {
      query,
      prepareFileAccess: () => {
        preparationCalls += 1;
        if (preparationCalls === 2) throw new Error("queued snapshot validation failed");
      },
      onProviderTurnSettled,
    });
    runner.on((event) => events.push(event));

    await runner.start({ prompt: "first" });
    outputs[0]!.push(SYSTEM_INIT);
    await flush();
    await runner.send("queued second");
    outputs[0]!.push(resultMsg());

    await vi.waitFor(() => expect(runner.getStatus()).toBe("stopped"));
    expect(terminationAttempts).toBe(1);
    expect(onProviderTurnSettled).not.toHaveBeenCalled();
    expect(collectStatuses(events)).not.toContain("error");
    expect(events).toContainEqual(expect.objectContaining({
      kind: "error",
      message: expect.stringContaining("termination remains pending"),
    }));

    await expect(runner.send("retry after exact close")).resolves.toBeUndefined();
    expect(terminationAttempts).toBe(2);
    expect(onProviderTurnSettled).toHaveBeenCalledTimes(1);
    expect(queryCalls).toBe(2);
    await runner.terminate();
  });

  it("does not publish a cleanup-triggering error when iterator failure cannot terminate exactly", async () => {
    const crash = deferred();
    const outputs: AsyncMessageQueue<SdkMessage>[] = [];
    let queryCalls = 0;
    let terminationAttempts = 0;
    const query: QueryFn = () => {
      const callIndex = queryCalls++;
      const output = new AsyncMessageQueue<SdkMessage>();
      outputs.push(output);
      return {
        async *[Symbol.asyncIterator]() {
          if (callIndex === 0) {
            yield SYSTEM_INIT;
            await crash.promise;
            throw new Error("provider iterator failed");
          }
          yield SYSTEM_INIT;
          await new Promise<void>((resolve) => {
            void (async () => {
              for await (const _message of output) {
                // Keep the second provider alive until exact termination closes the queue.
              }
              resolve();
            })();
          });
        },
        terminate: async () => {
          if (callIndex === 0) {
            terminationAttempts += 1;
            if (terminationAttempts === 1) throw new Error("iterator transport still alive");
          }
          output.close();
        },
      };
    };
    const onProviderTurnSettled = vi.fn();
    const events: AgentEvent[] = [];
    const runner = new AgentRunner("iterator-termination-ledger-agent", {
      query,
      onProviderTurnSettled,
    });
    runner.on((event) => events.push(event));

    await runner.start({ prompt: "first" });
    await vi.waitFor(() => expect(runner.getStatus()).toBe("running"));
    crash.resolve();

    await vi.waitFor(() => expect(runner.getStatus()).toBe("stopped"));
    expect(terminationAttempts).toBe(1);
    expect(onProviderTurnSettled).not.toHaveBeenCalled();
    expect(collectStatuses(events)).not.toContain("error");

    await expect(runner.send("restart after iterator close")).resolves.toBeUndefined();
    expect(terminationAttempts).toBe(2);
    expect(onProviderTurnSettled).toHaveBeenCalledTimes(1);
    expect(queryCalls).toBe(2);
    await runner.terminate();
  });

  it("serializes concurrent automation delivery across a cleared turn and queued inputs", async () => {
    const ctl = makeControllableQuery();
    const queuedPreparation = deferred();
    let preparationCall = 0;
    const prepareFileAccess = vi.fn(() => {
      preparationCall += 1;
      return preparationCall === 2 ? queuedPreparation.promise : undefined;
    });
    const runner = new AgentRunner("serialized-delivery-agent", {
      query: ctl.query,
      prepareFileAccess,
    });
    const events: AgentEvent[] = [];
    let delivery: Promise<void> | undefined;
    let statusAtFirstResult: AgentStatus | undefined;
    runner.on((event) => {
      events.push(event);
      if (event.kind === "result" && !delivery) {
        statusAtFirstResult = runner.getStatus();
        delivery = Promise.all([
          runner.deliver("PR authorization"),
          runner.deliver("sync authorization"),
        ]).then(() => undefined);
      }
    });

    await runner.start({ prompt: "first" });
    ctl.emit(SYSTEM_INIT);
    await flush();
    await runner.send("ordinary queued input");
    ctl.setSteerAvailable(false);
    ctl.emit(resultMsg());
    await flush();
    expect(delivery).toBeUndefined();

    queuedPreparation.resolve();
    await flush();
    await delivery;

    expect(statusAtFirstResult).toBe("running");
    expect(ctl.steeredInputs).toEqual([]);
    expect(
      events.filter(
        (event): event is Extract<AgentEvent, { kind: "user_input" }> =>
          event.kind === "user_input" && event.mode === "queued",
      ),
    ).toEqual([
      { kind: "user_input", text: "ordinary queued input", mode: "queued" },
      { kind: "user_input", text: "PR authorization", mode: "queued" },
      { kind: "user_input", text: "sync authorization", mode: "queued" },
    ]);

    ctl.emit(resultMsg());
    await flush();
    ctl.emit(resultMsg());
    await flush();
    expect(ctl.inputs.map((input) => input.message.content)).toEqual([
      "first",
      "ordinary queued input",
      "PR authorization",
      "sync authorization",
    ]);
  });

  it("queues safely when a turn completes during serialized path preparation", async () => {
    const ctl = makeControllableQuery();
    const deliveryPreparation = deferred();
    let preparationCall = 0;
    const runner = new AgentRunner("prepared-delivery-agent", {
      query: ctl.query,
      prepareFileAccess: () => {
        preparationCall += 1;
        return preparationCall === 2 ? deliveryPreparation.promise : undefined;
      },
    });

    await runner.start({ prompt: "first" });
    ctl.emit(SYSTEM_INIT);
    await flush();
    const delivery = runner.deliver("after result");
    ctl.setSteerAvailable(false);
    ctl.emit(resultMsg());
    await flush();
    expect(runner.getStatus()).toBe("running");

    deliveryPreparation.resolve();
    await delivery;
    await flush();

    expect(ctl.steeredInputs).toEqual([]);
    expect(ctl.inputs.map((input) => input.message.content)).toEqual(["first", "after result"]);
    expect(runner.getStatus()).toBe("running");
  });

  it("queues when the provider turn closes between steer selection and the steer RPC", async () => {
    const ctl = makeControllableQuery();
    const steerDelay = deferred();
    const runner = new AgentRunner("steer-completion-race-agent", { query: ctl.query });

    await runner.start({ prompt: "first" });
    ctl.emit(SYSTEM_INIT);
    await flush();
    ctl.setSteerDelay(steerDelay.promise);
    const delivery = runner.deliver("authorization after turn completion");
    await flush();
    expect(ctl.steerCalls()).toBe(1);

    ctl.setSteerAvailable(false);
    ctl.emit(resultMsg());
    steerDelay.resolve();
    await delivery;
    await flush();

    expect(ctl.steeredInputs).toEqual([]);
    expect(ctl.inputs.map((input) => input.message.content)).toEqual([
      "first",
      "authorization after turn completion",
    ]);
    expect(runner.getStatus()).toBe("running");
  });

  it("preserves automation delivery order when the first preparation is slower", async () => {
    const ctl = makeControllableQuery();
    const firstDeliveryPreparation = deferred();
    let preparationCall = 0;
    const runner = new AgentRunner("ordered-delivery-agent", {
      query: ctl.query,
      prepareFileAccess: () => {
        preparationCall += 1;
        return preparationCall === 2 ? firstDeliveryPreparation.promise : undefined;
      },
    });

    await runner.start({ prompt: "first" });
    ctl.emit(SYSTEM_INIT);
    await flush();
    const first = runner.deliver("first automation message");
    const second = runner.deliver("second automation message");
    await flush();
    expect(preparationCall).toBe(2);
    expect(ctl.steeredInputs).toEqual([]);

    firstDeliveryPreparation.resolve();
    await Promise.all([first, second]);

    expect(ctl.steeredInputs.map((input) => input.message.content)).toEqual([
      "first automation message",
      "second automation message",
    ]);
  });

  it("serializes concurrent automation deliveries while resuming a restored session", async () => {
    const ctl = makeControllableQuery();
    const runner = new AgentRunner("restored-delivery-agent", { query: ctl.query });
    runner.restore({
      id: "restored-delivery-agent",
      status: "waiting_input",
      sessionId: "restored-session",
      config: { prompt: "old task", resume: "restored-session" },
      createdAt: 1,
      lastEventSeq: 0,
    });

    await Promise.all([
      runner.deliver("first automation after restore"),
      runner.deliver("second automation after restore"),
    ]);
    await flush();

    expect(ctl.inputs.map((input) => input.message.content)).toEqual([
      "first automation after restore",
    ]);
    expect(ctl.getOptions()?.resume).toBe("restored-session");
    expect(runner.getStatus()).toBe("starting");

    ctl.emit(SYSTEM_INIT);
    await flush();
    ctl.emit(resultMsg());
    await flush();

    expect(ctl.inputs.map((input) => input.message.content)).toEqual([
      "first automation after restore",
      "second automation after restore",
    ]);
    expect(runner.getStatus()).toBe("running");
  });

  it("does not let delayed delivery or an old result mutate a restarted lifecycle", async () => {
    const ctl = makeControllableQuery();
    const steerDelay = deferred();
    const events: AgentEvent[] = [];
    const runner = new AgentRunner("delivery-restart-race-agent", { query: ctl.query });
    runner.on((event) => events.push(event));

    await runner.start({ prompt: "start A" });
    ctl.emit(SYSTEM_INIT);
    await flush();
    ctl.setSteerDelay(steerDelay.promise);
    const delivery = runner.deliver("stale authorization");
    await flush();
    expect(ctl.steerCalls()).toBe(1);
    ctl.emit(resultMsg());
    await flush();

    await runner.stop();
    ctl.setSteerDelay(undefined);
    await runner.start({ prompt: "start B" });
    ctl.emit(SYSTEM_INIT);
    await flush();
    steerDelay.resolve();
    await expect(delivery).rejects.toThrow("delivery target changed during dispatch");
    await flush();

    expect(runner.getStatus()).toBe("running");
    expect(
      events.filter(
        (event): event is Extract<AgentEvent, { kind: "user_input" }> =>
          event.kind === "user_input" && event.text === "stale authorization",
      ),
    ).toEqual([]);
    expect(ctl.inputs.map((input) => input.message.content)).toEqual(["start A", "start B"]);
  });

  it("orders a delayed direct steer before a concurrently arriving result", async () => {
    const ctl = makeControllableQuery();
    const steerDelay = deferred();
    const events: AgentEvent[] = [];
    const runner = new AgentRunner("direct-steer-result-order-agent", { query: ctl.query });
    runner.on((event) => events.push(event));

    await runner.start({ prompt: "start" });
    ctl.emit(SYSTEM_INIT);
    await flush();
    ctl.setSteerDelay(steerDelay.promise);
    const steering = runner.steer("use the new snapshot");
    await flush();
    expect(ctl.steerCalls()).toBe(1);

    ctl.emit(resultMsg());
    await flush();
    expect(events.some((event) => event.kind === "result")).toBe(false);
    expect(runner.getStatus()).toBe("running");

    steerDelay.resolve();
    await steering;
    await flush();
    const steerIndex = events.findIndex(
      (event) =>
        event.kind === "user_input" &&
        event.mode === "steer" &&
        event.text === "use the new snapshot",
    );
    const resultIndex = events.findIndex((event) => event.kind === "result");
    expect(steerIndex).toBeGreaterThanOrEqual(0);
    expect(resultIndex).toBeGreaterThan(steerIndex);
    expect(runner.getStatus()).toBe("waiting_input");
  });

  it("does not publish a delayed direct steer into a restarted lifecycle", async () => {
    const ctl = makeControllableQuery();
    const steerDelay = deferred();
    const events: AgentEvent[] = [];
    const runner = new AgentRunner("direct-steer-restart-race-agent", { query: ctl.query });
    runner.on((event) => events.push(event));

    await runner.start({ prompt: "start A" });
    ctl.emit(SYSTEM_INIT);
    await flush();
    ctl.setSteerDelay(steerDelay.promise);
    const steering = runner.steer("stale direct steer");
    await flush();
    expect(ctl.steerCalls()).toBe(1);

    await runner.stop();
    ctl.setSteerDelay(undefined);
    await runner.start({ prompt: "start B" });
    ctl.emit(SYSTEM_INIT);
    await flush();
    steerDelay.resolve();

    await expect(steering).rejects.toThrow("steer target changed during dispatch");
    await flush();
    expect(runner.getStatus()).toBe("running");
    expect(
      events.filter(
        (event) => event.kind === "user_input" && event.text === "stale direct steer",
      ),
    ).toEqual([]);
    expect(ctl.inputs.map((input) => input.message.content)).toEqual(["start A", "start B"]);
  });

  it("validates live paths before initial start resolves file access or starts the provider", async () => {
    const ctl = makeControllableQuery();
    const query = vi.fn(ctl.query);
    const resolveFileAccess = vi.fn(() => ({
      readableFiles: [],
      writableFiles: [],
      writableDirectories: ["/unsafe/docs"],
    }));
    const runner = new AgentRunner("initial-path-agent", {
      query,
      resolveFileAccess,
      prepareFileAccess: async () => {
        throw new Error("documentation mount was replaced");
      },
    });

    await expect(runner.start({ prompt: "first" })).rejects.toThrow(
      "documentation mount was replaced",
    );

    expect(resolveFileAccess).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(runner.getStatus()).toBe("error");
  });

  it.each(["resolve", "reject"] as const)(
    "does not let a stale %s from start A corrupt start B",
    async (settlement) => {
      const ctl = makeControllableQuery();
      const firstPreparation = deferred();
      const secondPreparation = deferred();
      let preparationCall = 0;
      const events: AgentEvent[] = [];
      const runner = new AgentRunner("overlapping-start-agent", {
        query: ctl.query,
        prepareFileAccess: () =>
          ++preparationCall === 1 ? firstPreparation.promise : secondPreparation.promise,
      });
      runner.on((event) => events.push(event));

      const startA = runner.start({ prompt: "start A" });
      const startAOutcome = startA.then(
        () => undefined,
        (error: unknown) => error,
      );
      await runner.stop();
      const startB = runner.start({ prompt: "start B" });

      if (settlement === "resolve") firstPreparation.resolve();
      else firstPreparation.reject(new Error("start A validation failed"));
      expect(await startAOutcome).toBeInstanceOf(Error);

      expect(runner.getStatus()).toBe("starting");
      expect(ctl.inputs).toEqual([]);
      expect(events.filter((event) => event.kind === "error")).toEqual([]);

      secondPreparation.resolve();
      await startB;
      await flush();

      expect(ctl.inputs.map((input) => input.message.content)).toEqual(["start B"]);
      expect(runner.getStatus()).toBe("starting");
      expect(events.filter((event) => event.kind === "error")).toEqual([]);
      await runner.terminate();
    },
  );

  it("blocks direct waiting-input send when live validation fails", async () => {
    const ctl = makeControllableQuery();
    let unsafe = false;
    const prepareFileAccess = vi.fn(async () => {
      if (unsafe) throw new Error("documentation mount was replaced");
    });
    const runner = new AgentRunner("direct-send-path-agent", {
      query: ctl.query,
      prepareFileAccess,
    });

    await runner.start({ prompt: "first" });
    ctl.emit(SYSTEM_INIT);
    ctl.emit(resultMsg());
    await flush();
    unsafe = true;

    await expect(runner.send("automation review request")).rejects.toThrow(
      "documentation mount was replaced",
    );
    expect(prepareFileAccess).toHaveBeenCalledTimes(2);
    expect(ctl.inputs.map((input) => input.message.content)).toEqual(["first"]);
    expect(runner.getStatus()).toBe("waiting_input");
  });

  it("blocks direct native steer when live validation fails", async () => {
    const ctl = makeControllableQuery();
    let unsafe = false;
    const prepareFileAccess = vi.fn(async () => {
      if (unsafe) throw new Error("documentation mount was replaced");
    });
    const runner = new AgentRunner("direct-steer-path-agent", {
      query: ctl.query,
      prepareFileAccess,
    });

    await runner.start({ prompt: "first" });
    ctl.emit(SYSTEM_INIT);
    await flush();
    unsafe = true;

    await expect(runner.steer("automation review request")).rejects.toThrow(
      "documentation mount was replaced",
    );
    expect(prepareFileAccess).toHaveBeenCalledTimes(2);
    expect(ctl.steeredInputs).toEqual([]);
    expect(runner.getStatus()).toBe("running");
  });

  it("does not prepare a file snapshot for compact because the command carries no file access", async () => {
    const ctl = makeControllableQuery();
    let unsafe = false;
    const prepareFileAccess = vi.fn(async () => {
      if (unsafe) throw new Error("documentation mount was replaced");
    });
    const runner = new AgentRunner("compact-path-agent", {
      query: ctl.query,
      prepareFileAccess,
    });

    await runner.start({ prompt: "first" });
    ctl.emit(SYSTEM_INIT);
    ctl.emit(resultMsg());
    await flush();
    unsafe = true;

    await expect(runner.compact()).resolves.toBeUndefined();
    await flush();
    expect(prepareFileAccess).toHaveBeenCalledTimes(1);
    expect(ctl.inputs.map((input) => input.message.content)).toEqual(["first", "/compact"]);
    expect(ctl.inputs[1]?.fileAccess).toBeUndefined();
    expect(runner.getStatus()).toBe("running");
    await runner.terminate();
  });

  it("revalidates a stopped session before restarting it with a new input", async () => {
    const ctl = makeControllableQuery();
    let unsafe = false;
    const prepareFileAccess = vi.fn(async () => {
      if (unsafe) throw new Error("documentation mount was replaced");
    });
    const runner = new AgentRunner("stopped-path-agent", {
      query: ctl.query,
      prepareFileAccess,
    });

    await runner.start({ prompt: "first" });
    ctl.emit(SYSTEM_INIT);
    await flush();
    await runner.stop();
    unsafe = true;

    await expect(runner.send("resume after stop")).rejects.toThrow(
      "documentation mount was replaced",
    );
    expect(prepareFileAccess).toHaveBeenCalledTimes(2);
    expect(ctl.inputs.map((input) => input.message.content)).toEqual(["first"]);
    expect(runner.getStatus()).toBe("error");
  });

  it("revalidates a restored resumable session before dispatching its first resumed input", async () => {
    const ctl = makeControllableQuery();
    const query = vi.fn(ctl.query);
    const resolveFileAccess = vi.fn(() => ({
      readableFiles: [],
      writableFiles: [],
      writableDirectories: ["/unsafe/docs"],
    }));
    const runner = new AgentRunner("resume-path-agent", {
      query,
      resolveFileAccess,
      prepareFileAccess: async () => {
        throw new Error("documentation mount was replaced");
      },
    });
    runner.restore({
      id: "resume-path-agent",
      status: "waiting_input",
      sessionId: "session-resume",
      config: { prompt: "old task", resume: "session-resume" },
      createdAt: 1,
      lastEventSeq: 0,
    });

    await expect(runner.send("resume task")).rejects.toThrow(
      "documentation mount was replaced",
    );

    expect(resolveFileAccess).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(runner.getStatus()).toBe("error");
  });

  it("does not let stale queued validation failure terminate a restarted session", async () => {
    const ctl = makeControllableQuery();
    const queuedPreparation = deferred();
    let preparationCall = 0;
    const events: AgentEvent[] = [];
    const runner = new AgentRunner("queued-restart-race-agent", {
      query: ctl.query,
      prepareFileAccess: () => {
        preparationCall++;
        return preparationCall === 2 ? queuedPreparation.promise : undefined;
      },
    });
    runner.on((event) => events.push(event));

    await runner.start({ prompt: "start A" });
    ctl.emit(SYSTEM_INIT);
    await flush();
    await runner.send("queued for A");
    ctl.emit(resultMsg());
    await flush();
    expect(preparationCall).toBe(2);

    await runner.stop();
    await runner.send("start B");
    await runner.send("queued for B");
    queuedPreparation.reject(new Error("stale A validation failed"));
    await flush();
    await flush();

    expect(runner.getStatus()).toBe("starting");
    expect(events.filter((event) => event.kind === "error")).toEqual([]);

    ctl.emit(SYSTEM_INIT);
    ctl.emit(resultMsg());
    await flush();

    expect(ctl.inputs.map((input) => input.message.content)).toEqual([
      "start A",
      "start B",
      "queued for B",
    ]);
    expect(runner.getStatus()).toBe("running");
    expect(events.filter((event) => event.kind === "error")).toEqual([]);
    await runner.terminate();
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

  it("provider 没有原生 steer 时打断当前轮，并把引导插到普通队列前", async () => {
    const ctl = makeControllableQuery({ nativeSteer: false });
    const events: AgentEvent[] = [];
    const runner = new AgentRunner("steer-fallback-agent", { query: ctl.query });
    runner.on((event) => events.push(event));

    runner.start({ prompt: "长任务" });
    ctl.emit(SYSTEM_INIT);
    await flush();

    runner.send("普通排队");
    await runner.steer("请优先看失败测试");

    expect(ctl.wasInterrupted()).toBe(true);
    expect(ctl.steeredInputs).toHaveLength(0);
    expect(events).toContainEqual({
      kind: "user_input",
      text: "普通排队",
      mode: "queued",
    });
    expect(events).toContainEqual({
      kind: "user_input",
      text: "请优先看失败测试",
      mode: "steer",
    });

    ctl.emit(resultMsg());
    await flush();

    expect(ctl.inputs.map((input) => input.message.content)).toEqual([
      "长任务",
      "请优先看失败测试",
    ]);

    ctl.emit(resultMsg());
    await flush();

    expect(ctl.inputs.map((input) => input.message.content)).toEqual([
      "长任务",
      "请优先看失败测试",
      "普通排队",
    ]);
  });

  it("provider 发起交互问题时广播到前端，并等待 answerQuestion", async () => {
    const ctl = makeControllableQuery();
    const events: AgentEvent[] = [];
    const runner = new AgentRunner("question-agent", { query: ctl.query });
    runner.on((event) => events.push(event));

    runner.start({ prompt: "需要澄清" });
    ctl.emit(SYSTEM_INIT);
    await flush();

    const pending = ctl.getOptions()?.requestUserInput?.({
      requestId: "q-1",
      kind: "ask_user_question",
      title: "Claude 需要确认",
      questions: [
        {
          id: "choice",
          question: "选哪个？",
          options: [
            { label: "A", description: "方案 A" },
            { label: "B", description: "方案 B" },
          ],
        },
      ],
    });
    await flush();

    expect(events).toContainEqual({
      kind: "user_question",
      request: {
        requestId: "q-1",
        kind: "ask_user_question",
        title: "Claude 需要确认",
        questions: [
          {
            id: "choice",
            question: "选哪个？",
            options: [
              { label: "A", description: "方案 A" },
              { label: "B", description: "方案 B" },
            ],
          },
        ],
      },
    });

    runner.answerQuestion("q-1", { answers: { choice: "A" } });
    await expect(pending).resolves.toEqual({
      action: "accept",
      answers: { choice: "A" },
    });
    expect(events).toContainEqual({
      kind: "user_question_result",
      requestId: "q-1",
      action: "accept",
      summary: "已回答 1 个问题",
    });
  });

  it("provider 发起授权请求时广播到前端，并等待 answerApproval", async () => {
    const ctl = makeControllableQuery();
    const events: AgentEvent[] = [];
    const runner = new AgentRunner("approval-agent", { query: ctl.query });
    runner.on((event) => events.push(event));

    runner.start({ prompt: "需要执行命令" });
    ctl.emit(SYSTEM_INIT);
    await flush();

    const pending = ctl.getOptions()?.requestApproval?.({
      requestId: "approval-1",
      kind: "command",
      title: "Codex 请求执行命令",
      command: "npm test",
      cwd: "/repo",
    });
    await flush();

    expect(events).toContainEqual({
      kind: "user_approval",
      request: {
        requestId: "approval-1",
        kind: "command",
        title: "Codex 请求执行命令",
        command: "npm test",
        cwd: "/repo",
      },
    });

    runner.answerApproval("approval-1", { action: "approve", remember: true });
    await expect(pending).resolves.toEqual({ action: "approve", remember: true });
    expect(events).toContainEqual({
      kind: "user_approval_result",
      requestId: "approval-1",
      action: "approve",
      summary: "已允许并记住",
    });
  });

  it("完全权限模式下授权请求直接允许且不广播等待事件", async () => {
    const ctl = makeControllableQuery();
    const events: AgentEvent[] = [];
    const runner = new AgentRunner("full-permission-agent", {
      query: ctl.query,
      fullPermissionMode: () => true,
    });
    runner.on((event) => events.push(event));

    runner.start({ prompt: "需要执行命令" });
    ctl.emit(SYSTEM_INIT);
    await flush();

    await expect(
      ctl.getOptions()?.requestApproval?.({
        requestId: "approval-auto",
        kind: "command",
        title: "Codex 请求执行命令",
        command: "npm test",
      }),
    ).resolves.toEqual({ action: "approve" });
    expect(events.some((event) => event.kind === "user_approval")).toBe(false);
  });

  it("stop → stopped，调用 interrupt；继续输入时优先复用未关闭的流式会话", async () => {
    const ctl = makeControllableQuery();
    const onProviderTurnSettled = vi.fn();
    const runner = new AgentRunner("a2", {
      query: ctl.query,
      onProviderTurnSettled,
    });
    runner.start({ prompt: "x" });
    ctl.emit(SYSTEM_INIT);
    await flush();

    await runner.stop();
    expect(runner.getStatus()).toBe("stopped");
    expect(ctl.wasInterrupted()).toBe(true);
    ctl.emit(resultMsg());
    await flush();
    expect(onProviderTurnSettled).toHaveBeenCalledTimes(1);

    runner.send("y");
    await flush();
    expect(runner.getStatus()).toBe("running");
    expect(ctl.wasTerminated()).toBe(false);
    expect(ctl.inputs.map((input) => input.message.content)).toEqual(["x", "y"]);
  });

  it("does not let a hanging best-effort interrupt block stop or exact termination", async () => {
    const output = new AsyncMessageQueue<SdkMessage>();
    const interruptStarted = deferred();
    const neverInterrupts = deferred();
    let terminated = false;
    const runner = new AgentRunner("hanging-interrupt-agent", {
      query: () => ({
        [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
        interrupt: async () => {
          interruptStarted.resolve();
          await neverInterrupts.promise;
        },
        terminate: async () => {
          terminated = true;
          output.close();
        },
      }),
    });

    await runner.start({ prompt: "start" });
    output.push(SYSTEM_INIT);
    await flush();
    await expect(
      Promise.race([
        runner.stop().then(() => "stopped"),
        new Promise<string>((resolve) => setTimeout(() => resolve("timed out"), 100)),
      ]),
    ).resolves.toBe("stopped");
    await interruptStarted.promise;
    expect(runner.getStatus()).toBe("stopped");

    await expect(runner.terminate()).resolves.toBeUndefined();
    expect(terminated).toBe(true);
    expect(runner.getStatus()).toBe("terminated");
  });

  it.each(["deliver", "steer"] as const)(
    "does not let a hanging fallback interrupt block %s or exact termination",
    async (operation) => {
      const output = new AsyncMessageQueue<SdkMessage>();
      const interruptStarted = deferred();
      const neverInterrupts = deferred();
      const runner = new AgentRunner(`hanging-${operation}-interrupt-agent`, {
        query: () => ({
          [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
          interrupt: async () => {
            interruptStarted.resolve();
            await neverInterrupts.promise;
          },
          terminate: async () => output.close(),
        }),
      });

      await runner.start({ prompt: "start" });
      output.push(SYSTEM_INIT);
      await flush();
      const dispatch = operation === "deliver"
        ? runner.deliver("queued delivery")
        : runner.steer("queued steer");
      await expect(
        Promise.race([
          dispatch.then(() => "dispatched"),
          new Promise<string>((resolve) => setTimeout(() => resolve("timed out"), 100)),
        ]),
      ).resolves.toBe("dispatched");
      await interruptStarted.promise;
      await expect(runner.terminate()).resolves.toBeUndefined();
    },
  );

  it("waits for stopped transport termination and preserves concurrent restart inputs", async () => {
    const termination = deferred();
    const terminationStarted = deferred();
    const outputs: AsyncMessageQueue<SdkMessage>[] = [];
    const inputs: SdkUserInput[] = [];
    let queryCalls = 0;
    const query: QueryFn = ({ prompt }) => {
      const callIndex = queryCalls++;
      const output = new AsyncMessageQueue<SdkMessage>();
      outputs.push(output);
      if (typeof prompt !== "string") {
        void (async () => {
          for await (const input of prompt) inputs.push(input);
        })();
      }
      return {
        [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
        interrupt: async () => undefined,
        terminate: async () => {
          if (callIndex === 0) {
            terminationStarted.resolve();
            await termination.promise;
          }
          output.close();
        },
      };
    };
    const prepareFileAccess = vi.fn(async () => undefined);
    const onProviderTurnSettled = vi.fn();
    const events: AgentEvent[] = [];
    const runner = new AgentRunner("stopped-concurrent-restart-agent", {
      query,
      prepareFileAccess,
      onProviderTurnSettled,
    });
    runner.on((event) => events.push(event));

    await runner.start({ prompt: "start A" });
    outputs[0]!.push(SYSTEM_INIT);
    await flush();
    await runner.stop();
    const firstRestart = runner.send("restart one");
    await terminationStarted.promise;
    const secondRestart = runner.send("restart two");
    await flush();

    expect(queryCalls).toBe(1);
    expect(prepareFileAccess).toHaveBeenCalledTimes(1);
    expect(onProviderTurnSettled).not.toHaveBeenCalled();
    termination.resolve();
    await Promise.all([firstRestart, secondRestart]);
    await flush();

    expect(queryCalls).toBe(2);
    expect(prepareFileAccess).toHaveBeenCalledTimes(2);
    expect(onProviderTurnSettled).toHaveBeenCalledTimes(1);
    expect(inputs.map((input) => input.message.content)).toEqual(["start A", "restart one"]);
    expect(
      events.filter((event) => event.kind === "user_input").map((event) => event.text),
    ).toEqual(["start A", "restart one", "restart two"]);
    await runner.terminate();
  });

  it("notifies stopped settlement only after a failed transport close is retried successfully", async () => {
    const outputs: AsyncMessageQueue<SdkMessage>[] = [];
    let queryCalls = 0;
    let terminationAttempts = 0;
    const query: QueryFn = () => {
      const callIndex = queryCalls++;
      const output = new AsyncMessageQueue<SdkMessage>();
      outputs.push(output);
      return {
        [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
        interrupt: async () => undefined,
        terminate: async () => {
          if (callIndex === 0) {
            terminationAttempts += 1;
            if (terminationAttempts === 1) throw new Error("provider still owns snapshot");
          }
          output.close();
        },
      };
    };
    const onProviderTurnSettled = vi.fn();
    const runner = new AgentRunner("stopped-close-retry-settlement-agent", {
      query,
      onProviderTurnSettled,
    });

    await runner.start({ prompt: "start A" });
    outputs[0]!.push(SYSTEM_INIT);
    await flush();
    await runner.stop();

    await expect(runner.send("first resume attempt")).rejects.toThrow(
      /provider transport termination failed/u,
    );
    expect(onProviderTurnSettled).not.toHaveBeenCalled();
    expect(queryCalls).toBe(1);
    expect(runner.getStatus()).toBe("stopped");

    await expect(runner.send("retry resume")).resolves.toBeUndefined();
    expect(terminationAttempts).toBe(2);
    expect(onProviderTurnSettled).toHaveBeenCalledTimes(1);
    expect(queryCalls).toBe(2);
    expect(runner.getStatus()).toBe("starting");
    await runner.terminate();
  });

  it("preserves concurrent stopped inputs after the old provider naturally settles", async () => {
    const outputs: AsyncMessageQueue<SdkMessage>[] = [];
    const inputs: SdkUserInput[] = [];
    const settled = deferred();
    let queryCalls = 0;
    const query: QueryFn = ({ prompt }) => {
      queryCalls += 1;
      const output = new AsyncMessageQueue<SdkMessage>();
      outputs.push(output);
      if (typeof prompt !== "string") {
        void (async () => {
          for await (const input of prompt) inputs.push(input);
        })();
      }
      return {
        [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
        interrupt: async () => undefined,
        terminate: async () => output.close(),
      };
    };
    const events: AgentEvent[] = [];
    const runner = new AgentRunner("settled-stopped-concurrent-agent", {
      query,
      onProviderTurnSettled: () => settled.resolve(),
    });
    runner.on((event) => events.push(event));

    await runner.start({ prompt: "start A" });
    outputs[0]!.push(SYSTEM_INIT);
    await flush();
    await runner.stop();
    outputs[0]!.close();
    await settled.promise;

    const firstRestart = runner.send("restart one");
    const secondRestart = runner.send("restart two");
    await Promise.all([firstRestart, secondRestart]);
    await flush();

    expect(queryCalls).toBe(2);
    expect(inputs.map((input) => input.message.content)).toEqual(["start A", "restart one"]);
    expect(
      events.filter((event) => event.kind === "user_input").map((event) => event.text),
    ).toEqual(["start A", "restart one", "restart two"]);
    await runner.terminate();
  });

  it("cancels every queued stopped restart when terminating a pending restart", async () => {
    const termination = deferred();
    const terminationStarted = deferred();
    const output = new AsyncMessageQueue<SdkMessage>();
    let queryCalls = 0;
    const query: QueryFn = () => {
      queryCalls += 1;
      return {
        [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
        interrupt: async () => undefined,
        terminate: async () => {
          terminationStarted.resolve();
          await termination.promise;
          output.close();
        },
      };
    };
    const runner = new AgentRunner("stopped-close-barrier-agent", { query });

    await runner.start({ prompt: "start A" });
    output.push(SYSTEM_INIT);
    await flush();
    await runner.stop();
    const firstRestart = runner.send("start B");
    await terminationStarted.promise;
    const secondRestart = runner.send("queue after B");
    const firstOutcome = firstRestart.then(
      () => undefined,
      (error: unknown) => error,
    );
    const secondOutcome = secondRestart.then(
      () => undefined,
      (error: unknown) => error,
    );
    let terminated = false;
    const terminating = runner.terminate().then(() => {
      terminated = true;
    });
    await flush();

    expect(terminated).toBe(false);
    expect(queryCalls).toBe(1);
    termination.resolve();
    await terminating;
    const firstError = await firstOutcome;
    const secondError = await secondOutcome;
    expect(firstError).toBeInstanceOf(Error);
    expect(String(firstError)).toMatch(/restart was cancelled before dispatch/u);
    expect(secondError).toBeInstanceOf(Error);
    expect(String(secondError)).toMatch(/closed-state input was cancelled/u);
    expect(runner.getStatus()).toBe("terminated");
    expect(queryCalls).toBe(1);
  });

  it("a second terminate cancels a restart queued while the first terminate is pending", async () => {
    const termination = deferred();
    const terminationStarted = deferred();
    const output = new AsyncMessageQueue<SdkMessage>();
    let queryCalls = 0;
    const query: QueryFn = () => {
      queryCalls += 1;
      return {
        [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
        terminate: async () => {
          terminationStarted.resolve();
          await termination.promise;
          output.close();
        },
      };
    };
    const runner = new AgentRunner("terminate-restart-cancellation-agent", { query });

    await runner.start({ prompt: "start A" });
    output.push(SYSTEM_INIT);
    await flush();
    const firstTerminate = runner.terminate();
    await terminationStarted.promise;
    const restarting = runner.send("restart after terminate");
    const restartOutcome = restarting.then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(runner.getStatus()).toBe("starting"));
    const secondTerminate = runner.terminate();

    termination.resolve();
    await Promise.all([firstTerminate, secondTerminate]);
    const restartError = await restartOutcome;
    expect(restartError).toBeInstanceOf(Error);
    expect(String(restartError)).toMatch(/start was cancelled before dispatch/u);
    expect(runner.getStatus()).toBe("terminated");
    expect(queryCalls).toBe(1);
  });

  it("terminate cancels a terminated-state restart before its transition microtask begins", async () => {
    let queryCalls = 0;
    const runner = new AgentRunner("same-tick-terminated-restart-agent", {
      query: () => {
        queryCalls += 1;
        return {
          async *[Symbol.asyncIterator]() {},
          terminate: async () => undefined,
        };
      },
    });
    await runner.terminate();

    const restarting = runner.send("must not restart");
    const restartOutcome = restarting.then(
      () => undefined,
      (error: unknown) => error,
    );
    const terminating = runner.terminate();

    await terminating;
    const restartError = await restartOutcome;
    expect(restartError).toBeInstanceOf(Error);
    expect(String(restartError)).toMatch(/closed-state input was cancelled before dispatch/u);
    expect(queryCalls).toBe(0);
    expect(runner.getStatus()).toBe("terminated");
  });

  it("propagates transport termination failures and retries the retained handle", async () => {
    const output = new AsyncMessageQueue<SdkMessage>();
    let attempts = 0;
    const runner = new AgentRunner("retry-provider-termination-agent", {
      query: () => ({
        [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
        terminate: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("provider still alive");
          output.close();
        },
      }),
    });

    await runner.start({ prompt: "start" });
    output.push(SYSTEM_INIT);
    await flush();
    await expect(runner.terminate()).rejects.toThrow(/provider transport termination failed/u);
    expect(runner.getStatus()).toBe("terminated");
    expect(attempts).toBe(1);

    await expect(runner.terminate()).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });

  it("preserves a pending documentation policy across stop and stopped-session reuse", async () => {
    const ctl = makeControllableQuery();
    let workDocumentationEnabled = false;
    const runner = new AgentRunner("stopped-documentation-policy-agent", {
      query: ctl.query,
      workDocumentationEnabled: () => workDocumentationEnabled,
    });
    runner.start({ prompt: "first", branchWorkspaceId: "branch_1" });
    ctl.emit(SYSTEM_INIT);
    await flush();

    workDocumentationEnabled = true;
    runner.refreshPolicyPrompt();
    await runner.stop();
    ctl.emit(resultMsg());
    await flush();

    runner.send("continue");
    await flush();

    expect(runner.getStatus()).toBe("running");
    expect(ctl.wasTerminated()).toBe(false);
    expect(ctl.inputs.map((input) => input.message.content)).toEqual(["first", "continue"]);
    expect(readablePromptContents(ctl.inputs.at(-1))).toEqual([
      agentCanvasPolicyPrompt("stopped-documentation-policy-agent", {
        workDocumentationEnabled: true,
      }),
    ]);
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

  it("terminate → terminated，并关闭底层 handle；继续输入时用当前 session 重启", async () => {
    const ctl = makeControllableQuery();
    const runner = new AgentRunner("terminate-agent", { query: ctl.query });
    runner.start({ prompt: "x" });
    ctl.emit(SYSTEM_INIT);
    await flush();

    await runner.terminate();
    await flush();
    expect(runner.getStatus()).toBe("terminated");
    expect(ctl.wasTerminated()).toBe(true);
    runner.send("y");
    await flush();
    expect(runner.getStatus()).toBe("starting");
    expect(ctl.getOptions()?.resume).toBe("s1");
    expect(ctl.inputs.map((input) => input.message.content)).toEqual(["x", "y"]);
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

  it("re-injects documentation policy changes and explicitly revokes disabled rules", async () => {
    const ctl = makeControllableQuery();
    let workDocumentationEnabled = false;
    const runner = new AgentRunner("documentation-policy-agent", {
      query: ctl.query,
      workDocumentationEnabled: () => workDocumentationEnabled,
    });

    runner.start({ prompt: "first", branchWorkspaceId: "branch_1" });
    await flush();
    expect(readablePromptContents(ctl.inputs[0])).toEqual([
      agentCanvasPolicyPrompt("documentation-policy-agent"),
    ]);

    ctl.emit(SYSTEM_INIT);
    ctl.emit(resultMsg());
    await flush();
    workDocumentationEnabled = true;
    runner.refreshPolicyPrompt();
    runner.send("enabled");
    await flush();
    expect(readablePromptContents(ctl.inputs.at(-1))).toEqual([
      agentCanvasPolicyPrompt("documentation-policy-agent", {
        workDocumentationEnabled: true,
      }),
    ]);

    ctl.emit(resultMsg());
    await flush();
    workDocumentationEnabled = false;
    runner.refreshPolicyPrompt({
      id: "agent-canvas:work-documentation-disabled",
      name: "Agent Canvas 工作文档维护已关闭",
      content: workDocumentationDisabledPrompt(),
      kind: "shared",
    });
    workDocumentationEnabled = true;
    runner.refreshPolicyPrompt(undefined, "agent-canvas:work-documentation-disabled");
    runner.send("rapidly re-enabled");
    await flush();
    expect(readablePromptContents(ctl.inputs.at(-1))).toEqual([
      agentCanvasPolicyPrompt("documentation-policy-agent", {
        workDocumentationEnabled: true,
      }),
    ]);

    ctl.emit(resultMsg());
    await flush();
    workDocumentationEnabled = false;
    runner.refreshPolicyPrompt({
      id: "agent-canvas:work-documentation-disabled",
      name: "Agent Canvas 工作文档维护已关闭",
      content: workDocumentationDisabledPrompt(),
      kind: "shared",
    });
    runner.send("disabled");
    await flush();
    expect(readablePromptContents(ctl.inputs.at(-1))).toEqual([
      agentCanvasPolicyPrompt("documentation-policy-agent"),
      workDocumentationDisabledPrompt(),
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

  it("updateSettings switches the provider model for later responses", async () => {
    const ctl = makeControllableQuery();
    const runner = new AgentRunner("model-switch-agent", { query: ctl.query });

    runner.start({ prompt: "first", model: "old-model" });
    ctl.emit(SYSTEM_INIT);
    ctl.emit(resultMsg());
    await flush();

    runner.updateSettings({ model: "new-model" });

    expect(runner.snapshot().config?.model).toBe("new-model");
    expect(ctl.modelUpdates).toEqual(["new-model"]);
  });

  it("updateSettings can clear the provider model back to default", async () => {
    const ctl = makeControllableQuery();
    const runner = new AgentRunner("model-clear-agent", { query: ctl.query });

    runner.start({ prompt: "first", model: "old-model" });
    ctl.emit(SYSTEM_INIT);
    ctl.emit(resultMsg());
    await flush();

    runner.updateSettings({ model: null });

    expect(runner.snapshot().config?.model).toBeUndefined();
    expect(ctl.modelUpdates).toEqual([undefined]);
  });

  it("branch switch prompt is injected once on the next business input", async () => {
    const ctl = makeControllableQuery();
    const runner = new AgentRunner("branch-switch-agent", { query: ctl.query });

    runner.updateSettings(
      {
        branchWorkspaceId: "branch_2",
        branch: "feature/a",
        cwd: "/repo-feature-a",
      },
      {
        id: "agent-canvas:branch-switch:main->feature/a",
        name: "Agent Canvas branch 切换说明",
        content: "从 main 切换到 feature/a\n- M src/app.ts",
        kind: "shared",
      },
    );
    runner.start({
      ...(runner.snapshot().config ?? {}),
      prompt: "after switch",
    });
    await flush();

    expect(ctl.getOptions()?.cwd).toBe("/repo-feature-a");
    expect(readablePromptContents(ctl.inputs[0])).toEqual([
      agentCanvasPolicyPrompt("branch-switch-agent"),
      "从 main 切换到 feature/a\n- M src/app.ts",
    ]);
  });

  it.each([
    { ending: "error", expectedStatus: "error" },
    { ending: "finish", expectedStatus: "done" },
  ] as const)(
    "does not suppress the resumed handle's $ending state after settings detach",
    async ({ ending, expectedStatus }) => {
      const firstOutput = new AsyncMessageQueue<SdkMessage>();
      let queryCalls = 0;
      const events: AgentEvent[] = [];
      const query: QueryFn = ({ options }) => {
        queryCalls += 1;
        if (queryCalls === 1) {
          options?.abortController?.signal.addEventListener("abort", () => firstOutput.close());
          return {
            [Symbol.asyncIterator]: () => firstOutput[Symbol.asyncIterator](),
            terminate: async () => firstOutput.close(),
          };
        }
        return {
          // eslint-disable-next-line require-yield
          async *[Symbol.asyncIterator]() {
            if (ending === "error") throw new Error("resumed provider failed");
          },
          terminate: async () => undefined,
        };
      };
      const runner = new AgentRunner(`detached-${ending}-agent`, { query });
      runner.on((event) => events.push(event));

      await runner.start({ prompt: "first", branch: "main", cwd: "/repo-main" });
      firstOutput.push(SYSTEM_INIT);
      firstOutput.push(resultMsg());
      await flush();
      expect(runner.getStatus()).toBe("waiting_input");

      runner.updateSettings({
        branchWorkspaceId: "branch_2",
        branch: "feature/a",
        cwd: "/repo-feature-a",
      });
      await runner.send("resume after branch switch");
      await flush();

      expect(queryCalls).toBe(2);
      expect(runner.getStatus()).toBe(expectedStatus);
      expect(events.some((event) => event.kind === "error")).toBe(ending === "error");
    },
  );

  it("invalidates a delayed automation delivery when settings detach the idle session", async () => {
    const ctl = makeControllableQuery();
    const deliveryPreparation = deferred();
    let delayPreparation = false;
    const runner = new AgentRunner("detached-delivery-agent", {
      query: ctl.query,
      prepareFileAccess: () =>
        delayPreparation ? deliveryPreparation.promise : undefined,
    });

    await runner.start({ prompt: "first", branch: "main", cwd: "/repo-main" });
    ctl.emit(SYSTEM_INIT);
    ctl.emit(resultMsg());
    await flush();
    expect(runner.getStatus()).toBe("waiting_input");

    delayPreparation = true;
    const delivery = runner.deliver("stale automation delivery");
    await flush();
    runner.updateSettings({
      branchWorkspaceId: "branch_2",
      branch: "feature/a",
      cwd: "/repo-feature-a",
    });
    deliveryPreparation.resolve();

    await expect(delivery).rejects.toThrow("delivery target changed before dispatch");
    await flush();
    expect(ctl.inputs.map((input) => input.message.content)).toEqual(["first"]);
    expect(runner.getStatus()).toBe("waiting_input");
  });

  it("waiting_input branch switch resumes next send with the new cwd", async () => {
    const ctl = makeControllableQuery();
    const runner = new AgentRunner("branch-resume-agent", { query: ctl.query });

    runner.start({ prompt: "first", branch: "main", cwd: "/repo-main" });
    ctl.emit(SYSTEM_INIT);
    ctl.emit(resultMsg());
    await flush();
    expect(runner.getStatus()).toBe("waiting_input");
    expect(runner.snapshot().sessionId).toBe("s1");

    runner.updateSettings(
      {
        branchWorkspaceId: "branch_2",
        branch: "feature/a",
        cwd: "/repo-feature-a",
      },
      {
        id: "agent-canvas:branch-switch:main->feature/a",
        name: "Agent Canvas branch 切换说明",
        content: "从 main 切换到 feature/a",
        kind: "shared",
      },
    );
    expect(runner.getStatus()).toBe("waiting_input");

    runner.send("after branch switch");
    await flush();
    expect(ctl.getOptions()?.cwd).toBe("/repo-feature-a");
    expect(ctl.getOptions()?.resume).toBe("s1");
    expect(readablePromptContents(ctl.inputs.at(-1))).toEqual([
      agentCanvasPolicyPrompt("branch-resume-agent"),
      "从 main 切换到 feature/a",
    ]);
  });

  it("消息流抛错 → error 事件 + error 状态", async () => {
    const query: QueryFn = () => ({
      // eslint-disable-next-line require-yield
      async *[Symbol.asyncIterator]() {
        throw new Error("boom");
      },
      terminate: async () => undefined,
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
      terminate: async () => undefined,
    }));
    const codexQuery: QueryFn = vi.fn(() => ({
      async *[Symbol.asyncIterator]() {
        // empty
      },
      terminate: async () => undefined,
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
