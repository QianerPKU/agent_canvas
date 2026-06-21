import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, lstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceManager, type GitRunner } from "./WorkspaceManager.js";

describe("WorkspaceManager", () => {
  it("connects a repo into app data, creates branch workspaces and maps shared resources", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-workspaces-"));
    const source = path.join(root, "source-repo");
    const projectRoot = path.join(root, "project");
    await mkdir(source, { recursive: true });

    const runGit: GitRunner = async (args, options) => {
      if (args[0] === "remote") return "https://github.com/acme/demo.git";
      if (args[0] === "branch") return "main";
      if (args[0] === "clone") {
        await mkdir(path.join(String(args[2]), ".git", "info"), { recursive: true });
        return "";
      }
      if (args[0] === "worktree" && args[1] === "add") {
        const worktreePath = String(args[4]);
        await mkdir(path.join(worktreePath, ".git", "info"), { recursive: true });
        return "";
      }
      if (args[0] === "rev-parse") {
        return path.join(options?.cwd ?? "", ".git", "info", "exclude");
      }
      return "";
    };

    try {
      const manager = new WorkspaceManager({
        defaultSourcePath: source,
        projectRoot,
        runGit,
        now: () => 123,
      });

      const project = await manager.project();
      expect(project.projectRoot).toBe(projectRoot);
      expect(project.repo).toMatchObject({
        remoteUrl: "https://github.com/acme/demo.git",
        owner: "acme",
        repo: "demo",
        defaultBranch: "main",
        localRepoPath: path.join(projectRoot, "repos", "repo_1", "repo"),
      });
      expect(project.branches[0]).toMatchObject({
        branch: "main",
        worktreePath: path.join(projectRoot, "repos", "repo_1", "repo"),
        scratchRoot: path.join(projectRoot, "repos", "repo_1", "repo", ".agent-tmp"),
        isDefault: true,
      });

      const feature = await manager.createBranch({ branch: "feature/data" });
      expect(feature).toMatchObject({
        branch: "feature/data",
        worktreePath: path.join(projectRoot, "worktrees", "repo_1", "feature-data"),
        isDefault: false,
      });

      const dataset = await manager.createSharedResource({
        name: "dataset",
        mountPath: "data/raw",
      });
      expect(dataset).toMatchObject({
        sourcePath: path.join(projectRoot, "shared", "repo_1", "dataset"),
        access: "readOnly",
      });
      const mountStat = await lstat(path.join(feature.worktreePath, "data", "raw"));
      expect(mountStat.isSymbolicLink()).toBe(true);

      let access = manager.accessForAgent({ branchWorkspaceId: feature.id });
      expect(access.readableDirectories).toEqual([dataset.sourcePath]);
      expect(access.writableDirectories).toEqual([]);
      expect(access.sharedResources).toEqual([
        {
          name: "dataset",
          mountPath: path.join(feature.worktreePath, "data/raw"),
          sourcePath: dataset.sourcePath,
          access: "readOnly",
        },
      ]);

      const weights = await manager.createSharedResource({
        name: "weights",
        mountPath: "models/weights",
        access: "readWrite",
      });
      access = manager.accessForAgent({ branchWorkspaceId: feature.id });
      expect(access.writableDirectories).toEqual([weights.sourcePath]);

      const scratch = await manager.prepareAgentWorkspace("agent_1", {
        branchWorkspaceId: feature.id,
      });
      const scratchStat = await lstat(scratch!);
      expect(scratchStat.isDirectory()).toBe(true);

      const exclude = await readFile(
        path.join(feature.worktreePath, ".git", "info", "exclude"),
        "utf-8",
      );
      expect(exclude).toContain(".agent-tmp/");
      expect(exclude).toContain("data/raw/");
      expect(exclude).toContain("models/weights/");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
