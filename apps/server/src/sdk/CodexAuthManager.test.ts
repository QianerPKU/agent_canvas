import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { CodexAuthManager } from "./CodexAuthManager.js";

function fakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    exitCode: number | null;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.exitCode = null;
  proc.kill = vi.fn(() => {
    proc.exitCode = 0;
    proc.emit("exit", 0, null);
    return true;
  });
  return proc;
}

describe("CodexAuthManager", () => {
  it("maps codex login status output", async () => {
    const proc = fakeProcess();
    const spawnFn = vi.fn(() => proc) as never;
    const manager = new CodexAuthManager({ spawnFn });
    const status = manager.status();

    proc.stdout.write("Logged in with ChatGPT\n");
    proc.emit("exit", 0, null);

    await expect(status).resolves.toMatchObject({
      state: "authenticated",
      message: "Logged in with ChatGPT",
    });
    expect(spawnFn).toHaveBeenCalledWith(
      "codex",
      ["login", "status"],
      expect.objectContaining({ windowsHide: true }),
    );
  });

  it("starts device login and extracts the URL and user code", async () => {
    const proc = fakeProcess();
    const spawnFn = vi.fn(() => proc) as never;
    const manager = new CodexAuthManager({ spawnFn, now: () => 10 });

    const started = manager.startDeviceLogin();
    proc.stdout.write("Open https://auth.openai.com/device and enter code: ABCD-EFGH\n");

    expect(manager.loginSession()).toMatchObject({
      id: started.id,
      state: "running",
      loginUrl: "https://auth.openai.com/device",
      userCode: "ABCD-EFGH",
    });

    proc.emit("exit", 0, null);
    expect(manager.loginSession()).toMatchObject({ state: "completed" });
  });
});
