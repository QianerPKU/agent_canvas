import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { openFileInVscode } from "./VscodeFileOpener.js";

describe("openFileInVscode", () => {
  it("Windows 通过 VS Code CLI 复用窗口打开指定文件", async () => {
    const child = new EventEmitter() as ChildProcess;
    child.stderr = new PassThrough();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    });

    await openFileInVscode("C:/files/notes.md", {
      command: "C:/VSCode/bin/code.cmd",
      platform: "win32",
      comSpec: "C:/Windows/System32/cmd.exe",
      env: {},
      spawnFn,
    });

    expect(spawnFn).toHaveBeenCalledWith(
      "C:/Windows/System32/cmd.exe",
      [
        "/d",
        "/s",
        "/v:off",
        "/c",
        'call "%AGENT_CANVAS_VSCODE_CLI%" --reuse-window "%AGENT_CANVAS_FILE_TO_OPEN%"',
      ],
      expect.objectContaining({
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
        windowsVerbatimArguments: true,
        env: expect.objectContaining({
          AGENT_CANVAS_VSCODE_CLI: "C:/VSCode/bin/code.cmd",
          AGENT_CANVAS_FILE_TO_OPEN: "C:/files/notes.md",
        }),
      }),
    );
  });

  it("VS Code CLI 失败时返回实际错误", async () => {
    const child = new EventEmitter() as ChildProcess;
    child.stderr = new PassThrough();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => {
        child.stderr?.emit("data", Buffer.from("bad option"));
        child.emit("close", 1, null);
      });
      return child;
    });

    await expect(
      openFileInVscode("C:/files/notes.md", {
        command: "C:/VSCode/bin/code.cmd",
        platform: "win32",
        comSpec: "C:/Windows/System32/cmd.exe",
        env: {},
        spawnFn,
      }),
    ).rejects.toThrow("bad option");
  });
});
