import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PersistedPromptState } from "@agent-canvas/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PromptManager } from "./PromptManager.js";

const managedFileFault = vi.hoisted(() => ({ failLabel: undefined as string | undefined }));

vi.mock("../workspaces/safeManagedFile.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../workspaces/safeManagedFile.js")>();
  return {
    ...actual,
    writeManagedFileAtomically: async (
      ...args: Parameters<typeof actual.writeManagedFileAtomically>
    ) => {
      if (args[2]?.label === managedFileFault.failLabel) {
        throw new Error(`Injected persistence failure for ${managedFileFault.failLabel}`);
      }
      return actual.writeManagedFileAtomically(...args);
    },
  };
});

describe("PromptManager import transactions", () => {
  let root = "";
  let manager: PromptManager;

  beforeEach(async () => {
    managedFileFault.failLabel = undefined;
    root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-prompt-import-"));
    manager = new PromptManager({
      workspaceRoot: root,
      promptRoot: path.join(root, "prompts"),
      now: () => 100,
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.each([
    {
      name: "a later traversal prompt id",
      state: {
        prompts: [persistedPrompt("prompt_2", "first"), persistedPrompt("../escape", "second")],
        connections: [],
      },
    },
    {
      name: "a later invalid connection",
      state: {
        prompts: [persistedPrompt("prompt_2", "first"), persistedPrompt("prompt_3", "second")],
        connections: [
          {
            id: "prompt_connection_1",
            promptId: "prompt_3",
            agentId: "agent_1",
            access: "admin",
          },
        ],
      },
    },
  ])("validates $name before changing memory or disk", async ({ state }) => {
    await manager.create({ name: "live", content: "unchanged", kind: "normal" });
    const promptRoot = path.join(root, "prompts");
    const beforeState = manager.exportState();
    const beforeDisk = await snapshotTree(promptRoot);

    await expect(
      manager.importState(state as unknown as PersistedPromptState),
    ).rejects.toThrow();

    expect(withoutPromptTimestamps(manager.exportState())).toEqual(
      withoutPromptTimestamps(beforeState),
    );
    expect(await snapshotTree(promptRoot)).toEqual(beforeDisk);
    expect(await pathExists(path.join(root, "escape"))).toBe(false);
  });

  it("rejects a prompt-root junction without touching the outside directory", async (context) => {
    const promptRoot = path.join(root, "prompts");
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "sentinel.txt"), "outside", "utf-8");
    try {
      await symlink(outside, promptRoot, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (isLinkPermissionError(error)) {
        context.skip();
        return;
      }
      throw error;
    }

    await expect(
      manager.importState({ prompts: [persistedPrompt("prompt_1", "replacement")], connections: [] }),
    ).rejects.toThrow(/unsafe mapping/u);

    expect(await readFile(path.join(outside, "sentinel.txt"), "utf-8")).toBe("outside");
    expect(await pathExists(path.join(outside, "prompt_1", "prompt.txt"))).toBe(false);
  });

  it("allows the explicitly trusted project-root junction while rejecting mappings below it", async (context) => {
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
      if (isLinkPermissionError(error)) {
        context.skip();
        return;
      }
      throw error;
    }
    const linkedManager = new PromptManager({
      promptRoot: path.join(linkedProject, "prompts"),
      trustedRoot: linkedProject,
    });

    await linkedManager.create({ name: "trusted", content: "inside", kind: "normal" });

    await expect(
      readFile(path.join(actualProject, "prompts", "prompt_1", "prompt.txt"), "utf-8"),
    ).resolves.toBe("inside");
  });

  it("fails closed when a live prompt directory is replaced by an outside junction", async (context) => {
    const prompt = await manager.create({
      name: "live shared",
      content: "inside",
      kind: "shared",
    });
    await manager.update(prompt.id, { sharedRead: true, sharedWrite: true });
    const promptDirectory = path.join(root, "prompts", prompt.id);
    const displaced = `${promptDirectory}-displaced`;
    const outside = path.join(root, "outside-live-prompt");
    await mkdir(outside);
    await writeFile(path.join(outside, "prompt.txt"), "outside secret", "utf-8");
    await rename(promptDirectory, displaced);
    try {
      await symlink(
        outside,
        promptDirectory,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      await rename(displaced, promptDirectory);
      if (isLinkPermissionError(error)) {
        context.skip();
        return;
      }
      throw error;
    }

    expect(() => manager.accessFor("agent_1")).toThrow(/unsafe mapping/u);
    await expect(readFile(path.join(outside, "prompt.txt"), "utf-8"))
      .resolves.toBe("outside secret");
  });

  it("fails closed when a live prompt file becomes a hard link", async () => {
    const prompt = await manager.create({ name: "live", content: "inside", kind: "shared" });
    await manager.update(prompt.id, { sharedRead: true });
    const promptPath = path.join(root, "prompts", prompt.id, "prompt.txt");
    const outside = path.join(root, "outside-live-prompt.txt");
    await writeFile(outside, "outside hard link", "utf-8");
    await rm(promptPath);
    await link(outside, promptPath);

    expect(() => manager.accessFor("agent_1")).toThrow(/single-link/u);
    await expect(readFile(outside, "utf-8")).resolves.toBe("outside hard link");
  });

  it("rejects a hard-linked prompt target without modifying its outside sentinel", async () => {
    const promptDirectory = path.join(root, "prompts", "prompt_1");
    const outside = path.join(root, "outside.txt");
    const target = path.join(promptDirectory, "prompt.txt");
    await mkdir(promptDirectory, { recursive: true });
    await writeFile(outside, "outside", "utf-8");
    await link(outside, target);

    await expect(
      manager.importState({ prompts: [persistedPrompt("prompt_1", "replacement")], connections: [] }),
    ).rejects.toThrow(/single-link/u);

    expect(await readFile(outside, "utf-8")).toBe("outside");
    expect(await readFile(target, "utf-8")).toBe("outside");
    expect(manager.list()).toEqual([]);
  });

  it("rolls back earlier file updates and created directories when a later write fails", async () => {
    await manager.create({ name: "live", content: "original", kind: "normal" });
    const promptRoot = path.join(root, "prompts");
    const beforeState = manager.exportState();
    const beforeDisk = await snapshotTree(promptRoot);
    managedFileFault.failLabel = "prompt prompt_2";

    await expect(
      manager.importState({
        prompts: [
          persistedPrompt("prompt_1", "replacement"),
          persistedPrompt("prompt_2", "never-written"),
        ],
        connections: [],
      }),
    ).rejects.toThrow("Injected persistence failure");

    expect(withoutPromptTimestamps(manager.exportState())).toEqual(
      withoutPromptTimestamps(beforeState),
    );
    expect(await snapshotTree(promptRoot)).toEqual(beforeDisk);
  });
});

function persistedPrompt(id: string, content: string) {
  return {
    id,
    name: id,
    content,
    kind: "normal" as const,
    sharedRead: false,
    sharedWrite: false,
    createdAt: 1,
    updatedAt: 1,
  };
}

async function snapshotTree(root: string, relative = ""): Promise<string[]> {
  const directory = path.join(root, relative);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const snapshot: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryRelative = path.join(relative, entry.name);
    const entryPath = path.join(root, entryRelative);
    if (entry.isDirectory()) {
      snapshot.push(`directory:${entryRelative}`);
      snapshot.push(...(await snapshotTree(root, entryRelative)));
    } else if (entry.isSymbolicLink()) {
      snapshot.push(`link:${entryRelative}:${await readlink(entryPath)}`);
    } else {
      snapshot.push(`file:${entryRelative}:${await readFile(entryPath, "utf-8")}`);
    }
  }
  return snapshot;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    try {
      await readdir(filePath);
      return true;
    } catch (directoryError) {
      if ((directoryError as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw directoryError;
    }
  }
}

function isLinkPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EPERM" || code === "EACCES" || code === "ENOTSUP";
}

function withoutPromptTimestamps(state: PersistedPromptState): unknown {
  return {
    ...state,
    prompts: state.prompts.map(({ updatedAt: _updatedAt, ...prompt }) => prompt),
  };
}
