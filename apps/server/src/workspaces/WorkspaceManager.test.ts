import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceManager, type GitRunner } from "./WorkspaceManager.js";

describe("WorkspaceManager", () => {
  it("creates and opens explicit canvas projects", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-projects-"));
    try {
      const manager = new WorkspaceManager({
        defaultSourcePath: root,
        projectsRoot: path.join(root, "projects"),
        autoOpenDefault: false,
        now: () => 456,
      });

      await expect(manager.project()).rejects.toThrow("尚未打开 canvas 项目");
      const created = await manager.createCanvasProject({ name: "Demo Canvas" });
      expect(created).toMatchObject({
        name: "Demo Canvas",
        projectRoot: path.join(root, "projects", "Demo-Canvas-co"),
      });
      expect(await manager.listCanvasProjects()).toEqual([created]);
      const opened = await manager.openCanvasProject({ id: created.id });
      expect(opened.canvasProject).toMatchObject({ id: created.id, name: "Demo Canvas" });
      expect(opened.repo).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("creates canvas projects in a custom project folder", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-custom-project-"));
    try {
      const customProjectRoot = path.join(root, "custom", "canvas-a");
      const manager = new WorkspaceManager({
        defaultSourcePath: root,
        projectsRoot: path.join(root, "projects"),
        autoOpenDefault: false,
        now: () => 789,
      });

      const created = await manager.createCanvasProject({
        name: "Custom Canvas",
        projectRoot: customProjectRoot,
      });

      expect(created).toMatchObject({
        name: "Custom Canvas",
        projectRoot: customProjectRoot,
      });
      expect(await readFile(path.join(customProjectRoot, "workspace.json"), "utf-8")).toContain(
        '"branches": []',
      );
      expect(await manager.listCanvasProjects()).toEqual([created]);
      await expect(manager.openCanvasProject({ id: created.id })).resolves.toMatchObject({
        projectRoot: customProjectRoot,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("connects a repo into app data, creates branch workspaces and maps shared resources", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-workspaces-"));
    const source = path.join(root, "source-repo");
    const projectRoot = path.join(root, "project");
    await mkdir(source, { recursive: true });

    const runGit: GitRunner = async (args, options) => {
      if (args[0] === "remote") return "https://github.com/acme/demo.git";
      if (args[0] === "branch") return "main";
      if (args[0] === "ls-remote") {
        return [
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/heads/main",
          "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\trefs/heads/feature/remote",
        ].join("\n");
      }
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

      const disconnected = await manager.project();
      expect(disconnected.repo).toBeUndefined();

      const project = await manager.connect({ localPath: source });
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
      expect(await manager.listBranchOptions()).toEqual([
        expect.objectContaining({ branch: "feature/remote", hasWorkspace: false }),
        expect.objectContaining({ branch: "main", hasWorkspace: true }),
      ]);

      const feature = await manager.createBranch({ branch: "feature/data" });
      expect(feature).toMatchObject({
        branch: "feature/data",
        worktreePath: path.join(projectRoot, "worktrees", "repo_1", "feature-data"),
        isDefault: false,
      });
      expect(await manager.listBranchOptions()).toContainEqual(
        expect.objectContaining({ branch: "feature/data", hasWorkspace: true }),
      );

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

  it("requires PR source branches to include the latest target branch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-pr-ready-"));
    const source = path.join(root, "source-repo");
    const projectRoot = path.join(root, "project");
    await mkdir(source, { recursive: true });
    const calls: string[][] = [];
    let sourceIncludesTarget = true;

    const runGit: GitRunner = async (args, options) => {
      calls.push(args.map(String));
      if (args[0] === "remote") return "https://github.com/acme/demo.git";
      if (args[0] === "branch") return "main";
      if (args[0] === "clone") {
        await mkdir(path.join(String(args[2]), ".git", "info"), { recursive: true });
        return "";
      }
      if (args[0] === "rev-parse") {
        return path.join(options?.cwd ?? "", ".git", "info", "exclude");
      }
      if (args[0] === "fetch") return "";
      if (args[0] === "merge-base") {
        if (sourceIncludesTarget) return "";
        throw new Error("not ancestor");
      }
      return "";
    };

    try {
      const manager = new WorkspaceManager({
        defaultSourcePath: source,
        projectRoot,
        runGit,
      });
      await manager.connect({ localPath: source });

      await expect(
        manager.ensurePullRequestBranchesReady("feature/a", "main"),
      ).resolves.toBeUndefined();
      expect(calls).toContainEqual([
        "fetch",
        "origin",
        "+refs/heads/main:refs/remotes/origin/main",
      ]);
      expect(calls).toContainEqual([
        "merge-base",
        "--is-ancestor",
        "origin/main",
        "feature/a",
      ]);

      sourceIncludesTarget = false;
      await expect(
        manager.ensurePullRequestBranchesReady("feature/a", "main"),
      ).rejects.toThrow("pull, merge, or rebase main into feature/a");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("maps one read-write shared resource into every real git branch worktree", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-real-git-"));
    const source = path.join(root, "source-repo");
    const remote = path.join(root, "remote.git");
    const projectRoot = path.join(root, "project");

    try {
      await mkdir(source, { recursive: true });
      await runGit(["init", "--initial-branch=main"], source);
      await runGit(["config", "user.email", "agent-canvas@example.test"], source);
      await runGit(["config", "user.name", "Agent Canvas Test"], source);
      await writeFile(path.join(source, "README.md"), "# smoke\n", "utf-8");
      await runGit(["add", "README.md"], source);
      await runGit(["commit", "-m", "init"], source);
      await runGit(["init", "--bare", "--initial-branch=main", remote], root);
      await runGit(["remote", "add", "origin", remote], source);
      await runGit(["push", "-u", "origin", "main"], source);

      const manager = new WorkspaceManager({
        defaultSourcePath: source,
        projectRoot,
      });

      const project = await manager.connect({
        remoteUrl: remote,
        localPath: source,
        defaultBranch: "main",
      });
      const main = project.branches[0];
      if (!main) throw new Error("expected default branch workspace");
      const featureA = await manager.createBranch({ branch: "feature/a" });
      await writeFile(
        path.join(featureA.worktreePath, "feature-only.txt"),
        "from feature/a\n",
        "utf-8",
      );
      await runGit(["add", "feature-only.txt"], featureA.worktreePath);
      await runGit(["commit", "-m", "feature-only"], featureA.worktreePath);
      const resource = await manager.createSharedResource({
        name: "dataset",
        mountPath: "shared/dataset",
        access: "readWrite",
      });
      const featureB = await manager.createBranch({
        branch: "feature/b",
        baseBranch: "feature/a",
      });
      expect(featureB.baseBranch).toBe("feature/a");
      await expect(
        readFile(path.join(featureB.worktreePath, "feature-only.txt"), "utf-8"),
      ).resolves.toContain("from feature/a");
      const branches = [main, featureA, featureB];

      for (const branch of branches) {
        const mountPath = path.join(branch.worktreePath, "shared", "dataset");
        const mountStat = await lstat(mountPath);
        expect(mountStat.isDirectory() || mountStat.isSymbolicLink()).toBe(true);
        expect(await realpath(mountPath)).toBe(await realpath(resource.sourcePath));
      }

      await writeFile(
        path.join(main.worktreePath, "shared", "dataset", "from-main.txt"),
        "main branch\n",
        "utf-8",
      );
      await writeFile(
        path.join(featureA.worktreePath, "shared", "dataset", "from-feature-a.txt"),
        "feature a\n",
        "utf-8",
      );
      await writeFile(
        path.join(featureB.worktreePath, "shared", "dataset", "from-feature-b.txt"),
        "feature b\n",
        "utf-8",
      );

      for (const branch of branches) {
        const mountPath = path.join(branch.worktreePath, "shared", "dataset");
        await expect(readFile(path.join(mountPath, "from-main.txt"), "utf-8")).resolves.toBe(
          "main branch\n",
        );
        await expect(
          readFile(path.join(mountPath, "from-feature-a.txt"), "utf-8"),
        ).resolves.toBe("feature a\n");
        await expect(
          readFile(path.join(mountPath, "from-feature-b.txt"), "utf-8"),
        ).resolves.toBe("feature b\n");
      }

      const access = branches.map((branch) =>
        manager.accessForAgent({ branchWorkspaceId: branch.id }),
      );
      expect(
        access.every((item) => (item.readableDirectories ?? []).includes(resource.sourcePath)),
      ).toBe(
        true,
      );
      expect(
        access.every((item) => (item.writableDirectories ?? []).includes(resource.sourcePath)),
      ).toBe(
        true,
      );
      expect(access.map((item) => item.sharedResources?.[0]?.mountPath)).toEqual(
        branches.map((branch) => path.join(branch.worktreePath, "shared/dataset")),
      );

      for (const branch of branches) {
        const status = await runGit(["status", "--short"], branch.worktreePath);
        expect(status).toBe("");
        const excludePath = await gitPath(branch.worktreePath, "info/exclude");
        const exclude = await readFile(
          excludePath,
          "utf-8",
        );
        expect(exclude).toContain("shared/dataset/");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

async function runGit(args: string[], cwd: string): Promise<string> {
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

async function gitPath(cwd: string, key: string): Promise<string> {
  const value = await runGit(["rev-parse", "--git-path", key], cwd);
  return path.isAbsolute(value) ? value : path.resolve(cwd, value);
}
