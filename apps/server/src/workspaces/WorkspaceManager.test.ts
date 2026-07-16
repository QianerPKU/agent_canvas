import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceManager, type GitRunner } from "./WorkspaceManager.js";
import { sharedBranchDirectory } from "./workDocumentation.js";

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
      const excludeLines = exclude.split(/\r?\n/u);
      expect(excludeLines).toContain("/.agent-tmp");
      expect(excludeLines).toContain("/data/raw");
      expect(excludeLines).toContain("/models/weights");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("provisions isolated and shared work documentation without overwriting agent content", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-work-docs-"));
    const source = path.join(root, "source-repo");
    const projectRoot = path.join(root, "project");
    await mkdir(source, { recursive: true });
    let documentationPreflights = 0;
    const runGit: GitRunner = async (args, options) => {
      if (args[0] === "remote") return "https://github.com/acme/work-docs.git";
      if (args[0] === "branch") return "main";
      if (args[0] === "clone") {
        await mkdir(path.join(String(args[2]), ".git", "info"), { recursive: true });
        return "";
      }
      if (args[0] === "worktree" && args[1] === "add") {
        await mkdir(path.join(String(args[4]), ".git", "info"), { recursive: true });
        return "";
      }
      if (args[0] === "rev-parse") {
        return path.join(options?.cwd ?? "", ".git", "info", "exclude");
      }
      if (args[0] === "ls-files") documentationPreflights += 1;
      return "";
    };

    try {
      const manager = new WorkspaceManager({
        defaultSourcePath: source,
        projectRoot,
        runGit,
      });
      const project = await manager.connect({ localPath: source });
      const main = project.branches[0]!;
      const feature = await manager.createBranch({ branch: "feature/documentation" });

      expect(
        manager.accessForAgent(
          { branchWorkspaceId: feature.id },
          { workDocumentationEnabled: false },
        ).readableFiles,
      ).toEqual([]);

      await Promise.all([
        manager.prepareAgentWorkspace(
          "agent_1",
          { branchWorkspaceId: main.id },
          { workDocumentationEnabled: true },
        ),
        manager.prepareAgentWorkspace(
          "agent_2",
          { branchWorkspaceId: feature.id },
          { workDocumentationEnabled: true },
        ),
        manager.prepareWorkDocumentationForAllBranches(),
      ]);

      const mainIndex = path.join(main.worktreePath, ".agent-docs", "index.md");
      const featureIndex = path.join(feature.worktreePath, ".agent-docs", "index.md");
      const mainSharedIndex = path.join(main.worktreePath, ".agent-shared-docs", "index.md");
      const featureSharedIndex = path.join(
        feature.worktreePath,
        ".agent-shared-docs",
        "index.md",
      );
      await expect(readFile(mainIndex, "utf-8")).resolves.toContain("`main`");
      await expect(readFile(featureIndex, "utf-8")).resolves.toContain(
        "`feature/documentation`",
      );
      expect(await realpath(mainSharedIndex)).toBe(await realpath(featureSharedIndex));

      const sharedIndex = await readFile(featureSharedIndex, "utf-8");
      expect(sharedIndex.match(/agent-canvas:branch:/gu)).toHaveLength(2);
      expect(sharedIndex).toContain("feature/documentation");

      await writeFile(featureIndex, "# Agent maintained\n", "utf-8");
      await manager.prepareWorkDocumentationForAllBranches();
      await expect(readFile(featureIndex, "utf-8")).resolves.toBe("# Agent maintained\n");
      expect(documentationPreflights).toBe(2);
      expect(
        (await readFile(featureSharedIndex, "utf-8")).match(/agent-canvas:branch:/gu),
      ).toHaveLength(2);

      const access = manager.accessForAgent(
        { branchWorkspaceId: feature.id },
        { workDocumentationEnabled: true },
      );
      expect(access.readableFiles).toEqual([
        expect.objectContaining({
          name: "branch-work-documentation-index.md",
          path: featureIndex,
          previewKind: "markdown",
        }),
        expect.objectContaining({
          name: "shared-work-documentation-index.md",
          path: featureSharedIndex,
          previewKind: "markdown",
        }),
      ]);
      expect(access.writableFiles).toEqual([]);
      expect(access.writableDirectories).not.toContain(path.dirname(featureIndex));
      expect(access.sandboxWritableDirectories).toContain(path.dirname(featureIndex));
      const branchMountDirectory = path.join(
        feature.worktreePath,
        ".agent-shared-docs",
        "branches",
        sharedBranchDirectory(feature.branch),
      );
      const branchSourceDirectory = await realpath(branchMountDirectory);
      expect(access.sandboxWritableDirectories).toContain(branchMountDirectory);
      expect(access.sandboxWritableDirectories).toContain(branchSourceDirectory);
      expect(access.sandboxWritableDirectories).not.toContain(
        path.join(feature.worktreePath, ".agent-shared-docs"),
      );
      expect(access.sharedResources).toContainEqual(
        expect.objectContaining({
          name: "Agent Canvas 当前 branch 共享概要",
          mountPath: branchMountDirectory,
          sourcePath: branchSourceDirectory,
          access: "readWrite",
        }),
      );

      const exclude = await readFile(
        path.join(feature.worktreePath, ".git", "info", "exclude"),
        "utf-8",
      );
      const excludeLines = exclude.split(/\r?\n/u);
      expect(excludeLines).toContain("/.agent-docs");
      expect(excludeLines).toContain("/.agent-shared-docs");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps queued documentation bound to the project that scheduled it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-doc-project-race-"));
    const source = path.join(root, "source-repo");
    const projectsRoot = path.join(root, "projects");
    await mkdir(source, { recursive: true });
    let blockDocumentation = false;
    let signalBlocked!: () => void;
    let releaseDocumentation!: () => void;
    const blocked = new Promise<void>((resolve) => {
      signalBlocked = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseDocumentation = resolve;
    });
    const runGit: GitRunner = async (args, options) => {
      if (args[0] === "remote") return "https://github.com/acme/project-race.git";
      if (args[0] === "branch") return "main";
      if (args[0] === "clone") {
        await mkdir(path.join(String(args[2]), ".git", "info"), { recursive: true });
        return "";
      }
      if (args[0] === "rev-parse") {
        return path.join(options?.cwd ?? "", ".git", "info", "exclude");
      }
      if (args[0] === "ls-files" && blockDocumentation) {
        blockDocumentation = false;
        signalBlocked();
        await released;
      }
      return "";
    };

    try {
      const manager = new WorkspaceManager({
        defaultSourcePath: source,
        projectsRoot,
        autoOpenDefault: false,
        runGit,
      });
      const projectA = await manager.createCanvasProject({ name: "Project A" });
      const workspaceA = (await manager.connect({ localPath: source })).branches[0]!;
      blockDocumentation = true;
      const preparing = manager.prepareAgentWorkspace(
        "agent_a",
        { branchWorkspaceId: workspaceA.id },
        { workDocumentationEnabled: true },
      );
      await blocked;

      const projectB = await manager.createCanvasProject({ name: "Project B" });
      releaseDocumentation();
      await preparing;

      const sharedTarget = await realpath(
        path.join(workspaceA.worktreePath, ".agent-shared-docs"),
      );
      expect(path.relative(projectA.projectRoot, sharedTarget)).not.toMatch(/^\.\.(?:[\\/]|$)/u);
      await expect(
        lstat(path.join(projectB.projectRoot, "shared", "_agent-canvas")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      releaseDocumentation?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a shared documentation source mapped outside the project", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-doc-boundary-"));
    const source = path.join(root, "source-repo");
    const projectRoot = path.join(root, "project");
    const outside = path.join(root, "outside");
    const remoteUrl = "https://github.com/acme/doc-boundary.git";
    await Promise.all([
      mkdir(source, { recursive: true }),
      mkdir(outside, { recursive: true }),
    ]);
    const runGit: GitRunner = async (args, options) => {
      if (args[0] === "remote") return remoteUrl;
      if (args[0] === "branch") return "main";
      if (args[0] === "clone") {
        await mkdir(path.join(String(args[2]), ".git", "info"), { recursive: true });
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
      });
      await manager.connect({ localPath: source });
      const repositoryKey = createHash("sha256")
        .update(remoteUrl.toLowerCase())
        .digest("hex")
        .slice(0, 16);
      const sharedSource = path.join(
        projectRoot,
        "shared",
        "_agent-canvas",
        repositoryKey,
        "work-documentation",
      );
      await mkdir(path.dirname(sharedSource), { recursive: true });
      await symlink(
        outside,
        sharedSource,
        process.platform === "win32" ? "junction" : "dir",
      );

      await expect(manager.prepareWorkDocumentationForAllBranches()).rejects.toThrow(
        "工作文档目录包含不安全的映射",
      );
      const workspace = (await manager.project()).branches[0]!;
      await expect(
        lstat(path.join(workspace.worktreePath, ".agent-docs")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(path.join(outside, "index.md"))).rejects.toMatchObject({
        code: "ENOENT",
      });

      await rm(sharedSource, { force: true });
      const conflictingMount = path.join(
        workspace.worktreePath,
        ".agent-shared-docs",
      );
      await mkdir(conflictingMount, { recursive: true });
      await expect(manager.prepareWorkDocumentationForAllBranches()).rejects.toThrow(
        "共享资源挂载点已存在且不是映射",
      );
      await expect(
        lstat(path.join(workspace.worktreePath, ".agent-docs")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to reuse a tracked repository directory for managed documentation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-work-docs-collision-"));
    const source = path.join(root, "source-repo");
    const projectRoot = path.join(root, "project");
    await mkdir(source, { recursive: true });
    let trackedDocumentation = false;
    const runGit: GitRunner = async (args, options) => {
      if (args[0] === "remote") return "https://github.com/acme/work-docs-collision.git";
      if (args[0] === "branch") return "main";
      if (args[0] === "clone") {
        await mkdir(path.join(String(args[2]), ".git", "info"), { recursive: true });
        return "";
      }
      if (args[0] === "rev-parse") {
        return path.join(options?.cwd ?? "", ".git", "info", "exclude");
      }
      if (args[0] === "ls-files") {
        return trackedDocumentation ? ".agent-docs/index.md" : "";
      }
      return "";
    };

    try {
      const manager = new WorkspaceManager({
        defaultSourcePath: source,
        projectRoot,
        runGit,
      });
      const project = await manager.connect({ localPath: source });
      const main = project.branches[0]!;
      const indexPath = path.join(main.worktreePath, ".agent-docs", "index.md");
      await mkdir(path.dirname(indexPath), { recursive: true });
      await writeFile(indexPath, "# Repository documentation\n", "utf-8");
      trackedDocumentation = true;

      await expect(manager.prepareWorkDocumentationForAllBranches()).rejects.toThrow(
        ".agent-docs/ 或 .agent-shared-docs/ 已包含 Git 跟踪文件",
      );
      await expect(readFile(indexPath, "utf-8")).resolves.toBe(
        "# Repository documentation\n",
      );
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
      await manager.prepareWorkDocumentationForAllBranches();

      for (const branch of branches) {
        await writeFile(
          path.join(branch.worktreePath, ".agent-docs", "analysis.md"),
          `# ${branch.branch} analysis\n`,
          "utf-8",
        );
        await writeFile(
          path.join(branch.worktreePath, ".agent-shared-docs", `${branch.id}.md`),
          `# ${branch.branch} shared summary\n`,
          "utf-8",
        );
      }

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
        const excludeLines = exclude.split(/\r?\n/u);
        expect(excludeLines).toContain("/shared/dataset");
        expect(excludeLines).toContain("/.agent-docs");
        expect(excludeLines).toContain("/.agent-shared-docs");
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
