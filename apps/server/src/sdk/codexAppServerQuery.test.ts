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
): SdkUserInput {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    fileAccess,
  };
}

function makeFakeSpawn() {
  const requests: string[] = [];
  const messages: Array<{ id?: number; method?: string; params?: Record<string, unknown> }> = [];
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
    };
    if (!message.method) return;
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
        write({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed" },
          },
        });
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
      userInput("处理这些文件", {
        readableFiles: [
          { name: "notes.md", path: "C:/shared/notes.md", previewKind: "markdown" },
          { name: "shot.png", path: "C:/shared/shot.png", previewKind: "image" },
        ],
        writableFiles: [
          { name: "output.csv", path: "C:/shared/output/output.csv", previewKind: "csv" },
        ],
        writableDirectories: ["C:/shared/output"],
      }),
    );

    const handle = createCodexAppServerQuery({ spawnFn: fake.spawnFn })({
      prompt,
      options: { cwd: "C:/repo" },
    });
    const iterator = handle[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();

    prompt.push(
      userInput("处理下一轮文件", {
        readableFiles: [
          { name: "next.txt", path: "C:/shared/next.txt", previewKind: "text" },
        ],
        writableFiles: [],
        writableDirectories: [],
      }),
    );
    await iterator.next();

    const turnStarts = fake.messages.filter((message) => message.method === "turn/start");
    expect(turnStarts[0]?.params?.input).toEqual([
      {
        type: "text",
        text:
          "处理这些文件\n\n可写的画布文件（作为输出目标）：\n" +
          "- C:/shared/output/output.csv",
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
});
