import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CommitManager } from "./CommitManager.js";

describe("CommitManager", () => {
  it("records commit metadata and per-file diffs from git", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-commit-"));
    try {
      await git(root, ["init"]);
      await git(root, ["config", "user.email", "agent@example.com"]);
      await git(root, ["config", "user.name", "Agent"]);
      await writeFile(path.join(root, "README.md"), "old\n", "utf-8");
      await git(root, ["add", "README.md"]);
      await git(root, ["commit", "-m", "init"]);

      await mkdir(path.join(root, "src"), { recursive: true });
      await writeFile(path.join(root, "README.md"), "new\n", "utf-8");
      await writeFile(path.join(root, "src", "app.ts"), "export const value = 1;\n", "utf-8");
      await git(root, ["add", "README.md", "src/app.ts"]);
      await git(root, ["commit", "-m", "feat: add app"]);

      const manager = new CommitManager({ now: () => 123 });
      const commit = await manager.recordFromAgent(
        "agent_1",
        { cwd: root, branch: "main" },
        2,
        { summary: "reported summary" },
      );

      expect(commit).toMatchObject({
        agentId: "agent_1",
        sourceTurnIndex: 2,
        subject: "feat: add app",
        summary: "reported summary",
        createdAt: 123,
      });
      expect(commit.shortSha).toHaveLength(7);
      expect(commit.files.map((file) => file.path).sort()).toEqual(["README.md", "src/app.ts"]);
      expect(commit.files.find((file) => file.path === "README.md")?.diff).toContain("+new");

      const duplicate = await manager.recordFromAgent("agent_1", { cwd: root }, 3);
      expect(duplicate.id).toBe(commit.id);
      expect(manager.list()).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || error.message).trim()));
        return;
      }
      resolve(stdout.trim());
    });
  });
}
