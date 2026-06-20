import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PromptManager } from "./PromptManager.js";

describe("PromptManager", () => {
  let root = "";
  let manager: PromptManager;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-prompts-"));
    manager = new PromptManager({
      workspaceRoot: root,
      promptRoot: path.join(root, "prompts"),
      now: () => 100,
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("创建、更新纯文本提示词，并同步外部写入", async () => {
    const prompt = await manager.create({
      name: "规则",
      content: "先写测试",
      kind: "normal",
    });
    const writable = manager.connect(prompt.id, "agent_1", "write");
    expect(writable.access).toBe("write");
    const target = manager.accessFor("agent_1").writablePrompts[0]!;
    await writeFile(target.path, "先测试，再实现", "utf-8");

    expect(manager.get(prompt.id)?.content).toBe("先测试，再实现");
    expect(await readFile(target.path, "utf-8")).toBe("先测试，再实现");

    const updated = await manager.update(prompt.id, {
      name: "工程规则",
      content: "保持简单",
    });
    expect(updated).toMatchObject({ name: "工程规则", content: "保持简单" });
  });

  it("读权限按共享优先、同类 UTF-8 编码顺序排列", async () => {
    const normalB = await manager.create({ name: "普通 B", content: "beta", kind: "normal" });
    const sharedZ = await manager.create({ name: "共享 Z", content: "zeta", kind: "shared" });
    const sharedA = await manager.create({ name: "共享 A", content: "alpha", kind: "shared" });
    const normalA = await manager.create({ name: "普通 A", content: "aardvark", kind: "normal" });
    await manager.update(sharedZ.id, { sharedRead: true });
    await manager.update(sharedA.id, { sharedRead: true });
    manager.connect(normalB.id, "agent_1", "read");
    manager.connect(normalA.id, "agent_1", "read");

    expect(manager.accessFor("agent_1").readablePrompts.map((prompt) => prompt.content)).toEqual([
      "alpha",
      "zeta",
      "aardvark",
      "beta",
    ]);
  });

  it("普通读写连线可复制给 fork Agent", async () => {
    const prompt = await manager.create({
      name: "规范",
      content: "保持兼容",
      kind: "normal",
    });
    manager.connect(prompt.id, "agent_1", "read");
    manager.connect(prompt.id, "agent_1", "write");
    manager.copyAgentConnections("agent_1", "agent_2");

    expect(manager.accessFor("agent_2").readablePrompts[0]?.content).toBe("保持兼容");
    expect(manager.accessFor("agent_2").writablePrompts[0]?.name).toBe("规范");
  });
});
