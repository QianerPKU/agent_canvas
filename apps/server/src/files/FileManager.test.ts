import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileManager } from "./FileManager.js";
import { captureManagedTrustedRootBoundary } from "../workspaces/safeManagedFile.js";

describe("FileManager", () => {
  let root = "";
  let manager: FileManager;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-files-"));
    manager = new FileManager({
      workspaceRoot: root,
      isolatedRoot: path.join(root, "isolated"),
      now: () => 100,
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("创建隔离文本文件、预览并重命名真实文件", async () => {
    const file = await manager.create({
      name: "notes",
      extension: "txt",
      storage: "isolated",
      kind: "normal",
    });
    await writeFile(file.path, "hello file node", "utf-8");

    expect(await manager.readPreview(file.id)).toEqual({
      content: "hello file node",
      truncated: false,
    });
    expect(await manager.readContent(file.id)).toEqual({
      content: "hello file node",
      truncated: false,
    });

    const renamed = await manager.update(file.id, { name: "summary", extension: "md" });
    expect(renamed.filename).toBe("summary.md");
    expect(await readFile(renamed.path, "utf-8")).toBe("hello file node");
  });

  it("rejects a persisted project-root swap before creating an isolated file", async () => {
    const actualRoot = path.join(root, "actual-project");
    const outsideRoot = path.join(root, "outside-project");
    const linkedRoot = path.join(root, "linked-project");
    await mkdir(actualRoot);
    await mkdir(outsideRoot);
    await symlink(
      actualRoot,
      linkedRoot,
      process.platform === "win32" ? "junction" : "dir",
    );
    const boundary = await captureManagedTrustedRootBoundary(linkedRoot, "project root");
    manager = new FileManager({
      isolatedRoot: path.join(linkedRoot, "files"),
      trustedRoot: linkedRoot,
      trustedRootBoundary: boundary,
    });
    await rm(linkedRoot);
    await symlink(
      outsideRoot,
      linkedRoot,
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(
      manager.create({ name: "sentinel", extension: "txt", kind: "normal" }),
    ).rejects.toThrow(/persisted trusted root/u);
    await expect(lstat(path.join(outsideRoot, "files"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("never replaces an existing rename target", async () => {
    const file = await manager.create({ name: "source", extension: "txt", kind: "normal" });
    await writeFile(file.path, "source content", "utf-8");
    const targetPath = path.join(path.dirname(file.path), "target.txt");
    await writeFile(targetPath, "concurrent target", "utf-8");

    await expect(manager.update(file.id, { name: "target" })).rejects.toThrow(
      /already exists/u,
    );

    expect(manager.get(file.id)?.path).toBe(file.path);
    await expect(readFile(file.path, "utf-8")).resolves.toBe("source content");
    await expect(readFile(targetPath, "utf-8")).resolves.toBe("concurrent target");
  });

  it("文件节点固定创建在隔离目录中", async () => {
    const file = await manager.create({
      name: "brief",
      extension: "md",
      kind: "normal",
    });

    expect(file.path).toBe(path.join(root, "isolated", file.id, "brief.md"));
    expect(file.storage).toBe("isolated");
  });

  it("creates agent result files with content and origin metadata", async () => {
    const file = await manager.createWithContent(
      {
        name: "result",
        extension: "md",
        kind: "normal",
      },
      "# Result",
      {
        origin: {
          kind: "agent_result",
          agentId: "agent_1",
          sourceTurnIndex: 2,
          resultKind: "document",
          summary: "experiment report",
        },
      },
    );

    expect(await readFile(file.path, "utf-8")).toBe("# Result");
    expect(file.origin).toMatchObject({
      kind: "agent_result",
      agentId: "agent_1",
      sourceTurnIndex: 2,
      resultKind: "document",
      summary: "experiment report",
    });
  });

  it("共享读写开关对全部 Agent 生效", async () => {
    const file = await manager.create({
      name: "shared",
      extension: "csv",
      storage: "isolated",
      kind: "shared",
    });
    await manager.update(file.id, { sharedRead: true, sharedWrite: true });

    const access = manager.accessFor("agent_1");
    expect(access.readableFiles).toEqual([
      expect.objectContaining({ name: "shared.csv", path: file.path }),
    ]);
    expect(access.writableFiles).toEqual([
      expect.objectContaining({ name: "shared.csv", path: file.path }),
    ]);
    expect(access.writableDirectories).toEqual([path.dirname(file.path)]);
  });

  it("普通节点按读写连线授权，并可复制给 fork Agent", async () => {
    const file = await manager.create({
      name: "input",
      extension: "json",
      storage: "isolated",
      kind: "normal",
    });
    manager.connect(file.id, "agent_1", "read");
    manager.connect(file.id, "agent_1", "write");
    manager.copyAgentConnections("agent_1", "agent_2");

    expect(manager.accessFor("agent_2")).toEqual({
      readableFiles: [
        expect.objectContaining({ name: "input.json", path: file.path }),
      ],
      readableDirectories: [],
      writableFiles: [
        expect.objectContaining({ name: "input.json", path: file.path }),
      ],
      writableDirectories: [path.dirname(file.path)],
      sharedResources: [],
    });
    expect(manager.listConnections().filter((item) => item.agentId === "agent_2")).toHaveLength(2);
  });

  it("rebuilds persisted paths from the active isolated root", async () => {
    const file = await manager.create({ name: "safe", extension: "txt", kind: "shared" });
    await writeFile(file.path, "safe content", "utf-8");
    const state = manager.exportState();
    state.files[0] = { ...state.files[0]!, path: path.join(root, "outside.txt") };

    const reloaded = new FileManager({ isolatedRoot: path.join(root, "isolated") });
    await reloaded.importState(state);

    expect(reloaded.get(file.id)?.path).toBe(file.path);
    await expect(reloaded.readContent(file.id)).resolves.toEqual({
      content: "safe content",
      truncated: false,
    });
  });

  it("rejects traversal identifiers from persisted file state", async () => {
    const file = await manager.create({ name: "safe", extension: "txt", kind: "normal" });
    const state = manager.exportState();
    state.files[0] = {
      ...state.files[0]!,
      id: "../../outside",
      path: path.join(root, "outside.txt"),
    };

    await expect(manager.importState(state)).rejects.toThrow("Invalid persisted file id");
  });

  it("rejects a pre-created file directory junction without touching outside data", async (context) => {
    const isolatedRoot = path.join(root, "isolated");
    const outside = path.join(root, "outside");
    const sentinel = path.join(outside, "sentinel.txt");
    await Promise.all([mkdir(isolatedRoot), mkdir(outside)]);
    await writeFile(sentinel, "outside", "utf-8");
    try {
      await symlink(
        outside,
        path.join(isolatedRoot, "file_1"),
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      if (["EPERM", "EACCES", "UNKNOWN"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        context.skip();
        return;
      }
      throw error;
    }

    await expect(
      manager.create({ name: "escaped", extension: "txt", kind: "normal" }),
    ).rejects.toThrow(/unsafe mapping/u);
    await expect(readFile(sentinel, "utf-8")).resolves.toBe("outside");
    await expect(lstat(path.join(outside, "escaped.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("revalidates a live file directory before granting agent access", async (context) => {
    const file = await manager.create({ name: "grant", extension: "txt", kind: "shared" });
    await manager.update(file.id, { sharedRead: true, sharedWrite: true });
    const directory = path.dirname(file.path);
    const displaced = `${directory}-displaced`;
    const outside = path.join(root, "outside-live-swap");
    await mkdir(outside);
    await writeFile(path.join(outside, file.filename), "outside", "utf-8");
    await rename(directory, displaced);
    try {
      await symlink(outside, directory, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      await rename(displaced, directory);
      if (["EPERM", "EACCES", "UNKNOWN"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        context.skip();
        return;
      }
      throw error;
    }

    expect(() => manager.accessFor("agent_1")).toThrow(/unsafe mapping/u);
    await expect(readFile(path.join(outside, file.filename), "utf-8")).resolves.toBe("outside");
  });

  it("allows only the explicitly trusted project-root junction", async (context) => {
    const actualProject = path.join(root, "actual-project");
    const linkedProject = path.join(root, "linked-project");
    await mkdir(actualProject);
    try {
      await symlink(
        actualProject,
        linkedProject,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      if (["EPERM", "EACCES", "UNKNOWN"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        context.skip();
        return;
      }
      throw error;
    }
    const linkedManager = new FileManager({
      isolatedRoot: path.join(linkedProject, "files"),
      trustedRoot: linkedProject,
    });

    const file = await linkedManager.create({ name: "inside", extension: "txt", kind: "normal" });

    expect(file.path).toBe(path.join(linkedProject, "files", "file_1", "inside.txt"));
    await expect(readFile(path.join(actualProject, "files", "file_1", "inside.txt"), "utf-8"))
      .resolves.toBe("");
  });

  it("rejects an intermediate files-directory junction during persisted import", async (context) => {
    const projectRoot = path.join(root, "project");
    const outside = path.join(root, "outside-import");
    await Promise.all([mkdir(projectRoot), mkdir(outside)]);
    const seed = new FileManager({ isolatedRoot: outside });
    const outsideFile = await seed.create({ name: "persisted", extension: "txt", kind: "shared" });
    await writeFile(outsideFile.path, "outside persisted data", "utf-8");
    try {
      await symlink(
        outside,
        path.join(projectRoot, "files"),
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      if (["EPERM", "EACCES", "UNKNOWN"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        context.skip();
        return;
      }
      throw error;
    }
    const target = new FileManager({
      isolatedRoot: path.join(projectRoot, "files"),
      trustedRoot: projectRoot,
    });

    await expect(target.importState(seed.exportState())).rejects.toThrow(/unsafe mapping/u);

    expect(target.list()).toEqual([]);
    await expect(readFile(outsideFile.path, "utf-8")).resolves.toBe("outside persisted data");
  });
});
