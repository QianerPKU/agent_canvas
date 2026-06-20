import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { openFileInVscode } from "./VscodeFileOpener.js";

describe("openFileInVscode", () => {
  it("用 VS Code 复用窗口打开指定文件并与子进程脱离", async () => {
    const child = new EventEmitter() as ChildProcess;
    child.unref = vi.fn();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });

    await openFileInVscode("C:/files/notes.md", {
      command: "C:/VSCode/Code.exe",
      spawnFn,
    });

    expect(spawnFn).toHaveBeenCalledWith(
      "C:/VSCode/Code.exe",
      ["--reuse-window", "C:/files/notes.md"],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      },
    );
    expect(child.unref).toHaveBeenCalledOnce();
  });
});
