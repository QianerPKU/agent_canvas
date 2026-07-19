import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
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
import { FileManager, PickedFileSelectionExpiredError } from "./FileManager.js";
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
    expect(manager.accessFor("agent_1")).toMatchObject({
      readableFiles: [expect.objectContaining({ path: await realpath(sourcePath) })],
      writableFiles: [],
      writableDirectories: [],
    });
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

    expect(manager.accessFor("agent_1")).toEqual({
      readableFiles: [
        expect.objectContaining({ name: "shared-reference.csv", path: await realpath(sourcePath) }),
      ],
      readableDirectories: [],
      writableFiles: [],
      writableDirectories: [],
      sharedResources: [],
    });
    await expect(manager.update(file!.id, { sharedWrite: true })).rejects.toThrow(
      /cannot grant shared write/u,
    );
  });

  it("requires explicit trust for persisted references and preserves authorized missing nodes", async () => {
    const sourcePath = path.join(root, "movable.txt");
    await writeFile(sourcePath, "before move", "utf-8");
    const selection = await manager.stagePickedFiles([sourcePath]);
    const [file] = await manager.importPicked(selection.id, "reference", "normal");
    manager.connect(file!.id, "agent_1", "read");
    const state = manager.exportState();
    await rm(sourcePath);

    const reloaded = new FileManager({ isolatedRoot: path.join(root, "reloaded-isolated") });
    await expect(reloaded.importState(state)).rejects.toThrow(/not trusted/u);
    await reloaded.importState(state, { trustedReferencedPaths: [file!.path] });

    expect(reloaded.get(file!.id)).toMatchObject({
      storage: "referenced",
      availability: "missing",
      path: file!.path,
    });
    expect(reloaded.accessFor("agent_1").readableFiles).toEqual([]);
    await expect(reloaded.readContent(file!.id)).rejects.toThrow(/is missing/u);

    const replacementPath = path.join(root, "replacement.md");
    await writeFile(replacementPath, "# relinked", "utf-8");
    const relinked = await reloaded.relinkReferenced(file!.id, replacementPath);
    expect(relinked).toMatchObject({
      availability: "available",
      extension: "md",
      filename: `${file!.name}.md`,
      path: await realpath(replacementPath),
    });
    expect(reloaded.accessFor("agent_1").readableFiles).toEqual([
      expect.objectContaining({ path: await realpath(replacementPath) }),
    ]);
    await expect(reloaded.readContent(file!.id)).resolves.toEqual({
      content: "# relinked",
      truncated: false,
    });
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
    await expect(manager.relinkReferenced(file!.id, link)).rejects.toThrow(
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
    await expect(manager.relinkReferenced(file!.id, directory)).rejects.toThrow(
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

  it("refreshes referenced availability only when availability or identity changes", async () => {
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
    expect(identityChanged.availability).toBe("available");
    await expect(manager.refreshAvailability(file!.id)).resolves.toBe(identityChanged);

    await rm(sourcePath);
    const missing = await manager.refreshAvailability(file!.id);
    expect(missing).not.toBe(identityChanged);
    expect(missing.availability).toBe("missing");
    await expect(manager.refreshAvailability(file!.id)).resolves.toBe(missing);

    await writeFile(sourcePath, "restored", "utf-8");
    const restored = await manager.refreshAvailability(file!.id);
    expect(restored).not.toBe(missing);
    expect(restored.availability).toBe("available");
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
      trustedReferencedPaths: [directoryFile!.path, nestedFile!.path],
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
    await reloaded.importState(state, { trustedReferencedPaths: [file!.path] });
    expect(reloaded.get(file!.id)).toMatchObject({
      availability: "missing",
      path: file!.path,
    });

    const aliasState = structuredClone(state);
    aliasState.files[0] = { ...aliasState.files[0]!, path: aliasPath };
    const rejected = new FileManager({ isolatedRoot: path.join(root, "alias-reload") });
    await expect(
      rejected.importState(aliasState, { trustedReferencedPaths: [file!.path] }),
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

    await chmod(parent, 0o000);
    try {
      await expect(manager.refreshAvailability(file!.id)).resolves.toMatchObject({
        availability: "missing",
        path: file!.path,
      });
      const reloaded = new FileManager({ isolatedRoot: path.join(root, "eacces-reload") });
      await reloaded.importState(state, { trustedReferencedPaths: [file!.path] });
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

    await existingReload.importState(existingState, { trustedReferencedPaths: [actualFile] });
    expect(existingReload.get(file!.id)?.path).toBe(await realpath(actualFile));

    const missingActual = path.join(actualDirectory, "missing.txt");
    const missingState = manager.exportState();
    missingState.files[0] = {
      ...missingState.files[0]!,
      path: path.join(linkedDirectory, "missing.txt"),
    };
    const missingReload = new FileManager({ isolatedRoot: path.join(root, "reload-missing") });
    await missingReload.importState(missingState, {
      trustedReferencedPaths: [missingActual],
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
    const canonicalAuthorizedPath = await realpath(authorizedPath);
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
      manager.relinkReferenced(file!.id, canonicalAuthorizedPath),
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
    state.files[0] = { ...state.files[0]!, extension: "png", filename: "metadata.png" };
    const reloaded = new FileManager({ isolatedRoot: path.join(root, "metadata-reload") });

    await expect(
      reloaded.importState(state, { trustedReferencedPaths: [file!.path] }),
    ).rejects.toThrow(/extension does not match/u);
    expect(reloaded.list()).toEqual([]);
  });

  it("keeps an authorized lexical reference missing when its parent mapping drifts", async (context) => {
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
    await reloaded.importState(state, { trustedReferencedPaths: [file!.path] });
    expect(reloaded.get(file!.id)).toMatchObject({
      availability: "missing",
      path: file!.path,
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
