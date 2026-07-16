import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
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
      expect(
        JSON.parse(await readFile(path.join(customProjectRoot, "workspace.json"), "utf-8")),
      ).toMatchObject({ project: created });
      expect(await manager.listCanvasProjects()).toEqual([created]);
      await expect(manager.openCanvasProject({ id: created.id })).resolves.toMatchObject({
        projectRoot: customProjectRoot,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("loads and registers a project from an arbitrary folder", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-load-project-"));
    try {
      const customProjectRoot = path.join(root, "elsewhere", "saved-canvas");
      const creator = new WorkspaceManager({
        defaultSourcePath: root,
        projectsRoot: path.join(root, "creator-index"),
        autoOpenDefault: false,
        now: () => 100,
      });
      const created = await creator.createCanvasProject({
        name: "Saved Canvas",
        projectRoot: customProjectRoot,
      });
      const loader = new WorkspaceManager({
        defaultSourcePath: root,
        projectsRoot: path.join(root, "loader-index"),
        autoOpenDefault: false,
        now: () => 200,
      });

      const opened = await loader.openCanvasProject({ projectRoot: customProjectRoot });

      expect(opened.canvasProject).toEqual({ ...created, openedAt: 200 });
      expect(await loader.listCanvasProjects()).toEqual([{ ...created, openedAt: 200 }]);
      expect(
        JSON.parse(await readFile(path.join(root, "loader-index", "index.json"), "utf-8")),
      ).toMatchObject({ projects: [{ id: created.id, projectRoot: customProjectRoot }] });

      const configured = new WorkspaceManager({
        defaultSourcePath: root,
        projectRoot: customProjectRoot,
        projectsRoot: path.join(root, "configured-index"),
        now: () => 300,
      });
      expect(await configured.listCanvasProjects()).toEqual([{ ...created, openedAt: 200 }]);
      await expect(configured.project()).resolves.toMatchObject({
        canvasProject: { id: created.id, name: created.name },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("relocates internal paths when a project is moved or copied", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-relocate-project-"));
    const projectsRoot = path.join(root, "projects");
    const originalRoot = path.join(projectsRoot, "original");
    const movedRoot = path.join(projectsRoot, "moved");
    const copiedRoot = path.join(projectsRoot, "copied");
    try {
      const creator = new WorkspaceManager({
        defaultSourcePath: root,
        projectsRoot,
        autoOpenDefault: false,
        now: () => 250,
      });
      await creator.createCanvasProject({ name: "Relocatable", projectRoot: originalRoot });
      const workspacePath = path.join(originalRoot, "workspace.json");
      const document = JSON.parse(await readFile(workspacePath, "utf-8"));
      document.repo = {
        id: "repo_1",
        remoteUrl: "https://github.com/acme/demo.git",
        defaultBranch: "main",
        localRepoPath: path.join(originalRoot, "repos", "repo_1", "repo"),
        connectedAt: 250,
      };
      document.branches = [
        {
          id: "branch_1",
          repoId: "repo_1",
          branch: "main",
          baseBranch: "main",
          worktreePath: path.join(originalRoot, "repos", "repo_1", "repo"),
          scratchRoot: path.join(originalRoot, "repos", "repo_1", "repo", ".agent-tmp"),
          isDefault: true,
          createdAt: 250,
        },
      ];
      document.sharedResources = [
        {
          id: "shared_1",
          repoId: "repo_1",
          name: "dataset",
          sourcePath: path.join(originalRoot, "shared", "repo_1", "dataset"),
          mountPath: "data/dataset",
          access: "readOnly",
          createdAt: 250,
        },
      ];
      await writeFile(workspacePath, `${JSON.stringify(document, undefined, 2)}\n`, "utf-8");
      await rename(originalRoot, movedRoot);

      const movedLoader = new WorkspaceManager({
        defaultSourcePath: root,
        projectsRoot,
        autoOpenDefault: false,
        now: () => 260,
      });
      const moved = await movedLoader.openCanvasProject({ projectRoot: movedRoot });
      expect(moved.repo?.localRepoPath).toBe(path.join(movedRoot, "repos", "repo_1", "repo"));
      expect(moved.branches[0]?.worktreePath).toBe(
        path.join(movedRoot, "repos", "repo_1", "repo"),
      );
      expect(moved.sharedResources[0]?.sourcePath).toBe(
        path.join(movedRoot, "shared", "repo_1", "dataset"),
      );

      await cp(movedRoot, copiedRoot, { recursive: true });
      const copiedLoader = new WorkspaceManager({
        defaultSourcePath: root,
        projectsRoot,
        autoOpenDefault: false,
        now: () => 270,
      });
      const listed = await copiedLoader.listCanvasProjects();
      expect(listed.map((project) => project.projectRoot).sort()).toEqual(
        [copiedRoot, movedRoot].sort(),
      );
      expect(new Set(listed.map((project) => project.id)).size).toBe(2);
      const copied = await copiedLoader.openCanvasProject({ projectRoot: copiedRoot });
      expect(copied.repo?.localRepoPath).toBe(path.join(copiedRoot, "repos", "repo_1", "repo"));
      expect(copied.branches[0]?.scratchRoot).toBe(
        path.join(copiedRoot, "repos", "repo_1", "repo", ".agent-tmp"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires explicit authorization for external shared resources on import", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-external-resource-"));
    try {
      const projectRoot = path.join(root, "external-project");
      const externalSource = path.join(root, "external-dataset");
      await mkdir(externalSource, { recursive: true });
      const creator = new WorkspaceManager({
        defaultSourcePath: root,
        projectsRoot: path.join(root, "creator-index"),
        autoOpenDefault: false,
        now: () => 280,
      });
      await creator.createCanvasProject({ name: "External", projectRoot });
      const workspacePath = path.join(projectRoot, "workspace.json");
      const document = JSON.parse(await readFile(workspacePath, "utf-8"));
      document.repo = {
        id: "repo_1",
        remoteUrl: "https://github.com/acme/demo.git",
        defaultBranch: "main",
        localRepoPath: path.join(projectRoot, "repos", "repo_1", "repo"),
        connectedAt: 280,
      };
      document.sharedResources = [
        {
          id: "shared_1",
          repoId: "repo_1",
          name: "external dataset",
          sourcePath: externalSource,
          mountPath: "data/external",
          access: "readOnly",
          createdAt: 280,
        },
      ];
      await writeFile(workspacePath, `${JSON.stringify(document, undefined, 2)}\n`, "utf-8");
      const before = await readFile(workspacePath, "utf-8");
      const loader = new WorkspaceManager({
        defaultSourcePath: root,
        projectsRoot: path.join(root, "loader-index"),
        autoOpenDefault: false,
      });

      const inspection = await loader.inspectCanvasProject(projectRoot);
      expect(inspection.externalSharedResources).toEqual([
        expect.objectContaining({ sourcePath: externalSource, access: "readOnly" }),
      ]);
      await expect(loader.openCanvasProject({ projectRoot })).rejects.toThrow(
        "外部共享资源需要重新授权",
      );
      await expect(readFile(workspacePath, "utf-8")).resolves.toBe(before);
      await expect(
        loader.openCanvasProject({
          projectRoot,
          trustedExternalResourcePaths: [externalSource],
        }),
      ).resolves.toMatchObject({
        sharedResources: [expect.objectContaining({ sourcePath: externalSource })],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unversioned and malicious workspace files without rewriting them", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-malicious-project-"));
    try {
      const arbitraryRoot = path.join(root, "arbitrary");
      await mkdir(arbitraryRoot, { recursive: true });
      const arbitraryPath = path.join(arbitraryRoot, "workspace.json");
      const arbitraryContent = '{"branches":[],"sharedResources":[]}\n';
      await writeFile(arbitraryPath, arbitraryContent, "utf-8");
      const loader = new WorkspaceManager({
        defaultSourcePath: root,
        projectsRoot: path.join(root, "index"),
        autoOpenDefault: false,
      });

      await expect(loader.inspectCanvasProject(arbitraryRoot)).rejects.toThrow("schema 必须为");
      await expect(readFile(arbitraryPath, "utf-8")).resolves.toBe(arbitraryContent);

      const maliciousRoot = path.join(root, "malicious");
      const creator = new WorkspaceManager({
        defaultSourcePath: root,
        projectsRoot: path.join(root, "creator-index"),
        autoOpenDefault: false,
        now: () => 290,
      });
      await creator.createCanvasProject({ name: "Malicious", projectRoot: maliciousRoot });
      const maliciousPath = path.join(maliciousRoot, "workspace.json");
      const document = JSON.parse(await readFile(maliciousPath, "utf-8"));
      document.repo = {
        id: "repo_1",
        remoteUrl: "https://github.com/acme/demo.git",
        defaultBranch: "main",
        localRepoPath: path.join(root, "outside-repo"),
        connectedAt: 290,
      };
      const maliciousContent = `${JSON.stringify(document, undefined, 2)}\n`;
      await writeFile(maliciousPath, maliciousContent, "utf-8");

      await expect(loader.inspectCanvasProject(maliciousRoot)).rejects.toThrow(
        "repo.localRepoPath 必须位于项目目录内",
      );
      await expect(readFile(maliciousPath, "utf-8")).resolves.toBe(maliciousContent);

      document.repo.localRepoPath = path.join(maliciousRoot, "repos", "repo_1", "repo");
      document.sharedResources = [
        {
          id: "shared_1",
          repoId: "repo_1",
          name: "escape",
          sourcePath: path.join(root, "outside-resource"),
          mountPath: "../escape",
          access: "readOnly",
          createdAt: 290,
        },
      ];
      await writeFile(maliciousPath, `${JSON.stringify(document, undefined, 2)}\n`, "utf-8");
      await expect(loader.inspectCanvasProject(maliciousRoot)).rejects.toThrow(
        "mountPath 必须是安全相对路径",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("discovers projects under the default root when the index is missing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-discover-project-"));
    const projectsRoot = path.join(root, "projects");
    try {
      const creator = new WorkspaceManager({
        defaultSourcePath: root,
        projectsRoot,
        autoOpenDefault: false,
        now: () => 300,
      });
      const created = await creator.createCanvasProject({ name: "Discoverable" });
      await rm(path.join(projectsRoot, "index.json"));
      const loader = new WorkspaceManager({
        defaultSourcePath: root,
        projectsRoot,
        autoOpenDefault: false,
      });

      expect(await loader.listCanvasProjects()).toEqual([created]);
      await expect(loader.openCanvasProject({ id: created.id })).resolves.toMatchObject({
        projectRoot: created.projectRoot,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("deletes a project directory and removes it from the index", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-delete-project-"));
    try {
      const manager = new WorkspaceManager({
        defaultSourcePath: root,
        projectsRoot: path.join(root, "projects"),
        autoOpenDefault: false,
        now: () => 400,
      });
      const created = await manager.createCanvasProject({ name: "Disposable" });
      await writeFile(path.join(created.projectRoot, "canvas-state.json"), "saved", "utf-8");

      await expect(manager.deleteCanvasProject(created.id)).resolves.toEqual(created);

      await expect(readFile(path.join(created.projectRoot, "workspace.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await manager.listCanvasProjects()).toEqual([]);
      await expect(manager.project()).rejects.toThrow("尚未打开 canvas 项目");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not overwrite a non-empty folder when creating a project", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-project-collision-"));
    const projectRoot = path.join(root, "existing");
    try {
      await mkdir(projectRoot, { recursive: true });
      await writeFile(path.join(projectRoot, "keep.txt"), "keep", "utf-8");
      const manager = new WorkspaceManager({
        defaultSourcePath: root,
        projectsRoot: path.join(root, "projects"),
        autoOpenDefault: false,
      });

      await expect(
        manager.createCanvasProject({ name: "Collision", projectRoot }),
      ).rejects.toThrow("项目文件夹必须为空");
      await expect(readFile(path.join(projectRoot, "keep.txt"), "utf-8")).resolves.toBe("keep");

      const containingRoot = path.join(root, "containing-root");
      const containingManager = new WorkspaceManager({
        defaultSourcePath: root,
        projectsRoot: path.join(containingRoot, "project-index"),
        autoOpenDefault: false,
      });
      await expect(
        containingManager.createCanvasProject({ name: "Unsafe", projectRoot: containingRoot }),
      ).rejects.toThrow("项目文件夹不能包含项目列表根目录");
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
