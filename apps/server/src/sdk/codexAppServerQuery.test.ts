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

function makeFakeSpawn(options: { completeTurnStart?: boolean } = {}) {
  const completeTurnStart = options.completeTurnStart ?? true;
  const requests: string[] = [];
  const messages: Array<{ id?: number; method?: string; params?: Record<string, unknown> }> = [];
  const responses: Array<{ id?: number; result?: unknown; error?: unknown }> = [];
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
        write({
          id: message.id,
          result: { thread: { id: "thread-1", cwd: "C:/repo" }, model: "gpt-5.5" },
        });
        break;
      case "turn/start":
        write({ id: message.id, result: { turn: { id: "turn-1" } } });
        if (completeTurnStart) {
          write({
            method: "turn/completed",
            params: {
              threadId: "thread-1",
              turn: { id: "turn-1", status: "completed" },
            },
          });
        }
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
    proc,
  };
}

describe("Codex app-server query", () => {
  it("将 /compact 转为原生 thread/compact/start，并可终止 CLI", async () => {
    const fake = makeFakeSpawn();
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

  it("把每轮文件引用和额外写目录映射到 Codex 原生输入与 sandboxPolicy", async () => {
    const fake = makeFakeSpawn();
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
        expect.stringMatching(/C:[\\/]repo$/),
        expect.stringMatching(/C:[\\/]shared[\\/]output$/),
        expect.stringMatching(/C:[\\/]models[\\/]weights$/),
        expect.stringMatching(/C:[\\/]prompts$/),
      ],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
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
    expect(turnStarts[1]?.params?.sandboxPolicy).toBeUndefined();
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
