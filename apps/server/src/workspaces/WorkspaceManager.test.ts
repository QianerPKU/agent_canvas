import { describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import {
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const workspaceFileSystemHooks = vi.hoisted(() => ({
  afterSymlink: undefined as
    | undefined
    | ((sourcePath: string, mountPath: string) => Promise<void>),
  afterRename: undefined as
    | undefined
    | ((sourcePath: string, destinationPath: string) => Promise<void>),
  afterLink: undefined as
    | undefined
    | ((sourcePath: string, destinationPath: string) => Promise<void>),
  afterReaddir: undefined as undefined | ((directoryPath: string) => Promise<void>),
  afterMkdir: undefined as undefined | ((directoryPath: string) => Promise<void>),
  beforeRm: undefined as
    | undefined
    | ((targetPath: string, options: unknown) => Promise<void>),
  failReadlinkPath: undefined as string | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    symlink: async (...args: Parameters<typeof actual.symlink>) => {
      await actual.symlink(...args);
      const hook = workspaceFileSystemHooks.afterSymlink;
      if (hook) await hook(String(args[0]), String(args[1]));
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      await actual.rename(...args);
      const hook = workspaceFileSystemHooks.afterRename;
      if (hook) await hook(String(args[0]), String(args[1]));
    },
    link: async (...args: Parameters<typeof actual.link>) => {
      await actual.link(...args);
      const hook = workspaceFileSystemHooks.afterLink;
      if (hook) await hook(String(args[0]), String(args[1]));
    },
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      const result = await actual.readdir(...args as Parameters<typeof actual.readdir>);
      const hook = workspaceFileSystemHooks.afterReaddir;
      if (hook) await hook(String(args[0]));
      return result;
    },
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      const result = await actual.mkdir(...args);
      await workspaceFileSystemHooks.afterMkdir?.(String(args[0]));
      return result;
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      await workspaceFileSystemHooks.beforeRm?.(String(args[0]), args[1]);
      return await actual.rm(...args);
    },
    readlink: async (...args: Parameters<typeof actual.readlink>) => {
      if (
        workspaceFileSystemHooks.failReadlinkPath &&
        sameMockPath(String(args[0]), workspaceFileSystemHooks.failReadlinkPath)
      ) {
        workspaceFileSystemHooks.failReadlinkPath = undefined;
        throw new Error("injected readlink failure");
      }
      return await actual.readlink(...args);
    },
  };
});

function sameMockPath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function setAfterManagedMountPublished(
  hook: (sourcePath: string, mountPath: string) => Promise<void>,
): void {
  workspaceFileSystemHooks.afterRename = hook;
  workspaceFileSystemHooks.afterLink = hook;
}

function clearAfterManagedMountPublished(): void {
  workspaceFileSystemHooks.afterRename = undefined;
  workspaceFileSystemHooks.afterLink = undefined;
}

import {
  WorkspaceManager as BaseWorkspaceManager,
  type GitRunner,
  type WorkspaceManagerOptions,
} from "./WorkspaceManager.js";
import { sharedBranchDirectory, sharedDocumentationIndex } from "./workDocumentation.js";

class WorkspaceManager extends BaseWorkspaceManager {
  constructor(options: WorkspaceManagerOptions) {
    super({
      ...options,
      projectsRoot: options.projectsRoot ?? path.join(
        options.projectRoot ? path.dirname(options.projectRoot) : options.defaultSourcePath,
        ".agent-canvas-test-projects",
      ),
    });
  }
}

const CASE_DISTINCT_TEST_FILESYSTEM = testFilesystemPreservesCaseDistinctDirectories();
const FILE_SYMLINK_TEST_SUPPORTED = testFilesystemSupportsFileSymlinks();

describe("WorkspaceManager", () => {
  it("rejects an external projects-root junction before creating its index", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-project-list-root-link-"));
    const outside = path.join(root, "outside");
    const projectsRoot = path.join(root, "projects");
    const sentinel = path.join(outside, "sentinel.txt");
    try {
      await mkdir(outside);
      await writeFile(sentinel, "outside sentinel\n", "utf-8");
      await symlink(
        outside,
        projectsRoot,
        process.platform === "win32" ? "junction" : "dir",
      );
      const manager = new WorkspaceManager({
        defaultSourcePath: root,
        projectsRoot,
        autoOpenDefault: false,
      });

      await expect(manager.listCanvasProjects()).rejects.toThrow(/Canvas projects root.*unsafe mapping/u);
      expect(await readFile(sentinel, "utf-8")).toBe("outside sentinel\n");
      await expect(lstat(path.join(outside, "index.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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

  it("removes a newly created project root when the project index changes before commit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-create-project-cas-"));
    const projectsRoot = path.join(root, "projects");
    const rejectedRoot = path.join(root, "rejected-project");
    try {
      const manager = new WorkspaceManager({
        defaultSourcePath: root,
        projectsRoot,
        autoOpenDefault: false,
      });
      const first = await manager.createCanvasProject({ name: "First project" });
      const indexPath = path.join(projectsRoot, "index.json");
      workspaceFileSystemHooks.afterLink = async (_sourcePath, destinationPath) => {
        if (!sameMockPath(destinationPath, path.join(rejectedRoot, "workspace.json"))) return;
        workspaceFileSystemHooks.afterLink = undefined;
        const currentIndex = await readFile(indexPath, "utf-8");
        await writeFile(indexPath, `${currentIndex} `, "utf-8");
      };

      await expect(
        manager.createCanvasProject({
          name: "Rejected project",
          projectRoot: rejectedRoot,
        }),
      ).rejects.toThrow(/content changed/u);

      expect(manager.currentProjectId()).toBe(first.id);
      await expect(lstat(rejectedRoot)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(manager.listCanvasProjects()).resolves.toEqual([first]);
    } finally {
      workspaceFileSystemHooks.afterLink = undefined;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows the selected project root itself to be a trusted directory junction", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-project-root-link-"));
    const actualProjectRoot = path.join(root, "actual-project");
    const linkedProjectRoot = path.join(root, "linked-project");
    try {
      const creator = new WorkspaceManager({
        defaultSourcePath: root,
        projectsRoot: path.join(root, "creator-index"),
        autoOpenDefault: false,
      });
      await creator.createCanvasProject({
        name: "Linked project",
        projectRoot: actualProjectRoot,
      });
      await symlink(
        actualProjectRoot,
        linkedProjectRoot,
        process.platform === "win32" ? "junction" : "dir",
      );

      const loader = new WorkspaceManager({
        defaultSourcePath: root,
        projectsRoot: path.join(root, "loader-index"),
        autoOpenDefault: false,
      });
      const opened = await loader.openCanvasProject({ projectRoot: linkedProjectRoot });

      expect(opened.projectRoot).toBe(path.resolve(linkedProjectRoot));
      await expect(realpath(opened.projectRoot)).resolves.toBe(await realpath(actualProjectRoot));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a live project-root junction swap before workspace metadata access", async (context) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-project-root-swap-"));
    const projectRoot = path.join(root, "project");
    const displacedRoot = path.join(root, "project-original");
    const outside = path.join(root, "outside-project-root");
    const outsideWorkspace = path.join(outside, "workspace.json");
    let linked = false;
    try {
      const manager = new WorkspaceManager({
        defaultSourcePath: root,
        projectsRoot: path.join(root, "projects"),
        autoOpenDefault: false,
      });
      await manager.createCanvasProject({ name: "Root swap", projectRoot });
      await mkdir(outside);
      await writeFile(outsideWorkspace, "outside sentinel", "utf-8");
      await rename(projectRoot, displacedRoot);
      try {
        await symlink(
          outside,
          projectRoot,
          process.platform === "win32" ? "junction" : "dir",
        );
        linked = true;
      } catch (error) {
        await rename(displacedRoot, projectRoot);
        if (["EPERM", "EACCES", "UNKNOWN"].includes((error as NodeJS.ErrnoException).code ?? "")) {
          context.skip();
          return;
        }
        throw error;
      }

      await expect(manager.project()).rejects.toThrow(/project root identity changed/u);
      await expect(manager.connect({ localPath: root })).rejects.toThrow(
        /project root identity changed/u,
      );
      await expect(readFile(outsideWorkspace, "utf-8")).resolves.toBe("outside sentinel");
    } finally {
      if (linked) {
        await rm(projectRoot, { force: true });
        await rename(displacedRoot, projectRoot);
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("restores an empty selection when project persistence fails after selection", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-create-rollback-"));
    try {
      const blockedProjectsRoot = path.join(root, "projects-root-is-a-file");
      const projectRoot = path.join(root, "new-project");
      await writeFile(blockedProjectsRoot, "not a directory", "utf-8");
      const manager = new WorkspaceManager({
        defaultSourcePath: root,
        projectsRoot: blockedProjectsRoot,
        autoOpenDefault: false,
      });

      await expect(
        manager.createCanvasProject({ name: "Must Roll Back", projectRoot }),
      ).rejects.toBeTruthy();
      expect(manager.currentProjectId()).toBeUndefined();
      await expect(manager.project()).rejects.toThrow("尚未打开 canvas 项目");
      await expect(readFile(path.join(projectRoot, "workspace.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes every owned directory when project directory creation fails mid-chain", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-create-chain-rollback-"));
    const customParent = path.join(root, "nested", "owned");
    const projectRoot = path.join(customParent, "project");
    try {
      const manager = new WorkspaceManager({
        defaultSourcePath: root,
        projectsRoot: path.join(root, "projects"),
        autoOpenDefault: false,
      });
      workspaceFileSystemHooks.afterMkdir = async (directoryPath) => {
        if (!sameMockPath(directoryPath, customParent)) return;
        workspaceFileSystemHooks.afterMkdir = undefined;
        throw new Error("injected directory creation failure");
      };

      await expect(
        manager.createCanvasProject({ name: "Directory rollback", projectRoot }),
      ).rejects.toThrow("injected directory creation failure");

      expect(manager.currentProjectId()).toBeUndefined();
      await expect(lstat(path.join(root, "nested"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      workspaceFileSystemHooks.afterMkdir = undefined;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("restores the prior in-memory project when opening persistence fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-open-state-rollback-"));
    const projectsRoot = path.join(root, "projects");
    try {
      const manager = new WorkspaceManager({
        defaultSourcePath: root,
        projectsRoot,
        autoOpenDefault: false,
      });
      const first = await manager.createCanvasProject({
        name: "First",
        projectRoot: path.join(root, "first"),
      });
      const second = await manager.createCanvasProject({
        name: "Second",
        projectRoot: path.join(root, "second"),
      });
      await manager.openCanvasProject({ id: first.id });
      const secondWorkspacePath = path.join(second.projectRoot, "workspace.json");
      const secondWorkspaceBefore = await readFile(secondWorkspacePath, "utf-8");
      const indexPath = path.join(projectsRoot, "index.json");
      workspaceFileSystemHooks.afterRename = async (_sourcePath, destinationPath) => {
        if (!sameMockPath(destinationPath, secondWorkspacePath)) return;
        workspaceFileSystemHooks.afterRename = undefined;
        await writeFile(indexPath, `${await readFile(indexPath, "utf-8")} `, "utf-8");
      };

      await expect(manager.openCanvasProject({ id: second.id })).rejects.toThrow(
        /content changed/u,
      );

      expect(manager.currentProjectId()).toBe(first.id);
      await expect(manager.project()).resolves.toMatchObject({
        canvasProject: { id: first.id },
      });
      await expect(readFile(secondWorkspacePath, "utf-8")).resolves.toBe(
        secondWorkspaceBefore,
      );
    } finally {
      workspaceFileSystemHooks.afterRename = undefined;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a hard-linked workspace.json without modifying its outside sentinel", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-workspace-hardlink-"));
    const source = path.join(root, "source-repo");
    const projectRoot = path.join(root, "project");
    const projectsRoot = path.join(root, "projects");
    const outsideSentinel = path.join(root, "outside-workspace.json");
    await mkdir(source, { recursive: true });

    try {
      const manager = new WorkspaceManager({
        defaultSourcePath: source,
        projectRoot,
        projectsRoot,
        runGit: createFakeWorkspaceGit("https://github.com/acme/workspace-hardlink.git"),
      });
      await manager.connect({ localPath: source });
      const beforeProject = await manager.project();
      const workspacePath = path.join(projectRoot, "workspace.json");
      const sentinelContent = await readFile(workspacePath, "utf-8");
      await writeFile(outsideSentinel, sentinelContent, "utf-8");
      await rm(workspacePath);
      await link(outsideSentinel, workspacePath);

      await expect(
        manager.createSharedResource({
          name: "metadata probe",
          mountPath: "metadata/probe",
        }),
      ).rejects.toThrow();

      await expect(readFile(outsideSentinel, "utf-8")).resolves.toBe(sentinelContent);
      expect((await lstat(outsideSentinel)).nlink).toBe(2);
      expect((await lstat(workspacePath)).nlink).toBe(2);
      await expect(manager.project()).resolves.toEqual(beforeProject);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an unsafe indexed workspace while listing projects without rewriting metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-project-list-hardlink-"));
    const projectsRoot = path.join(root, "projects");
    const projectRoot = path.join(root, "listed-project");
    const outsideSentinel = path.join(root, "outside-workspace.json");
    try {
      const manager = new WorkspaceManager({
        defaultSourcePath: root,
        projectsRoot,
        autoOpenDefault: false,
      });
      await manager.createCanvasProject({ name: "Listed project", projectRoot });
      const indexPath = path.join(projectsRoot, "index.json");
      const indexBefore = await readFile(indexPath, "utf-8");
      const workspacePath = path.join(projectRoot, "workspace.json");
      const workspaceBefore = await readFile(workspacePath, "utf-8");
      await writeFile(outsideSentinel, workspaceBefore, "utf-8");
      await rm(workspacePath);
      await link(outsideSentinel, workspacePath);

      await expect(manager.listCanvasProjects()).rejects.toThrow(
        "no-follow single-link regular file",
      );

      await expect(readFile(indexPath, "utf-8")).resolves.toBe(indexBefore);
      await expect(readFile(outsideSentinel, "utf-8")).resolves.toBe(workspaceBefore);
      expect((await lstat(outsideSentinel)).nlink).toBe(2);
      expect((await lstat(workspacePath)).nlink).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not overwrite a concurrent project-index update while listing projects", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-project-list-race-"));
    const projectsRoot = path.join(root, "projects");
    const projectRoot = path.join(root, "listed-project");
    try {
      const manager = new WorkspaceManager({
        defaultSourcePath: root,
        projectsRoot,
        autoOpenDefault: false,
      });
      const created = await manager.createCanvasProject({
        name: "Listed project",
        projectRoot,
      });
      const indexPath = path.join(projectsRoot, "index.json");
      const concurrentContent = `${JSON.stringify({
        projects: [
          created,
          {
            id: "concurrent-project",
            name: "Concurrent project",
            projectRoot: path.join(root, "concurrent-project"),
            createdAt: 999,
          },
        ],
      }, null, 2)}\n`;
      workspaceFileSystemHooks.afterReaddir = async (directoryPath) => {
        if (!sameTestPath(directoryPath, projectsRoot)) return;
        workspaceFileSystemHooks.afterReaddir = undefined;
        await writeFile(indexPath, concurrentContent, "utf-8");
      };

      await expect(manager.listCanvasProjects()).rejects.toThrow(
        "Canvas project index content changed before persistence",
      );
      await expect(readFile(indexPath, "utf-8")).resolves.toBe(concurrentContent);
    } finally {
      workspaceFileSystemHooks.afterReaddir = undefined;
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(!FILE_SYMLINK_TEST_SUPPORTED)(
    "rejects a dangling workspace.json symlink during an uncached load",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-workspace-dangling-"));
      const projectRoot = path.join(root, "project");
      const workspacePath = path.join(projectRoot, "workspace.json");
      try {
        await mkdir(projectRoot, { recursive: true });
        await symlink(path.join(root, "missing-workspace.json"), workspacePath, "file");
        const manager = new WorkspaceManager({
          defaultSourcePath: root,
          projectRoot,
          projectsRoot: path.join(root, "projects"),
        });

        await expect(manager.project()).rejects.toThrow(
          "no-follow single-link regular file",
        );
        expect((await lstat(workspacePath)).isSymbolicLink()).toBe(true);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("rejects a hard-linked project index without modifying its outside sentinel", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-project-index-hardlink-"));
    const projectsRoot = path.join(root, "projects");
    const firstProjectRoot = path.join(root, "project-a");
    const rejectedProjectRoot = path.join(root, "project-b");
    const outsideSentinel = path.join(root, "outside-index.json");

    try {
      const manager = new WorkspaceManager({
        defaultSourcePath: root,
        projectsRoot,
        autoOpenDefault: false,
      });
      const firstProject = await manager.createCanvasProject({
        name: "Project A",
        projectRoot: firstProjectRoot,
      });
      const indexPath = path.join(projectsRoot, "index.json");
      const sentinelContent = await readFile(indexPath, "utf-8");
      await writeFile(outsideSentinel, sentinelContent, "utf-8");
      await rm(indexPath);
      await link(outsideSentinel, indexPath);

      await expect(
        manager.createCanvasProject({
          name: "Project B",
          projectRoot: rejectedProjectRoot,
        }),
      ).rejects.toThrow();

      expect(manager.currentProjectId()).toBe(firstProject.id);
      await expect(readFile(outsideSentinel, "utf-8")).resolves.toBe(sentinelContent);
      expect((await lstat(outsideSentinel)).nlink).toBe(2);
      expect((await lstat(indexPath)).nlink).toBe(2);
      await expect(
        lstat(path.join(rejectedProjectRoot, "workspace.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects project deletion before touching disk when the index is unsafe", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-delete-index-hardlink-"));
    const projectsRoot = path.join(root, "projects");
    const projectRoot = path.join(root, "delete-target");
    const outsideSentinel = path.join(root, "outside-index.json");
    try {
      const manager = new WorkspaceManager({
        defaultSourcePath: root,
        projectsRoot,
        autoOpenDefault: false,
      });
      const project = await manager.createCanvasProject({
        name: "Delete target",
        projectRoot,
      });
      const workspacePath = path.join(projectRoot, "workspace.json");
      const workspaceBefore = await readFile(workspacePath, "utf-8");
      const indexPath = path.join(projectsRoot, "index.json");
      const indexBefore = await readFile(indexPath, "utf-8");
      await writeFile(outsideSentinel, indexBefore, "utf-8");
      await rm(indexPath);
      await link(outsideSentinel, indexPath);

      await expect(manager.deleteCanvasProject(project.id)).rejects.toThrow(
        "Canvas project index must be a no-follow single-link regular file",
      );

      await expect(readFile(workspacePath, "utf-8")).resolves.toBe(workspaceBefore);
      await expect(readFile(outsideSentinel, "utf-8")).resolves.toBe(indexBefore);
      expect((await lstat(indexPath)).nlink).toBe(2);
      expect((await lstat(outsideSentinel)).nlink).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preflights an unsafe project index before creating a branch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-branch-index-hardlink-"));
    const source = path.join(root, "source");
    const projectRoot = path.join(root, "project");
    const projectsRoot = path.join(root, "projects");
    const outsideSentinel = path.join(root, "outside-index.json");
    const baseGit = createFakeWorkspaceGit("https://github.com/acme/index-preflight.git");
    let worktreeAdds = 0;
    const runGit: GitRunner = async (args, options) => {
      if (args[0] === "worktree" && args[1] === "add") worktreeAdds += 1;
      return await baseGit(args, options);
    };
    await mkdir(source, { recursive: true });

    try {
      const manager = new WorkspaceManager({
        defaultSourcePath: source,
        projectRoot,
        projectsRoot,
        runGit,
      });
      await manager.connect({ localPath: source });
      worktreeAdds = 0;
      const beforeProject = await manager.project();
      const workspacePath = path.join(projectRoot, "workspace.json");
      const beforeWorkspace = await readFile(workspacePath, "utf-8");
      const indexPath = path.join(projectsRoot, "index.json");
      const beforeIndex = await readFile(indexPath, "utf-8");
      await writeFile(outsideSentinel, beforeIndex, "utf-8");
      await rm(indexPath);
      await link(outsideSentinel, indexPath);

      await expect(manager.createBranch({ branch: "feature/index-preflight" })).rejects.toThrow();

      expect(worktreeAdds).toBe(0);
      await expect(manager.project()).resolves.toEqual(beforeProject);
      await expect(readFile(workspacePath, "utf-8")).resolves.toBe(beforeWorkspace);
      await expect(readFile(outsideSentinel, "utf-8")).resolves.toBe(beforeIndex);
      expect((await lstat(outsideSentinel)).nlink).toBe(2);
      expect((await lstat(indexPath)).nlink).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("aborts branch creation when the local ref query fails operationally", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-branch-ref-query-"));
    const source = path.join(root, "source");
    const projectRoot = path.join(root, "project");
    const baseGit = createFakeWorkspaceGit("https://github.com/acme/ref-query.git");
    let failRefQuery = false;
    let worktreeAdds = 0;
    let refUpdates = 0;
    const runGit: GitRunner = async (args, options) => {
      if (args[0] === "for-each-ref" && failRefQuery) {
        throw new Error("injected ref query permission failure");
      }
      if (args[0] === "worktree" && args[1] === "add") worktreeAdds += 1;
      if (args[0] === "update-ref") refUpdates += 1;
      return await baseGit(args, options);
    };
    await mkdir(source, { recursive: true });

    try {
      const manager = new WorkspaceManager({
        defaultSourcePath: source,
        projectRoot,
        projectsRoot: path.join(root, "projects"),
        runGit,
      });
      await manager.connect({ localPath: source });
      const beforeProject = await manager.project();
      const beforeWorkspace = await readFile(
        path.join(projectRoot, "workspace.json"),
        "utf-8",
      );
      failRefQuery = true;

      await expect(
        manager.createBranch({ branch: "feature/ref-query-failure" }),
      ).rejects.toThrow("injected ref query permission failure");

      expect(worktreeAdds).toBe(0);
      expect(refUpdates).toBe(0);
      await expect(manager.project()).resolves.toEqual(beforeProject);
      await expect(readFile(path.join(projectRoot, "workspace.json"), "utf-8")).resolves.toBe(
        beforeWorkspace,
      );
      await expect(lstat(path.join(projectRoot, "worktrees"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rolls workspace metadata back when the project index changes during persistence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-index-commit-race-"));
    const source = path.join(root, "source");
    const projectRoot = path.join(root, "project");
    const projectsRoot = path.join(root, "projects");
    const outsideIndex = path.join(root, "outside-index.json");
    await mkdir(source, { recursive: true });
    try {
      const manager = new WorkspaceManager({
        defaultSourcePath: source,
        projectRoot,
        projectsRoot,
        runGit: createFakeWorkspaceGit("https://github.com/acme/index-commit-race.git"),
      });
      await manager.connect({ localPath: source });
      const projectBefore = await manager.project();
      const workspacePath = path.join(projectRoot, "workspace.json");
      const workspaceBefore = await readFile(workspacePath, "utf-8");
      const indexPath = path.join(projectsRoot, "index.json");
      const indexBefore = await readFile(indexPath, "utf-8");
      await writeFile(outsideIndex, indexBefore, "utf-8");
      workspaceFileSystemHooks.afterRename = async (_sourcePath, destinationPath) => {
        if (!sameTestPath(destinationPath, workspacePath)) return;
        workspaceFileSystemHooks.afterRename = undefined;
        await rm(indexPath);
        await link(outsideIndex, indexPath);
      };

      await expect(
        manager.createBranch({ branch: "feature/index-commit-race" }),
      ).rejects.toThrow("Canvas project index must be a no-follow single-link regular file");

      await expect(manager.project()).resolves.toEqual(projectBefore);
      await expect(readFile(workspacePath, "utf-8")).resolves.toBe(workspaceBefore);
      await expect(readFile(outsideIndex, "utf-8")).resolves.toBe(indexBefore);
      expect((await lstat(indexPath)).nlink).toBe(2);
      expect((await lstat(outsideIndex)).nlink).toBe(2);
    } finally {
      workspaceFileSystemHooks.afterRename = undefined;
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
        const worktreePath = worktreeAddPath(args);
        await mkdir(path.join(worktreePath, ".git", "info"), { recursive: true });
        return "";
      }
      if (args[0] === "worktree" && args[1] === "move") {
        await rename(String(args[2]), String(args[3]));
        return "";
      }
      if (args[0] === "rev-parse") {
        if (args[1] === "--verify") return "a".repeat(40);
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

      access = manager.accessForAgent({
        branchWorkspaceId: feature.id,
        allowSharedResourceWrites: true,
      });
      expect(access.writableDirectories).toEqual([weights.sourcePath]);
      expect(access.sandboxWritableDirectories).toEqual([dataset.sourcePath]);
      expect(access.sharedResources).toEqual([
        {
          name: "dataset",
          mountPath: path.join(feature.worktreePath, "data/raw"),
          sourcePath: dataset.sourcePath,
          access: "readWrite",
        },
        {
          name: "weights",
          mountPath: path.join(feature.worktreePath, "models/weights"),
          sourcePath: weights.sourcePath,
          access: "readWrite",
        },
      ]);

      await manager.createSharedResource({
        name: "project-shared-root",
        mountPath: "shared-root",
        sourcePath: path.join(projectRoot, "shared"),
      });
      expect(() =>
        manager.accessForAgent({
          branchWorkspaceId: feature.id,
          allowSharedResourceWrites: true,
        }),
      ).toThrow("too broad for Agent-level write access");

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

  it("removes a staged clone when git reports failure after creating it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-connect-clone-failure-"));
    const source = path.join(root, "source");
    const projectRoot = path.join(root, "project");
    await mkdir(source);
    const baseGit = createFakeWorkspaceGit("https://github.com/acme/clone-failure.git");
    const runGit: GitRunner = async (args, options) => {
      const result = await baseGit(args, options);
      if (args[0] === "clone") throw new Error("injected post-clone failure");
      return result;
    };
    try {
      const manager = new WorkspaceManager({
        defaultSourcePath: source,
        projectRoot,
        projectsRoot: path.join(root, "projects"),
        runGit,
      });

      await expect(manager.connect({ localPath: source })).rejects.toThrow(
        "injected post-clone failure",
      );

      await expect(manager.project()).resolves.toMatchObject({
        repo: undefined,
        branches: [],
        sharedResources: [],
      });
      await expect(lstat(path.join(projectRoot, "repos"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rolls back a cloned repository when metadata CAS fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-connect-metadata-failure-"));
    const source = path.join(root, "source");
    const projectRoot = path.join(root, "project");
    const projectsRoot = path.join(root, "projects");
    await mkdir(source);
    try {
      const manager = new WorkspaceManager({
        defaultSourcePath: source,
        projectsRoot,
        autoOpenDefault: false,
        runGit: createFakeWorkspaceGit("https://github.com/acme/connect-metadata-failure.git"),
      });
      const project = await manager.createCanvasProject({
        name: "Connect metadata failure",
        projectRoot,
      });
      const workspacePath = path.join(projectRoot, "workspace.json");
      const indexPath = path.join(projectsRoot, "index.json");
      const beforeWorkspace = await readFile(workspacePath, "utf-8");
      workspaceFileSystemHooks.afterRename = async (_sourcePath, destinationPath) => {
        if (!sameMockPath(destinationPath, workspacePath)) return;
        workspaceFileSystemHooks.afterRename = undefined;
        const currentIndex = await readFile(indexPath, "utf-8");
        await writeFile(indexPath, `${currentIndex} `, "utf-8");
      };

      await expect(manager.connect({ localPath: source })).rejects.toThrow(/content changed/u);

      expect(manager.currentProjectId()).toBe(project.id);
      await expect(manager.project()).resolves.toMatchObject({ repo: undefined, branches: [] });
      await expect(readFile(workspacePath, "utf-8")).resolves.toBe(beforeWorkspace);
      await expect(lstat(path.join(projectRoot, "repos"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      workspaceFileSystemHooks.afterRename = undefined;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reconciles a project-directory rename that reports failure after committing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-delete-rename-reconcile-"));
    const projectRoot = path.join(root, "project");
    try {
      const manager = new WorkspaceManager({
        defaultSourcePath: root,
        projectsRoot: path.join(root, "projects"),
        autoOpenDefault: false,
      });
      const project = await manager.createCanvasProject({ name: "Rename reconcile", projectRoot });
      workspaceFileSystemHooks.afterRename = async (sourcePath, destinationPath) => {
        if (!sameMockPath(sourcePath, projectRoot) ||
            !path.basename(destinationPath).includes(".agent-canvas-delete-")) return;
        workspaceFileSystemHooks.afterRename = undefined;
        throw new Error("injected post-rename failure");
      };

      await expect(manager.deleteCanvasProject(project.id)).resolves.toEqual(project);
      await expect(lstat(projectRoot)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(manager.listCanvasProjects()).resolves.toEqual([]);
    } finally {
      workspaceFileSystemHooks.afterRename = undefined;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("commits project deletion and returns a cleanup warning when tombstone removal fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-delete-cleanup-warning-"));
    const projectRoot = path.join(root, "project");
    try {
      const manager = new WorkspaceManager({
        defaultSourcePath: root,
        projectsRoot: path.join(root, "projects"),
        autoOpenDefault: false,
      });
      const project = await manager.createCanvasProject({ name: "Cleanup warning", projectRoot });
      workspaceFileSystemHooks.beforeRm = async (targetPath) => {
        if (!path.basename(targetPath).includes(".agent-canvas-delete-")) return;
        workspaceFileSystemHooks.beforeRm = undefined;
        throw new Error("injected tombstone cleanup failure");
      };

      const deleted = await manager.deleteCanvasProject(project.id);

      expect(deleted).toMatchObject({
        ...project,
        cleanupWarning: expect.stringContaining("injected tombstone cleanup failure"),
      });
      await expect(manager.listCanvasProjects()).resolves.toEqual([]);
      await expect(manager.project()).rejects.toThrow();
      await expect(lstat(projectRoot)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await readdir(root)).some((entry) => entry.includes(".agent-canvas-delete-")))
        .toBe(true);
    } finally {
      workspaceFileSystemHooks.beforeRm = undefined;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a nested shared-resource mount parent junction without touching any branch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-resource-parent-junction-"));
    const source = path.join(root, "source-repo");
    const projectRoot = path.join(root, "project");
    const outside = path.join(root, "outside-mount-parent");
    const outsideSentinel = path.join(outside, "sentinel.txt");
    await Promise.all([
      mkdir(source, { recursive: true }),
      mkdir(outside, { recursive: true }),
    ]);
    await writeFile(outsideSentinel, "outside mount parent\n", "utf-8");

    try {
      const manager = new WorkspaceManager({
        defaultSourcePath: source,
        projectRoot,
        runGit: createFakeWorkspaceGit("https://github.com/acme/resource-parent-junction.git"),
      });
      const main = (await manager.connect({ localPath: source })).branches[0]!;
      const feature = await manager.createBranch({ branch: "feature/junction-parent" });
      const branches = [main, feature];
      const unsafeParent = path.join(feature.worktreePath, "nested", "escape");
      await mkdir(path.dirname(unsafeParent), { recursive: true });
      await symlink(
        outside,
        unsafeParent,
        process.platform === "win32" ? "junction" : "dir",
      );
      const beforeProject = await manager.project();
      const workspacePath = path.join(projectRoot, "workspace.json");
      const beforeWorkspace = await readFile(workspacePath, "utf-8");
      const beforeExcludes = await Promise.all(
        branches.map(async (branch) => {
          const excludePath = path.join(branch.worktreePath, ".git", "info", "exclude");
          return [excludePath, await readFile(excludePath, "utf-8")] as const;
        }),
      );
      const sourcePath = path.join(projectRoot, "shared", "repo_1", "junction-dataset");

      await expect(
        manager.createSharedResource({
          name: "junction-dataset",
          mountPath: "nested/escape/dataset",
        }),
      ).rejects.toThrow();

      await expect(manager.project()).resolves.toEqual(beforeProject);
      await expect(readFile(workspacePath, "utf-8")).resolves.toBe(beforeWorkspace);
      await expect(readFile(outsideSentinel, "utf-8")).resolves.toBe(
        "outside mount parent\n",
      );
      await expect(lstat(path.join(outside, "dataset"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(realpath(unsafeParent)).resolves.toBe(await realpath(outside));
      await expect(lstat(path.join(main.worktreePath, "nested"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(lstat(sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
      for (const [excludePath, content] of beforeExcludes) {
        await expect(readFile(excludePath, "utf-8")).resolves.toBe(content);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("revalidates a preflighted worktree against the project root before mounting", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-resource-worktree-swap-"));
    const source = path.join(root, "source-repo");
    const projectRoot = path.join(root, "project");
    const outside = path.join(root, "outside-worktree");
    const outsideSentinel = path.join(outside, "sentinel.txt");
    await Promise.all([
      mkdir(source, { recursive: true }),
      mkdir(outside, { recursive: true }),
    ]);
    await writeFile(outsideSentinel, "outside\n", "utf-8");
    let swapAfterMainPreflight = false;
    let featureWorktree = "";
    let mainWorktree = "";
    let displacedMain = "";
    const baseGit = createFakeWorkspaceGit("https://github.com/acme/resource-worktree-swap.git");
    const runGit: GitRunner = async (args, options) => {
      if (
        swapAfterMainPreflight &&
        args[0] === "rev-parse" &&
        options?.cwd === featureWorktree
      ) {
        swapAfterMainPreflight = false;
        await rename(mainWorktree, displacedMain);
        await symlink(
          outside,
          mainWorktree,
          process.platform === "win32" ? "junction" : "dir",
        );
      }
      return await baseGit(args, options);
    };

    try {
      const manager = new WorkspaceManager({
        defaultSourcePath: source,
        projectRoot,
        projectsRoot: path.join(root, "projects"),
        runGit,
      });
      const main = (await manager.connect({ localPath: source })).branches[0]!;
      const feature = await manager.createBranch({ branch: "feature/worktree-swap" });
      mainWorktree = main.worktreePath;
      featureWorktree = feature.worktreePath;
      displacedMain = `${mainWorktree}-displaced`;
      const projectBefore = await manager.project();
      const workspacePath = path.join(projectRoot, "workspace.json");
      const workspaceBefore = await readFile(workspacePath, "utf-8");
      const resourceSource = path.join(projectRoot, "shared", "repo_1", "swapped-worktree");

      swapAfterMainPreflight = true;
      await expect(
        manager.createSharedResource({
          name: "swapped worktree",
          mountPath: "swapped/worktree",
        }),
      ).rejects.toThrow();

      await expect(readFile(workspacePath, "utf-8")).resolves.toBe(workspaceBefore);
      await expect(readFile(outsideSentinel, "utf-8")).resolves.toBe("outside\n");
      await expect(lstat(path.join(outside, "swapped", "worktree"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(lstat(resourceSource)).rejects.toMatchObject({ code: "ENOENT" });

      await rm(mainWorktree);
      await rename(displacedMain, mainWorktree);
      await expect(manager.project()).resolves.toEqual(projectBefore);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("revalidates every earlier mount parent before the multi-branch workspace commit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-resource-final-parent-"));
    const source = path.join(root, "source-repo");
    const projectRoot = path.join(root, "project");
    const externalResource = path.join(root, "external-resource");
    const outsideParent = path.join(root, "outside-parent");
    const outsideSentinel = path.join(outsideParent, "sentinel.txt");
    await Promise.all([
      mkdir(source, { recursive: true }),
      mkdir(externalResource, { recursive: true }),
      mkdir(outsideParent, { recursive: true }),
    ]);
    await writeFile(outsideSentinel, "outside parent\n", "utf-8");

    try {
      const manager = new WorkspaceManager({
        defaultSourcePath: source,
        projectRoot,
        projectsRoot: path.join(root, "projects"),
        runGit: createFakeWorkspaceGit("https://github.com/acme/resource-final-parent.git"),
      });
      const main = (await manager.connect({ localPath: source })).branches[0]!;
      const feature = await manager.createBranch({ branch: "feature/final-parent" });
      const beforeProject = await manager.project();
      const workspacePath = path.join(projectRoot, "workspace.json");
      const beforeWorkspace = await readFile(workspacePath, "utf-8");
      const firstParent = path.join(main.worktreePath, "final-parent-race");
      const displacedFirstParent = path.join(main.worktreePath, "displaced-final-parent-race");
      const outsideMount = path.join(outsideParent, "dataset");
      let publications = 0;
      setAfterManagedMountPublished(async () => {
        publications += 1;
        if (publications !== 2) return;
        clearAfterManagedMountPublished();
        await rename(firstParent, displacedFirstParent);
        await symlink(
          outsideParent,
          firstParent,
          process.platform === "win32" ? "junction" : "dir",
        );
        await symlink(
          externalResource,
          outsideMount,
          process.platform === "win32" ? "junction" : "dir",
        );
      });

      await expect(
        manager.createSharedResource({
          name: "final-parent-resource",
          sourcePath: externalResource,
          mountPath: "final-parent-race/dataset",
        }),
      ).rejects.toThrow();

      await expect(manager.project()).resolves.toEqual(beforeProject);
      await expect(readFile(workspacePath, "utf-8")).resolves.toBe(beforeWorkspace);
      await expect(readFile(outsideSentinel, "utf-8")).resolves.toBe("outside parent\n");
      await expect(realpath(outsideMount)).resolves.toBe(await realpath(externalResource));
      await expect(
        lstat(path.join(feature.worktreePath, "final-parent-race")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      clearAfterManagedMountPublished();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not claim or remove a mount that appears after shared-resource preflight", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-resource-mount-race-"));
    const source = path.join(root, "source-repo");
    const projectRoot = path.join(root, "project");
    const resourceSource = path.join(root, "existing-resource");
    await Promise.all([
      mkdir(source, { recursive: true }),
      mkdir(resourceSource, { recursive: true }),
    ]);
    let blockPreflight = false;
    let blockedWorktree = "";
    let signalBlocked!: () => void;
    let releaseBlocked!: () => void;
    const blocked = new Promise<void>((resolve) => {
      signalBlocked = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseBlocked = resolve;
    });
    const baseGit = createFakeWorkspaceGit("https://github.com/acme/resource-mount-race.git");
    const runGit: GitRunner = async (args, options) => {
      if (
        args[0] === "rev-parse" &&
        blockPreflight &&
        options?.cwd === blockedWorktree
      ) {
        blockPreflight = false;
        signalBlocked();
        await released;
      }
      return await baseGit(args, options);
    };

    try {
      const manager = new WorkspaceManager({
        defaultSourcePath: source,
        projectRoot,
        projectsRoot: path.join(root, "projects"),
        runGit,
      });
      const main = (await manager.connect({ localPath: source })).branches[0]!;
      const feature = await manager.createBranch({ branch: "feature/mount-race" });
      blockedWorktree = feature.worktreePath;
      const beforeProject = await manager.project();
      const workspacePath = path.join(projectRoot, "workspace.json");
      const beforeWorkspace = await readFile(workspacePath, "utf-8");
      const concurrentMount = path.join(main.worktreePath, "race-mount");

      blockPreflight = true;
      const creating = manager.createSharedResource({
        name: "mount-race",
        sourcePath: resourceSource,
        mountPath: "race-mount",
      });
      await blocked;
      await symlink(
        resourceSource,
        concurrentMount,
        process.platform === "win32" ? "junction" : "dir",
      );
      releaseBlocked();

      await expect(creating).rejects.toThrow();
      await expect(realpath(concurrentMount)).resolves.toBe(await realpath(resourceSource));
      await expect(manager.project()).resolves.toEqual(beforeProject);
      await expect(readFile(workspacePath, "utf-8")).resolves.toBe(beforeWorkspace);
      await expect(lstat(path.join(feature.worktreePath, "race-mount"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      releaseBlocked?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not remove a concurrently replaced mount during transaction rollback", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-resource-mount-ownership-"));
    const source = path.join(root, "source-repo");
    const projectRoot = path.join(root, "project");
    const resourceSource = path.join(root, "existing-resource");
    await Promise.all([
      mkdir(source, { recursive: true }),
      mkdir(resourceSource, { recursive: true }),
    ]);
    let replaceMount = false;
    let mountPath = "";
    const baseGit = createFakeWorkspaceGit("https://github.com/acme/resource-ownership.git");
    const runGit: GitRunner = async (args, options) => {
      if (
        replaceMount &&
        args[0] === "rev-parse" &&
        options?.cwd &&
        mountPath &&
        existsSync(mountPath)
      ) {
        replaceMount = false;
        await rm(mountPath);
        await symlink(
          resourceSource,
          mountPath,
          process.platform === "win32" ? "junction" : "dir",
        );
        throw new Error("injected failure after mount replacement");
      }
      return await baseGit(args, options);
    };

    try {
      const manager = new WorkspaceManager({
        defaultSourcePath: source,
        projectRoot,
        projectsRoot: path.join(root, "projects"),
        runGit,
      });
      const main = (await manager.connect({ localPath: source })).branches[0]!;
      mountPath = path.join(main.worktreePath, "ownership-mount");
      const projectBefore = await manager.project();
      const workspacePath = path.join(projectRoot, "workspace.json");
      const workspaceBefore = await readFile(workspacePath, "utf-8");

      replaceMount = true;
      await expect(
        manager.createSharedResource({
          name: "ownership resource",
          sourcePath: resourceSource,
          mountPath: "ownership-mount",
        }),
      ).rejects.toThrow("rollback was incomplete");

      await expect(realpath(mountPath)).resolves.toBe(await realpath(resourceSource));
      await expect(manager.project()).resolves.toEqual(projectBefore);
      await expect(readFile(workspacePath, "utf-8")).resolves.toBe(workspaceBefore);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("quarantines mount rollback so a late foreign replacement is not deleted", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-resource-mount-quarantine-"));
    const source = path.join(root, "source-repo");
    const projectRoot = path.join(root, "project");
    const resourceSource = path.join(root, "volatile-resource");
    await Promise.all([
      mkdir(source, { recursive: true }),
      mkdir(resourceSource, { recursive: true }),
    ]);
    let mountPath = "";
    let quarantinePath = "";
    const failAfterPublication = async (destinationPath: string): Promise<void> => {
      if (!sameMockPath(destinationPath, mountPath)) return;
      await rm(resourceSource, { recursive: true, force: true });
    };

    try {
      const manager = new WorkspaceManager({
        defaultSourcePath: source,
        projectRoot,
        projectsRoot: path.join(root, "projects"),
        runGit: createFakeWorkspaceGit("https://github.com/acme/resource-quarantine.git"),
      });
      const main = (await manager.connect({ localPath: source })).branches[0]!;
      mountPath = path.join(main.worktreePath, "quarantine-mount");
      const workspacePath = path.join(projectRoot, "workspace.json");
      const beforeWorkspace = await readFile(workspacePath, "utf-8");
      workspaceFileSystemHooks.afterLink = async (_sourcePath, destinationPath) => {
        await failAfterPublication(destinationPath);
      };
      workspaceFileSystemHooks.afterRename = async (sourcePath, destinationPath) => {
        if (sameMockPath(destinationPath, mountPath)) {
          await failAfterPublication(destinationPath);
          return;
        }
        if (
          sameMockPath(sourcePath, mountPath) &&
          path.basename(destinationPath).includes(".agent-canvas-remove-")
        ) {
          quarantinePath = destinationPath;
          await rm(destinationPath);
          await writeFile(destinationPath, "foreign quarantine sentinel\n", "utf-8");
        }
      };

      await expect(
        manager.createSharedResource({
          name: "quarantine resource",
          sourcePath: resourceSource,
          mountPath: "quarantine-mount",
        }),
      ).rejects.toThrow();

      expect(quarantinePath).not.toBe("");
      await expect(readFile(quarantinePath, "utf-8")).resolves.toBe(
        "foreign quarantine sentinel\n",
      );
      await expect(lstat(mountPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(workspacePath, "utf-8")).resolves.toBe(beforeWorkspace);
    } finally {
      workspaceFileSystemHooks.afterLink = undefined;
      workspaceFileSystemHooks.afterRename = undefined;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes its newly created mount when post-creation validation fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-resource-link-validation-"));
    const source = path.join(root, "source-repo");
    const projectRoot = path.join(root, "project");
    const resourceSource = path.join(root, "volatile-resource");
    await Promise.all([
      mkdir(source, { recursive: true }),
      mkdir(resourceSource, { recursive: true }),
    ]);

    try {
      const manager = new WorkspaceManager({
        defaultSourcePath: source,
        projectRoot,
        projectsRoot: path.join(root, "projects"),
        runGit: createFakeWorkspaceGit("https://github.com/acme/resource-link-validation.git"),
      });
      const main = (await manager.connect({ localPath: source })).branches[0]!;
      const mountPath = path.join(main.worktreePath, "volatile-mount");
      const workspacePath = path.join(projectRoot, "workspace.json");
      const projectBefore = await manager.project();
      const workspaceBefore = await readFile(workspacePath, "utf-8");
      setAfterManagedMountPublished(async (_sourcePath, createdMountPath) => {
        if (!sameTestPath(createdMountPath, mountPath)) return;
        clearAfterManagedMountPublished();
        await rm(resourceSource, { recursive: true, force: true });
      });

      await expect(
        manager.createSharedResource({
          name: "volatile resource",
          sourcePath: resourceSource,
          mountPath: "volatile-mount",
        }),
      ).rejects.toThrow();

      await expect(lstat(mountPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(manager.project()).resolves.toEqual(projectBefore);
      await expect(readFile(workspacePath, "utf-8")).resolves.toBe(workspaceBefore);
    } finally {
      clearAfterManagedMountPublished();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("journals a mount when link creation commits before reporting an error", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-resource-link-reconcile-"));
    const source = path.join(root, "source-repo");
    const projectRoot = path.join(root, "project");
    await mkdir(source, { recursive: true });
    try {
      const manager = new WorkspaceManager({
        defaultSourcePath: source,
        projectRoot,
        runGit: createFakeWorkspaceGit("https://github.com/acme/resource-link-reconcile.git"),
      });
      const main = (await manager.connect({ localPath: source })).branches[0]!;
      const mountPath = path.join(main.worktreePath, "reconciled-mount");
      setAfterManagedMountPublished(async (_sourcePath, createdMountPath) => {
        if (!sameTestPath(createdMountPath, mountPath)) return;
        clearAfterManagedMountPublished();
        throw new Error("injected post-link error");
      });

      const resource = await manager.createSharedResource({
        name: "reconciled resource",
        mountPath: "reconciled-mount",
      });

      await expect(realpath(mountPath)).resolves.toBe(await realpath(resource.sourcePath));
      await expect(manager.project()).resolves.toMatchObject({
        sharedResources: [expect.objectContaining({ id: resource.id })],
      });
    } finally {
      clearAfterManagedMountPublished();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reconciles a staging-link syscall that reports an error after commit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-resource-staging-reconcile-"));
    const source = path.join(root, "source-repo");
    const projectRoot = path.join(root, "project");
    await mkdir(source, { recursive: true });
    try {
      const manager = new WorkspaceManager({
        defaultSourcePath: source,
        projectRoot,
        runGit: createFakeWorkspaceGit("https://github.com/acme/staging-reconcile.git"),
      });
      const main = (await manager.connect({ localPath: source })).branches[0]!;
      const mountPath = path.join(main.worktreePath, "staging-error-mount");
      workspaceFileSystemHooks.afterSymlink = async (_sourcePath, createdPath) => {
        if (
          path.dirname(createdPath) !== path.dirname(mountPath) ||
          !path.basename(createdPath).startsWith(".staging-error-mount.agent-canvas-link-")
        ) {
          return;
        }
        workspaceFileSystemHooks.afterSymlink = undefined;
        throw Object.assign(new Error("injected post-staging-link error"), { code: "EIO" });
      };

      const resource = await manager.createSharedResource({
        name: "staging reconcile",
        mountPath: "staging-error-mount",
      });

      await expect(realpath(mountPath)).resolves.toBe(await realpath(resource.sourcePath));
      expect(
        (await readdir(path.dirname(mountPath))).some((entry) =>
          entry.includes(".agent-canvas-link-"),
        ),
      ).toBe(false);
    } finally {
      workspaceFileSystemHooks.afterSymlink = undefined;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not delete a mount replaced before ownership capture", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-resource-early-replace-"));
    const source = path.join(root, "source-repo");
    const projectRoot = path.join(root, "project");
    const outside = path.join(root, "outside-replacement");
    const sentinel = path.join(outside, "sentinel.txt");
    await Promise.all([mkdir(source, { recursive: true }), mkdir(outside, { recursive: true })]);
    await writeFile(sentinel, "outside replacement", "utf-8");
    try {
      const manager = new WorkspaceManager({
        defaultSourcePath: source,
        projectRoot,
        runGit: createFakeWorkspaceGit("https://github.com/acme/resource-early-replace.git"),
      });
      const main = (await manager.connect({ localPath: source })).branches[0]!;
      const mountPath = path.join(main.worktreePath, "early-replaced-mount");
      setAfterManagedMountPublished(async (_sourcePath, createdMountPath) => {
        if (!sameTestPath(createdMountPath, mountPath)) return;
        clearAfterManagedMountPublished();
        await rm(createdMountPath, { force: true });
        await symlink(
          outside,
          createdMountPath,
          process.platform === "win32" ? "junction" : "dir",
        );
      });

      await expect(
        manager.createSharedResource({
          name: "early replaced resource",
          mountPath: "early-replaced-mount",
        }),
      ).rejects.toThrow(
        /ownership could not be established|publication was not atomic|rollback was incomplete/u,
      );

      await expect(realpath(mountPath)).resolves.toBe(await realpath(outside));
      await expect(readFile(sentinel, "utf-8")).resolves.toBe("outside replacement");
      expect((await manager.project()).sharedResources).toEqual([]);
    } finally {
      clearAfterManagedMountPublished();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an internal shared source swapped to an outside junction after mounting", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-resource-source-swap-"));
    const source = path.join(root, "source-repo");
    const projectRoot = path.join(root, "project");
    const resourceSource = path.join(projectRoot, "shared", "repo_1", "source-swap");
    const displacedSource = `${resourceSource}-displaced`;
    const outside = path.join(root, "outside-source-swap");
    const sentinel = path.join(outside, "sentinel.txt");
    await Promise.all([
      mkdir(source, { recursive: true }),
      mkdir(resourceSource, { recursive: true }),
      mkdir(outside, { recursive: true }),
    ]);
    await writeFile(sentinel, "outside source", "utf-8");
    try {
      const manager = new WorkspaceManager({
        defaultSourcePath: source,
        projectRoot,
        projectsRoot: path.join(root, "projects"),
        runGit: createFakeWorkspaceGit("https://github.com/acme/resource-source-swap.git"),
      });
      const main = (await manager.connect({ localPath: source })).branches[0]!;
      const mountPath = path.join(main.worktreePath, "source-swap-mount");
      const workspacePath = path.join(projectRoot, "workspace.json");
      const projectBefore = await manager.project();
      const workspaceBefore = await readFile(workspacePath, "utf-8");
      let linkCreated = false;
      setAfterManagedMountPublished(async (_target, createdPath) => {
        if (!sameTestPath(createdPath, mountPath)) return;
        clearAfterManagedMountPublished();
        linkCreated = true;
        await rename(resourceSource, displacedSource);
        await symlink(
          outside,
          resourceSource,
          process.platform === "win32" ? "junction" : "dir",
        );
      });

      await expect(
        manager.createSharedResource({
          name: "source swap",
          sourcePath: resourceSource,
          mountPath: "source-swap-mount",
        }),
      ).rejects.toThrow();

      if (!linkCreated) return;
      await expect(readFile(sentinel, "utf-8")).resolves.toBe("outside source");
      await expect(lstat(mountPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(manager.project()).resolves.toEqual(projectBefore);
      await expect(readFile(workspacePath, "utf-8")).resolves.toBe(workspaceBefore);
    } finally {
      clearAfterManagedMountPublished();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes its newly created mount when reading the link target fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-resource-readlink-failure-"));
    const source = path.join(root, "source-repo");
    const projectRoot = path.join(root, "project");
    await mkdir(source, { recursive: true });
    try {
      const manager = new WorkspaceManager({
        defaultSourcePath: source,
        projectRoot,
        projectsRoot: path.join(root, "projects"),
        runGit: createFakeWorkspaceGit("https://github.com/acme/resource-readlink-failure.git"),
      });
      const main = (await manager.connect({ localPath: source })).branches[0]!;
      const mountPath = path.join(main.worktreePath, "readlink-failure-mount");
      const workspacePath = path.join(projectRoot, "workspace.json");
      const projectBefore = await manager.project();
      const workspaceBefore = await readFile(workspacePath, "utf-8");
      workspaceFileSystemHooks.failReadlinkPath = mountPath;

      await expect(
        manager.createSharedResource({
          name: "readlink failure resource",
          mountPath: "readlink-failure-mount",
        }),
      ).rejects.toThrow("injected readlink failure");

      await expect(lstat(mountPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(manager.project()).resolves.toEqual(projectBefore);
      await expect(readFile(workspacePath, "utf-8")).resolves.toBe(workspaceBefore);
    } finally {
      workspaceFileSystemHooks.failReadlinkPath = undefined;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a nested mount-parent junction when applying a resource to a new branch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-new-branch-junction-"));
    const source = path.join(root, "source-repo");
    const projectRoot = path.join(root, "project");
    const outside = path.join(root, "outside");
    const outsideSentinel = path.join(outside, "sentinel.txt");
    await Promise.all([mkdir(source, { recursive: true }), mkdir(outside, { recursive: true })]);
    await writeFile(outsideSentinel, "outside\n", "utf-8");
    let injectJunction = false;
    let injectedParent = "";
    const baseGit = createFakeWorkspaceGit("https://github.com/acme/new-branch-junction.git");
    const runGit: GitRunner = async (args, options) => {
      const result = await baseGit(args, options);
      if (args[0] === "worktree" && args[1] === "add" && injectJunction) {
        injectJunction = false;
        const worktree = worktreeAddPath(args);
        injectedParent = path.join(worktree, "nested", "escape");
        await mkdir(path.dirname(injectedParent), { recursive: true });
        await symlink(
          outside,
          injectedParent,
          process.platform === "win32" ? "junction" : "dir",
        );
      }
      return result;
    };

    try {
      const manager = new WorkspaceManager({
        defaultSourcePath: source,
        projectRoot,
        projectsRoot: path.join(root, "projects"),
        runGit,
      });
      await manager.connect({ localPath: source });
      await manager.createSharedResource({
        name: "branch-junction-resource",
        mountPath: "nested/escape/dataset",
      });
      const beforeProject = await manager.project();
      const beforeWorkspace = await readFile(path.join(projectRoot, "workspace.json"), "utf-8");

      injectJunction = true;
      await expect(
        manager.createBranch({ branch: "feature/unsafe-resource-parent" }),
      ).rejects.toThrow();

      await expect(manager.project()).resolves.toEqual(beforeProject);
      await expect(readFile(path.join(projectRoot, "workspace.json"), "utf-8")).resolves.toBe(
        beforeWorkspace,
      );
      await expect(readFile(outsideSentinel, "utf-8")).resolves.toBe("outside\n");
      await expect(lstat(path.join(outside, "dataset"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(injectedParent)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(path.dirname(path.dirname(injectedParent)))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(lstat(path.join(projectRoot, "worktrees"))).rejects.toMatchObject({
        code: "ENOENT",
      });

      const retried = await manager.createBranch({ branch: "feature/unsafe-resource-parent" });
      expect(retried.id).toBe("branch_2");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rolls back an entire new branch when a later shared resource fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-new-branch-transaction-"));
    const source = path.join(root, "source-repo");
    const projectRoot = path.join(root, "project");
    await mkdir(source, { recursive: true });
    try {
      const manager = new WorkspaceManager({
        defaultSourcePath: source,
        projectRoot,
        projectsRoot: path.join(root, "projects"),
        runGit: createFakeWorkspaceGit("https://github.com/acme/new-branch-transaction.git"),
      });
      await manager.connect({ localPath: source });
      const first = await manager.createSharedResource({
        name: "first branch resource",
        mountPath: "branch-resources/first",
      });
      const second = await manager.createSharedResource({
        name: "second branch resource",
        mountPath: "branch-resources/second",
      });
      const projectBefore = await manager.project();
      const workspacePath = path.join(projectRoot, "workspace.json");
      const workspaceBefore = await readFile(workspacePath, "utf-8");
      const worktreePath = path.join(
        projectRoot,
        "worktrees",
        "repo_1",
        "feature-two-resource-rollback",
      );
      const firstMount = path.join(worktreePath, "branch-resources", "first");
      const displacedSecondSource = `${second.sourcePath}-displaced`;
      setAfterManagedMountPublished(async (_sourcePath, createdMountPath) => {
        if (!sameTestPath(createdMountPath, firstMount)) return;
        clearAfterManagedMountPublished();
        await rename(second.sourcePath, displacedSecondSource);
      });

      await expect(
        manager.createBranch({ branch: "feature/two-resource-rollback" }),
      ).rejects.toThrow();

      await expect(manager.project()).resolves.toEqual(projectBefore);
      await expect(readFile(workspacePath, "utf-8")).resolves.toBe(workspaceBefore);
      await expect(lstat(worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(firstMount)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(realpath(path.join(projectBefore.branches[0]!.worktreePath, first.mountPath)))
        .resolves.toBe(await realpath(first.sourcePath));

      await rename(displacedSecondSource, second.sourcePath);
      const retried = await manager.createBranch({ branch: "feature/two-resource-rollback" });
      expect(retried.id).toBe("branch_2");
    } finally {
      clearAfterManagedMountPublished();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rolls back a late multi-branch shared-resource failure without consuming its id", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-resource-rollback-"));
    const source = path.join(root, "source-repo");
    const projectRoot = path.join(root, "project");
    const projectsRoot = path.join(root, "projects");
    const workspacePath = path.join(projectRoot, "workspace.json");
    const outsideWorkspace = path.join(root, "outside-workspace.json");
    await mkdir(source, { recursive: true });
    let armLateFailure = false;
    let finalWorktreePath = "";
    let finalMountPath = "";
    const baseGit = createFakeWorkspaceGit("https://github.com/acme/resource-rollback.git");
    const runGit: GitRunner = async (args, options) => {
      if (
        args[0] === "rev-parse" &&
        armLateFailure &&
        options?.cwd === finalWorktreePath &&
        existsSync(finalMountPath)
      ) {
        armLateFailure = false;
        await rm(workspacePath);
        await link(outsideWorkspace, workspacePath);
      }
      return await baseGit(args, options);
    };

    try {
      const manager = new WorkspaceManager({
        defaultSourcePath: source,
        projectRoot,
        projectsRoot,
        runGit,
      });
      const main = (await manager.connect({ localPath: source })).branches[0]!;
      const featureA = await manager.createBranch({ branch: "feature/rollback-a" });
      const featureB = await manager.createBranch({ branch: "feature/rollback-b" });
      const branches = [main, featureA, featureB];
      const mountPath = "rollback-mounts/dataset";
      const sourcePath = path.join(projectRoot, "shared", "repo_1", "rollback-dataset");
      finalWorktreePath = featureB.worktreePath;
      finalMountPath = path.join(finalWorktreePath, mountPath);
      const beforeProject = await manager.project();
      const beforeWorkspace = await readFile(workspacePath, "utf-8");
      await writeFile(outsideWorkspace, beforeWorkspace, "utf-8");
      const beforeExcludes = await Promise.all(
        branches.map(async (branch) => {
          const excludePath = path.join(branch.worktreePath, ".git", "info", "exclude");
          return [excludePath, await readFile(excludePath, "utf-8")] as const;
        }),
      );

      armLateFailure = true;
      const creating = manager.createSharedResource({
        name: "rollback-dataset",
        mountPath,
        access: "readWrite",
      });
      await expect(creating).rejects.toThrow();

      await expect(manager.project()).resolves.toEqual(beforeProject);
      await expect(readFile(workspacePath, "utf-8")).resolves.toBe(beforeWorkspace);
      await expect(readFile(outsideWorkspace, "utf-8")).resolves.toBe(beforeWorkspace);
      expect((await lstat(workspacePath)).nlink).toBe(2);
      expect((await lstat(outsideWorkspace)).nlink).toBe(2);
      await expect(lstat(sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
      for (const branch of branches) {
        await expect(
          lstat(path.join(branch.worktreePath, "rollback-mounts")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      }
      for (const [excludePath, content] of beforeExcludes) {
        await expect(readFile(excludePath, "utf-8")).resolves.toBe(content);
      }

      await rm(workspacePath);
      await writeFile(workspacePath, beforeWorkspace, "utf-8");
      const retried = await manager.createSharedResource({
        name: "rollback-dataset",
        mountPath,
        access: "readWrite",
      });
      expect(retried.id).toBe("shared_1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("journals a mount-parent mkdir that reports a coded error after committing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-resource-mkdir-reconcile-"));
    const source = path.join(root, "source-repo");
    const projectRoot = path.join(root, "project");
    await mkdir(source, { recursive: true });

    try {
      const manager = new WorkspaceManager({
        defaultSourcePath: source,
        projectRoot,
        projectsRoot: path.join(root, "projects"),
        runGit: createFakeWorkspaceGit("https://github.com/acme/resource-mkdir-reconcile.git"),
      });
      const main = (await manager.connect({ localPath: source })).branches[0]!;
      const mountParent = path.join(main.worktreePath, "coded-parent");
      const resourceSource = path.join(
        projectRoot,
        "shared",
        "repo_1",
        "coded-mkdir-resource",
      );
      const workspacePath = path.join(projectRoot, "workspace.json");
      const beforeProject = await manager.project();
      const beforeWorkspace = await readFile(workspacePath, "utf-8");
      workspaceFileSystemHooks.afterMkdir = async (directoryPath) => {
        if (!sameMockPath(directoryPath, mountParent)) return;
        workspaceFileSystemHooks.afterMkdir = undefined;
        throw Object.assign(new Error("injected coded post-mkdir failure"), { code: "EIO" });
      };

      await expect(
        manager.createSharedResource({
          name: "coded-mkdir-resource",
          mountPath: "coded-parent/dataset",
        }),
      ).rejects.toThrow("injected coded post-mkdir failure");

      await expect(manager.project()).resolves.toEqual(beforeProject);
      await expect(readFile(workspacePath, "utf-8")).resolves.toBe(beforeWorkspace);
      await expect(lstat(mountParent)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(resourceSource)).rejects.toMatchObject({ code: "ENOENT" });

      const retried = await manager.createSharedResource({
        name: "coded-mkdir-resource",
        mountPath: "coded-parent/dataset",
      });
      expect(retried.id).toBe("shared_1");
    } finally {
      workspaceFileSystemHooks.afterMkdir = undefined;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a pre-existing repository junction before cloning into it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-repo-junction-"));
    const source = path.join(root, "source-repo");
    const projectRoot = path.join(root, "project");
    const repositoryPath = path.join(projectRoot, "repos", "repo_1", "repo");
    const outside = path.join(root, "outside-repository");
    let cloneCalls = 0;
    await Promise.all([mkdir(source, { recursive: true }), mkdir(outside, { recursive: true })]);
    await writeFile(path.join(outside, "sentinel.txt"), "outside repository\n", "utf-8");
    await mkdir(path.dirname(repositoryPath), { recursive: true });
    await symlink(
      outside,
      repositoryPath,
      process.platform === "win32" ? "junction" : "dir",
    );
    const runGit: GitRunner = async (args) => {
      if (args[0] === "remote") return "https://github.com/acme/repo-junction.git";
      if (args[0] === "branch") return "main";
      if (args[0] === "clone") cloneCalls += 1;
      return "";
    };

    try {
      const manager = new WorkspaceManager({ defaultSourcePath: source, projectRoot, runGit });
      await expect(manager.connect({ localPath: source })).rejects.toThrow("不安全的映射");
      expect(cloneCalls).toBe(0);
      await expect(readFile(path.join(outside, "sentinel.txt"), "utf-8")).resolves.toBe(
        "outside repository\n",
      );
      await expect(lstat(path.join(outside, ".agent-tmp"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a pre-existing worktree junction before creating a branch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-branch-junction-"));
    const source = path.join(root, "source-repo");
    const projectRoot = path.join(root, "project");
    const outside = path.join(root, "outside-worktree");
    let worktreeAdds = 0;
    await Promise.all([mkdir(source, { recursive: true }), mkdir(outside, { recursive: true })]);
    await writeFile(path.join(outside, "sentinel.txt"), "outside worktree\n", "utf-8");
    const runGit: GitRunner = async (args, options) => {
      if (args[0] === "remote") return "https://github.com/acme/branch-junction.git";
      if (args[0] === "branch") return "main";
      if (args[0] === "clone") {
        await mkdir(path.join(String(args[2]), ".git", "info"), { recursive: true });
        return "";
      }
      if (args[0] === "worktree" && args[1] === "add") {
        worktreeAdds += 1;
        return "";
      }
      if (args[0] === "rev-parse") {
        if (args[1] === "--verify") return "a".repeat(40);
        return path.join(options?.cwd ?? "", ".git", "info", "exclude");
      }
      return "";
    };

    try {
      const manager = new WorkspaceManager({ defaultSourcePath: source, projectRoot, runGit });
      await manager.connect({ localPath: source });
      const worktreePath = path.join(
        projectRoot,
        "worktrees",
        "repo_1",
        "feature-external",
      );
      await mkdir(path.dirname(worktreePath), { recursive: true });
      await symlink(
        outside,
        worktreePath,
        process.platform === "win32" ? "junction" : "dir",
      );

      await expect(manager.createBranch({ branch: "feature/external" })).rejects.toThrow(
        "不安全的映射",
      );
      expect(worktreeAdds).toBe(0);
      await expect(readFile(path.join(outside, "sentinel.txt"), "utf-8")).resolves.toBe(
        "outside worktree\n",
      );
      await expect(lstat(path.join(outside, ".agent-tmp"))).rejects.toMatchObject({
        code: "ENOENT",
      });
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
        await mkdir(path.join(worktreeAddPath(args), ".git", "info"), { recursive: true });
        return "";
      }
      if (args[0] === "worktree" && args[1] === "move") {
        await rename(String(args[2]), String(args[3]));
        return "";
      }
      if (args[0] === "rev-parse") {
        if (args[1] === "--verify") return "a".repeat(40);
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
      expect(documentationPreflights).toBe(8);
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

  it("rejects a hard-linked shared index without modifying its outside sentinel", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-shared-doc-hardlink-"));
    const source = path.join(root, "source-repo");
    const projectRoot = path.join(root, "project");
    const outsideSentinel = path.join(root, "outside-shared-index.md");
    const remoteUrl = "https://github.com/acme/shared-hardlink.git";
    await mkdir(source, { recursive: true });
    const runGit: GitRunner = async (args, options) => {
      if (args[0] === "remote") return remoteUrl;
      if (args[0] === "branch") return "main";
      if (args[0] === "clone") {
        await mkdir(path.join(String(args[2]), ".git", "info"), { recursive: true });
        return "";
      }
      if (args[0] === "rev-parse") {
        if (args[1] === "--verify") return "a".repeat(40);
        return path.join(options?.cwd ?? "", ".git", "info", "exclude");
      }
      return "";
    };

    try {
      const manager = new WorkspaceManager({ defaultSourcePath: source, projectRoot, runGit });
      const workspace = (await manager.connect({ localPath: source })).branches[0]!;
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
      const sentinelContent = sharedDocumentationIndex();
      await mkdir(sharedSource, { recursive: true });
      await writeFile(
        path.join(sharedSource, ".agent-canvas-managed"),
        "Agent Canvas managed shared work documentation. Do not commit or remove this marker.\n",
        "utf-8",
      );
      await writeFile(outsideSentinel, sentinelContent, "utf-8");
      await link(outsideSentinel, path.join(sharedSource, "index.md"));

      await expect(manager.prepareWorkDocumentationForAllBranches()).rejects.toThrow("单链接");
      await expect(readFile(outsideSentinel, "utf-8")).resolves.toBe(sentinelContent);
      await expect(
        lstat(path.join(workspace.worktreePath, ".agent-docs")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("atomically replaces the shared index when adding a branch entry", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-shared-doc-atomic-"));
    const source = path.join(root, "source-repo");
    const projectRoot = path.join(root, "project");
    await mkdir(source, { recursive: true });
    const runGit: GitRunner = async (args, options) => {
      if (args[0] === "remote") return "https://github.com/acme/shared-atomic.git";
      if (args[0] === "branch") return "main";
      if (args[0] === "clone") {
        await mkdir(path.join(String(args[2]), ".git", "info"), { recursive: true });
        return "";
      }
      if (args[0] === "worktree" && args[1] === "add") {
        await mkdir(path.join(worktreeAddPath(args), ".git", "info"), { recursive: true });
        return "";
      }
      if (args[0] === "worktree" && args[1] === "move") {
        await rename(String(args[2]), String(args[3]));
        return "";
      }
      if (args[0] === "rev-parse") {
        if (args[1] === "--verify") return "a".repeat(40);
        return path.join(options?.cwd ?? "", ".git", "info", "exclude");
      }
      return "";
    };

    try {
      const manager = new WorkspaceManager({ defaultSourcePath: source, projectRoot, runGit });
      const main = (await manager.connect({ localPath: source })).branches[0]!;
      await manager.prepareWorkDocumentationForAllBranches();
      const sharedIndexPath = path.join(main.worktreePath, ".agent-shared-docs", "index.md");
      const before = await lstat(sharedIndexPath);

      await manager.createBranch({ branch: "feature/atomic-index" });
      await manager.prepareWorkDocumentationForAllBranches();
      const after = await lstat(sharedIndexPath);

      expect({ dev: after.dev, ino: after.ino }).not.toEqual({
        dev: before.dev,
        ino: before.ino,
      });
      expect(
        (await readFile(sharedIndexPath, "utf-8")).match(/agent-canvas:branch:/gu),
      ).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a hard-linked isolated index before publishing document access", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-isolated-doc-hardlink-"));
    const source = path.join(root, "source-repo");
    const projectRoot = path.join(root, "project");
    const outsideSentinel = path.join(root, "outside-isolated-index.md");
    await mkdir(source, { recursive: true });
    const runGit: GitRunner = async (args, options) => {
      if (args[0] === "remote") return "https://github.com/acme/isolated-hardlink.git";
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
      const manager = new WorkspaceManager({ defaultSourcePath: source, projectRoot, runGit });
      const workspace = (await manager.connect({ localPath: source })).branches[0]!;
      const isolatedDirectory = path.join(workspace.worktreePath, ".agent-docs");
      const sentinelContent = "# Outside sentinel\n";
      await mkdir(isolatedDirectory, { recursive: true });
      await writeFile(
        path.join(isolatedDirectory, ".agent-canvas-managed"),
        "Agent Canvas managed work documentation. Do not commit or remove this marker.\n",
        "utf-8",
      );
      await writeFile(outsideSentinel, sentinelContent, "utf-8");
      await link(outsideSentinel, path.join(isolatedDirectory, "index.md"));

      const config = { branchWorkspaceId: workspace.id };
      const options = { workDocumentationEnabled: true };
      await expect(manager.prepareAgentWorkspace("agent_1", config, options)).rejects.toThrow(
        "单链接",
      );
      await expect(readFile(outsideSentinel, "utf-8")).resolves.toBe(sentinelContent);
      expect(manager.accessForAgent(config, options).readableFiles).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a hard-linked git exclude without modifying its outside sentinel", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-exclude-hardlink-"));
    const source = path.join(root, "source-repo");
    const projectRoot = path.join(root, "project");
    const outsideSentinel = path.join(root, "outside-exclude");
    await mkdir(source, { recursive: true });
    const runGit: GitRunner = async (args, options) => {
      if (args[0] === "remote") return "https://github.com/acme/exclude-hardlink.git";
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
      const manager = new WorkspaceManager({ defaultSourcePath: source, projectRoot, runGit });
      const workspace = (await manager.connect({ localPath: source })).branches[0]!;
      const excludePath = path.join(workspace.worktreePath, ".git", "info", "exclude");
      const sentinelContent = "# Outside git exclude sentinel\n";
      await writeFile(outsideSentinel, sentinelContent, "utf-8");
      await rm(excludePath);
      await link(outsideSentinel, excludePath);

      await expect(manager.prepareWorkDocumentationForAllBranches()).rejects.toThrow("单链接");
      await expect(readFile(outsideSentinel, "utf-8")).resolves.toBe(sentinelContent);
      expect((await lstat(outsideSentinel)).nlink).toBe(2);
      await expect(
        lstat(path.join(workspace.worktreePath, ".agent-docs")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("revalidates cached work documentation before restoring agent access", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-work-docs-revalidate-"));
    const source = path.join(root, "source-repo");
    const projectRoot = path.join(root, "project");
    const outside = path.join(root, "outside");
    await Promise.all([mkdir(source, { recursive: true }), mkdir(outside, { recursive: true })]);
    let trackedDocumentation = false;
    const runGit: GitRunner = async (args, options) => {
      if (args[0] === "remote") return "https://github.com/acme/work-docs-revalidate.git";
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
      const workspace = (await manager.connect({ localPath: source })).branches[0]!;
      const config = { branchWorkspaceId: workspace.id };
      const options = { workDocumentationEnabled: true };
      const isolatedMarker = path.join(
        workspace.worktreePath,
        ".agent-docs",
        ".agent-canvas-managed",
      );
      const sharedMount = path.join(workspace.worktreePath, ".agent-shared-docs");

      await manager.prepareAgentWorkspace("agent_1", config, options);
      expect(manager.accessForAgent(config, options).readableFiles).toHaveLength(2);

      await rm(isolatedMarker);
      await expect(
        manager.prepareAgentWorkspace("agent_1", config, options),
      ).rejects.toThrow(".agent-docs/");
      expect(manager.accessForAgent(config, options).readableFiles).toEqual([]);

      await writeFile(
        isolatedMarker,
        "Agent Canvas managed work documentation. Do not commit or remove this marker.\n",
        "utf-8",
      );
      await manager.prepareAgentWorkspace("agent_1", config, options);

      trackedDocumentation = true;
      await expect(
        manager.prepareAgentWorkspace("agent_1", config, options),
      ).rejects.toThrow("Git");
      expect(manager.accessForAgent(config, options).readableFiles).toEqual([]);

      trackedDocumentation = false;
      await manager.prepareAgentWorkspace("agent_1", config, options);
      const expectedSharedSource = await realpath(sharedMount);
      await rm(sharedMount, { force: true });
      await symlink(
        outside,
        sharedMount,
        process.platform === "win32" ? "junction" : "dir",
      );
      await expect(
        manager.prepareAgentWorkspace("agent_1", config, options),
      ).rejects.toThrow("映射");
      expect(manager.accessForAgent(config, options).readableFiles).toEqual([]);

      await rm(sharedMount, { force: true });
      await symlink(
        expectedSharedSource,
        sharedMount,
        process.platform === "win32" ? "junction" : "dir",
      );
      await expect(
        manager.prepareAgentWorkspace("agent_1", config, options),
      ).resolves.toBeDefined();
      expect(manager.accessForAgent(config, options).readableFiles).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["repository", "worktree"] as const)(
    "rejects imported %s roots mapped through an external junction",
    async (mappedRoot) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-import-root-map-"));
      const projectRoot = path.join(root, "project");
      const outside = path.join(root, "outside");
      const projectsRoot = path.join(root, "projects-index");
      try {
        const creator = new WorkspaceManager({
          defaultSourcePath: root,
          projectsRoot,
          autoOpenDefault: false,
          now: () => 275,
        });
        await creator.createCanvasProject({ name: "Mapped import", projectRoot });
        const workspacePath = path.join(projectRoot, "workspace.json");
        const document = JSON.parse(await readFile(workspacePath, "utf-8"));
        const repoPath = path.join(projectRoot, "repos", "repo_1", "repo");
        const worktreePath = path.join(projectRoot, "worktrees", "repo_1", "feature-imported");
        await mkdir(outside, { recursive: true });
        document.repo = {
          id: "repo_1",
          remoteUrl: "https://github.com/acme/mapped-import.git",
          defaultBranch: "main",
          localRepoPath: repoPath,
          connectedAt: 275,
        };
        document.branches =
          mappedRoot === "worktree"
            ? [
                {
                  id: "branch_1",
                  repoId: "repo_1",
                  branch: "feature/imported",
                  baseBranch: "main",
                  worktreePath,
                  scratchRoot: path.join(worktreePath, ".agent-tmp"),
                  isDefault: false,
                  createdAt: 275,
                },
              ]
            : [];
        if (mappedRoot === "repository") {
          await mkdir(path.dirname(repoPath), { recursive: true });
          await symlink(outside, repoPath, process.platform === "win32" ? "junction" : "dir");
        } else {
          await mkdir(repoPath, { recursive: true });
          await mkdir(path.dirname(worktreePath), { recursive: true });
          await symlink(
            outside,
            worktreePath,
            process.platform === "win32" ? "junction" : "dir",
          );
        }
        await writeFile(workspacePath, `${JSON.stringify(document, undefined, 2)}\n`, "utf-8");

        const loader = new WorkspaceManager({
          defaultSourcePath: root,
          projectsRoot: path.join(root, "loader-index"),
          autoOpenDefault: false,
        });
        await expect(loader.inspectCanvasProject(projectRoot)).rejects.toThrow("不安全的映射");
        await expect(loader.openCanvasProject({ projectRoot })).rejects.toThrow("不安全的映射");
        await expect(lstat(path.join(outside, ".agent-docs"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("rejects a worktree replaced by an outside junction before agent preparation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-worktree-root-swap-"));
    const source = path.join(root, "source-repo");
    const projectRoot = path.join(root, "project");
    const outside = path.join(root, "outside-worktree");
    await Promise.all([mkdir(source, { recursive: true }), mkdir(outside, { recursive: true })]);
    const runGit: GitRunner = async (args, options) => {
      if (args[0] === "remote") return "https://github.com/acme/worktree-root-swap.git";
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
      const manager = new WorkspaceManager({ defaultSourcePath: source, projectRoot, runGit });
      const workspace = (await manager.connect({ localPath: source })).branches[0]!;
      await rm(workspace.worktreePath, { recursive: true, force: true });
      await symlink(
        outside,
        workspace.worktreePath,
        process.platform === "win32" ? "junction" : "dir",
      );

      await expect(
        manager.prepareAgentWorkspace(
          "agent_1",
          { branchWorkspaceId: workspace.id },
          { workDocumentationEnabled: true },
        ),
      ).rejects.toThrow("不安全的映射");
      await expect(lstat(path.join(outside, ".agent-tmp"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(lstat(path.join(outside, ".agent-docs"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  (CASE_DISTINCT_TEST_FILESYSTEM ? it : it.skip).each([
    "no-origin fallback",
    "file URL origin",
    "relative origin",
  ] as const)(
    "keeps case-distinct local repositories in separate documentation roots (%s)",
    async (identityMode) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-doc-repo-case-"));
      const upperSource = path.join(root, "Repo");
      const lowerSource = path.join(root, "repo");
      const projectRoot = path.join(root, "project");
      await mkdir(upperSource, { recursive: true });
      await mkdir(lowerSource, { recursive: true });

      try {
        const [upperRealPath, lowerRealPath] = await Promise.all([
          realpath(upperSource),
          realpath(lowerSource),
        ]);
        expect(upperRealPath).not.toBe(lowerRealPath);

        const runGit: GitRunner = async (args, options) => {
          if (args[0] === "remote") {
            if (identityMode === "no-origin fallback") {
              throw new Error("repository has no origin");
            }
            if (identityMode === "relative origin") return ".";
            return pathToFileURL(String(options?.cwd)).href;
          }
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
        const manager = new WorkspaceManager({
          defaultSourcePath: upperSource,
          projectRoot,
          runGit,
        });

        const firstProject = await manager.connect({ localPath: upperSource });
        await manager.prepareWorkDocumentationForAllBranches();
        const firstMount = path.join(
          firstProject.branches[0]!.worktreePath,
          ".agent-shared-docs",
        );
        const firstTarget = await realpath(firstMount);
        const sentinel = path.join(firstTarget, "first-repository.md");
        await writeFile(sentinel, "first repository only\n", "utf-8");

        // Reconnecting the single-repository project reuses its fixed worktree path. Remove
        // only that generated checkout/mount while retaining the first shared source as proof.
        await rm(firstMount, { force: true });
        await rm(firstProject.branches[0]!.worktreePath, {
          recursive: true,
          force: true,
        });
        await rm(path.join(projectRoot, "repos", "repo_1", "repo"), {
          recursive: true,
          force: true,
        });
        const secondProject = await manager.connect({ localPath: lowerSource });
        await manager.prepareWorkDocumentationForAllBranches();
        const secondMount = path.join(
          secondProject.branches[0]!.worktreePath,
          ".agent-shared-docs",
        );
        const secondTarget = await realpath(secondMount);

        expect(secondTarget).not.toBe(firstTarget);
        await expect(readFile(sentinel, "utf-8")).resolves.toContain("first repository only");
        await expect(
          readFile(path.join(secondTarget, "first-repository.md"), "utf-8"),
        ).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  (CASE_DISTINCT_TEST_FILESYSTEM ? it : it.skip)(
    "keeps case-distinct explicit project roots as separate project identities",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-project-root-case-"));
      const upperProject = path.join(root, "Upper", "repo");
      const lowerProject = path.join(root, "upper", "repo");
      const projectsRoot = path.join(root, "index");
      try {
        const manager = new WorkspaceManager({
          defaultSourcePath: root,
          projectsRoot,
          autoOpenDefault: false,
        });
        const first = await manager.createCanvasProject({
          name: "Upper project",
          projectRoot: upperProject,
        });
        const second = await manager.createCanvasProject({
          name: "Lower project",
          projectRoot: lowerProject,
        });

        expect(first.id).not.toBe(second.id);
        expect((await manager.listCanvasProjects()).map((project) => project.id).sort())
          .toEqual([first.id, second.id].sort());
        await manager.deleteCanvasProject(first.id);
        await expect(manager.listCanvasProjects()).resolves.toEqual([second]);
        await expect(lstat(path.join(lowerProject, "workspace.json"))).resolves.toMatchObject({
          isFile: expect.any(Function),
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("resolves a relative local origin against its source repository", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-doc-relative-origin-"));
    const source = path.join(root, "source", "worktree");
    const projectRoot = path.join(root, "project");
    await mkdir(source, { recursive: true });
    const runGit: GitRunner = async (args, options) => {
      if (args[0] === "remote") return "../Repository";
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
      const workspace = await manager.connect({ localPath: source });
      expect(workspace.repo?.remoteUrl).toBe(path.resolve(source, "../Repository"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("waits for in-progress documentation writes before switching projects", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-doc-project-race-"));
    const source = path.join(root, "source-repo");
    const projectsRoot = path.join(root, "projects");
    await mkdir(source, { recursive: true });
    let blockDocumentation = false;
    let documentationChecks = 0;
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
        documentationChecks += 1;
        if (documentationChecks === 2) {
          blockDocumentation = false;
          signalBlocked();
          await released;
        }
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
      const preparing = manager.prepareWorkDocumentationForAllBranches();
      await blocked;

      await expect(
        readFile(path.join(workspaceA.worktreePath, ".agent-docs", "index.md"), "utf-8"),
      ).resolves.toContain("main");
      let switchSettled = false;
      const switching = manager.createCanvasProject({ name: "Project B" });
      void switching.then(
        () => {
          switchSettled = true;
        },
        () => {
          switchSettled = true;
        },
      );
      await Promise.resolve();
      expect(switchSettled).toBe(false);
      expect(manager.currentProjectId()).toBe(projectA.id);
      releaseDocumentation();
      await expect(preparing).resolves.toBeUndefined();
      const projectB = await switching;

      await expect(
        lstat(path.join(projectA.projectRoot, "shared", "_agent-canvas")),
      ).resolves.toMatchObject({ isDirectory: expect.any(Function) });
      await expect(
        lstat(path.join(projectB.projectRoot, "shared", "_agent-canvas")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      releaseDocumentation?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("waits for in-progress documentation writes before deleting their project", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-doc-delete-race-"));
    const source = path.join(root, "source-repo");
    const projectsRoot = path.join(root, "projects");
    await mkdir(source, { recursive: true });
    let blockDocumentation = false;
    let documentationChecks = 0;
    let signalBlocked!: () => void;
    let releaseDocumentation!: () => void;
    const blocked = new Promise<void>((resolve) => {
      signalBlocked = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseDocumentation = resolve;
    });
    const runGit: GitRunner = async (args, options) => {
      if (args[0] === "remote") return "https://github.com/acme/project-delete-race.git";
      if (args[0] === "branch") return "main";
      if (args[0] === "clone") {
        await mkdir(path.join(String(args[2]), ".git", "info"), { recursive: true });
        return "";
      }
      if (args[0] === "rev-parse") {
        return path.join(options?.cwd ?? "", ".git", "info", "exclude");
      }
      if (args[0] === "ls-files" && blockDocumentation) {
        documentationChecks += 1;
        if (documentationChecks === 2) {
          blockDocumentation = false;
          signalBlocked();
          await released;
        }
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
      const project = await manager.createCanvasProject({ name: "Delete Me" });
      await manager.connect({ localPath: source });
      blockDocumentation = true;
      const preparing = manager.prepareWorkDocumentationForAllBranches();
      await blocked;

      await expect(
        lstat(path.join(project.projectRoot, "shared", "_agent-canvas")),
      ).resolves.toMatchObject({ isDirectory: expect.any(Function) });
      let deleteSettled = false;
      const deleting = manager.deleteCanvasProject(project.id);
      void deleting.then(
        () => {
          deleteSettled = true;
        },
        () => {
          deleteSettled = true;
        },
      );
      await Promise.resolve();
      expect(deleteSettled).toBe(false);
      expect(manager.currentProjectId()).toBe(project.id);

      releaseDocumentation();
      await expect(preparing).resolves.toBeUndefined();
      await expect(deleting).resolves.toEqual(project);
      await expect(lstat(project.projectRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      releaseDocumentation?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps shared-resource creation bound to its project while a switch is queued", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-resource-project-race-"));
    const source = path.join(root, "source-repo");
    const projectsRoot = path.join(root, "projects");
    await mkdir(source, { recursive: true });
    let blockResourceMount = false;
    let signalBlocked!: () => void;
    let releaseResource!: () => void;
    const blocked = new Promise<void>((resolve) => {
      signalBlocked = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseResource = resolve;
    });
    const runGit: GitRunner = async (args, options) => {
      if (args[0] === "remote") return "https://github.com/acme/resource-project-race.git";
      if (args[0] === "branch") return "main";
      if (args[0] === "clone") {
        await mkdir(path.join(String(args[2]), ".git", "info"), { recursive: true });
        return "";
      }
      if (args[0] === "rev-parse") {
        if (blockResourceMount) {
          blockResourceMount = false;
          signalBlocked();
          await released;
        }
        return path.join(options?.cwd ?? "", ".git", "info", "exclude");
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
      blockResourceMount = true;
      const creatingResource = manager.createSharedResource({
        name: "Dataset",
        mountPath: ".agent-resources/dataset",
        access: "readOnly",
      });
      await blocked;

      let switchSettled = false;
      const switching = manager.createCanvasProject({ name: "Project B" });
      void switching.then(
        () => {
          switchSettled = true;
        },
        () => {
          switchSettled = true;
        },
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      expect(switchSettled).toBe(false);
      expect(manager.currentProjectId()).toBe(projectA.id);

      releaseResource();
      const resource = await creatingResource;
      await switching;
      expect((await manager.project()).sharedResources).toEqual([]);

      const reopenedA = await manager.openCanvasProject({ id: projectA.id });
      expect(reopenedA.sharedResources).toContainEqual(
        expect.objectContaining({ id: resource.id, sourcePath: resource.sourcePath }),
      );
      await expect(
        realpath(path.join(workspaceA.worktreePath, ".agent-resources", "dataset")),
      ).resolves.toBe(await realpath(resource.sourcePath));
    } finally {
      releaseResource?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a shared documentation source mapped outside the project", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-doc-boundary-"));
    const source = path.join(root, "source-repo");
    const projectRoot = path.join(root, "project");
    const outside = path.join(root, "outside");
    const remoteUrl = "https://GitHub.com/Acme/Doc-Boundary.git";
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

  it.each(["git-file", "git-junction", "repository-junction"] as const)(
    "rejects a live repository %s replacement before branch, PR, or changed-file Git operations",
    async (replacement) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-live-git-boundary-"));
      const source = path.join(root, "source-repo");
      const projectRoot = path.join(root, "project");
      const outside = path.join(root, "outside-repository");
      const sentinelPath = path.join(outside, "sentinel.txt");
      const calls: string[][] = [];
      await Promise.all([
        mkdir(source, { recursive: true }),
        mkdir(path.join(outside, ".git", "info"), { recursive: true }),
      ]);
      await writeFile(sentinelPath, "outside repository\n", "utf-8");
      const runGit: GitRunner = async (args, options) => {
        calls.push(args.map(String));
        if (args[0] === "remote") return "https://github.com/acme/live-boundary.git";
        if (args[0] === "branch") return "main";
        if (args[0] === "clone") {
          await mkdir(path.join(String(args[2]), ".git", "info"), { recursive: true });
          return "";
        }
        if (
          args[0] === "fetch" ||
          args[0] === "update-ref" ||
          (args[0] === "worktree" && args[1] !== "list")
        ) {
          await writeFile(sentinelPath, "mutated by Git\n", "utf-8");
        }
        if (args[0] === "rev-parse") {
          if (args[1] === "--verify") return "a".repeat(40);
          return path.join(options?.cwd ?? "", ".git", "info", "exclude");
        }
        return "";
      };

      try {
        const manager = new WorkspaceManager({ defaultSourcePath: source, projectRoot, runGit });
        const project = await manager.connect({ localPath: source });
        const repositoryPath = project.repo!.localRepoPath;
        if (replacement === "repository-junction") {
          await rm(repositoryPath, { recursive: true, force: true });
          await symlink(
            outside,
            repositoryPath,
            process.platform === "win32" ? "junction" : "dir",
          );
        } else {
          const gitPath = path.join(repositoryPath, ".git");
          await rm(gitPath, { recursive: true, force: true });
          if (replacement === "git-file") {
            await writeFile(gitPath, `gitdir: ${path.join(outside, ".git")}\n`, "utf-8");
          } else {
            await symlink(
              path.join(outside, ".git"),
              gitPath,
              process.platform === "win32" ? "junction" : "dir",
            );
          }
        }
        const callsBeforeRejectedOperations = calls.length;

        await expect(manager.createBranch({ branch: "feature/unsafe" })).rejects.toThrow();
        await expect(
          manager.ensurePullRequestBranchesReady("feature/unsafe", "main"),
        ).rejects.toThrow();
        await expect(
          manager.changedFilesForCommit("a".repeat(40), "feature/unsafe"),
        ).rejects.toThrow();

        expect(calls).toHaveLength(callsBeforeRejectedOperations);
        await expect(readFile(sentinelPath, "utf-8")).resolves.toBe("outside repository\n");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("maps one read-write shared resource into every real git branch worktree", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-real-git-"));
    const source = path.join(root, "source-repo");
    const remote = path.join(root, "remote.git");
    const projectRoot = path.join(root, "project");
    let refUpdateAfterWorktreeRemoval:
      | { worktreePath: string; ref: string; sha: string }
      | undefined;

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

      const managerGit: GitRunner = async (args, options) => {
        const cwd = options?.cwd ?? source;
        const result = await runGit(args, cwd);
        const pending = refUpdateAfterWorktreeRemoval;
        if (
          pending &&
          args[0] === "worktree" &&
          args[1] === "remove" &&
          args[2] === "--force" &&
          sameTestPath(String(args[3]), pending.worktreePath)
        ) {
          refUpdateAfterWorktreeRemoval = undefined;
          await runGit(["update-ref", pending.ref, pending.sha], cwd);
        }
        return result;
      };
      const manager = new WorkspaceManager({
        defaultSourcePath: source,
        projectRoot,
        runGit: managerGit,
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
      const rollbackGuard = await manager.createSharedResource({
        name: "rollback guard",
        mountPath: "shared/rollback-guard",
      });
      const failedBranch = "feature/rollback-real";
      const failedWorktree = path.join(
        projectRoot,
        "worktrees",
        "repo_1",
        "feature-rollback-real",
      );
      const failedFirstMount = path.join(failedWorktree, resource.mountPath);
      const displacedGuardSource = `${rollbackGuard.sourcePath}-displaced`;
      await expect(
        runGit(["show-ref", "--verify", `refs/heads/${failedBranch}`], main.worktreePath),
      ).rejects.toThrow();
      setAfterManagedMountPublished(async (_sourcePath, createdMountPath) => {
        if (!sameTestPath(createdMountPath, failedFirstMount)) return;
        clearAfterManagedMountPublished();
        await rename(rollbackGuard.sourcePath, displacedGuardSource);
      });

      await expect(manager.createBranch({ branch: failedBranch })).rejects.toThrow();

      await expect(lstat(failedWorktree)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        runGit(["show-ref", "--verify", `refs/heads/${failedBranch}`], main.worktreePath),
      ).rejects.toThrow();
      await rename(displacedGuardSource, rollbackGuard.sourcePath);

      const existingFailedBranch = "feature/rollback-existing";
      await runGit(["branch", existingFailedBranch, "main"], main.worktreePath);
      const existingRefBefore = await runGit(
        ["rev-parse", `refs/heads/${existingFailedBranch}`],
        main.worktreePath,
      );
      const existingFailedWorktree = path.join(
        projectRoot,
        "worktrees",
        "repo_1",
        "feature-rollback-existing",
      );
      const existingFirstMount = path.join(existingFailedWorktree, resource.mountPath);
      setAfterManagedMountPublished(async (_sourcePath, createdMountPath) => {
        if (!sameTestPath(createdMountPath, existingFirstMount)) return;
        clearAfterManagedMountPublished();
        await rename(rollbackGuard.sourcePath, displacedGuardSource);
      });

      await expect(
        manager.createBranch({
          branch: existingFailedBranch,
          baseBranch: "feature/a",
        }),
      ).rejects.toThrow();

      await expect(lstat(existingFailedWorktree)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        runGit(["rev-parse", `refs/heads/${existingFailedBranch}`], main.worktreePath),
      ).resolves.toBe(existingRefBefore);
      await rename(displacedGuardSource, rollbackGuard.sourcePath);

      const featureASha = await runGit(["rev-parse", "feature/a"], main.worktreePath);
      const featureATree = await runGit(
        ["rev-parse", `${featureASha}^{tree}`],
        main.worktreePath,
      );
      const concurrentSha = await runGit(
        ["commit-tree", featureATree, "-p", featureASha, "-m", "concurrent ref update"],
        main.worktreePath,
      );

      const concurrentNewBranch = "feature/rollback-concurrent-new";
      const concurrentNewRef = `refs/heads/${concurrentNewBranch}`;
      const concurrentNewWorktree = path.join(
        projectRoot,
        "worktrees",
        "repo_1",
        "feature-rollback-concurrent-new",
      );
      const concurrentNewFirstMount = path.join(
        concurrentNewWorktree,
        resource.mountPath,
      );
      setAfterManagedMountPublished(async (_sourcePath, createdMountPath) => {
        if (!sameTestPath(createdMountPath, concurrentNewFirstMount)) return;
        clearAfterManagedMountPublished();
        await rename(rollbackGuard.sourcePath, displacedGuardSource);
      });
      refUpdateAfterWorktreeRemoval = {
        worktreePath: concurrentNewWorktree,
        ref: concurrentNewRef,
        sha: concurrentSha,
      };

      await expect(
        manager.createBranch({ branch: concurrentNewBranch }),
      ).rejects.toThrow("rollback was incomplete");

      expect(refUpdateAfterWorktreeRemoval).toBeUndefined();
      await expect(lstat(concurrentNewWorktree)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        runGit(["rev-parse", concurrentNewRef], main.worktreePath),
      ).resolves.toBe(concurrentSha);
      await runGit(["update-ref", "-d", concurrentNewRef, concurrentSha], main.worktreePath);
      await rename(displacedGuardSource, rollbackGuard.sourcePath);

      const concurrentExistingBranch = "feature/rollback-concurrent-existing";
      const concurrentExistingRef = `refs/heads/${concurrentExistingBranch}`;
      await runGit(["branch", concurrentExistingBranch, "main"], main.worktreePath);
      const concurrentExistingWorktree = path.join(
        projectRoot,
        "worktrees",
        "repo_1",
        "feature-rollback-concurrent-existing",
      );
      const concurrentExistingFirstMount = path.join(
        concurrentExistingWorktree,
        resource.mountPath,
      );
      setAfterManagedMountPublished(async (_sourcePath, createdMountPath) => {
        if (!sameTestPath(createdMountPath, concurrentExistingFirstMount)) return;
        clearAfterManagedMountPublished();
        await rename(rollbackGuard.sourcePath, displacedGuardSource);
      });
      refUpdateAfterWorktreeRemoval = {
        worktreePath: concurrentExistingWorktree,
        ref: concurrentExistingRef,
        sha: concurrentSha,
      };

      await expect(
        manager.createBranch({
          branch: concurrentExistingBranch,
          baseBranch: "feature/a",
        }),
      ).rejects.toThrow("rollback was incomplete");

      expect(refUpdateAfterWorktreeRemoval).toBeUndefined();
      await expect(lstat(concurrentExistingWorktree)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        runGit(["rev-parse", concurrentExistingRef], main.worktreePath),
      ).resolves.toBe(concurrentSha);
      await runGit(
        ["update-ref", "-d", concurrentExistingRef, concurrentSha],
        main.worktreePath,
      );
      await rename(displacedGuardSource, rollbackGuard.sourcePath);
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
      clearAfterManagedMountPublished();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

function worktreeAddPath(args: string[]): string {
  const newBranchIndex = args.indexOf("-b");
  const detachedIndex = args.indexOf("--detach");
  const value =
    newBranchIndex >= 0
      ? args[newBranchIndex + 2]
      : detachedIndex >= 0
        ? args[detachedIndex + 1]
      : args[args.indexOf("--no-checkout") + 1];
  if (!value) throw new Error(`Missing worktree path in: ${args.join(" ")}`);
  return value;
}

function createFakeWorkspaceGit(remoteUrl: string): GitRunner {
  return async (args, options) => {
    if (args[0] === "remote") return remoteUrl;
    if (args[0] === "branch") return "main";
    if (args[0] === "clone") {
      await mkdir(path.join(String(args[2]), ".git", "info"), { recursive: true });
      return "";
    }
    if (args[0] === "worktree" && args[1] === "add") {
      await mkdir(path.join(worktreeAddPath(args), ".git", "info"), { recursive: true });
      return "";
    }
    if (args[0] === "worktree" && args[1] === "move") {
      await rename(String(args[2]), String(args[3]));
      return "";
    }
    if (args[0] === "rev-parse") {
      if (args[1] === "--verify") return "a".repeat(40);
      return path.join(options?.cwd ?? "", ".git", "info", "exclude");
    }
    return "";
  };
}

function sameTestPath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function testFilesystemPreservesCaseDistinctDirectories(): boolean {
  const root = mkdtempSync(path.join(os.tmpdir(), "agent-canvas-case-probe-"));
  try {
    const upper = path.join(root, "Repo");
    const lower = path.join(root, "repo");
    mkdirSync(upper, { recursive: true });
    mkdirSync(lower, { recursive: true });
    const upperOnlyFile = path.join(upper, "upper-only");
    writeFileSync(upperOnlyFile, "probe\n", "utf-8");
    return !existsSync(path.join(lower, "upper-only"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function testFilesystemSupportsFileSymlinks(): boolean {
  const root = mkdtempSync(path.join(os.tmpdir(), "agent-canvas-symlink-probe-"));
  try {
    symlinkSync(path.join(root, "missing-target"), path.join(root, "probe-link"), "file");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

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
