import { describe, expect, it, vi } from "vitest";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const fileSystemHooks = vi.hoisted(() => ({
  onManagedFileOpen: undefined as undefined | (() => Promise<void>),
  onTemporaryFileSync: undefined as undefined | (() => Promise<void>),
  beforeRemovalRename: undefined as
    | undefined
    | ((sourcePath: string, destinationPath: string) => Promise<void>),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (String(args[1]).includes(".agent-canvas-remove-")) {
        const hook = fileSystemHooks.beforeRemovalRename;
        fileSystemHooks.beforeRemovalRename = undefined;
        await hook?.(String(args[0]), String(args[1]));
      }
      return await actual.rename(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const openedPath = String(args[0]);
      if (!openedPath.includes(".agent-canvas-") || !openedPath.endsWith(".tmp")) {
        const hook = fileSystemHooks.onManagedFileOpen;
        fileSystemHooks.onManagedFileOpen = undefined;
        await hook?.();
        return handle;
      }
      return new Proxy(handle, {
        get(target, property) {
          if (property === "sync") {
            return async () => {
              await target.sync();
              const hook = fileSystemHooks.onTemporaryFileSync;
              fileSystemHooks.onTemporaryFileSync = undefined;
              await hook?.();
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
});

import {
  ManagedFileSafetyError,
  captureManagedTrustedRootBoundary,
  readManagedFile,
  readManagedFileSnapshot,
  removeManagedFile,
  writeManagedFileAtomically,
} from "./safeManagedFile.js";

describe("safeManagedFile", () => {
  it("rejects a persisted trusted-root swap between outer validation and publication", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-managed-root-race-"));
    const originalRoot = path.join(root, "original-project");
    const outsideRoot = path.join(root, "outside-project");
    const projectRoot = path.join(root, "selected-project");
    const originalState = path.join(originalRoot, "state.json");
    const outsideState = path.join(outsideRoot, "state.json");
    try {
      await mkdir(originalRoot);
      await mkdir(outsideRoot);
      await writeFile(originalState, "original\n", "utf-8");
      await writeFile(outsideState, "outside sentinel\n", "utf-8");
      await symlink(
        originalRoot,
        projectRoot,
        process.platform === "win32" ? "junction" : "dir",
      );
      const boundary = await captureManagedTrustedRootBoundary(projectRoot, "project root");
      fileSystemHooks.onTemporaryFileSync = async () => {
        await rm(projectRoot);
        await symlink(
          outsideRoot,
          projectRoot,
          process.platform === "win32" ? "junction" : "dir",
        );
      };

      await expect(
        writeManagedFileAtomically(path.join(projectRoot, "state.json"), "replacement\n", {
          label: "state",
          trustedRootBoundary: boundary,
          expectedContent: "original\n",
        }),
      ).rejects.toThrow(/persisted trusted root/u);

      expect(await readFile(originalState, "utf-8")).toBe("original\n");
      expect(await readFile(outsideState, "utf-8")).toBe("outside sentinel\n");
    } finally {
      fileSystemHooks.onTemporaryFileSync = undefined;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("creates and atomically replaces an ordinary managed file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-managed-file-"));
    const managedFile = path.join(root, "nested", "state.json");
    try {
      await writeManagedFileAtomically(managedFile, "first\n", { label: "state" });
      expect(await readManagedFile(managedFile, { label: "state" })).toBe("first\n");
      const firstIdentity = await lstat(managedFile);

      await writeManagedFileAtomically(managedFile, "second\n", { label: "state" });

      expect(await readManagedFile(managedFile, { label: "state" })).toBe("second\n");
      const secondIdentity = await lstat(managedFile);
      expect(secondIdentity.isFile()).toBe(true);
      expect(secondIdentity.nlink).toBe(1);
      expect(
        firstIdentity.dev !== secondIdentity.dev || firstIdentity.ino !== secondIdentity.ino,
      ).toBe(true);
      expect(await readdir(path.dirname(managedFile))).toEqual(["state.json"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a symlink or junction target without touching its outside contents", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-managed-symlink-"));
    const outside = path.join(root, "outside");
    const sentinel = path.join(outside, "sentinel.txt");
    const managedFile = path.join(root, "state.json");
    try {
      await mkdir(outside);
      await writeFile(sentinel, "outside\n", "utf-8");
      await symlink(outside, managedFile, process.platform === "win32" ? "junction" : "dir");

      await expect(readManagedFile(managedFile, { label: "state" })).rejects.toBeInstanceOf(
        ManagedFileSafetyError,
      );
      await expect(
        writeManagedFileAtomically(managedFile, "replacement\n", { label: "state" }),
      ).rejects.toBeInstanceOf(ManagedFileSafetyError);
      expect(await readFile(sentinel, "utf-8")).toBe("outside\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a mapped parent before creating a managed file outside its boundary", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-managed-parent-link-"));
    const outside = path.join(root, "outside");
    const mappedParent = path.join(root, "mapped-parent");
    const sentinel = path.join(outside, "sentinel.txt");
    const managedFile = path.join(mappedParent, "state.json");
    try {
      await mkdir(outside);
      await writeFile(sentinel, "outside\n", "utf-8");
      await symlink(outside, mappedParent, process.platform === "win32" ? "junction" : "dir");

      await expect(
        writeManagedFileAtomically(managedFile, "managed\n", { label: "state" }),
      ).rejects.toThrow("state path contains an unsafe mapping");
      expect(await readFile(sentinel, "utf-8")).toBe("outside\n");
      await expect(lstat(path.join(outside, "state.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a hard-linked target without changing the outside sentinel", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-managed-hardlink-"));
    const sentinel = path.join(root, "outside-sentinel.json");
    const managedFile = path.join(root, "state.json");
    try {
      await writeFile(sentinel, "outside\n", "utf-8");
      await link(sentinel, managedFile);

      await expect(readManagedFile(managedFile, { label: "state" })).rejects.toBeInstanceOf(
        ManagedFileSafetyError,
      );
      await expect(
        writeManagedFileAtomically(managedFile, "replacement\n", { label: "state" }),
      ).rejects.toBeInstanceOf(ManagedFileSafetyError);
      expect(await readFile(sentinel, "utf-8")).toBe("outside\n");
      expect((await lstat(sentinel)).nlink).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects replacement when the target identity changes while the temporary file is written", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-managed-race-"));
    const managedFile = path.join(root, "state.json");
    const displacedFile = path.join(root, "displaced-state.json");
    try {
      await writeFile(managedFile, "original\n", "utf-8");
      fileSystemHooks.onTemporaryFileSync = async () => {
        await rename(managedFile, displacedFile);
        await writeFile(managedFile, "concurrent replacement\n", "utf-8");
      };

      await expect(
        writeManagedFileAtomically(managedFile, "managed replacement\n", { label: "state" }),
      ).rejects.toThrow("state changed before replacement");

      expect(await readFile(managedFile, "utf-8")).toBe("concurrent replacement\n");
      expect(await readFile(displacedFile, "utf-8")).toBe("original\n");
      expect((await readdir(root)).sort()).toEqual(["displaced-state.json", "state.json"]);
    } finally {
      fileSystemHooks.onTemporaryFileSync = undefined;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects replacement when the original inode is modified in place during the write", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-managed-content-race-"));
    const managedFile = path.join(root, "state.json");
    try {
      await writeFile(managedFile, "original\n", "utf-8");
      const original = await readManagedFileSnapshot(managedFile, { label: "state" });
      fileSystemHooks.onTemporaryFileSync = async () => {
        await writeFile(managedFile, "concurrent in-place update\n", "utf-8");
      };

      await expect(
        writeManagedFileAtomically(managedFile, "managed replacement\n", {
          label: "state",
          expectedContent: original!.content,
          expectedIdentity: original!.identity,
        }),
      ).rejects.toThrow("state content changed before replacement");

      expect(await readFile(managedFile, "utf-8")).toBe("concurrent in-place update\n");
      expect(await readdir(root)).toEqual(["state.json"]);
    } finally {
      fileSystemHooks.onTemporaryFileSync = undefined;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a managed read when the path identity changes after opening", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-managed-read-race-"));
    const managedFile = path.join(root, "state.json");
    const displacedFile = path.join(root, "displaced-state.json");
    try {
      await writeFile(managedFile, "original\n", "utf-8");
      fileSystemHooks.onManagedFileOpen = async () => {
        await rename(managedFile, displacedFile);
        await writeFile(managedFile, "concurrent replacement\n", "utf-8");
      };

      await expect(readManagedFile(managedFile, { label: "state" })).rejects.toThrow(
        "state changed while reading",
      );
      expect(await readFile(managedFile, "utf-8")).toBe("concurrent replacement\n");
      expect(await readFile(displacedFile, "utf-8")).toBe("original\n");
    } finally {
      fileSystemHooks.onManagedFileOpen = undefined;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("only removes the single-link inode owned by the caller", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-managed-remove-"));
    const managedFile = path.join(root, "state.json");
    const sentinel = path.join(root, "outside.json");
    try {
      const created = await writeManagedFileAtomically(managedFile, "owned\n", {
        label: "state",
      });
      await removeManagedFile(managedFile, {
        expectedContent: created.content,
        expectedIdentity: created.identity,
        label: "state",
      });
      await expect(lstat(managedFile)).rejects.toMatchObject({ code: "ENOENT" });

      await writeFile(sentinel, "outside\n", "utf-8");
      await link(sentinel, managedFile);
      await expect(
        removeManagedFile(managedFile, {
          expectedContent: "outside\n",
          label: "state",
        }),
      ).rejects.toBeInstanceOf(ManagedFileSafetyError);
      expect(await readFile(sentinel, "utf-8")).toBe("outside\n");
      expect((await lstat(sentinel)).nlink).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("compares binary removal guards byte-for-byte", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-managed-binary-remove-"));
    const managedFile = path.join(root, "payload.bin");
    const original = Buffer.from([0x80]);
    const utf8Collision = Buffer.from([0x81]);
    try {
      await writeFile(managedFile, original);

      await expect(
        removeManagedFile(managedFile, {
          expectedContent: utf8Collision,
          label: "binary payload",
        }),
      ).rejects.toThrow("binary payload content changed before removal");
      await expect(readFile(managedFile)).resolves.toEqual(original);

      await removeManagedFile(managedFile, {
        expectedContent: original,
        label: "binary payload",
      });
      await expect(lstat(managedFile)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("restores an in-place binary mutation made immediately before quarantine", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-managed-binary-race-"));
    const managedFile = path.join(root, "payload.bin");
    const original = Buffer.from([0x80]);
    const utf8Collision = Buffer.from([0x81]);
    try {
      await writeFile(managedFile, original);
      const identity = await lstat(managedFile);
      fileSystemHooks.beforeRemovalRename = async () => {
        await writeFile(managedFile, utf8Collision);
      };

      await expect(
        removeManagedFile(managedFile, {
          expectedContent: original,
          expectedIdentity: { dev: identity.dev, ino: identity.ino },
          label: "binary payload",
        }),
      ).rejects.toThrow("binary payload content changed while being quarantined");

      await expect(readFile(managedFile)).resolves.toEqual(utf8Collision);
      expect(await readdir(root)).toEqual(["payload.bin"]);
    } finally {
      fileSystemHooks.beforeRemovalRename = undefined;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not remove a managed file modified in place before unlink", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-managed-remove-race-"));
    const managedFile = path.join(root, "state.json");
    try {
      const created = await writeManagedFileAtomically(managedFile, "owned\n", {
        label: "state",
      });
      fileSystemHooks.onManagedFileOpen = async () => {
        fileSystemHooks.onManagedFileOpen = async () => {
          await writeFile(managedFile, "concurrent in-place update\n", "utf-8");
        };
      };

      await expect(
        removeManagedFile(managedFile, {
          expectedContent: created.content,
          expectedIdentity: created.identity,
          label: "state",
        }),
      ).rejects.toThrow("state content changed before removal");

      expect(await readFile(managedFile, "utf-8")).toBe("concurrent in-place update\n");
    } finally {
      fileSystemHooks.onManagedFileOpen = undefined;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("restores a foreign replacement swapped in immediately before removal", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-managed-remove-swap-"));
    const managedFile = path.join(root, "state.json");
    const displacedFile = path.join(root, "owned-state.json");
    try {
      const created = await writeManagedFileAtomically(managedFile, "owned\n", {
        label: "state",
      });
      fileSystemHooks.beforeRemovalRename = async () => {
        await rename(managedFile, displacedFile);
        await writeFile(managedFile, "foreign sentinel\n", "utf-8");
      };

      await expect(
        removeManagedFile(managedFile, {
          expectedContent: created.content,
          expectedIdentity: created.identity,
          label: "state",
        }),
      ).rejects.toThrow("changed while being quarantined");

      expect(await readFile(managedFile, "utf-8")).toBe("foreign sentinel\n");
      expect(await readFile(displacedFile, "utf-8")).toBe("owned\n");
      expect((await readdir(root)).sort()).toEqual(["owned-state.json", "state.json"]);
    } finally {
      fileSystemHooks.beforeRemovalRename = undefined;
      await rm(root, { recursive: true, force: true });
    }
  });
});
