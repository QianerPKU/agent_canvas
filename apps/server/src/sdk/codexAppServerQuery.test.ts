import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import readline from "node:readline";
import { describe, expect, it, vi } from "vitest";
import { AsyncMessageQueue } from "../util/AsyncMessageQueue.js";
import { createCodexAppServerQuery } from "./codexAppServerQuery.js";
import type { SdkUserInput } from "./types.js";

function userInput(
  text: string,
  fileAccess?: SdkUserInput["fileAccess"],
  promptAccess?: SdkUserInput["promptAccess"],
): SdkUserInput {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    fileAccess,
    promptAccess,
  };
}

interface FakeSecurityDefaults {
  sandboxPolicy?: Record<string, unknown>;
  approvalPolicy?: unknown;
  responseLocation?: "topLevel" | "thread" | "missing";
}

function makeFakeSpawn(
  options: {
    completeTurnStart?: boolean;
    compactTokenUsage?: Record<string, unknown>;
    rejectSettingsUpdateCalls?: number[];
    rejectTurnStart?: boolean;
    securityDefaults?: FakeSecurityDefaults;
  } = {},
) {
  const completeTurnStart = options.completeTurnStart ?? true;
  const securityDefaults = options.securityDefaults;
  const responseLocation = securityDefaults?.responseLocation ?? "topLevel";
  const requests: string[] = [];
  const messages: Array<{ id?: number; method?: string; params?: Record<string, unknown> }> = [];
  const responses: Array<{ id?: number; result?: unknown; error?: unknown }> = [];
  const effectiveTurnSecurity: Array<{
    sandboxPolicy?: unknown;
    approvalPolicy?: unknown;
  }> = [];
  const securityUpdates: Array<{
    sandboxPolicy?: unknown;
    approvalPolicy?: unknown;
  }> = [];
  let stickySandboxPolicy = securityDefaults?.sandboxPolicy;
  let stickyApprovalPolicy = securityDefaults?.approvalPolicy;
  let settingsUpdateCounter = 0;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    exitCode: number | null;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdin = stdin;
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.exitCode = null;
  proc.kill = vi.fn(() => {
    proc.exitCode = 0;
    proc.emit("exit", 0, null);
    return true;
  });

  const write = (message: unknown) => stdout.write(`${JSON.stringify(message)}\n`);
  let turnCounter = 0;
  const inputLines = readline.createInterface({ input: stdin });
  inputLines.on("line", (line) => {
    const message = JSON.parse(line) as {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      result?: unknown;
      error?: unknown;
    };
    if (!message.method) {
      responses.push(message);
      return;
    }
    messages.push(message);
    requests.push(message.method);
    if (message.id === undefined) return;

    switch (message.method) {
      case "initialize":
        write({ id: message.id, result: {} });
        break;
      case "thread/start":
        {
          const thread: Record<string, unknown> = { id: "thread-1", cwd: "C:/repo" };
          const result: Record<string, unknown> = {
            thread,
            model: "gpt-5.5",
            cwd: "C:/repo",
          };
          if (responseLocation === "thread") {
            if (securityDefaults?.sandboxPolicy !== undefined) {
              thread.sandbox = securityDefaults.sandboxPolicy;
            }
            if (securityDefaults?.approvalPolicy !== undefined) {
              thread.approvalPolicy = securityDefaults.approvalPolicy;
            }
          } else if (responseLocation === "topLevel") {
            if (securityDefaults?.sandboxPolicy !== undefined) {
              result.sandbox = securityDefaults.sandboxPolicy;
            }
            if (securityDefaults?.approvalPolicy !== undefined) {
              result.approvalPolicy = securityDefaults.approvalPolicy;
            }
          }
          write({
            id: message.id,
            result,
          });
        }
        break;
      case "turn/start":
        if (Object.prototype.hasOwnProperty.call(message.params, "sandboxPolicy")) {
          stickySandboxPolicy = message.params?.sandboxPolicy as Record<string, unknown>;
        }
        if (Object.prototype.hasOwnProperty.call(message.params, "approvalPolicy")) {
          stickyApprovalPolicy = message.params?.approvalPolicy;
        }
        effectiveTurnSecurity.push({
          sandboxPolicy: stickySandboxPolicy,
          approvalPolicy: stickyApprovalPolicy,
        });
        if (options.rejectTurnStart) {
          write({
            id: message.id,
            error: { code: -32602, message: "turn rejected after applying settings" },
          });
          break;
        }
        turnCounter += 1;
        write({ id: message.id, result: { turn: { id: `turn-${turnCounter}` } } });
        if (completeTurnStart) {
          write({
            method: "turn/completed",
            params: {
              threadId: "thread-1",
              turn: { id: `turn-${turnCounter}`, status: "completed" },
            },
          });
        }
        break;
      case "thread/settings/update":
        settingsUpdateCounter += 1;
        if (options.rejectSettingsUpdateCalls?.includes(settingsUpdateCounter)) {
          write({
            id: message.id,
            error: {
              code: -32603,
              message: `settings update ${settingsUpdateCounter} rejected`,
            },
          });
          break;
        }
        if (Object.prototype.hasOwnProperty.call(message.params, "sandboxPolicy")) {
          stickySandboxPolicy = message.params?.sandboxPolicy as Record<string, unknown>;
        }
        if (Object.prototype.hasOwnProperty.call(message.params, "approvalPolicy")) {
          stickyApprovalPolicy = message.params?.approvalPolicy;
        }
        if (
          Object.prototype.hasOwnProperty.call(message.params, "sandboxPolicy") ||
          Object.prototype.hasOwnProperty.call(message.params, "approvalPolicy")
        ) {
          securityUpdates.push({
            sandboxPolicy: stickySandboxPolicy,
            approvalPolicy: stickyApprovalPolicy,
          });
        }
        write({ id: message.id, result: {} });
        break;
      case "turn/interrupt":
        write({ id: message.id, result: {} });
        write({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: message.params?.turnId, status: "interrupted" },
          },
        });
        break;
      case "turn/steer":
        if (message.params?.expectedTurnId !== "turn-1") {
          write({
            id: message.id,
            error: {
              code: -32602,
              message: "expectedTurnId is required",
            },
          });
          break;
        }
        write({ id: message.id, result: { turnId: "turn-1" } });
        break;
      case "thread/compact/start":
        write({ id: message.id, result: {} });
        write({
          method: "turn/started",
          params: {
            threadId: "thread-1",
            turn: { id: "compact-turn", status: "inProgress" },
          },
        });
        if (options.compactTokenUsage) {
          write({
            method: "thread/tokenUsage/updated",
            params: {
              threadId: "thread-1",
              turnId: "compact-turn",
              tokenUsage: options.compactTokenUsage,
            },
          });
        }
        write({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "compact-turn",
            item: { type: "contextCompaction", id: "compact-item" },
          },
        });
        write({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "compact-turn", status: "completed" },
          },
        });
        break;
    }
  });

  return {
    spawnFn: vi.fn(() => proc) as never,
    requests,
    messages,
    responses,
    effectiveTurnSecurity,
    securityUpdates,
    proc,
    completeTurn: (turnId = "turn-1") =>
      write({
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: turnId, status: "completed" } },
      }),
    emitTokenUsage: (
      turnId: string,
      tokenUsage: Record<string, unknown>,
    ) =>
      write({
        method: "thread/tokenUsage/updated",
        params: { threadId: "thread-1", turnId, tokenUsage },
      }),
  };
}

describe("Codex app-server query", () => {
  it("将 /compact 转为原生 thread/compact/start，并可终止 CLI", async () => {
    const fake = makeFakeSpawn({
      compactTokenUsage: {
        last: {
          inputTokens: 800,
          cachedInputTokens: 500,
          outputTokens: 20,
          totalTokens: 820,
          reasoningOutputTokens: 0,
        },
        total: {
          inputTokens: 5000,
          cachedInputTokens: 3000,
          outputTokens: 200,
          totalTokens: 5200,
          reasoningOutputTokens: 50,
        },
        modelContextWindow: 128000,
      },
    });
    const prompt = new AsyncMessageQueue<SdkUserInput>();
    prompt.push(userInput("先完成一轮"));

    const query = createCodexAppServerQuery({ spawnFn: fake.spawnFn });
    const handle = query({ prompt, options: { model: "gpt-5.5" } });
    const iterator = handle[Symbol.asyncIterator]();

    expect((await iterator.next()).value).toMatchObject({
      type: "system",
      subtype: "init",
      session_id: "thread-1",
    });
    expect((await iterator.next()).value).toMatchObject({
      type: "result",
      subtype: "completed",
    });

    prompt.push(userInput("/compact"));
    expect((await iterator.next()).value).toMatchObject({
      type: "usage",
      usage: { context_tokens: 820, context_window: 128000 },
    });
    expect((await iterator.next()).value).toEqual({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "manual" },
      uuid: "compact-item",
      session_id: "thread-1",
    });

    await handle.terminate?.();
    expect(fake.requests).toContain("thread/compact/start");
    expect(fake.proc.kill).toHaveBeenCalledOnce();
  });

  it("接收 resume 后携带旧 turnId 的线程 usage，不把它误过滤", async () => {
    const fake = makeFakeSpawn({ completeTurnStart: false });
    const prompt = new AsyncMessageQueue<SdkUserInput>();
    prompt.push(userInput("继续处理"));

    const handle = createCodexAppServerQuery({ spawnFn: fake.spawnFn })({
      prompt,
      options: { model: "gpt-5.5" },
    });
    const iterator = handle[Symbol.asyncIterator]();
    await iterator.next();

    const usageMessage = iterator.next();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fake.emitTokenUsage("previous-turn", {
      last: {
        inputTokens: 4090,
        cachedInputTokens: 2048,
        outputTokens: 6,
        totalTokens: 4096,
        reasoningOutputTokens: 0,
      },
      total: {
        inputTokens: 90000,
        cachedInputTokens: 80000,
        outputTokens: 10000,
        totalTokens: 100000,
        reasoningOutputTokens: 5000,
      },
      modelContextWindow: 128000,
    });

    expect((await usageMessage).value).toMatchObject({
      type: "usage",
      usage: { context_tokens: 4096, context_window: 128000 },
    });

    const completed = iterator.next();
    fake.completeTurn();
    expect((await completed).value).toMatchObject({
      type: "result",
      usage: { context_tokens: 4096 },
    });
    await handle.terminate?.();
  });

  it("每轮临时写权限结束后恢复 Codex 线程原始安全策略", async () => {
    const originalSandboxPolicy = {
      type: "workspaceWrite",
      writableRoots: ["C:/preconfigured-root"],
      networkAccess: true,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    };
    const fake = makeFakeSpawn({
      securityDefaults: {
        sandboxPolicy: originalSandboxPolicy,
        approvalPolicy: "untrusted",
      },
    });
    const prompt = new AsyncMessageQueue<SdkUserInput>();
    prompt.push(
      userInput(
        "处理这些文件",
        {
          readableFiles: [
            { name: "notes.md", path: "C:/shared/notes.md", previewKind: "markdown" },
            { name: "shot.png", path: "C:/shared/shot.png", previewKind: "image" },
          ],
          readableDirectories: ["C:/datasets/raw", "C:/models/weights"],
          writableFiles: [
            { name: "output.csv", path: "C:/shared/output/output.csv", previewKind: "csv" },
          ],
          writableDirectories: ["C:/shared/output", "C:/models/weights"],
          sharedResources: [
            {
              name: "raw dataset",
              mountPath: "C:/repo/data/raw",
              sourcePath: "C:/datasets/raw",
              access: "readOnly",
            },
            {
              name: "weights",
              mountPath: "C:/repo/models/weights",
              sourcePath: "C:/models/weights",
              access: "readWrite",
            },
          ],
        },
        {
          readablePrompts: [
            { id: "prompt_1", name: "规则", content: "先写测试", kind: "shared" },
          ],
          writablePrompts: [
            { id: "prompt_2", name: "可写规则", path: "C:/prompts/prompt_2.txt" },
          ],
          writableDirectories: ["C:/prompts"],
        },
      ),
    );

    const handle = createCodexAppServerQuery({ spawnFn: fake.spawnFn })({
      prompt,
      options: {
        cwd: "C:/repo",
        fileAccess: {
          readableFiles: [],
          writableFiles: [],
          sandboxWritableDirectories: ["C:/stale-agent-docs"],
          writableDirectories: [],
        },
        promptAccess: {
          readablePrompts: [
            { id: "prompt_1", name: "规则", content: "先写测试", kind: "shared" },
          ],
          writablePrompts: [
            { id: "prompt_2", name: "可写规则", path: "C:/prompts/prompt_2.txt" },
          ],
          writableDirectories: ["C:/prompts"],
        },
      },
    });
    const iterator = handle[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();

    prompt.push(
      userInput(
        "处理下一轮文件",
        {
          readableFiles: [
            { name: "next.txt", path: "C:/shared/next.txt", previewKind: "text" },
          ],
          writableFiles: [],
          sandboxWritableDirectories: ["C:/agent-docs"],
          writableDirectories: [],
        },
        {
          readablePrompts: [],
          writablePrompts: [],
          writableDirectories: [],
        },
      ),
    );
    await iterator.next();

    prompt.push(
      userInput(
        "关闭工作文档后继续",
        {
          readableFiles: [],
          writableFiles: [],
          writableDirectories: [],
        },
        {
          readablePrompts: [],
          writablePrompts: [],
          writableDirectories: [],
        },
      ),
    );
    await iterator.next();

    const turnStarts = fake.messages.filter((message) => message.method === "turn/start");
    expect(turnStarts[0]?.params?.input).toEqual([
      {
        type: "text",
        text:
          "先写测试\n\n处理这些文件\n\n共享映射资源（除非用户明确授权，否则 readOnly 资源不能修改）：\n" +
          "- raw dataset [readOnly]: C:/repo/data/raw -> C:/datasets/raw\n" +
          "- weights [readWrite]: C:/repo/models/weights -> C:/models/weights\n\n" +
          "可写的画布文件（作为输出目标）：\n" +
          "- C:/shared/output/output.csv\n\n可写的提示词节点（修改对应文本文件）：\n" +
          "- 可写规则: C:/prompts/prompt_2.txt",
        text_elements: [],
      },
      { type: "mention", name: "notes.md", path: "C:/shared/notes.md" },
      { type: "localImage", path: "C:/shared/shot.png" },
    ]);
    expect(turnStarts[0]?.params?.sandboxPolicy).toEqual({
      type: "workspaceWrite",
      writableRoots: [
        "C:/preconfigured-root",
        expect.stringMatching(/C:[\\/]shared[\\/]output$/),
        expect.stringMatching(/C:[\\/]models[\\/]weights$/),
        expect.stringMatching(/C:[\\/]prompts$/),
      ],
      networkAccess: true,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    });
    expect(turnStarts[0]?.params?.approvalPolicy).toBe("never");
    expect(turnStarts[1]?.params?.input).toEqual([
      {
        type: "text",
        text: "处理下一轮文件",
        text_elements: [],
      },
      { type: "mention", name: "next.txt", path: "C:/shared/next.txt" },
    ]);
    expect(turnStarts[1]?.params?.sandboxPolicy).toEqual({
      type: "workspaceWrite",
      writableRoots: [
        "C:/preconfigured-root",
        expect.stringMatching(/C:[\\/]agent-docs$/),
      ],
      networkAccess: true,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    });
    expect(turnStarts[1]?.params?.approvalPolicy).toBe("untrusted");
    expect(turnStarts[2]?.params?.input).toEqual([
      {
        type: "text",
        text: "关闭工作文档后继续",
        text_elements: [],
      },
    ]);
    expect(turnStarts[2]?.params?.sandboxPolicy).toEqual(originalSandboxPolicy);
    expect(turnStarts[2]?.params?.approvalPolicy).toBe("untrusted");
    expect(fake.effectiveTurnSecurity).toEqual([
      {
        sandboxPolicy: turnStarts[0]?.params?.sandboxPolicy,
        approvalPolicy: "never",
      },
      {
        sandboxPolicy: turnStarts[1]?.params?.sandboxPolicy,
        approvalPolicy: "untrusted",
      },
      {
        sandboxPolicy: originalSandboxPolicy,
        approvalPolicy: "untrusted",
      },
    ]);
    expect(fake.securityUpdates).toEqual([
      {
        sandboxPolicy: originalSandboxPolicy,
        approvalPolicy: "untrusted",
      },
      {
        sandboxPolicy: originalSandboxPolicy,
        approvalPolicy: "untrusted",
      },
    ]);
    const firstOverrideRequests = fake.messages
      .filter(
        (message) =>
          message.method === "turn/start" || message.method === "thread/settings/update",
      )
      .slice(0, 3);
    expect(firstOverrideRequests.map((message) => message.method)).toEqual([
      "thread/settings/update",
      "turn/start",
      "thread/settings/update",
    ]);
    expect(firstOverrideRequests[0]?.params).toEqual({ threadId: "thread-1" });
    expect(firstOverrideRequests[2]?.params).toEqual({
      threadId: "thread-1",
      sandboxPolicy: originalSandboxPolicy,
      approvalPolicy: "untrusted",
    });
    await handle.terminate?.();
  });

  it("从 thread 响应读取只读基线且不会为工作文档扩大整个 cwd 写权限", async () => {
    const originalSandboxPolicy = { type: "readOnly", networkAccess: true };
    const fake = makeFakeSpawn({
      securityDefaults: {
        sandboxPolicy: originalSandboxPolicy,
        approvalPolicy: "on-request",
        responseLocation: "thread",
      },
    });
    const prompt = new AsyncMessageQueue<SdkUserInput>();
    prompt.push(
      userInput("维护工作文档", {
        readableFiles: [],
        writableFiles: [],
        sandboxWritableDirectories: ["C:/repo/.agent-docs", "C:/shared/branch-docs"],
        writableDirectories: ["C:/canvas-output"],
      }),
    );

    const handle = createCodexAppServerQuery({ spawnFn: fake.spawnFn })({
      prompt,
      options: { cwd: "C:/repo" },
    });
    const iterator = handle[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();

    const turnStart = fake.messages.find((message) => message.method === "turn/start");
    expect(turnStart?.params?.sandboxPolicy).toEqual(originalSandboxPolicy);
    expect(turnStart?.params?.approvalPolicy).toBe("on-request");
    expect(fake.effectiveTurnSecurity).toEqual([
      {
        sandboxPolicy: originalSandboxPolicy,
        approvalPolicy: "on-request",
      },
    ]);
    expect(fake.securityUpdates).toEqual([]);
    await handle.terminate?.();
  });

  it("策略响应缺失或只有 mode 时保留用户默认值且不创建不可恢复的 sticky override", async () => {
    const modeOnlySandboxProjection = { type: "workspaceWrite" };
    const fake = makeFakeSpawn({
      securityDefaults: {
        sandboxPolicy: modeOnlySandboxProjection,
        responseLocation: "topLevel",
      },
    });
    const prompt = new AsyncMessageQueue<SdkUserInput>();
    prompt.push(
      userInput("处理可写目标并维护文档", {
        readableFiles: [],
        writableFiles: [],
        sandboxWritableDirectories: ["C:/repo/.agent-docs"],
        writableDirectories: ["C:/canvas-output"],
      }),
    );

    const handle = createCodexAppServerQuery({ spawnFn: fake.spawnFn })({
      prompt,
      options: { cwd: "C:/repo" },
    });
    const iterator = handle[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();

    const turnStart = fake.messages.find((message) => message.method === "turn/start");
    expect(turnStart?.params?.sandboxPolicy).toBeUndefined();
    expect(turnStart?.params?.approvalPolicy).toBeUndefined();
    expect(fake.effectiveTurnSecurity).toEqual([
      {
        sandboxPolicy: modeOnlySandboxProjection,
        approvalPolicy: undefined,
      },
    ]);
    expect(fake.securityUpdates).toEqual([]);
    await handle.terminate?.();

    const hiddenSandboxPolicy = { type: "readOnly", networkAccess: false };
    const missing = makeFakeSpawn({
      securityDefaults: {
        sandboxPolicy: hiddenSandboxPolicy,
        approvalPolicy: "untrusted",
        responseLocation: "missing",
      },
    });
    const missingPrompt = new AsyncMessageQueue<SdkUserInput>();
    missingPrompt.push(
      userInput("维护工作文档", {
        readableFiles: [],
        writableFiles: [],
        sandboxWritableDirectories: ["C:/repo/.agent-docs"],
        writableDirectories: [],
      }),
    );
    const missingHandle = createCodexAppServerQuery({ spawnFn: missing.spawnFn })({
      prompt: missingPrompt,
      options: { cwd: "C:/repo" },
    });
    const missingIterator = missingHandle[Symbol.asyncIterator]();
    await missingIterator.next();
    await missingIterator.next();

    const missingTurnStart = missing.messages.find(
      (message) => message.method === "turn/start",
    );
    expect(missingTurnStart?.params?.sandboxPolicy).toBeUndefined();
    expect(missingTurnStart?.params?.approvalPolicy).toBeUndefined();
    expect(missing.effectiveTurnSecurity).toEqual([
      {
        sandboxPolicy: hiddenSandboxPolicy,
        approvalPolicy: "untrusted",
      },
    ]);
    expect(missing.securityUpdates).toEqual([]);
    await missingHandle.terminate?.();
  });

  it("未完成的临时工作文档 turn 在等待消息前恢复线程基线并可安全终止", async () => {
    const originalSandboxPolicy = {
      type: "workspaceWrite",
      writableRoots: ["C:/existing-root"],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
    const fake = makeFakeSpawn({
      completeTurnStart: false,
      securityDefaults: {
        sandboxPolicy: originalSandboxPolicy,
        approvalPolicy: "untrusted",
      },
    });
    const prompt = new AsyncMessageQueue<SdkUserInput>();
    prompt.push(
      userInput("维护工作文档", {
        readableFiles: [],
        writableFiles: [],
        sandboxWritableDirectories: ["C:/repo/.agent-docs"],
        writableDirectories: [],
      }),
    );

    const handle = createCodexAppServerQuery({ spawnFn: fake.spawnFn })({
      prompt,
      options: { cwd: "C:/repo" },
    });
    const iterator = handle[Symbol.asyncIterator]();
    await iterator.next();
    const pendingTurn = iterator.next();
    void pendingTurn.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fake.securityUpdates).toEqual([
      {
        sandboxPolicy: originalSandboxPolicy,
        approvalPolicy: "untrusted",
      },
    ]);
    expect(
      fake.messages
        .filter(
          (message) =>
            message.method === "turn/start" ||
            message.method === "thread/settings/update",
        )
        .map((message) => message.method),
    ).toEqual([
      "thread/settings/update",
      "turn/start",
      "thread/settings/update",
    ]);
    await handle.terminate?.();
    expect(fake.proc.kill).toHaveBeenCalledOnce();
  });

  it("安全恢复能力探测失败时不发送 turn/start", async () => {
    const originalSandboxPolicy = {
      type: "workspaceWrite",
      writableRoots: [],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
    const fake = makeFakeSpawn({
      rejectSettingsUpdateCalls: [1],
      securityDefaults: {
        sandboxPolicy: originalSandboxPolicy,
        approvalPolicy: "on-request",
      },
    });
    const prompt = new AsyncMessageQueue<SdkUserInput>();
    prompt.push(
      userInput("维护工作文档", {
        readableFiles: [],
        writableFiles: [],
        sandboxWritableDirectories: ["C:/repo/.agent-docs"],
        writableDirectories: [],
      }),
    );

    const handle = createCodexAppServerQuery({ spawnFn: fake.spawnFn })({
      prompt,
      options: { cwd: "C:/repo" },
    });
    const iterator = handle[Symbol.asyncIterator]();
    await iterator.next();
    await expect(iterator.next()).rejects.toThrow("settings update 1 rejected");

    const probe = fake.messages.find(
      (message) => message.method === "thread/settings/update",
    );
    expect(probe?.params).toEqual({ threadId: "thread-1" });
    expect(fake.messages.some((message) => message.method === "turn/start")).toBe(false);
    expect(fake.securityUpdates).toEqual([]);
    await handle.terminate?.();
  });

  it("立即恢复失败时中断活动 turn、重试恢复并终止该轮", async () => {
    const originalSandboxPolicy = {
      type: "workspaceWrite",
      writableRoots: ["C:/existing-root"],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
    const fake = makeFakeSpawn({
      completeTurnStart: false,
      rejectSettingsUpdateCalls: [2],
      securityDefaults: {
        sandboxPolicy: originalSandboxPolicy,
        approvalPolicy: "untrusted",
      },
    });
    const prompt = new AsyncMessageQueue<SdkUserInput>();
    prompt.push(
      userInput("维护工作文档", {
        readableFiles: [],
        writableFiles: [],
        sandboxWritableDirectories: ["C:/repo/.agent-docs"],
        writableDirectories: [],
      }),
    );

    const handle = createCodexAppServerQuery({ spawnFn: fake.spawnFn })({
      prompt,
      options: { cwd: "C:/repo" },
    });
    const iterator = handle[Symbol.asyncIterator]();
    await iterator.next();
    await expect(iterator.next()).rejects.toThrow(
      "the active turn was stopped and defaults were restored on retry",
    );

    expect(
      fake.messages
        .filter((message) =>
          ["thread/settings/update", "turn/start", "turn/interrupt"].includes(
            message.method ?? "",
          ),
        )
        .map((message) => message.method),
    ).toEqual([
      "thread/settings/update",
      "turn/start",
      "thread/settings/update",
      "turn/interrupt",
      "thread/settings/update",
    ]);
    expect(
      fake.messages.find((message) => message.method === "turn/interrupt")?.params,
    ).toEqual({ threadId: "thread-1", turnId: "turn-1" });
    expect(fake.securityUpdates).toEqual([
      {
        sandboxPolicy: originalSandboxPolicy,
        approvalPolicy: "untrusted",
      },
    ]);
    await handle.terminate?.();
  });

  it("turn/start 在应用 sticky 设置后报错也会尝试恢复线程基线", async () => {
    const originalSandboxPolicy = {
      type: "workspaceWrite",
      writableRoots: [],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
    const fake = makeFakeSpawn({
      rejectTurnStart: true,
      securityDefaults: {
        sandboxPolicy: originalSandboxPolicy,
        approvalPolicy: "on-request",
      },
    });
    const prompt = new AsyncMessageQueue<SdkUserInput>();
    prompt.push(
      userInput("维护工作文档", {
        readableFiles: [],
        writableFiles: [],
        sandboxWritableDirectories: ["C:/repo/.agent-docs"],
        writableDirectories: [],
      }),
    );

    const handle = createCodexAppServerQuery({ spawnFn: fake.spawnFn })({
      prompt,
      options: { cwd: "C:/repo" },
    });
    const iterator = handle[Symbol.asyncIterator]();
    await iterator.next();
    await expect(iterator.next()).rejects.toThrow("turn rejected after applying settings");
    expect(fake.securityUpdates).toEqual([
      {
        sandboxPolicy: originalSandboxPolicy,
        approvalPolicy: "on-request",
      },
    ]);
    expect(
      fake.messages
        .filter(
          (message) =>
            message.method === "turn/start" ||
            message.method === "thread/settings/update",
        )
        .map((message) => message.method),
    ).toEqual([
      "thread/settings/update",
      "turn/start",
      "thread/settings/update",
    ]);
    await handle.terminate?.();
  });

  it("steer 在活跃 turn 上调用 Codex 原生 turn/steer", async () => {
    const fake = makeFakeSpawn({ completeTurnStart: false });
    const prompt = new AsyncMessageQueue<SdkUserInput>();
    prompt.push(userInput("长任务"));

    const handle = createCodexAppServerQuery({ spawnFn: fake.spawnFn })({
      prompt,
      options: { model: "gpt-5.5" },
    });
    const iterator = handle[Symbol.asyncIterator]();
    await iterator.next();

    const pendingTurn = iterator.next();
    void pendingTurn.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(handle.canSteerNow?.()).toBe(true);
    await handle.steer?.(userInput("请优先检查失败测试"));

    const steer = fake.messages.find((message) => message.method === "turn/steer");
    expect(steer?.params).toEqual({
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      input: [
        {
          type: "text",
          text: "请优先检查失败测试",
          text_elements: [],
        },
      ],
    });

    fake.completeTurn();
    await pendingTurn;
    expect(handle.canSteerNow?.()).toBe(false);

    await handle.terminate?.();
  });

  it("interrupt 只中断当前 turn，不关闭 app-server，并可继续下一轮", async () => {
    const fake = makeFakeSpawn({ completeTurnStart: false });
    const prompt = new AsyncMessageQueue<SdkUserInput>();
    prompt.push(userInput("长任务"));

    const handle = createCodexAppServerQuery({ spawnFn: fake.spawnFn })({
      prompt,
      options: { model: "gpt-5.5" },
    });
    const iterator = handle[Symbol.asyncIterator]();
    await iterator.next();
    const pendingTurn = iterator.next();
    await new Promise((resolve) => setTimeout(resolve, 0));

    await handle.interrupt?.();
    await pendingTurn;
    expect(fake.requests).toContain("turn/interrupt");
    expect(fake.proc.kill).not.toHaveBeenCalled();

    prompt.push(userInput("继续"));
    const nextTurn = iterator.next();
    void nextTurn.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.messages.filter((message) => message.method === "turn/start")).toHaveLength(2);
    expect(fake.messages.at(-1)?.params?.input).toEqual([
      {
        type: "text",
        text: "继续",
        text_elements: [],
      },
    ]);

    await handle.terminate?.();
  });

  it("setModel updates the model sent with later turn/start requests", async () => {
    const fake = makeFakeSpawn();
    const prompt = new AsyncMessageQueue<SdkUserInput>();
    prompt.push(userInput("first"));

    const handle = createCodexAppServerQuery({ spawnFn: fake.spawnFn })({
      prompt,
      options: { model: "gpt-5.4" },
    });
    const iterator = handle[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();

    await handle.setModel?.("gpt-5.4-mini");
    prompt.push(userInput("second"));
    await iterator.next();

    const turnStarts = fake.messages.filter((message) => message.method === "turn/start");
    expect(turnStarts[0]?.params?.model).toBe("gpt-5.4");
    expect(turnStarts[1]?.params?.model).toBe("gpt-5.4-mini");

    await handle.terminate?.();
  });

  it("setReasoningEffort updates the effort sent with later turn/start requests", async () => {
    const fake = makeFakeSpawn();
    const prompt = new AsyncMessageQueue<SdkUserInput>();
    prompt.push(userInput("first"));

    const handle = createCodexAppServerQuery({ spawnFn: fake.spawnFn })({
      prompt,
      options: { reasoningEffort: "low" },
    });
    const iterator = handle[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();

    await handle.setReasoningEffort?.("high");
    prompt.push(userInput("second"));
    await iterator.next();

    const turnStarts = fake.messages.filter((message) => message.method === "turn/start");
    expect(turnStarts[0]?.params?.effort).toBe("low");
    expect(turnStarts[1]?.params?.effort).toBe("high");

    await handle.terminate?.();
  });

  it("将 Codex requestUserInput 转发给前端处理器并回写 answers", async () => {
    const fake = makeFakeSpawn({ completeTurnStart: false });
    const prompt = new AsyncMessageQueue<SdkUserInput>();
    prompt.push(userInput("需要询问用户"));
    const requestUserInput = vi.fn().mockResolvedValue({
      answers: { flavor: "vanilla" },
    });

    const handle = createCodexAppServerQuery({ spawnFn: fake.spawnFn })({
      prompt,
      options: { requestUserInput },
    });
    const iterator = handle[Symbol.asyncIterator]();
    await iterator.next();
    const pendingTurn = iterator.next();
    void pendingTurn.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));

    fake.proc.stdout.write(
      `${JSON.stringify({
        id: 99,
        method: "item/tool/requestUserInput",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-question",
          questions: [
            {
              id: "flavor",
              header: "口味",
              question: "选择口味？",
              options: [{ label: "vanilla", description: "香草" }],
              isOther: false,
              isSecret: false,
            },
          ],
          autoResolutionMs: 60000,
        },
      })}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(requestUserInput).toHaveBeenCalledWith({
      requestId: "codex:99",
      kind: "ask_user_question",
      title: "Codex 需要确认",
      questions: [
        {
          id: "flavor",
          header: "口味",
          question: "选择口味？",
          options: [{ label: "vanilla", description: "香草" }],
          multiSelect: false,
          isOther: false,
          isSecret: false,
        },
      ],
      autoResolutionMs: 60000,
    });
    expect(fake.responses).toContainEqual({
      id: 99,
      result: {
        answers: {
          flavor: { answers: ["vanilla"] },
        },
      },
    });

    await handle.terminate?.();
  });

  it("将 Codex 命令授权请求转发给前端处理器并回写 accept", async () => {
    const fake = makeFakeSpawn({ completeTurnStart: false });
    const prompt = new AsyncMessageQueue<SdkUserInput>();
    prompt.push(userInput("运行命令"));
    const requestApproval = vi.fn().mockResolvedValue({ action: "approve" });

    const handle = createCodexAppServerQuery({ spawnFn: fake.spawnFn })({
      prompt,
      options: { requestApproval },
    });
    const iterator = handle[Symbol.asyncIterator]();
    await iterator.next();
    const pendingTurn = iterator.next();
    void pendingTurn.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));

    fake.proc.stdout.write(
      `${JSON.stringify({
        id: 101,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "cmd-1",
          startedAtMs: 1,
          command: "npm test",
          cwd: "C:/repo",
          reason: "需要运行测试",
        },
      })}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(requestApproval).toHaveBeenCalledWith({
      requestId: "codex-approval:101",
      kind: "command",
      title: "Codex 请求执行命令",
      message: "需要运行测试",
      command: "npm test",
      cwd: "C:/repo",
      raw: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-1",
        startedAtMs: 1,
        command: "npm test",
        cwd: "C:/repo",
        reason: "需要运行测试",
      },
    });
    expect(fake.responses).toContainEqual({
      id: 101,
      result: { decision: "accept" },
    });

    await handle.terminate?.();
  });
});
