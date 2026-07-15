import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { readCodexUsage } from "./codexUsage.js";

function fakeCodexProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn(() => true);
  return proc;
}

describe("Codex usage reader", () => {
  it("rejects cleanly when the Codex app-server process fails to spawn", async () => {
    const proc = fakeCodexProcess();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => proc.emit("error", new Error("spawn codex ENOENT")));
      return proc;
    });

    await expect(readCodexUsage({ spawnFn: spawnFn as never })).rejects.toThrow("spawn codex ENOENT");
    expect(proc.kill).toHaveBeenCalled();
  });
});
