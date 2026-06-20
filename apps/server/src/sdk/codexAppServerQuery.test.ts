import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import readline from "node:readline";
import { describe, expect, it, vi } from "vitest";
import { AsyncMessageQueue } from "../util/AsyncMessageQueue.js";
import { createCodexAppServerQuery } from "./codexAppServerQuery.js";
import type { SdkUserInput } from "./types.js";

function userInput(text: string): SdkUserInput {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
  };
}

function makeFakeSpawn() {
  const requests: string[] = [];
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
    const message = JSON.parse(line) as { id?: number; method?: string };
    if (!message.method) return;
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
});
