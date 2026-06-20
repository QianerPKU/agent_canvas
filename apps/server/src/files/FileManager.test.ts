import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileManager } from "./FileManager.js";

describe("FileManager", () => {
  let root = "";
  let manager: FileManager;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-files-"));
    manager = new FileManager({
      workspaceRoot: root,
      isolatedRoot: path.join(root, "isolated"),
      resolveAgentCwd: () => path.join(root, "agent-workspace"),
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

    const renamed = await manager.update(file.id, { name: "summary", extension: "md" });
    expect(renamed.filename).toBe("summary.md");
    expect(await readFile(renamed.path, "utf-8")).toBe("hello file node");
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
      writableFiles: [
        expect.objectContaining({ name: "input.json", path: file.path }),
      ],
      writableDirectories: [path.dirname(file.path)],
    });
    expect(manager.listConnections().filter((item) => item.agentId === "agent_2")).toHaveLength(2);
  });
});
