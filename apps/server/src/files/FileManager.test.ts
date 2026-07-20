import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FileManager,
  PickedFileSelectionExpiredError,
  resolvedFileSystemPathKey,
  type TrustedReferencedFileAuthorization,
} from "./FileManager.js";
import {
  captureManagedTrustedRootBoundary,
  writeManagedFileAtomically,
} from "../workspaces/safeManagedFile.js";

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
    await manager.disposeAccessSnapshots();
    await rm(root, { recursive: true, force: true });
  });

  it("keeps Windows case variants distinct in storage-root keys", () => {
    expect(
      resolvedFileSystemPathKey(String.raw`C:\Canvas\Files`, path.win32),
    ).not.toBe(
      resolvedFileSystemPathKey(String.raw`C:\canvas\files`, path.win32),
    );
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

  it("repins a safely validated file after an authorized atomic save", async () => {
    const file = await manager.create({ name: "agent-output", extension: "txt", kind: "shared" });
    await manager.update(file.id, { sharedRead: true, sharedWrite: true });

    await writeManagedFileAtomically(file.path, "saved atomically", {
      label: "authorized agent file save",
      expectedContent: "",
    });

    expect(manager.accessFor("agent_1")).toMatchObject({
      readableFiles: [expect.objectContaining({ path: file.path })],
      writableFiles: [expect.objectContaining({ path: file.path })],
      writableDirectories: [path.dirname(file.path)],
    });
    await expect(manager.readContent(file.id)).resolves.toEqual({
      content: "saved atomically",
      truncated: false,
    });

    const persisted = manager.exportState();
    const reloaded = new FileManager({ isolatedRoot: path.join(root, "isolated") });
    await reloaded.importState(persisted);
    await expect(reloaded.readContent(file.id)).resolves.toEqual({
      content: "saved atomically",
      truncated: false,
    });
  });

  it("preserves binary bytes when renaming a file node", async () => {
    const binary = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x41]);
    const file = await manager.createWithContent(
      { name: "binary-source", extension: "bin", kind: "normal" },
      binary,
    );

    const renamed = await manager.update(file.id, { name: "binary-target" });

    await expect(readFile(renamed.path)).resolves.toEqual(binary);
    await expect(lstat(file.path)).rejects.toMatchObject({ code: "ENOENT" });
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

  it("stages picked files once and copies their exact bytes into isolated storage", async () => {
    const sourcePath = path.join(root, "picked-report.bin");
    const content = Buffer.from([0x00, 0xff, 0x41, 0x80]);
    await writeFile(sourcePath, content);

    const selection = await manager.stagePickedFiles([sourcePath]);

    expect(selection).toEqual({
      id: expect.stringMatching(/^file_selection_/u),
      files: [
        {
          name: "picked-report",
          extension: "bin",
          filename: "picked-report.bin",
          size: content.length,
        },
      ],
    });

    const [file] = await manager.importPicked(selection.id, "copy", "normal");
    expect(file).toMatchObject({
      storage: "isolated",
      availability: "available",
      filename: "picked-report.bin",
    });
    expect(file!.path).toBe(path.join(root, "isolated", file!.id, "picked-report.bin"));
    await expect(readFile(file!.path)).resolves.toEqual(content);
    await expect(readFile(sourcePath)).resolves.toEqual(content);
    await expect(manager.importPicked(selection.id, "copy", "normal")).rejects.toThrow(
      /unknown or expired/iu,
    );
  });

  it("creates uploaded binary files without accepting a client path", async () => {
    const content = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    const file = await manager.createUploaded("Photo.JPG", content, "shared");

    expect(file).toMatchObject({
      name: "Photo",
      extension: "JPG",
      filename: "Photo.JPG",
      storage: "isolated",
      availability: "available",
      kind: "shared",
      mimeType: "image/jpeg",
    });
    await expect(readFile(file.path)).resolves.toEqual(content);
    await expect(
      manager.createUploaded(path.join("outside", "secret.txt"), content, "normal"),
    ).rejects.toThrow(/safe basename without a directory path/u);
  });

  it("references canonical picked files read-only and renames only node metadata", async () => {
    const sourcePath = path.join(root, "reference.txt");
    await writeFile(sourcePath, "live source", "utf-8");
    const selection = await manager.stagePickedFiles([sourcePath]);
    const [file] = await manager.importPicked(selection.id, "reference", "normal");

    expect(file).toMatchObject({
      path: await realpath(sourcePath),
      storage: "referenced",
      availability: "available",
      sharedWrite: false,
    });
    manager.connect(file!.id, "agent_1", "read");
    expect(manager.accessFor("agent_1").readableFiles).toEqual([]);
    await manager.prepareAccessFor("agent_1");
    const preparedAccess = manager.accessFor("agent_1");
    expect(preparedAccess).toMatchObject({
      readableFiles: [expect.objectContaining({ name: "reference.txt" })],
      writableFiles: [],
      writableDirectories: [],
    });
    expect(preparedAccess.readableFiles[0]!.path).not.toBe(await realpath(sourcePath));
    await expect(readFile(preparedAccess.readableFiles[0]!.path, "utf-8")).resolves.toBe(
      "live source",
    );
    expect(() => manager.connect(file!.id, "agent_1", "write")).toThrow(/read-only/u);
    await expect(manager.update(file!.id, { sharedWrite: true })).rejects.toThrow(
      /cannot grant shared write/u,
    );
    await expect(manager.update(file!.id, { extension: "md" })).rejects.toThrow(
      /derived from the source/u,
    );

    const renamed = await manager.update(file!.id, { name: "display-name" });
    expect(renamed).toMatchObject({
      name: "display-name",
      filename: "display-name.txt",
      path: await realpath(sourcePath),
    });
    await expect(readFile(sourcePath, "utf-8")).resolves.toBe("live source");
  });

  it("never grants directory write access to a shared referenced file", async () => {
    const sourcePath = path.join(root, "shared-reference.csv");
    await writeFile(sourcePath, "a,b\n1,2\n", "utf-8");
    const selection = await manager.stagePickedFiles([sourcePath]);
    const [file] = await manager.importPicked(selection.id, "reference", "shared");
    await manager.update(file!.id, { sharedRead: true });
    await manager.prepareAccessFor("agent_1");
    const preparedAccess = manager.accessFor("agent_1");

    expect(preparedAccess).toEqual({
      readableFiles: [
        expect.objectContaining({ name: "shared-reference.csv" }),
      ],
      readableDirectories: [path.dirname(preparedAccess.readableFiles[0]!.path)],
      writableFiles: [],
      writableDirectories: [],
      sharedResources: [],
    });
    await expect(manager.update(file!.id, { sharedWrite: true })).rejects.toThrow(
      /cannot grant shared write/u,
    );
  });

  it("exposes referenced files only through prepared immutable snapshots", async () => {
    const sourcePath = path.join(root, "snapshot-source.bin");
    const original = Buffer.from([0, 1, 2, 3, 255]);
    await writeFile(sourcePath, original);
    const selection = await manager.stagePickedFiles([sourcePath]);
    const [file] = await manager.importPicked(selection.id, "reference", "normal");
    manager.connect(file!.id, "agent_1", "read");
    const rawPath = await realpath(sourcePath);

    expect(manager.accessFor("agent_1")).toMatchObject({
      readableFiles: [],
      readableDirectories: [],
    });

    await manager.prepareAccessFor("agent_1");
    const prepared = manager.accessFor("agent_1");
    const snapshotPath = prepared.readableFiles[0]!.path;
    expect(snapshotPath).not.toBe(rawPath);
    expect(prepared.readableDirectories).toEqual([path.dirname(snapshotPath)]);
    await expect(readFile(snapshotPath)).resolves.toEqual(original);

    await rename(sourcePath, `${sourcePath}.displaced`);
    await writeFile(sourcePath, Buffer.from("replacement"));
    expect(manager.accessFor("agent_1").readableFiles[0]!.path).toBe(snapshotPath);
    await expect(readFile(snapshotPath)).resolves.toEqual(original);
  });

  it("places agent snapshots below the canonical operating-system temp directory", async () => {
    const sourcePath = path.join(root, "snapshot-canonical-temp.txt");
    await writeFile(sourcePath, "canonical temp", "utf-8");
    const selection = await manager.stagePickedFiles([sourcePath]);
    const [file] = await manager.importPicked(selection.id, "reference", "normal");
    manager.connect(file!.id, "agent_1", "read");

    await manager.prepareAccessFor("agent_1");
    const snapshotPath = manager.accessFor("agent_1").readableFiles[0]!.path;
    const canonicalTemp = await realpath(os.tmpdir());
    const relativeSnapshot = path.relative(canonicalTemp, snapshotPath);

    expect(relativeSnapshot).not.toBe("");
    expect(relativeSnapshot).not.toBe("..");
    expect(relativeSnapshot.startsWith(`..${path.sep}`)).toBe(false);
    expect(path.isAbsolute(relativeSnapshot)).toBe(false);
  });

  it("invalidates prepared access after an authorization graph mutation", async () => {
    const sourcePath = path.join(root, "snapshot-invalidated.txt");
    await writeFile(sourcePath, "prepared", "utf-8");
    const selection = await manager.stagePickedFiles([sourcePath]);
    const [file] = await manager.importPicked(selection.id, "reference", "normal");
    const connection = manager.connect(file!.id, "agent_1", "read");
    await manager.prepareAccessFor("agent_1");
    const oldSnapshot = manager.accessFor("agent_1").readableFiles[0]!.path;

    expect(manager.disconnect(connection.id)).toBe(true);
    expect(manager.accessFor("agent_1")).toMatchObject({
      readableFiles: [],
      readableDirectories: [],
    });
    await expect(readFile(oldSnapshot, "utf-8")).resolves.toBe("prepared");
  });

  it("rolls back an in-flight scope when its connection state changes", async () => {
    const sourcePath = path.join(root, "snapshot-stale-prepare.txt");
    await writeFile(sourcePath, "stale prepare", "utf-8");
    let armed = false;
    let connectionId = "";
    manager = new FileManager({
      isolatedRoot: path.join(root, "snapshot-stale-isolated"),
      readChunkObserver: ({ purpose }) => {
        if (purpose !== "preview" || !armed) return;
        armed = false;
        manager.disconnect(connectionId);
      },
    });
    const selection = await manager.stagePickedFiles([sourcePath]);
    const [file] = await manager.importPicked(selection.id, "reference", "normal");
    connectionId = manager.connect(file!.id, "agent_1", "read").id;
    await manager.prepareAccessFor("agent_1");
    const oldSnapshot = manager.accessFor("agent_1").readableFiles[0]!.path;
    const snapshotRoot = path.dirname(path.dirname(oldSnapshot));
    const oldScope = path.basename(path.dirname(oldSnapshot));

    armed = true;
    await expect(manager.prepareAccessFor("agent_1")).rejects.toThrow(/File access changed/u);
    expect(manager.accessFor("agent_1").readableFiles).toEqual([]);
    await expect(readdir(snapshotRoot)).resolves.toEqual([oldScope]);
  });

  it("keeps concurrent agent preparations and repeated scopes isolated", async () => {
    const sourcePath = path.join(root, "snapshot-agents.txt");
    await writeFile(sourcePath, "shared bytes", "utf-8");
    const selection = await manager.stagePickedFiles([sourcePath]);
    const [file] = await manager.importPicked(selection.id, "reference", "shared");
    await manager.update(file!.id, { sharedRead: true });

    await Promise.all([
      manager.prepareAccessFor("agent_1"),
      manager.prepareAccessFor("agent_2"),
    ]);
    const firstAgentPath = manager.accessFor("agent_1").readableFiles[0]!.path;
    const secondAgentPath = manager.accessFor("agent_2").readableFiles[0]!.path;
    expect(path.dirname(firstAgentPath)).not.toBe(path.dirname(secondAgentPath));

    await manager.prepareAccessFor("agent_1");
    const repeatedPath = manager.accessFor("agent_1").readableFiles[0]!.path;
    expect(path.dirname(repeatedPath)).not.toBe(path.dirname(firstAgentPath));
    await Promise.all([
      expect(readFile(firstAgentPath, "utf-8")).resolves.toBe("shared bytes"),
      expect(readFile(secondAgentPath, "utf-8")).resolves.toBe("shared bytes"),
      expect(readFile(repeatedPath, "utf-8")).resolves.toBe("shared bytes"),
    ]);
  });

  it("rejects an oversized referenced access snapshot without granting access", async () => {
    manager = new FileManager({
      isolatedRoot: path.join(root, "snapshot-limit-isolated"),
      maxPickedFileBytes: 3,
      maxPickedBatchBytes: 10,
    });
    const sourcePath = path.join(root, "snapshot-too-large.bin");
    await writeFile(sourcePath, Buffer.from([1, 2, 3, 4]));
    const selection = await manager.stagePickedFiles([sourcePath]);
    const [file] = await manager.importPicked(selection.id, "reference", "normal");
    manager.connect(file!.id, "agent_1", "read");

    await expect(manager.prepareAccessFor("agent_1")).rejects.toThrow(/3 byte read limit/u);
    expect(manager.accessFor("agent_1")).toMatchObject({
      readableFiles: [],
      readableDirectories: [],
    });
  });

  it("rolls back a partial scope when referenced snapshot batch limits are exceeded", async () => {
    manager = new FileManager({
      isolatedRoot: path.join(root, "snapshot-batch-isolated"),
      maxPickedFileBytes: 4,
      maxPickedBatchBytes: 5,
    });
    const firstPath = path.join(root, "snapshot-batch-a.bin");
    const secondPath = path.join(root, "snapshot-batch-b.bin");
    await Promise.all([
      writeFile(firstPath, Buffer.from([1, 2, 3])),
      writeFile(secondPath, Buffer.from([4, 5, 6])),
    ]);
    const selection = await manager.stagePickedFiles([firstPath, secondPath]);
    const [first, second] = await manager.importPicked(selection.id, "reference", "normal");
    manager.connect(first!.id, "agent_1", "read");
    await manager.prepareAccessFor("agent_1");
    const oldSnapshot = manager.accessFor("agent_1").readableFiles[0]!.path;
    const snapshotRoot = path.dirname(path.dirname(oldSnapshot));
    const oldScope = path.basename(path.dirname(oldSnapshot));

    manager.connect(second!.id, "agent_1", "read");
    await expect(manager.prepareAccessFor("agent_1")).rejects.toThrow(/5 byte snapshot limit/u);
    expect(manager.accessFor("agent_1").readableFiles).toEqual([]);
    await expect(readdir(snapshotRoot)).resolves.toEqual([oldScope]);
    await expect(readFile(oldSnapshot)).resolves.toEqual(Buffer.from([1, 2, 3]));
  });

  it("keeps a partial unpublished scope discoverable by final cleanup when rollback fails", async () => {
    let snapshotRoot = "";
    let blockCleanup = true;
    manager = new FileManager({
      isolatedRoot: path.join(root, "snapshot-partial-cleanup-isolated"),
      maxPickedFileBytes: 4,
      maxPickedBatchBytes: 5,
      accessSnapshotPathRemover: async (targetPath) => {
        snapshotRoot ||= path.dirname(targetPath);
        if (blockCleanup) {
          throw Object.assign(new Error("injected snapshot rollback EBUSY"), {
            code: "EBUSY",
          });
        }
        await rm(targetPath, { recursive: true, force: true });
      },
    });
    const firstPath = path.join(root, "snapshot-partial-cleanup-a.bin");
    const secondPath = path.join(root, "snapshot-partial-cleanup-b.bin");
    await Promise.all([
      writeFile(firstPath, Buffer.from([1, 2, 3])),
      writeFile(secondPath, Buffer.from([4, 5, 6])),
    ]);
    const selection = await manager.stagePickedFiles([firstPath, secondPath]);
    const [first, second] = await manager.importPicked(selection.id, "reference", "normal");
    manager.connect(first!.id, "agent_1", "read");
    manager.connect(second!.id, "agent_1", "read");

    let preparationError: unknown;
    try {
      await manager.prepareAccessFor("agent_1");
    } catch (error) {
      preparationError = error;
    }
    expect(preparationError).toBeInstanceOf(AggregateError);
    const rollbackErrors = (preparationError as AggregateError).errors as unknown[];
    expect((rollbackErrors[0] as Error).message).toMatch(/5 byte snapshot limit/u);
    expect((rollbackErrors[1] as Error).message).toMatch(/injected snapshot rollback EBUSY/u);
    expect(manager.accessFor("agent_1").readableFiles).toEqual([]);
    const [leakedScope] = await readdir(snapshotRoot);
    expect(leakedScope).toBeTruthy();
    await expect(readdir(path.join(snapshotRoot, leakedScope!))).resolves.toHaveLength(1);

    await expect(manager.prepareAccessFor("agent_1")).rejects.toThrow(
      /injected snapshot rollback EBUSY/u,
    );
    await expect(readdir(snapshotRoot)).resolves.toEqual([leakedScope]);
    blockCleanup = false;
    await manager.disposeAccessSnapshots();
    await expect(lstat(snapshotRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("disposes all prepared access snapshot scopes", async () => {
    const sourcePath = path.join(root, "snapshot-dispose.txt");
    await writeFile(sourcePath, "dispose", "utf-8");
    const selection = await manager.stagePickedFiles([sourcePath]);
    const [file] = await manager.importPicked(selection.id, "reference", "normal");
    manager.connect(file!.id, "agent_1", "read");
    await manager.prepareAccessFor("agent_1");
    const snapshotPath = manager.accessFor("agent_1").readableFiles[0]!.path;
    const snapshotRoot = path.dirname(path.dirname(snapshotPath));

    await manager.disposeAccessSnapshots();
    await expect(lstat(snapshotRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect(manager.accessFor("agent_1")).toMatchObject({
      readableFiles: [],
      readableDirectories: [],
    });
  });

  it("refuses to retire a replaced snapshot scope and leaves the replacement untouched", async () => {
    const sourcePath = path.join(root, "snapshot-scope-ownership.txt");
    await writeFile(sourcePath, "owned scope", "utf-8");
    const selection = await manager.stagePickedFiles([sourcePath]);
    const [file] = await manager.importPicked(selection.id, "reference", "normal");
    manager.connect(file!.id, "agent_1", "read");
    await manager.prepareAccessFor("agent_1");
    const snapshotPath = manager.accessFor("agent_1").readableFiles[0]!.path;
    const scopePath = path.dirname(snapshotPath);
    const displacedScope = `${scopePath}.displaced`;
    const sentinel = path.join(scopePath, "replacement-sentinel.txt");
    const checkpoint = manager.captureAccessCheckpoint("agent_1");

    await rename(scopePath, displacedScope);
    await mkdir(scopePath);
    await writeFile(sentinel, "do not delete", "utf-8");
    try {
      await expect(manager.retireAccessThrough(checkpoint)).rejects.toThrow(
        /scope changed or became unsafe/u,
      );
      await expect(readFile(sentinel, "utf-8")).resolves.toBe("do not delete");
      await expect(readFile(path.join(displacedScope, path.basename(snapshotPath)), "utf-8"))
        .resolves.toBe("owned scope");
    } finally {
      await rm(scopePath, { recursive: true, force: true });
      await rename(displacedScope, scopePath);
    }

    await expect(manager.retireAccessThrough(checkpoint)).resolves.toBeUndefined();
    await expect(lstat(snapshotPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to dispose a replaced snapshot root and retries after ownership is restored", async () => {
    const sourcePath = path.join(root, "snapshot-root-ownership.txt");
    await writeFile(sourcePath, "owned root", "utf-8");
    const selection = await manager.stagePickedFiles([sourcePath]);
    const [file] = await manager.importPicked(selection.id, "reference", "normal");
    manager.connect(file!.id, "agent_1", "read");
    await manager.prepareAccessFor("agent_1");
    const snapshotPath = manager.accessFor("agent_1").readableFiles[0]!.path;
    const snapshotRoot = path.dirname(path.dirname(snapshotPath));
    const displacedRoot = `${snapshotRoot}.displaced`;
    const sentinel = path.join(snapshotRoot, "replacement-sentinel.txt");

    await rename(snapshotRoot, displacedRoot);
    await mkdir(snapshotRoot);
    await writeFile(sentinel, "do not delete", "utf-8");
    try {
      await expect(manager.disposeAccessSnapshots()).rejects.toThrow(
        /root changed or became unsafe/u,
      );
      await expect(readFile(sentinel, "utf-8")).resolves.toBe("do not delete");
      await expect(
        readFile(
          path.join(displacedRoot, path.relative(snapshotRoot, snapshotPath)),
          "utf-8",
        ),
      ).resolves.toBe("owned root");
    } finally {
      await rm(snapshotRoot, { recursive: true, force: true });
      await rename(displacedRoot, snapshotRoot);
    }

    await expect(manager.disposeAccessSnapshots()).resolves.toBeUndefined();
    await expect(lstat(snapshotRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retries a failed root disposal while keeping preparation permanently closed", async () => {
    let removeCalls = 0;
    manager = new FileManager({
      isolatedRoot: path.join(root, "snapshot-dispose-retry-isolated"),
      accessSnapshotPathRemover: async (targetPath) => {
        removeCalls += 1;
        if (removeCalls === 1) {
          throw Object.assign(new Error("injected snapshot dispose EBUSY"), {
            code: "EBUSY",
          });
        }
        await rm(targetPath, { recursive: true, force: true });
      },
    });
    const sourcePath = path.join(root, "snapshot-dispose-retry.txt");
    await writeFile(sourcePath, "dispose retry", "utf-8");
    const selection = await manager.stagePickedFiles([sourcePath]);
    const [file] = await manager.importPicked(selection.id, "reference", "normal");
    manager.connect(file!.id, "agent_1", "read");
    await manager.prepareAccessFor("agent_1");
    const snapshotPath = manager.accessFor("agent_1").readableFiles[0]!.path;
    const snapshotRoot = path.dirname(path.dirname(snapshotPath));

    await expect(manager.disposeAccessSnapshots()).rejects.toThrow(
      /injected snapshot dispose EBUSY/u,
    );
    await expect(readFile(snapshotPath, "utf-8")).resolves.toBe("dispose retry");
    expect(manager.accessFor("agent_1").readableFiles).toEqual([]);
    await expect(manager.prepareAccessFor("agent_1")).rejects.toThrow(/disposed/u);

    await expect(manager.disposeAccessSnapshots()).resolves.toBeUndefined();
    // The successful retry removes the restored scope and then its now-empty root.
    expect(removeCalls).toBe(3);
    await expect(lstat(snapshotRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps retained scope accounting intact when project-reset cleanup fails", async () => {
    let failReset = true;
    manager = new FileManager({
      isolatedRoot: path.join(root, "snapshot-reset-retry-isolated"),
      maxRetainedAccessScopesPerAgent: 1,
      accessSnapshotPathRemover: async (targetPath) => {
        if (failReset) {
          failReset = false;
          throw Object.assign(new Error("injected snapshot reset EBUSY"), {
            code: "EBUSY",
          });
        }
        await rm(targetPath, { recursive: true, force: true });
      },
    });
    const sourcePath = path.join(root, "snapshot-reset-retry.txt");
    await writeFile(sourcePath, "reset retry", "utf-8");
    const selection = await manager.stagePickedFiles([sourcePath]);
    const [file] = await manager.importPicked(selection.id, "reference", "normal");
    manager.connect(file!.id, "agent_1", "read");
    await manager.prepareAccessFor("agent_1");
    const snapshotPath = manager.accessFor("agent_1").readableFiles[0]!.path;

    await expect(manager.importState(undefined)).rejects.toThrow(
      /injected snapshot reset EBUSY/u,
    );
    expect(manager.list()).toHaveLength(1);
    expect(manager.accessFor("agent_1").readableFiles).toEqual([]);
    await expect(readFile(snapshotPath, "utf-8")).resolves.toBe("reset retry");
    await expect(manager.prepareAccessFor("agent_1")).rejects.toThrow(
      /retained scope limit/u,
    );

    await expect(manager.importState(undefined)).resolves.toBeUndefined();
    expect(manager.list()).toEqual([]);
    await expect(lstat(snapshotPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("revokes target file capabilities while retaining a failed cleanup ledger for retry", async () => {
    let cleanupBlocked = true;
    manager = new FileManager({
      isolatedRoot: path.join(root, "snapshot-revoke-ledger-isolated"),
      accessSnapshotPathRemover: async (targetPath) => {
        if (cleanupBlocked) {
          throw Object.assign(new Error("injected fail-closed cleanup EBUSY"), {
            code: "EBUSY",
          });
        }
        await rm(targetPath, { recursive: true, force: true });
      },
    });
    const sourcePath = path.join(root, "snapshot-revoke-ledger.txt");
    const unusedPath = path.join(root, "snapshot-revoke-unused.txt");
    await Promise.all([
      writeFile(sourcePath, "target secret", "utf-8"),
      writeFile(unusedPath, "unused", "utf-8"),
    ]);
    const selection = await manager.stagePickedFiles([sourcePath]);
    const [file] = await manager.importPicked(selection.id, "reference", "normal");
    manager.connect(file!.id, "agent_1", "read");
    const unusedSelection = await manager.stagePickedFiles([unusedPath]);
    await manager.prepareAccessFor("agent_1");
    const snapshotPath = manager.accessFor("agent_1").readableFiles[0]!.path;

    await expect(manager.importState(undefined)).rejects.toThrow(
      /injected fail-closed cleanup EBUSY/u,
    );
    manager.revokeInMemoryAccess();

    expect(manager.list()).toEqual([]);
    expect(manager.listConnections()).toEqual([]);
    expect(manager.get(file!.id)).toBeUndefined();
    expect(manager.accessFor("agent_1").readableFiles).toEqual([]);
    expect(() => manager.pickedSelectionPaths(unusedSelection.id)).toThrow(
      /Unknown or expired/u,
    );
    await expect(manager.readContent(file!.id)).rejects.toThrow();
    await expect(readFile(snapshotPath, "utf-8")).resolves.toBe("target secret");

    cleanupBlocked = false;
    await expect(manager.importState(undefined)).resolves.toBeUndefined();
    await expect(lstat(snapshotPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the checkpoint scope for queued results and retires same-turn scopes explicitly", async () => {
    const sourcePath = path.join(root, "snapshot-checkpoint.txt");
    await writeFile(sourcePath, "checkpoint", "utf-8");
    const selection = await manager.stagePickedFiles([sourcePath]);
    const [file] = await manager.importPicked(selection.id, "reference", "normal");
    manager.connect(file!.id, "agent_1", "read");

    await manager.prepareAccessFor("agent_1");
    const firstPath = manager.accessFor("agent_1").readableFiles[0]!.path;
    const firstCheckpoint = manager.captureAccessCheckpoint("agent_1");
    await manager.retireAccessBefore(firstCheckpoint);
    await expect(readFile(firstPath, "utf-8")).resolves.toBe("checkpoint");
    expect(manager.accessFor("agent_1").readableFiles[0]!.path).toBe(firstPath);

    await manager.prepareAccessFor("agent_1");
    const secondPath = manager.accessFor("agent_1").readableFiles[0]!.path;
    const secondCheckpoint = manager.captureAccessCheckpoint("agent_1");
    expect(secondCheckpoint.sequence).toBeGreaterThan(firstCheckpoint.sequence);

    await manager.retireAccessBefore(secondCheckpoint);
    await expect(lstat(firstPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(secondPath, "utf-8")).resolves.toBe("checkpoint");
    expect(manager.accessFor("agent_1").readableFiles[0]!.path).toBe(secondPath);

    await manager.retireAccessThrough(secondCheckpoint);
    await expect(lstat(secondPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(manager.accessFor("agent_1").readableFiles).toEqual([]);
  });

  it("does not let a late fixed-checkpoint retirement remove a later scope", async () => {
    const sourcePath = path.join(root, "snapshot-late-retire.txt");
    await writeFile(sourcePath, "late retire", "utf-8");
    const selection = await manager.stagePickedFiles([sourcePath]);
    const [file] = await manager.importPicked(selection.id, "reference", "normal");
    manager.connect(file!.id, "agent_1", "read");

    await manager.prepareAccessFor("agent_1");
    const oldPath = manager.accessFor("agent_1").readableFiles[0]!.path;
    const oldCheckpoint = manager.captureAccessCheckpoint("agent_1");
    await manager.prepareAccessFor("agent_1");
    const laterPath = manager.accessFor("agent_1").readableFiles[0]!.path;

    await manager.retireAccessThrough(oldCheckpoint);
    await expect(lstat(oldPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(laterPath, "utf-8")).resolves.toBe("late retire");
    expect(manager.accessFor("agent_1").readableFiles[0]!.path).toBe(laterPath);
  });

  it("retries retained-scope retirement without dropping its ledger early", async () => {
    let failRetirement = true;
    manager = new FileManager({
      isolatedRoot: path.join(root, "snapshot-retire-retry-isolated"),
      accessSnapshotPathRemover: async (targetPath) => {
        if (failRetirement) {
          failRetirement = false;
          throw Object.assign(new Error("injected snapshot retire EBUSY"), {
            code: "EBUSY",
          });
        }
        await rm(targetPath, { recursive: true, force: true });
      },
    });
    const sourcePath = path.join(root, "snapshot-retire-retry.txt");
    await writeFile(sourcePath, "retire retry", "utf-8");
    const selection = await manager.stagePickedFiles([sourcePath]);
    const [file] = await manager.importPicked(selection.id, "reference", "normal");
    manager.connect(file!.id, "agent_1", "read");
    await manager.prepareAccessFor("agent_1");
    const snapshotPath = manager.accessFor("agent_1").readableFiles[0]!.path;
    const checkpoint = manager.captureAccessCheckpoint("agent_1");

    await expect(manager.retireAccessThrough(checkpoint)).rejects.toThrow(
      /injected snapshot retire EBUSY/u,
    );
    expect(manager.accessFor("agent_1").readableFiles[0]!.path).toBe(snapshotPath);
    await expect(readFile(snapshotPath, "utf-8")).resolves.toBe("retire retry");

    await expect(manager.retireAccessThrough(checkpoint)).resolves.toBeUndefined();
    expect(manager.accessFor("agent_1").readableFiles).toEqual([]);
    await expect(lstat(snapshotPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not allocate a scope when an agent has no referenced files", async () => {
    const sourcePath = path.join(root, "snapshot-zero-reference.txt");
    await writeFile(sourcePath, "zero", "utf-8");
    const selection = await manager.stagePickedFiles([sourcePath]);
    const [file] = await manager.importPicked(selection.id, "reference", "normal");
    const connection = manager.connect(file!.id, "agent_1", "read");
    await manager.prepareAccessFor("agent_1");
    const oldPath = manager.accessFor("agent_1").readableFiles[0]!.path;
    const oldCheckpoint = manager.captureAccessCheckpoint("agent_1");
    const snapshotRoot = path.dirname(path.dirname(oldPath));
    const oldScope = path.basename(path.dirname(oldPath));

    manager.disconnect(connection.id);
    await manager.prepareAccessFor("agent_1");
    const emptyCheckpoint = manager.captureAccessCheckpoint("agent_1");
    expect(emptyCheckpoint.sequence).toBeGreaterThan(oldCheckpoint.sequence);
    expect(manager.accessFor("agent_1")).toMatchObject({
      readableFiles: [],
      readableDirectories: [],
    });
    await expect(readdir(snapshotRoot)).resolves.toEqual([oldScope]);

    await manager.retireAccessBefore(emptyCheckpoint);
    await expect(lstat(oldPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(manager.captureAccessCheckpoint("agent_1")).toEqual(emptyCheckpoint);
    await expect(readdir(snapshotRoot)).resolves.toEqual([]);
  });

  it("enforces the per-agent retained scope limit without discarding prior access", async () => {
    manager = new FileManager({
      isolatedRoot: path.join(root, "snapshot-retained-agent-limits"),
      maxRetainedAccessScopesPerAgent: 1,
    });
    const sourcePath = path.join(root, "snapshot-agent-cap.bin");
    await writeFile(sourcePath, Buffer.from([1, 2]));
    const selection = await manager.stagePickedFiles([sourcePath]);
    const [file] = await manager.importPicked(selection.id, "reference", "normal");
    manager.connect(file!.id, "agent_1", "read");
    await manager.prepareAccessFor("agent_1");
    const retainedPath = manager.accessFor("agent_1").readableFiles[0]!.path;

    await expect(manager.prepareAccessFor("agent_1")).rejects.toThrow(
      /retained scope limit/u,
    );
    expect(manager.accessFor("agent_1").readableFiles[0]!.path).toBe(retainedPath);
    await expect(readFile(retainedPath)).resolves.toEqual(Buffer.from([1, 2]));
  });

  it("enforces the per-agent retained byte limit without discarding prior access", async () => {
    manager = new FileManager({
      isolatedRoot: path.join(root, "snapshot-retained-agent-byte-limit"),
      maxRetainedAccessBytesPerAgent: 3,
    });
    const sourcePath = path.join(root, "snapshot-agent-byte-cap.bin");
    await writeFile(sourcePath, Buffer.from([1, 2]));
    const selection = await manager.stagePickedFiles([sourcePath]);
    const [file] = await manager.importPicked(selection.id, "reference", "normal");
    manager.connect(file!.id, "agent_1", "read");
    await manager.prepareAccessFor("agent_1");
    const retainedPath = manager.accessFor("agent_1").readableFiles[0]!.path;

    await expect(manager.prepareAccessFor("agent_1")).rejects.toThrow(
      /retained byte limit/u,
    );
    expect(manager.accessFor("agent_1").readableFiles[0]!.path).toBe(retainedPath);
    await expect(readFile(retainedPath)).resolves.toEqual(Buffer.from([1, 2]));
  });

  it("enforces the global retained scope limit across agents", async () => {
    manager = new FileManager({
      isolatedRoot: path.join(root, "snapshot-retained-global-limits"),
      maxRetainedAccessScopes: 1,
    });
    const sourcePath = path.join(root, "snapshot-global-cap.bin");
    await writeFile(sourcePath, Buffer.from([1, 2]));
    const selection = await manager.stagePickedFiles([sourcePath]);
    const [file] = await manager.importPicked(selection.id, "reference", "shared");
    await manager.update(file!.id, { sharedRead: true });
    await manager.prepareAccessFor("agent_1");
    const retainedPath = manager.accessFor("agent_1").readableFiles[0]!.path;

    await expect(manager.prepareAccessFor("agent_2")).rejects.toThrow(
      /retained scope limit/u,
    );
    await expect(readFile(retainedPath)).resolves.toEqual(Buffer.from([1, 2]));
    expect(manager.accessFor("agent_2").readableFiles).toEqual([]);
  });

  it("enforces the global retained byte limit across agents", async () => {
    manager = new FileManager({
      isolatedRoot: path.join(root, "snapshot-retained-global-byte-limit"),
      maxRetainedAccessBytes: 3,
    });
    const sourcePath = path.join(root, "snapshot-global-byte-cap.bin");
    await writeFile(sourcePath, Buffer.from([1, 2]));
    const selection = await manager.stagePickedFiles([sourcePath]);
    const [file] = await manager.importPicked(selection.id, "reference", "shared");
    await manager.update(file!.id, { sharedRead: true });
    await manager.prepareAccessFor("agent_1");
    const retainedPath = manager.accessFor("agent_1").readableFiles[0]!.path;

    await expect(manager.prepareAccessFor("agent_2")).rejects.toThrow(
      /retained byte limit/u,
    );
    await expect(readFile(retainedPath)).resolves.toEqual(Buffer.from([1, 2]));
    expect(manager.accessFor("agent_2").readableFiles).toEqual([]);
  });

  it("permanently closes snapshot preparation while disposing an in-flight scope", async () => {
    let releaseRead!: () => void;
    let enteredRead!: () => void;
    const readReleased = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const readEntered = new Promise<void>((resolve) => {
      enteredRead = resolve;
    });
    let armed = false;
    manager = new FileManager({
      isolatedRoot: path.join(root, "snapshot-dispose-race"),
      readChunkObserver: async ({ purpose }) => {
        if (purpose !== "preview" || !armed) return;
        armed = false;
        enteredRead();
        await readReleased;
      },
    });
    const sourcePath = path.join(root, "snapshot-dispose-race.txt");
    await writeFile(sourcePath, "dispose race", "utf-8");
    const selection = await manager.stagePickedFiles([sourcePath]);
    const [file] = await manager.importPicked(selection.id, "reference", "normal");
    manager.connect(file!.id, "agent_1", "read");

    armed = true;
    const preparing = manager.prepareAccessFor("agent_1");
    await readEntered;
    const disposing = manager.disposeAccessSnapshots();
    releaseRead();

    await expect(preparing).rejects.toThrow(/disposed|File access changed/u);
    await expect(disposing).resolves.toBeUndefined();
    await expect(manager.disposeAccessSnapshots()).resolves.toBeUndefined();
    await expect(manager.prepareAccessFor("agent_1")).rejects.toThrow(/disposed/u);
    expect(manager.accessFor("agent_1").readableFiles).toEqual([]);
  });

  it("cleans prior project snapshots before importing state and can prepare again", async () => {
    const sourcePath = path.join(root, "snapshot-project-reset.txt");
    await writeFile(sourcePath, "project reset", "utf-8");
    const selection = await manager.stagePickedFiles([sourcePath]);
    const [file] = await manager.importPicked(selection.id, "reference", "normal");
    manager.connect(file!.id, "agent_1", "read");
    await manager.prepareAccessFor("agent_1");
    const oldPath = manager.accessFor("agent_1").readableFiles[0]!.path;
    const oldCheckpoint = manager.captureAccessCheckpoint("agent_1");

    await manager.importState(undefined);
    await expect(lstat(oldPath)).rejects.toMatchObject({ code: "ENOENT" });
    const nextSelection = await manager.stagePickedFiles([sourcePath]);
    const [nextFile] = await manager.importPicked(nextSelection.id, "reference", "normal");
    manager.connect(nextFile!.id, "agent_1", "read");
    await manager.prepareAccessFor("agent_1");
    const nextPath = manager.accessFor("agent_1").readableFiles[0]!.path;

    await manager.retireAccessThrough(oldCheckpoint);
    await expect(readFile(nextPath, "utf-8")).resolves.toBe("project reset");
  });

  it("requires explicit trust for persisted references and preserves authorized missing nodes", async () => {
    const sourcePath = path.join(root, "movable.txt");
    await writeFile(sourcePath, "before move", "utf-8");
    const selection = await manager.stagePickedFiles([sourcePath]);
    const [file] = await manager.importPicked(selection.id, "reference", "normal");
    manager.connect(file!.id, "agent_1", "read");
    const state = manager.exportState();
    const sourceAuthorization = await authorizeExternalFile(file!.path);
    await rm(sourcePath);

    const reloaded = new FileManager({ isolatedRoot: path.join(root, "reloaded-isolated") });
    await expect(reloaded.importState(state)).rejects.toThrow(/not trusted/u);
    await reloaded.importState(state, { trustedReferencedFiles: [sourceAuthorization] });

    expect(reloaded.get(file!.id)).toMatchObject({
      storage: "referenced",
      availability: "missing",
      path: file!.path,
    });
    expect(reloaded.accessFor("agent_1").readableFiles).toEqual([]);
    await expect(reloaded.readContent(file!.id)).rejects.toThrow(/is missing/u);

    const replacementPath = path.join(root, "replacement.md");
    await writeFile(replacementPath, "# relinked", "utf-8");
    const relinked = await reloaded.relinkReferenced(
      file!.id,
      await authorizeExternalFile(replacementPath),
    );
    expect(relinked).toMatchObject({
      availability: "available",
      extension: "md",
      filename: `${file!.name}.md`,
      path: await realpath(replacementPath),
    });
    await reloaded.prepareAccessFor("agent_1");
    const preparedAccess = reloaded.accessFor("agent_1");
    expect(preparedAccess.readableFiles).toEqual([
      expect.objectContaining({ name: `${file!.name}.md` }),
    ]);
    expect(preparedAccess.readableFiles[0]!.path).not.toBe(await realpath(replacementPath));
    await expect(reloaded.readContent(file!.id)).resolves.toEqual({
      content: "# relinked",
      truncated: false,
    });
    await reloaded.disposeAccessSnapshots();
  });

  it("clears one-time picked selections when storage roots or project state change", async () => {
    const sourcePath = path.join(root, "staged.txt");
    await writeFile(sourcePath, "staged", "utf-8");

    const rootSelection = await manager.stagePickedFiles([sourcePath]);
    manager.setIsolatedRoot(path.join(root, "next-isolated"));
    await expect(
      manager.importPicked(rootSelection.id, "copy", "normal"),
    ).rejects.toThrow(/unknown or expired/iu);

    const stateSelection = await manager.stagePickedFiles([sourcePath]);
    await manager.importState(undefined);
    await expect(
      manager.importPicked(stateSelection.id, "copy", "normal"),
    ).rejects.toThrow(/unknown or expired/iu);
  });

  it("expires a picked selection when storage roots differ only by case", async () => {
    const sourcePath = path.join(root, "case-root-staged.txt");
    await writeFile(sourcePath, "case root", "utf-8");
    manager.setIsolatedRoot(path.join(root, "CaseStorage"));
    const selection = await manager.stagePickedFiles([sourcePath]);

    manager.setIsolatedRoot(path.join(root, "casestorage"));

    await expect(
      manager.importPicked(selection.id, "copy", "normal"),
    ).rejects.toThrow(/unknown or expired/iu);
  });

  it("keeps a picked selection when the same storage roots are reapplied", async () => {
    const sourcePath = path.join(root, "same-root-staged.txt");
    await writeFile(sourcePath, "same root", "utf-8");
    const isolatedRoot = path.join(root, "isolated");
    const trustedRoot = path.join(root, "trusted-project");
    await mkdir(trustedRoot);
    const firstBoundary = await captureManagedTrustedRootBoundary(
      trustedRoot,
      "project root",
    );
    manager.setIsolatedRoot(isolatedRoot, trustedRoot, firstBoundary);
    const selection = await manager.stagePickedFiles([sourcePath]);
    const equivalentBoundary = await captureManagedTrustedRootBoundary(
      trustedRoot,
      "project root",
    );

    manager.setIsolatedRoot(isolatedRoot, trustedRoot, equivalentBoundary);

    await expect(
      manager.importPicked(selection.id, "reference", "normal"),
    ).resolves.toEqual([
      expect.objectContaining({
        path: await realpath(sourcePath),
        storage: "referenced",
      }),
    ]);
  });

  it("expires a picked selection when the trusted root identity changes in place", async () => {
    const sourcePath = path.join(root, "replaced-root-staged.txt");
    await writeFile(sourcePath, "replaced root", "utf-8");
    const isolatedRoot = path.join(root, "isolated");
    const trustedRoot = path.join(root, "replaceable-project");
    const displacedRoot = path.join(root, "displaced-project");
    await mkdir(trustedRoot);
    const firstBoundary = await captureManagedTrustedRootBoundary(
      trustedRoot,
      "project root",
    );
    manager.setIsolatedRoot(isolatedRoot, trustedRoot, firstBoundary);
    const selection = await manager.stagePickedFiles([sourcePath]);
    await rename(trustedRoot, displacedRoot);
    await mkdir(trustedRoot);
    const replacementBoundary = await captureManagedTrustedRootBoundary(
      trustedRoot,
      "project root",
    );

    manager.setIsolatedRoot(isolatedRoot, trustedRoot, replacementBoundary);

    await expect(
      manager.importPicked(selection.id, "reference", "normal"),
    ).rejects.toThrow(/unknown or expired/iu);
  });

  it("retains a picked selection when import validation fails", async () => {
    const first = path.join(root, "first.txt");
    const second = path.join(root, "second.txt");
    await Promise.all([
      writeFile(first, "first", "utf-8"),
      writeFile(second, "second", "utf-8"),
    ]);
    const selection = await manager.stagePickedFiles([first, second]);
    await rm(second);

    await expect(manager.importPicked(selection.id, "copy", "normal")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(manager.list()).toEqual([]);
    expect(manager.releasePickedSelection(selection.id)).toBe(true);
  });

  it("rejects symbolic-link picker results", async (context) => {
    const target = path.join(root, "picker-target.txt");
    const link = path.join(root, "picker-link.txt");
    await writeFile(target, "target", "utf-8");
    try {
      await symlink(target, link, "file");
    } catch (error) {
      if (["EPERM", "EACCES", "UNKNOWN"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        context.skip();
        return;
      }
      throw error;
    }

    await expect(manager.stagePickedFiles([link])).rejects.toThrow(/non-symbolic-link/u);

    const selection = await manager.stagePickedFiles([target]);
    const [file] = await manager.importPicked(selection.id, "reference", "normal");
    const targetAuthorization = await authorizeExternalFile(target);
    await expect(manager.relinkReferenced(file!.id, {
      path: link,
      identity: targetAuthorization.identity,
    })).rejects.toThrow(
      /non-symbolic-link/u,
    );
    expect(manager.get(file!.id)?.path).toBe(await realpath(target));
  });

  it("strictly rejects directories selected or used to relink a reference", async () => {
    const directory = path.join(root, "picked-directory.txt");
    const sourcePath = path.join(root, "relink-source.txt");
    await mkdir(directory);
    await writeFile(sourcePath, "source", "utf-8");

    await expect(manager.stagePickedFiles([directory])).rejects.toThrow(
      /regular non-symbolic-link/u,
    );

    const selection = await manager.stagePickedFiles([sourcePath]);
    const [file] = await manager.importPicked(selection.id, "reference", "normal");
    await expect(manager.relinkReferenced(
      file!.id,
      await authorizeExternalFile(directory),
    )).rejects.toThrow(
      /regular non-symbolic-link/u,
    );
    expect(manager.get(file!.id)?.path).toBe(await realpath(sourcePath));
  });

  it("uses unpredictable expiring picker tokens that can be explicitly released", async () => {
    let now = 1_000;
    manager = new FileManager({
      isolatedRoot: path.join(root, "isolated"),
      now: () => now,
      pickedSelectionTtlMs: 50,
    });
    const sourcePath = path.join(root, "ttl.txt");
    await writeFile(sourcePath, "ttl", "utf-8");

    const first = await manager.stagePickedFiles([sourcePath]);
    const second = await manager.stagePickedFiles([sourcePath]);
    expect(first.id).toMatch(/^file_selection_[0-9a-f-]{36}$/u);
    expect(second.id).toMatch(/^file_selection_[0-9a-f-]{36}$/u);
    expect(second.id).not.toBe(first.id);
    expect(manager.pickedSelectionPaths(first.id)).toEqual([await realpath(sourcePath)]);
    expect(manager.releasePickedSelection(first.id)).toBe(true);
    expect(manager.releasePickedSelection(first.id)).toBe(false);
    expect(() => manager.pickedSelectionPaths(first.id)).toThrow(
      PickedFileSelectionExpiredError,
    );
    expect(() => manager.pickedSelectionPaths(first.id)).toThrow(/unknown or expired/iu);

    now += 51;
    expect(() => manager.pickedSelectionPaths(second.id)).toThrow(/unknown or expired/iu);
    await expect(manager.importPicked(second.id, "copy", "normal")).rejects.toThrow(
      /unknown or expired/iu,
    );
    expect(manager.releasePickedSelection(second.id)).toBe(false);
  });

  it("enforces per-file and aggregate picker copy limits without limiting references", async () => {
    let stagedBytes = 0;
    manager = new FileManager({
      isolatedRoot: path.join(root, "isolated"),
      maxPickedFileBytes: 3,
      maxPickedBatchBytes: 5,
      readChunkObserver: ({ purpose, bytesRead }) => {
        if (purpose === "stage") stagedBytes += bytesRead;
      },
    });
    const oversized = path.join(root, "oversized.bin");
    await writeFile(oversized, Buffer.from([1, 2, 3, 4]));

    const rejectedFile = await manager.stagePickedFiles([oversized]);
    await expect(manager.importPicked(rejectedFile.id, "copy", "normal")).rejects.toThrow(
      /file exceeds the 3 byte copy limit/iu,
    );
    expect(manager.releasePickedSelection(rejectedFile.id)).toBe(true);

    const referencedSelection = await manager.stagePickedFiles([oversized]);
    const [referenced] = await manager.importPicked(
      referencedSelection.id,
      "reference",
      "normal",
    );
    expect(referenced).toMatchObject({ storage: "referenced", availability: "available" });

    const first = path.join(root, "three-a.bin");
    const second = path.join(root, "three-b.bin");
    await Promise.all([
      writeFile(first, Buffer.from([1, 2, 3])),
      writeFile(second, Buffer.from([4, 5, 6])),
    ]);
    const rejectedBatch = await manager.stagePickedFiles([first, second]);
    await expect(manager.importPicked(rejectedBatch.id, "copy", "normal")).rejects.toThrow(
      /batch exceeds the 5 byte copy limit/iu,
    );
    expect(manager.releasePickedSelection(rejectedBatch.id)).toBe(true);
    expect(stagedBytes).toBe(0);
  });

  it("detects same-inode picked file edits before importing", async () => {
    const sourcePath = path.join(root, "fingerprint.txt");
    await writeFile(sourcePath, "initial", "utf-8");
    const before = await lstat(sourcePath);
    const selection = await manager.stagePickedFiles([sourcePath]);

    await writeFile(sourcePath, "changed", "utf-8");
    await utimes(sourcePath, before.atime, new Date(before.mtimeMs + 10_000));
    const after = await lstat(sourcePath);
    expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: before.dev, ino: before.ino });

    await expect(manager.importPicked(selection.id, "copy", "normal")).rejects.toThrow(
      /changed before import/u,
    );
    expect(manager.list()).toEqual([]);
    expect(manager.releasePickedSelection(selection.id)).toBe(true);
  });

  it("detects an equal-length picked file rewrite after its mtime is restored", async () => {
    const sourcePath = path.join(root, "restored-mtime.txt");
    const fixedTimeSeconds = 1_700_000_000;
    await writeFile(sourcePath, "initial", "utf-8");
    await utimes(sourcePath, fixedTimeSeconds, fixedTimeSeconds);
    const before = await lstat(sourcePath);
    const selection = await manager.stagePickedFiles([sourcePath]);

    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeFile(sourcePath, "changed", "utf-8");
    await utimes(sourcePath, fixedTimeSeconds, fixedTimeSeconds);
    const after = await lstat(sourcePath);
    expect({
      dev: after.dev,
      ino: after.ino,
      size: after.size,
      mtimeMs: after.mtimeMs,
    }).toEqual({
      dev: before.dev,
      ino: before.ino,
      size: before.size,
      mtimeMs: before.mtimeMs,
    });
    expect(after.ctimeMs).not.toBe(before.ctimeMs);

    await expect(manager.importPicked(selection.id, "copy", "normal")).rejects.toThrow(
      /changed before import/u,
    );
    expect(manager.list()).toEqual([]);
    expect(manager.releasePickedSelection(selection.id)).toBe(true);
  });

  it("rejects a picked copy changed between streamed read chunks", async () => {
    const sourcePath = path.join(root, "changed-during-copy.bin");
    const fixedTimeSeconds = 1_700_000_000;
    const original = Buffer.alloc(3 * 64 * 1024, 0x41);
    const changed = Buffer.alloc(original.length, 0x42);
    await writeFile(sourcePath, original);
    await utimes(sourcePath, fixedTimeSeconds, fixedTimeSeconds);
    let mutated = false;
    manager = new FileManager({
      isolatedRoot: path.join(root, "isolated"),
      readChunkObserver: async ({ purpose, filePath }) => {
        if (purpose !== "copy" || mutated) return;
        mutated = true;
        await writeFile(filePath, changed);
        await utimes(filePath, fixedTimeSeconds, fixedTimeSeconds);
      },
    });
    const selection = await manager.stagePickedFiles([sourcePath]);

    await expect(manager.importPicked(selection.id, "copy", "normal")).rejects.toThrow(
      /changed after it was selected|content changed/u,
    );
    expect(mutated).toBe(true);
    expect(manager.list()).toEqual([]);
    expect(manager.releasePickedSelection(selection.id)).toBe(true);
  });

  it("rolls back unpublished copied files when a later batch target fails", async () => {
    const first = path.join(root, "rollback-first.txt");
    const second = path.join(root, "rollback-second.txt");
    await Promise.all([
      writeFile(first, "first", "utf-8"),
      writeFile(second, "second", "utf-8"),
    ]);
    const selection = await manager.stagePickedFiles([first, second]);
    const blockerDirectory = path.join(root, "isolated", "file_2");
    await mkdir(blockerDirectory, { recursive: true });
    await writeFile(path.join(blockerDirectory, "rollback-second.txt"), "blocker", "utf-8");

    await expect(manager.importPicked(selection.id, "copy", "normal")).rejects.toThrow(
      /already exists/u,
    );

    expect(manager.list()).toEqual([]);
    await expect(lstat(path.join(root, "isolated", "file_1"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(manager.releasePickedSelection(selection.id)).toBe(true);
  });

  it("preserves safe native names and arbitrary extensions while manual creation stays strict", async () => {
    const filename = "分析数据.EXTENSION_非常非常长_123456789";
    const content = Buffer.from("native name", "utf-8");
    const uploaded = await manager.createUploaded(filename, content, "normal");

    expect(uploaded).toMatchObject({
      name: "分析数据",
      extension: "EXTENSION_非常非常长_123456789",
      filename,
    });
    await expect(readFile(uploaded.path)).resolves.toEqual(content);
    const renamed = await manager.update(uploaded.id, {
      name: "重命名",
      extension: uploaded.extension,
    });
    expect(renamed).toMatchObject({
      name: "重命名",
      extension: uploaded.extension,
      filename: `重命名.${uploaded.extension}`,
    });
    await expect(readFile(renamed.path)).resolves.toEqual(content);
    await expect(
      manager.create({
        name: "manual",
        extension: "EXTENSION_非常非常长_123456789",
        kind: "normal",
      }),
    ).rejects.toThrow(/文件后缀名不合法/u);

    const reloaded = new FileManager({ isolatedRoot: path.join(root, "isolated") });
    await reloaded.importState(manager.exportState());
    expect(reloaded.get(uploaded.id)?.filename).toBe(renamed.filename);
  });

  it("keeps a replacement missing until its new identity is explicitly authorized", async () => {
    const sourcePath = path.join(root, "refresh.txt");
    await writeFile(sourcePath, "first", "utf-8");
    const selection = await manager.stagePickedFiles([sourcePath]);
    const [file] = await manager.importPicked(selection.id, "reference", "normal");

    await expect(manager.refreshAvailability(file!.id)).resolves.toBe(file);

    const replacement = path.join(root, "refresh-replacement.txt");
    const displaced = path.join(root, "refresh-displaced.txt");
    await writeFile(replacement, "replacement", "utf-8");
    await rename(sourcePath, displaced);
    await rename(replacement, sourcePath);
    const identityChanged = await manager.refreshAvailability(file!.id);
    expect(identityChanged).not.toBe(file);
    expect(identityChanged.availability).toBe("missing");
    await expect(manager.refreshAvailability(file!.id)).resolves.toBe(identityChanged);

    const relinked = await manager.relinkReferenced(
      file!.id,
      await authorizeExternalFile(sourcePath),
    );
    expect(relinked.availability).toBe("available");

    await rm(sourcePath);
    const missing = await manager.refreshAvailability(file!.id);
    expect(missing).not.toBe(relinked);
    expect(missing.availability).toBe("missing");
    await expect(manager.refreshAvailability(file!.id)).resolves.toBe(missing);

    await writeFile(sourcePath, "restored", "utf-8");
    const restored = await manager.refreshAvailability(file!.id);
    expect(restored).toBe(missing);
    expect(restored.availability).toBe("missing");
    await expect(manager.relinkReferenced(
      file!.id,
      await authorizeExternalFile(sourcePath),
    )).resolves.toMatchObject({ availability: "available" });
  });

  it("normalizes directory and ENOTDIR reference failures to persisted missing nodes", async () => {
    const directoryPath = path.join(root, "became-directory.txt");
    const nestedParent = path.join(root, "became-file-parent");
    const nestedPath = path.join(nestedParent, "nested.txt");
    await mkdir(nestedParent);
    await Promise.all([
      writeFile(directoryPath, "directory source", "utf-8"),
      writeFile(nestedPath, "nested source", "utf-8"),
    ]);
    const selection = await manager.stagePickedFiles([directoryPath, nestedPath]);
    const [directoryFile, nestedFile] = await manager.importPicked(
      selection.id,
      "reference",
      "normal",
    );
    const state = manager.exportState();
    const authorizations = await Promise.all([
      authorizeExternalFile(directoryFile!.path),
      authorizeExternalFile(nestedFile!.path),
    ]);

    await rename(directoryPath, `${directoryPath}.displaced`);
    await mkdir(directoryPath);
    await rename(nestedParent, `${nestedParent}-displaced`);
    await writeFile(nestedParent, "not a directory", "utf-8");

    await expect(manager.refreshAvailability(directoryFile!.id)).resolves.toMatchObject({
      availability: "missing",
      path: directoryFile!.path,
    });
    await expect(manager.refreshAvailability(nestedFile!.id)).resolves.toMatchObject({
      availability: "missing",
      path: nestedFile!.path,
    });

    const reloaded = new FileManager({ isolatedRoot: path.join(root, "invalid-reload") });
    await reloaded.importState(state, {
      trustedReferencedFiles: authorizations,
    });
    expect(reloaded.list()).toEqual([
      expect.objectContaining({
        id: directoryFile!.id,
        availability: "missing",
        path: directoryFile!.path,
      }),
      expect.objectContaining({
        id: nestedFile!.id,
        availability: "missing",
        path: nestedFile!.path,
      }),
    ]);
  });

  it("normalizes a final symlink to missing but rejects an untrusted symlink alias", async (context) => {
    const sourcePath = path.join(root, "symlink-invalid.txt");
    const displacedPath = path.join(root, "symlink-invalid-displaced.txt");
    const aliasPath = path.join(root, "untrusted-alias.txt");
    await writeFile(sourcePath, "source", "utf-8");
    const selection = await manager.stagePickedFiles([sourcePath]);
    const [file] = await manager.importPicked(selection.id, "reference", "normal");
    const state = manager.exportState();
    const sourceAuthorization = await authorizeExternalFile(file!.path);
    await rename(sourcePath, displacedPath);
    try {
      await symlink(displacedPath, sourcePath, "file");
      await symlink(displacedPath, aliasPath, "file");
    } catch (error) {
      if (["EPERM", "EACCES", "UNKNOWN"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        context.skip();
        return;
      }
      throw error;
    }

    await expect(manager.refreshAvailability(file!.id)).resolves.toMatchObject({
      availability: "missing",
      path: file!.path,
    });
    const reloaded = new FileManager({ isolatedRoot: path.join(root, "symlink-reload") });
    await reloaded.importState(state, { trustedReferencedFiles: [sourceAuthorization] });
    expect(reloaded.get(file!.id)).toMatchObject({
      availability: "missing",
      path: file!.path,
    });

    const aliasState = structuredClone(state);
    aliasState.files[0] = { ...aliasState.files[0]!, path: aliasPath };
    const rejected = new FileManager({ isolatedRoot: path.join(root, "alias-reload") });
    await expect(
      rejected.importState(aliasState, { trustedReferencedFiles: [sourceAuthorization] }),
    ).rejects.toThrow(/not trusted/u);
    expect(rejected.list()).toEqual([]);
  });

  it("normalizes EACCES references to missing when permissions can be enforced", async (context) => {
    if (process.platform === "win32" || process.getuid?.() === 0) {
      context.skip();
      return;
    }
    const parent = path.join(root, "inaccessible-parent");
    const sourcePath = path.join(parent, "inaccessible.txt");
    await mkdir(parent);
    await writeFile(sourcePath, "inaccessible", "utf-8");
    const selection = await manager.stagePickedFiles([sourcePath]);
    const [file] = await manager.importPicked(selection.id, "reference", "normal");
    const state = manager.exportState();
    const sourceAuthorization = await authorizeExternalFile(file!.path);

    await chmod(parent, 0o000);
    try {
      await expect(manager.refreshAvailability(file!.id)).resolves.toMatchObject({
        availability: "missing",
        path: file!.path,
      });
      const reloaded = new FileManager({ isolatedRoot: path.join(root, "eacces-reload") });
      await reloaded.importState(state, { trustedReferencedFiles: [sourceAuthorization] });
      expect(reloaded.get(file!.id)).toMatchObject({
        availability: "missing",
        path: file!.path,
      });
    } finally {
      await chmod(parent, 0o700);
    }
  });

  it("canonicalizes existing and missing referenced paths before trust comparison", async (context) => {
    const actualDirectory = path.join(root, "canonical-actual");
    const linkedDirectory = path.join(root, "canonical-link");
    await mkdir(actualDirectory);
    try {
      await symlink(
        actualDirectory,
        linkedDirectory,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      if (["EPERM", "EACCES", "UNKNOWN"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        context.skip();
        return;
      }
      throw error;
    }
    const actualFile = path.join(actualDirectory, "canonical.txt");
    await writeFile(actualFile, "canonical", "utf-8");
    const selection = await manager.stagePickedFiles([actualFile]);
    const [file] = await manager.importPicked(selection.id, "reference", "normal");
    const existingState = manager.exportState();
    existingState.files[0] = {
      ...existingState.files[0]!,
      path: path.join(linkedDirectory, "canonical.txt"),
    };
    const existingReload = new FileManager({ isolatedRoot: path.join(root, "reload-existing") });

    await existingReload.importState(existingState, {
      trustedReferencedFiles: [await authorizeExternalFile(actualFile)],
    });
    expect(existingReload.get(file!.id)?.path).toBe(await realpath(actualFile));

    const missingActual = path.join(actualDirectory, "missing.txt");
    await writeFile(missingActual, "temporarily present", "utf-8");
    const missingAuthorization = await authorizeExternalFile(missingActual);
    await rm(missingActual);
    const missingState = manager.exportState();
    missingState.files[0] = {
      ...missingState.files[0]!,
      path: path.join(linkedDirectory, "missing.txt"),
    };
    const missingReload = new FileManager({ isolatedRoot: path.join(root, "reload-missing") });
    await missingReload.importState(missingState, {
      trustedReferencedFiles: [missingAuthorization],
    });
    expect(missingReload.get(file!.id)).toMatchObject({
      path: missingActual,
      availability: "missing",
    });
  });

  it("rejects a referenced file whose parent is replaced by a different canonical target", async (context) => {
    const originalDirectory = path.join(root, "refresh-parent");
    const displacedDirectory = path.join(root, "refresh-parent-displaced");
    const replacementDirectory = path.join(root, "refresh-parent-replacement");
    await mkdir(originalDirectory);
    await mkdir(replacementDirectory);
    const sourcePath = path.join(originalDirectory, "target.txt");
    await writeFile(sourcePath, "original", "utf-8");
    await writeFile(path.join(replacementDirectory, "target.txt"), "replacement", "utf-8");
    const selection = await manager.stagePickedFiles([sourcePath]);
    const [file] = await manager.importPicked(selection.id, "reference", "normal");

    await rename(originalDirectory, displacedDirectory);
    try {
      await symlink(
        replacementDirectory,
        originalDirectory,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      if (["EPERM", "EACCES", "UNKNOWN"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        context.skip();
        return;
      }
      throw error;
    }

    const missing = await manager.refreshAvailability(file!.id);
    expect(missing).not.toBe(file);
    expect(missing).toMatchObject({
      availability: "missing",
      path: path.join(originalDirectory, "target.txt"),
    });

    await rm(path.join(replacementDirectory, "target.txt"));
    await expect(manager.refreshAvailability(file!.id)).resolves.toBe(missing);
  });

  it("marks unsafe references missing for reads, agent access, and safe open paths", async () => {
    const firstPath = path.join(root, "unsafe-read.txt");
    const secondPath = path.join(root, "unsafe-access.txt");
    await Promise.all([
      writeFile(firstPath, "first", "utf-8"),
      writeFile(secondPath, "second", "utf-8"),
    ]);
    const selection = await manager.stagePickedFiles([firstPath, secondPath]);
    const [first, second] = await manager.importPicked(selection.id, "reference", "normal");
    manager.connect(first!.id, "agent_1", "read");
    manager.connect(second!.id, "agent_1", "read");

    await rename(firstPath, `${firstPath}.displaced`);
    await mkdir(firstPath);
    await expect(manager.readContent(first!.id)).rejects.toThrow(
      /Referenced file is missing or unavailable/u,
    );
    expect(manager.get(first!.id)?.availability).toBe("missing");

    await rename(secondPath, `${secondPath}.displaced`);
    await mkdir(secondPath);
    await expect(manager.prepareAccessFor("agent_1")).rejects.toThrow(
      /missing or unavailable/u,
    );
    expect(manager.accessFor("agent_1").readableFiles).toEqual([]);
    expect(manager.get(second!.id)?.availability).toBe("missing");
    await expect(manager.validatedOpenPath(second!.id)).rejects.toThrow(/is missing/u);
  });

  it("bounds referenced previews and full reads independently of import size", async () => {
    manager = new FileManager({
      isolatedRoot: path.join(root, "isolated"),
      maxPickedFileBytes: 4,
    });
    const sourcePath = path.join(root, "large-reference.txt");
    await writeFile(sourcePath, "0123456789", "utf-8");
    const selection = await manager.stagePickedFiles([sourcePath]);
    const [file] = await manager.importPicked(selection.id, "reference", "normal");

    await expect(manager.readPreview(file!.id, 3)).resolves.toEqual({
      content: "012",
      truncated: true,
    });
    await expect(manager.readContent(file!.id)).rejects.toThrow(/4 byte read limit/u);
    expect(manager.get(file!.id)?.availability).toBe("available");
  });

  it("rejects a changing reference preview without misclassifying it as missing", async () => {
    const sourcePath = path.join(root, "changed-during-preview.txt");
    const fixedTimeSeconds = 1_700_000_000;
    const original = Buffer.alloc(3 * 64 * 1024, 0x41);
    const changed = Buffer.alloc(original.length, 0x42);
    await writeFile(sourcePath, original);
    await utimes(sourcePath, fixedTimeSeconds, fixedTimeSeconds);
    let mutated = false;
    manager = new FileManager({
      isolatedRoot: path.join(root, "isolated"),
      readChunkObserver: async ({ purpose, filePath }) => {
        if (purpose !== "preview" || mutated) return;
        mutated = true;
        await writeFile(filePath, changed);
        await utimes(filePath, fixedTimeSeconds, fixedTimeSeconds);
      },
    });
    const selection = await manager.stagePickedFiles([sourcePath]);
    const [file] = await manager.importPicked(selection.id, "reference", "normal");

    await expect(manager.readPreview(file!.id)).rejects.toThrow(/changed while opening or reading/u);
    expect(mutated).toBe(true);
    expect(manager.get(file!.id)).toMatchObject({
      availability: "available",
      path: sourcePath,
    });
    await expect(manager.readPreview(file!.id)).resolves.toMatchObject({
      content: changed.toString("utf-8"),
      truncated: false,
    });
  });

  it("invalidates an in-flight picked import when its file-state root changes", async () => {
    const sourcePath = path.join(root, "generation.txt");
    await writeFile(sourcePath, "generation", "utf-8");
    const selection = await manager.stagePickedFiles([sourcePath]);

    const importing = manager.importPicked(selection.id, "copy", "normal");
    const nextRoot = path.join(root, "next-generation-root");
    manager.setIsolatedRoot(nextRoot);

    await expect(importing).rejects.toThrow(/File state changed/u);
    expect(manager.list()).toEqual([]);
    await expect(lstat(path.join(root, "isolated", "file_1"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(lstat(path.join(nextRoot, "file_1"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not publish an in-flight picker selection after its file-state root changes", async () => {
    const sourcePath = path.join(root, "staging-generation.txt");
    await writeFile(sourcePath, "generation", "utf-8");

    const staging = manager.stagePickedFiles([sourcePath]);
    manager.setIsolatedRoot(path.join(root, "staging-next-root"));

    await expect(staging).rejects.toThrow(/File state changed/u);
  });

  it("rejects canonical picker drift even when a parent mapping still reaches the same inode", async (context) => {
    const originalDirectory = path.join(root, "picked-canonical-parent");
    const displacedDirectory = path.join(root, "picked-canonical-displaced");
    await mkdir(originalDirectory);
    const sourcePath = path.join(originalDirectory, "same.txt");
    await writeFile(sourcePath, "same inode", "utf-8");
    const selection = await manager.stagePickedFiles([sourcePath]);
    await rename(originalDirectory, displacedDirectory);
    try {
      await symlink(
        displacedDirectory,
        originalDirectory,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      if (["EPERM", "EACCES", "UNKNOWN"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        context.skip();
        return;
      }
      throw error;
    }

    await expect(manager.importPicked(selection.id, "reference", "normal")).rejects.toThrow(
      /canonical target/u,
    );
    expect(manager.list()).toEqual([]);
    expect(manager.releasePickedSelection(selection.id)).toBe(true);
  });

  it("rejects relink when its authorized canonical parent drifts to another target", async (context) => {
    const originalPath = path.join(root, "relink-original.txt");
    const authorizedDirectory = path.join(root, "relink-authorized-parent");
    const displacedDirectory = path.join(root, "relink-authorized-displaced");
    const replacementDirectory = path.join(root, "relink-authorized-replacement");
    await Promise.all([mkdir(authorizedDirectory), mkdir(replacementDirectory)]);
    await writeFile(originalPath, "original", "utf-8");
    const authorizedPath = path.join(authorizedDirectory, "target.txt");
    await writeFile(authorizedPath, "authorized", "utf-8");
    await writeFile(path.join(replacementDirectory, "target.txt"), "replacement", "utf-8");
    const authorizedFile = await authorizeExternalFile(authorizedPath);
    const selection = await manager.stagePickedFiles([originalPath]);
    const [file] = await manager.importPicked(selection.id, "reference", "normal");

    await rename(authorizedDirectory, displacedDirectory);
    try {
      await symlink(
        replacementDirectory,
        authorizedDirectory,
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
      manager.relinkReferenced(file!.id, authorizedFile),
    ).rejects.toThrow(/canonical target/u);
    expect(manager.get(file!.id)).toMatchObject({
      path: await realpath(originalPath),
      availability: "available",
    });
  });

  it("rejects persisted referenced metadata whose extension differs from its source", async () => {
    const sourcePath = path.join(root, "metadata.txt");
    await writeFile(sourcePath, "metadata", "utf-8");
    const selection = await manager.stagePickedFiles([sourcePath]);
    const [file] = await manager.importPicked(selection.id, "reference", "normal");
    const state = manager.exportState();
    const sourceAuthorization = await authorizeExternalFile(file!.path);
    state.files[0] = { ...state.files[0]!, extension: "png", filename: "metadata.png" };
    const reloaded = new FileManager({ isolatedRoot: path.join(root, "metadata-reload") });

    await expect(
      reloaded.importState(state, { trustedReferencedFiles: [sourceAuthorization] }),
    ).rejects.toThrow(/extension does not match/u);
    expect(reloaded.list()).toEqual([]);
  });

  it("rejects an authorized lexical reference when its parent mapping reaches a replacement", async (context) => {
    const originalDirectory = path.join(root, "trusted-parent");
    const displacedDirectory = path.join(root, "trusted-parent-displaced");
    const replacementDirectory = path.join(root, "trusted-parent-replacement");
    await mkdir(originalDirectory);
    await mkdir(replacementDirectory);
    const originalPath = path.join(originalDirectory, "trusted.txt");
    await writeFile(originalPath, "authorized", "utf-8");
    await writeFile(path.join(replacementDirectory, "trusted.txt"), "not authorized", "utf-8");
    const selection = await manager.stagePickedFiles([originalPath]);
    const [file] = await manager.importPicked(selection.id, "reference", "normal");
    const state = manager.exportState();
    const sourceAuthorization = await authorizeExternalFile(file!.path);

    await rename(originalDirectory, displacedDirectory);
    try {
      await symlink(
        replacementDirectory,
        originalDirectory,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      if (["EPERM", "EACCES", "UNKNOWN"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        context.skip();
        return;
      }
      throw error;
    }

    const reloaded = new FileManager({ isolatedRoot: path.join(root, "reload-drift") });
    await expect(reloaded.importState(state, {
      trustedReferencedFiles: [sourceAuthorization],
    })).rejects.toThrow(/not trusted|identity changed/u);
    expect(reloaded.list()).toEqual([]);
  });

  it("keeps case-distinct external-file authorizations separate", async (context) => {
    const upperDirectory = path.join(root, "CaseDirectory");
    const lowerDirectory = path.join(root, "casedirectory");
    const upperPath = path.join(upperDirectory, "Report.txt");
    const lowerPath = path.join(lowerDirectory, "report.txt");
    await Promise.all([
      mkdir(upperDirectory, { recursive: true }),
      mkdir(lowerDirectory, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(upperPath, "upper", "utf-8"),
      writeFile(lowerPath, "lower", "utf-8"),
    ]);
    const [canonicalUpper, canonicalLower, upperStat, lowerStat] = await Promise.all([
      realpath(upperPath),
      realpath(lowerPath),
      lstat(upperPath, { bigint: true }),
      lstat(lowerPath, { bigint: true }),
    ]);
    if (
      canonicalUpper === canonicalLower ||
      (upperStat.dev === lowerStat.dev && upperStat.ino === lowerStat.ino)
    ) {
      context.skip();
      return;
    }

    const selection = await manager.stagePickedFiles([lowerPath]);
    const [file] = await manager.importPicked(selection.id, "reference", "normal");
    const state = manager.exportState();
    const reloaded = new FileManager({ isolatedRoot: path.join(root, "case-reload") });

    await expect(reloaded.importState(state, {
      trustedReferencedFiles: [{
        path: canonicalUpper,
        identity: { dev: upperStat.dev.toString(), ino: upperStat.ino.toString() },
      }],
    })).rejects.toThrow(/not trusted/u);
    expect(reloaded.list()).toEqual([]);

    await reloaded.importState(state, {
      trustedReferencedFiles: [{
        path: canonicalLower,
        identity: { dev: lowerStat.dev.toString(), ino: lowerStat.ino.toString() },
      }],
    });
    expect(reloaded.get(file!.id)).toMatchObject({
      path: canonicalLower,
      availability: "available",
    });
  });

  it("rejects a relink when its authorization identity lease is stale", async () => {
    const originalPath = path.join(root, "lease-original.txt");
    const replacementPath = path.join(root, "lease-replacement.txt");
    const stagedReplacement = path.join(root, "lease-new.txt");
    await Promise.all([
      writeFile(originalPath, "original", "utf-8"),
      writeFile(replacementPath, "authorized", "utf-8"),
      writeFile(stagedReplacement, "replacement", "utf-8"),
    ]);
    const selection = await manager.stagePickedFiles([originalPath]);
    const [file] = await manager.importPicked(selection.id, "reference", "normal");
    const canonicalReplacement = await realpath(replacementPath);
    const authorizedIdentity = await lstat(canonicalReplacement, { bigint: true });
    await rm(replacementPath);
    await rename(stagedReplacement, replacementPath);

    await expect(manager.relinkReferenced(file!.id, {
      path: canonicalReplacement,
      identity: {
        dev: authorizedIdentity.dev.toString(),
        ino: authorizedIdentity.ino.toString(),
      },
    })).rejects.toThrow(/canonical target/u);
    expect(manager.get(file!.id)?.path).toBe(await realpath(originalPath));
  });

  it("rejects wrong same-path dev and ino leases without number coercion", async () => {
    const sourcePath = path.join(root, "wrong-identity.txt");
    await writeFile(sourcePath, "authorized", "utf-8");
    const selection = await manager.stagePickedFiles([sourcePath]);
    const [file] = await manager.importPicked(selection.id, "reference", "normal");
    const state = manager.exportState();
    const authorization = await authorizeExternalFile(sourcePath);
    const hugeOffset = 2n ** 54n;
    const wrongIdentities = [
      {
        dev: (BigInt(authorization.identity.dev) + hugeOffset).toString(),
        ino: authorization.identity.ino,
      },
      {
        dev: authorization.identity.dev,
        ino: (BigInt(authorization.identity.ino) + hugeOffset + 1n).toString(),
      },
    ];

    for (const identity of wrongIdentities) {
      expect(BigInt(identity.dev) > BigInt(Number.MAX_SAFE_INTEGER) ||
        BigInt(identity.ino) > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
      const reloaded = new FileManager({ isolatedRoot: path.join(root, `wrong-${identity.ino}`) });
      await expect(reloaded.importState(state, {
        trustedReferencedFiles: [{ path: file!.path, identity }],
      })).rejects.toThrow(/identity changed/u);
      expect(reloaded.list()).toEqual([]);
    }
  });

  it("rejects identityless persisted and relink authorizations at runtime", async () => {
    const sourcePath = path.join(root, "identity-required-source.txt");
    const replacementPath = path.join(root, "identity-required-replacement.txt");
    await Promise.all([
      writeFile(sourcePath, "source", "utf-8"),
      writeFile(replacementPath, "replacement", "utf-8"),
    ]);
    const selection = await manager.stagePickedFiles([sourcePath]);
    const [file] = await manager.importPicked(selection.id, "reference", "normal");
    const identityless = { path: await realpath(replacementPath) } as
      TrustedReferencedFileAuthorization;

    await expect(manager.relinkReferenced(file!.id, identityless)).rejects.toThrow(
      /identity must contain decimal dev and ino strings/u,
    );
    const reloaded = new FileManager({ isolatedRoot: path.join(root, "identity-required-reload") });
    await expect(reloaded.importState(manager.exportState(), {
      trustedReferencedFiles: [{ path: file!.path } as TrustedReferencedFileAuthorization],
    })).rejects.toThrow(/identity must contain decimal dev and ino strings/u);
    expect(reloaded.list()).toEqual([]);
  });

  it("does not promote a same-path replacement after an authorized file was missing", async () => {
    const sourcePath = path.join(root, "missing-lease.txt");
    await writeFile(sourcePath, "authorized", "utf-8");
    const selection = await manager.stagePickedFiles([sourcePath]);
    const [file] = await manager.importPicked(selection.id, "reference", "normal");
    const state = manager.exportState();
    const authorization = await authorizeExternalFile(sourcePath);
    await rm(sourcePath);

    const reloaded = new FileManager({ isolatedRoot: path.join(root, "missing-lease-reload") });
    await reloaded.importState(state, { trustedReferencedFiles: [authorization] });
    const missing = reloaded.get(file!.id)!;
    expect(missing.availability).toBe("missing");

    await writeFile(sourcePath, "replacement", "utf-8");
    await expect(reloaded.refreshAvailability(file!.id)).resolves.toBe(missing);
    expect(reloaded.get(file!.id)?.availability).toBe("missing");
    await expect(reloaded.readContent(file!.id)).rejects.toThrow(/is missing/u);
  });

  it("rejects a path replacement after binding the opened file handle", async (context) => {
    const sourcePath = path.join(root, "inspection-race.txt");
    const displacedPath = path.join(root, "inspection-race-displaced.txt");
    const replacementPath = path.join(root, "inspection-race-replacement.txt");
    await Promise.all([
      writeFile(sourcePath, "authorized", "utf-8"),
      writeFile(replacementPath, "replacement", "utf-8"),
    ]);
    let unsupported = false;
    manager = new FileManager({
      isolatedRoot: path.join(root, "inspection-race-isolated"),
      referencedFileInspectionObserver: async () => {
        try {
          await rename(sourcePath, displacedPath);
          await rename(replacementPath, sourcePath);
        } catch (error) {
          if (["EPERM", "EACCES", "EBUSY"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )) {
            unsupported = true;
            return;
          }
          throw error;
        }
      },
    });

    let inspectionError: unknown;
    try {
      await manager.stagePickedFiles([sourcePath]);
    } catch (error) {
      inspectionError = error;
    }
    if (unsupported) {
      context.skip();
      return;
    }
    expect(inspectionError).toBeInstanceOf(Error);
    expect((inspectionError as Error).message).toMatch(/changed while it was being inspected/u);
    expect(manager.list()).toEqual([]);
  });

  it("rejects stale referenced read results after relinking the same node id", async () => {
    const readers: Array<{
      name: string;
      read: (target: FileManager, id: string) => Promise<unknown>;
    }> = [
      { name: "preview", read: async (target, id) => await target.readPreview(id) },
      { name: "content", read: async (target, id) => await target.readContent(id) },
      { name: "raw", read: async (target, id) => await target.readRaw(id) },
    ];

    for (const reader of readers) {
      const sourcePath = path.join(root, `${reader.name}-stale-a.txt`);
      const replacementPath = path.join(root, `${reader.name}-stale-b.txt`);
      await Promise.all([
        writeFile(sourcePath, `old-${reader.name}`, "utf-8"),
        writeFile(replacementPath, `new-${reader.name}`, "utf-8"),
      ]);
      const replacementAuthorization = await authorizeExternalFile(replacementPath);
      let armed = false;
      let caseManager!: FileManager;
      caseManager = new FileManager({
        isolatedRoot: path.join(root, `${reader.name}-stale-isolated`),
        readChunkObserver: async ({ purpose }) => {
          if (purpose !== "preview" || !armed) return;
          armed = false;
          await caseManager.relinkReferenced(file!.id, replacementAuthorization);
        },
      });
      const selection = await caseManager.stagePickedFiles([sourcePath]);
      const [file] = await caseManager.importPicked(selection.id, "reference", "normal");

      armed = true;
      await expect(reader.read(caseManager, file!.id)).rejects.toThrow(/File node changed/u);
      expect(caseManager.get(file!.id)).toMatchObject({
        path: replacementAuthorization.path,
        availability: "available",
      });
      await expect(caseManager.readContent(file!.id)).resolves.toEqual({
        content: `new-${reader.name}`,
        truncated: false,
      });
    }
  });

  it("does not let a stale referenced read failure mark an imported replacement missing", async () => {
    const sourcePath = path.join(root, "stale-failure-a.txt");
    const replacementPath = path.join(root, "stale-failure-b.txt");
    await Promise.all([
      writeFile(sourcePath, "old-content", "utf-8"),
      writeFile(replacementPath, "new-content", "utf-8"),
    ]);
    const replacementAuthorization = await authorizeExternalFile(replacementPath);
    let replacementState: ReturnType<FileManager["exportState"]> | undefined;
    let armed = false;
    manager = new FileManager({
      isolatedRoot: path.join(root, "stale-failure-isolated"),
      readChunkObserver: async ({ purpose }) => {
        if (purpose !== "preview" || !armed) return;
        armed = false;
        await manager.importState(replacementState!, {
          trustedReferencedFiles: [replacementAuthorization],
        });
        const unavailable = new Error("simulated stale read failure") as NodeJS.ErrnoException;
        unavailable.code = "ENOENT";
        throw unavailable;
      },
    });
    const selection = await manager.stagePickedFiles([sourcePath]);
    const [file] = await manager.importPicked(selection.id, "reference", "normal");
    replacementState = manager.exportState();
    replacementState.files[0] = {
      ...replacementState.files[0]!,
      path: replacementAuthorization.path,
    };

    armed = true;
    await expect(manager.readContent(file!.id)).rejects.toThrow(/File state changed/u);
    const replacement = manager.get(file!.id)!;
    expect(replacement).toMatchObject({
      path: replacementAuthorization.path,
      availability: "available",
    });
    await expect(manager.refreshAvailability(file!.id)).resolves.toBe(replacement);
    await expect(manager.readContent(file!.id)).resolves.toEqual({
      content: "new-content",
      truncated: false,
    });
  });

  it("does not let a stale validated-open failure pollute a relinked replacement", async () => {
    const sourcePath = path.join(root, "stale-open-a.txt");
    const replacementPath = path.join(root, "stale-open-b.txt");
    await Promise.all([
      writeFile(sourcePath, "old-open", "utf-8"),
      writeFile(replacementPath, "new-open", "utf-8"),
    ]);
    const replacementAuthorization = await authorizeExternalFile(replacementPath);
    let armed = false;
    manager = new FileManager({
      isolatedRoot: path.join(root, "stale-open-isolated"),
      referencedFileInspectionObserver: async () => {
        if (!armed) return;
        armed = false;
        await manager.relinkReferenced(file!.id, replacementAuthorization);
        const unavailable = new Error("simulated stale open failure") as NodeJS.ErrnoException;
        unavailable.code = "ENOENT";
        throw unavailable;
      },
    });
    const selection = await manager.stagePickedFiles([sourcePath]);
    const [file] = await manager.importPicked(selection.id, "reference", "normal");

    armed = true;
    await expect(manager.validatedOpenPath(file!.id)).rejects.toThrow(/File node changed/u);
    const replacement = manager.get(file!.id)!;
    expect(replacement).toMatchObject({
      path: replacementAuthorization.path,
      availability: "available",
    });
    await expect(manager.refreshAvailability(file!.id)).resolves.toBe(replacement);
    await expect(manager.validatedOpenPath(file!.id)).resolves.toBe(replacementAuthorization.path);
  });

  it("marks a reference missing when a parent mapping changes only by canonical casing", async (context) => {
    const upperDirectory = path.join(root, "MappedCase");
    const lowerDirectory = path.join(root, "mappedcase");
    const displacedDirectory = path.join(root, "MappedCase-displaced");
    const upperPath = path.join(upperDirectory, "source.txt");
    const lowerPath = path.join(lowerDirectory, "source.txt");
    await Promise.all([
      mkdir(upperDirectory, { recursive: true }),
      mkdir(lowerDirectory, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(upperPath, "authorized", "utf-8"),
      writeFile(lowerPath, "different", "utf-8"),
    ]);
    const [canonicalUpper, canonicalLower] = await Promise.all([
      realpath(upperPath),
      realpath(lowerPath),
    ]);
    if (canonicalUpper === canonicalLower) {
      context.skip();
      return;
    }
    const selection = await manager.stagePickedFiles([upperPath]);
    const [file] = await manager.importPicked(selection.id, "reference", "normal");
    await rename(upperDirectory, displacedDirectory);
    try {
      await symlink(
        lowerDirectory,
        upperDirectory,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      if (["EPERM", "EACCES", "UNKNOWN"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )) {
        context.skip();
        return;
      }
      throw error;
    }

    await expect(manager.refreshAvailability(file!.id)).resolves.toMatchObject({
      path: canonicalUpper,
      availability: "missing",
    });
  });

  it("loads legacy isolated nodes without persisted availability", async () => {
    const file = await manager.create({ name: "legacy", extension: "txt", kind: "normal" });
    const state = manager.exportState();
    delete (state.files[0] as Partial<(typeof state.files)[number]>).availability;
    const reloaded = new FileManager({ isolatedRoot: path.join(root, "isolated") });

    await reloaded.importState(state);

    expect(reloaded.get(file.id)?.availability).toBe("available");
  });
});

async function authorizeExternalFile(
  filePath: string,
): Promise<TrustedReferencedFileAuthorization> {
  const canonicalPath = await realpath(filePath);
  const stat = await lstat(canonicalPath, { bigint: true });
  return {
    path: canonicalPath,
    identity: { dev: stat.dev.toString(), ino: stat.ino.toString() },
  };
}
