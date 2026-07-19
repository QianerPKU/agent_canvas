import { createHash } from "node:crypto";
import { type Stats } from "node:fs";
import { lstat, mkdir, rmdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AgentPromptAccess,
  CanvasPromptConnection,
  CanvasPromptKind,
  CanvasPromptNode,
  CreateCanvasPromptInput,
  PromptConnectionAccess,
  UpdateCanvasPromptInput,
  PersistedPromptState,
} from "@agent-canvas/shared";
import {
  isMissingFileError,
  assertManagedTrustedRootBoundary,
  isManagedPathAtOrWithin,
  readManagedFileSnapshot,
  readManagedFileSnapshotSync,
  removeManagedFile,
  resolvedManagedPathKey,
  writeManagedFileAtomically,
  type ManagedFileSnapshot,
  type ManagedTrustedRootBoundary,
} from "../workspaces/safeManagedFile.js";

interface StoredPrompt extends CanvasPromptNode {
  path: string;
}

interface PromptImportPlan {
  prompts: Map<string, StoredPrompt>;
  connections: Map<string, CanvasPromptConnection>;
  files: PromptImportFilePlan[];
  missingDirectories: string[];
}

interface PromptImportFilePlan {
  path: string;
  content: string;
  label: string;
  original?: ManagedFileSnapshot;
}

interface PromptImportWrite {
  plan: PromptImportFilePlan;
  written: ManagedFileSnapshot;
}

interface CreatedDirectory {
  path: string;
  identity: { dev: number; ino: number };
}

export interface PromptManagerOptions {
  workspaceRoot?: string;
  promptRoot?: string;
  trustedRoot?: string;
  trustedRootBoundary?: ManagedTrustedRootBoundary;
  now?: () => number;
}

export class PromptManager {
  private readonly prompts = new Map<string, StoredPrompt>();
  private readonly connections = new Map<string, CanvasPromptConnection>();
  private promptRoot: string;
  private trustedRoot: string | undefined;
  private trustedRootBoundary: ManagedTrustedRootBoundary | undefined;
  private readonly now: () => number;
  private promptCounter = 0;
  private connectionCounter = 0;

  constructor(options: PromptManagerOptions = {}) {
    const workspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd());
    this.promptRoot = path.resolve(options.promptRoot ?? defaultPromptRoot(workspaceRoot));
    this.trustedRoot = options.trustedRoot ? path.resolve(options.trustedRoot) : undefined;
    this.trustedRootBoundary = options.trustedRootBoundary;
    this.now = options.now ?? Date.now;
  }

  list(): CanvasPromptNode[] {
    return [...this.prompts.values()]
      .map((prompt) => this.refresh(prompt))
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(publicPrompt);
  }

  setPromptRoot(
    promptRoot: string,
    trustedRoot?: string,
    trustedRootBoundary?: ManagedTrustedRootBoundary,
  ): void {
    this.promptRoot = path.resolve(promptRoot);
    this.trustedRoot = trustedRoot ? path.resolve(trustedRoot) : undefined;
    this.trustedRootBoundary = trustedRootBoundary;
  }

  exportState(): PersistedPromptState {
    return {
      prompts: this.list(),
      connections: this.listConnections(),
    };
  }

  async importState(state: PersistedPromptState | undefined): Promise<void> {
    const plan = await this.planImport(state);
    const committed = await this.applyImportFiles(plan);

    // No operation below can fail. The live state is replaced only after every
    // payload, path and file update has committed successfully.
    this.prompts.clear();
    for (const [id, prompt] of plan.prompts) this.prompts.set(id, prompt);
    this.connections.clear();
    for (const [id, connection] of plan.connections) this.connections.set(id, connection);
    for (const [id, prompt] of plan.prompts) {
      const snapshot = committed.get(prompt.path);
      if (!snapshot) throw new Error(`Missing committed prompt identity: ${id}`);
    }
    this.promptCounter = maxNumericSuffix([...plan.prompts.keys()]);
    this.connectionCounter = maxNumericSuffix([...plan.connections.keys()]);
  }

  get(id: string): CanvasPromptNode | undefined {
    const prompt = this.prompts.get(id);
    return prompt ? publicPrompt(this.refresh(prompt)) : undefined;
  }

  async create(input: CreateCanvasPromptInput): Promise<CanvasPromptNode> {
    const nextPromptCounter = this.promptCounter + 1;
    const id = `prompt_${nextPromptCounter}`;
    const name = normalizeName(input.name);
    const content = normalizeContent(input.content);
    const directory = path.join(this.promptRoot, id);
    const promptPath = path.join(directory, "prompt.txt");
    await writeManagedFileAtomically(promptPath, content, {
      expectedContent: undefined,
      label: `prompt ${id}`,
      trustedRoot: this.trustedRoot,
      trustedRootBoundary: this.trustedRootBoundary,
    });
    const at = this.now();
    const prompt: StoredPrompt = {
      id,
      name,
      content,
      path: promptPath,
      kind: input.kind,
      sharedRead: false,
      sharedWrite: false,
      createdAt: at,
      updatedAt: at,
    };
    this.prompts.set(id, prompt);
    this.promptCounter = nextPromptCounter;
    return publicPrompt(prompt);
  }

  async update(id: string, input: UpdateCanvasPromptInput): Promise<CanvasPromptNode> {
    const current = this.requirePrompt(id);
    const name = input.name === undefined ? current.name : normalizeName(input.name);
    const refreshedFile = this.refreshFile(current);
    const refreshed = refreshedFile.prompt;
    const content =
      input.content === undefined ? refreshed.content : normalizeContent(input.content);
    let modifiedAt = refreshedFile.snapshot.modifiedAt;
    if (input.content !== undefined) {
      const written = await writeManagedFileAtomically(current.path, content, {
        label: `prompt ${id}`,
        trustedRoot: this.trustedRoot,
        trustedRootBoundary: this.trustedRootBoundary,
        expectedContent: refreshed.content,
        expectedIdentity: refreshedFile.snapshot.identity,
      });
      modifiedAt = written.modifiedAt;
    }
    const updated: StoredPrompt = {
      ...refreshed,
      name,
      content,
      sharedRead:
        current.kind === "shared" && input.sharedRead !== undefined
          ? input.sharedRead
          : current.sharedRead,
      sharedWrite:
        current.kind === "shared" && input.sharedWrite !== undefined
          ? input.sharedWrite
          : current.sharedWrite,
      updatedAt: Math.max(refreshed.updatedAt, modifiedAt, this.now()),
    };
    this.prompts.set(id, updated);
    return publicPrompt(updated);
  }

  connect(
    promptId: string,
    agentId: string,
    access: PromptConnectionAccess,
  ): CanvasPromptConnection {
    const prompt = this.requirePrompt(promptId);
    if (prompt.kind !== "normal") {
      throw new Error("共享提示词通过读写开关授权，不使用连线");
    }
    const existing = this.listConnections().find(
      (connection) =>
        connection.promptId === promptId &&
        connection.agentId === agentId &&
        connection.access === access,
    );
    if (existing) return existing;
    const connection: CanvasPromptConnection = {
      id: `prompt_connection_${++this.connectionCounter}`,
      promptId,
      agentId,
      access,
    };
    this.connections.set(connection.id, connection);
    return connection;
  }

  disconnect(id: string): boolean {
    return this.connections.delete(id);
  }

  listConnections(): CanvasPromptConnection[] {
    return [...this.connections.values()];
  }

  copyAgentConnections(
    sourceAgentId: string,
    targetAgentId: string,
  ): CanvasPromptConnection[] {
    const copied: CanvasPromptConnection[] = [];
    for (const connection of this.connections.values()) {
      if (connection.agentId !== sourceAgentId) continue;
      copied.push(this.connect(connection.promptId, targetAgentId, connection.access));
    }
    return copied;
  }

  accessFor(agentId: string): AgentPromptAccess {
    const readable = new Map<string, StoredPrompt>();
    const writable = new Map<string, StoredPrompt>();
    for (const prompt of this.prompts.values()) {
      const refreshed = this.refresh(prompt);
      if (refreshed.kind === "shared" && refreshed.sharedRead) readable.set(refreshed.id, refreshed);
      if (refreshed.kind === "shared" && refreshed.sharedWrite) writable.set(refreshed.id, refreshed);
    }
    for (const connection of this.connections.values()) {
      if (connection.agentId !== agentId) continue;
      const prompt = this.prompts.get(connection.promptId);
      if (!prompt) continue;
      const refreshed = this.refresh(prompt);
      if (connection.access === "read") readable.set(refreshed.id, refreshed);
      if (connection.access === "write") writable.set(refreshed.id, refreshed);
    }
    const readablePrompts = [...readable.values()]
      .sort(comparePrompts)
      .map((prompt) => ({
        id: prompt.id,
        name: prompt.name,
        content: prompt.content,
        kind: prompt.kind,
      }));
    const writablePrompts = [...writable.values()].map((prompt) => ({
      id: prompt.id,
      name: prompt.name,
      path: prompt.path,
    }));
    return {
      readablePrompts,
      writablePrompts,
      writableDirectories: [
        ...new Set(writablePrompts.map((prompt) => path.dirname(prompt.path))),
      ],
    };
  }

  private requirePrompt(id: string): StoredPrompt {
    const prompt = this.prompts.get(id);
    if (!prompt) throw new Error(`未知提示词节点: ${id}`);
    return prompt;
  }

  private refresh(prompt: StoredPrompt): StoredPrompt {
    return this.refreshFile(prompt).prompt;
  }

  private refreshFile(prompt: StoredPrompt): {
    prompt: StoredPrompt;
    snapshot: ManagedFileSnapshot;
  } {
    const snapshot = readManagedFileSnapshotSync(prompt.path, {
      label: `prompt ${prompt.id}`,
      trustedRoot: this.trustedRoot,
      trustedRootBoundary: this.trustedRootBoundary,
    });
    const refreshed = {
      ...prompt,
      content: snapshot.content,
      updatedAt: Math.max(prompt.updatedAt, snapshot.modifiedAt),
    };
    this.prompts.set(prompt.id, refreshed);
    return { prompt: refreshed, snapshot };
  }

  private async planImport(state: PersistedPromptState | undefined): Promise<PromptImportPlan> {
    if (state !== undefined && !isRecord(state)) {
      throw new Error("Invalid persisted prompt state");
    }
    const promptNodes = state?.prompts ?? [];
    const connectionNodes = state?.connections ?? [];
    if (!Array.isArray(promptNodes) || !Array.isArray(connectionNodes)) {
      throw new Error("Invalid persisted prompt state");
    }

    const prompts = new Map<string, StoredPrompt>();
    const connections = new Map<string, CanvasPromptConnection>();
    const files: PromptImportFilePlan[] = [];
    const missingDirectories = new Set<string>();

    for (const value of promptNodes) {
      if (!isRecord(value)) throw new Error("Invalid persisted prompt");
      const id = persistedIdentifier(value.id, /^prompt_[1-9]\d*$/u, "prompt id");
      if (prompts.has(id)) throw new Error(`Duplicate persisted prompt id: ${id}`);
      const name = normalizeName(value.name);
      const content = normalizeContent(value.content);
      if (value.kind !== "normal" && value.kind !== "shared") {
        throw new Error(`Invalid persisted prompt kind: ${id}`);
      }
      if (typeof value.sharedRead !== "boolean" || typeof value.sharedWrite !== "boolean") {
        throw new Error(`Invalid persisted prompt sharing flags: ${id}`);
      }
      const createdAt = persistedTimestamp(value.createdAt, `prompt ${id} createdAt`);
      const updatedAt = persistedTimestamp(value.updatedAt, `prompt ${id} updatedAt`);
      const promptPath = this.importPath(id);
      prompts.set(id, {
        id,
        name,
        content,
        kind: value.kind,
        sharedRead: value.sharedRead,
        sharedWrite: value.sharedWrite,
        createdAt,
        updatedAt,
        path: promptPath,
      });
      files.push({ path: promptPath, content, label: `prompt ${id}` });
    }

    for (const value of connectionNodes) {
      if (!isRecord(value)) throw new Error("Invalid persisted prompt connection");
      const id = persistedIdentifier(
        value.id,
        /^prompt_connection_[1-9]\d*$/u,
        "prompt connection id",
      );
      if (connections.has(id)) throw new Error(`Duplicate persisted prompt connection id: ${id}`);
      const promptId = persistedIdentifier(
        value.promptId,
        /^prompt_[1-9]\d*$/u,
        "prompt connection prompt id",
      );
      if (!prompts.has(promptId)) {
        throw new Error(`Persisted prompt connection references an unknown prompt: ${id}`);
      }
      const agentId = persistedNonEmptyString(value.agentId, `prompt connection ${id} agent id`);
      if (value.access !== "read" && value.access !== "write") {
        throw new Error(`Invalid persisted prompt connection access: ${id}`);
      }
      connections.set(id, { id, promptId, agentId, access: value.access });
    }

    // Preflight every target only after the entire payload has passed validation.
    // This guarantees an invalid later node or connection cannot create an early
    // prompt directory or replace an existing prompt file.
    for (const file of files) {
      const preflight = await this.preflightImportPath(file.path, file.label);
      file.original = preflight.original;
      for (const directory of preflight.missingDirectories) missingDirectories.add(directory);
    }

    return {
      prompts,
      connections,
      files,
      missingDirectories: [...missingDirectories].sort(comparePathDepth),
    };
  }

  private importPath(id: string): string {
    const promptPath = path.resolve(this.promptRoot, id, "prompt.txt");
    if (!isManagedPathAtOrWithin(this.promptRoot, promptPath)) {
      throw new Error(`Persisted prompt path escapes the prompt root: ${id}`);
    }
    const relative = path.relative(this.promptRoot, promptPath);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Persisted prompt path escapes the prompt root: ${id}`);
    }
    return promptPath;
  }

  private async preflightImportPath(
    filePath: string,
    label: string,
  ): Promise<{ original?: ManagedFileSnapshot; missingDirectories: string[] }> {
    let managedFilePath = path.resolve(filePath);
    let root = this.trustedRoot ?? path.parse(managedFilePath).root;
    if (this.trustedRootBoundary) {
      await assertManagedTrustedRootBoundary(this.trustedRootBoundary, label);
      if (!isManagedPathAtOrWithin(this.trustedRootBoundary.path, managedFilePath)) {
        throw new Error(`${label} path escapes its trusted root: ${filePath}`);
      }
      const relative = path.relative(this.trustedRootBoundary.path, managedFilePath);
      managedFilePath = path.join(this.trustedRootBoundary.realPath, relative);
      root = this.trustedRootBoundary.realPath;
    }
    const parent = path.dirname(managedFilePath);
    if (!isManagedPathAtOrWithin(root, parent)) {
      throw new Error(`${label} path escapes its trusted root: ${filePath}`);
    }
    const relativeToRoot = path.relative(root, parent);
    const missingDirectories: string[] = [];
    let current = root;
    let ancestorMissing = false;
    const rootStat = await lstatIfExists(root);
    if (!rootStat ||
        (!rootStat.isDirectory() && !(this.trustedRoot && rootStat.isSymbolicLink())) ||
        (!this.trustedRoot && rootStat.isSymbolicLink())) {
      throw new Error(`${label} trusted root is unsafe: ${root}`);
    }
    for (const segment of relativeToRoot.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      if (ancestorMissing) {
        missingDirectories.push(current);
        continue;
      }
      const currentStat = await lstatIfExists(current);
      if (!currentStat) {
        ancestorMissing = true;
        missingDirectories.push(current);
        continue;
      }
      if (!currentStat.isDirectory() || currentStat.isSymbolicLink()) {
        throw new Error(`${label} path contains an unsafe mapping: ${current}`);
      }
    }
    if (ancestorMissing) return { missingDirectories };
    return {
      original: await readManagedFileSnapshot(filePath, {
        allowMissing: true,
        label,
        trustedRoot: this.trustedRoot,
        trustedRootBoundary: this.trustedRootBoundary,
      }),
      missingDirectories,
    };
  }

  private async applyImportFiles(
    plan: PromptImportPlan,
  ): Promise<Map<string, ManagedFileSnapshot>> {
    const createdDirectories: CreatedDirectory[] = [];
    const writes: PromptImportWrite[] = [];
    const committed = new Map<string, ManagedFileSnapshot>();
    try {
      for (const directory of plan.missingDirectories) {
        if (this.trustedRootBoundary) {
          await assertManagedTrustedRootBoundary(this.trustedRootBoundary, "Prompt root");
        }
        const existing = await lstatIfExists(directory);
        if (existing) {
          if (!existing.isDirectory() || existing.isSymbolicLink()) {
            throw new Error(`Prompt import directory became unsafe: ${directory}`);
          }
          continue;
        }
        await mkdir(directory);
        if (this.trustedRootBoundary) {
          await assertManagedTrustedRootBoundary(this.trustedRootBoundary, "Prompt root");
        }
        const created = await lstat(directory);
        if (!created.isDirectory() || created.isSymbolicLink()) {
          throw new Error(`Prompt import directory is unsafe: ${directory}`);
        }
        createdDirectories.push({
          path: directory,
          identity: { dev: created.dev, ino: created.ino },
        });
      }

      for (const file of plan.files) {
        if (file.original?.content === file.content) {
          committed.set(file.path, file.original);
          continue;
        }
        const written = await writeManagedFileAtomically(file.path, file.content, {
          expectedContent: file.original?.content,
          expectedIdentity: file.original?.identity,
          label: file.label,
          trustedRoot: this.trustedRoot,
          trustedRootBoundary: this.trustedRootBoundary,
        });
        writes.push({ plan: file, written });
        committed.set(file.path, written);
      }

      // Revalidate even unchanged files immediately before publishing the new
      // in-memory access graph. A path swap after preflight must not turn a
      // persisted prompt into an unsafe writable target.
      for (const file of plan.files) {
        const expected = committed.get(file.path);
        const current = await readManagedFileSnapshot(file.path, {
          label: file.label,
          trustedRoot: this.trustedRoot,
          trustedRootBoundary: this.trustedRootBoundary,
        });
        if (
          !expected ||
          !current ||
          current.content !== expected.content ||
          current.identity.dev !== expected.identity.dev ||
          current.identity.ino !== expected.identity.ino
        ) {
          throw new Error(`${file.label} changed before import commit: ${file.path}`);
        }
      }
      return committed;
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      for (const write of writes.reverse()) {
        try {
          if (write.plan.original) {
            await writeManagedFileAtomically(
              write.plan.path,
              write.plan.original.content,
              {
              expectedContent: write.written.content,
              expectedIdentity: write.written.identity,
              label: `${write.plan.label} rollback`,
              trustedRoot: this.trustedRoot,
              trustedRootBoundary: this.trustedRootBoundary,
              },
            );
          } else {
            await removeManagedFile(write.plan.path, {
              expectedContent: write.written.content,
              expectedIdentity: write.written.identity,
              label: `${write.plan.label} rollback`,
              trustedRoot: this.trustedRoot,
              trustedRootBoundary: this.trustedRootBoundary,
            });
          }
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      for (const directory of createdDirectories.reverse()) {
        try {
          const current = await lstatIfExists(directory.path);
          if (!current) continue;
          if (
            !current.isDirectory() ||
            current.isSymbolicLink() ||
            current.dev !== directory.identity.dev ||
            current.ino !== directory.identity.ino
          ) {
            throw new Error(`Prompt import directory changed before rollback: ${directory.path}`);
          }
          await rmdir(directory.path);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          "Prompt import failed and could not be fully rolled back",
        );
      }
      throw error;
    }
  }
}

function comparePrompts(a: StoredPrompt, b: StoredPrompt): number {
  const kindOrder = kindRank(a.kind) - kindRank(b.kind);
  if (kindOrder !== 0) return kindOrder;
  const contentOrder = Buffer.compare(Buffer.from(a.content, "utf-8"), Buffer.from(b.content, "utf-8"));
  return contentOrder !== 0 ? contentOrder : a.id.localeCompare(b.id);
}

function kindRank(kind: CanvasPromptKind): number {
  return kind === "shared" ? 0 : 1;
}

function publicPrompt(prompt: StoredPrompt): CanvasPromptNode {
  const { path: _path, ...node } = prompt;
  return node;
}

function normalizeName(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid prompt name");
  const name = value.trim();
  if (!name) throw new Error("提示词名称不能为空");
  return name;
}

function normalizeContent(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid prompt content");
  if (!value.trim()) throw new Error("提示词内容不能为空");
  return value;
}

function defaultPromptRoot(workspaceRoot: string): string {
  const localDataRoot =
    process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".local", "share");
  const workspaceKey = createHash("sha256")
    .update(resolvedManagedPathKey(workspaceRoot))
    .digest("hex")
    .slice(0, 12);
  return path.join(localDataRoot, "agent_canvas", "prompts", workspaceKey);
}

function maxNumericSuffix(ids: string[]): number {
  let max = 0;
  for (const id of ids) {
    const match = id.match(/_(\d+)$/u);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max;
}

function persistedIdentifier(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`Invalid persisted ${label}`);
  }
  return value;
}

function persistedNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid persisted ${label}`);
  }
  return value;
}

function persistedTimestamp(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid persisted ${label}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function comparePathDepth(left: string, right: string): number {
  const depth = pathDepth(left) - pathDepth(right);
  return depth !== 0 ? depth : left.localeCompare(right);
}

function pathDepth(value: string): number {
  return path.resolve(value).split(path.sep).filter(Boolean).length;
}

async function lstatIfExists(filePath: string): Promise<Stats | undefined> {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
}
