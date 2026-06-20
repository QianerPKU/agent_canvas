import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
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
} from "@agent-canvas/shared";

interface StoredPrompt extends CanvasPromptNode {
  path: string;
}

export interface PromptManagerOptions {
  workspaceRoot?: string;
  promptRoot?: string;
  now?: () => number;
}

export class PromptManager {
  private readonly prompts = new Map<string, StoredPrompt>();
  private readonly connections = new Map<string, CanvasPromptConnection>();
  private readonly promptRoot: string;
  private readonly now: () => number;
  private promptCounter = 0;
  private connectionCounter = 0;

  constructor(options: PromptManagerOptions = {}) {
    const workspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd());
    this.promptRoot = path.resolve(options.promptRoot ?? defaultPromptRoot(workspaceRoot));
    this.now = options.now ?? Date.now;
  }

  list(): CanvasPromptNode[] {
    return [...this.prompts.values()]
      .map((prompt) => this.refresh(prompt))
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(publicPrompt);
  }

  get(id: string): CanvasPromptNode | undefined {
    const prompt = this.prompts.get(id);
    return prompt ? publicPrompt(this.refresh(prompt)) : undefined;
  }

  async create(input: CreateCanvasPromptInput): Promise<CanvasPromptNode> {
    const id = `prompt_${++this.promptCounter}`;
    const name = normalizeName(input.name);
    const content = normalizeContent(input.content);
    const directory = path.join(this.promptRoot, id);
    const promptPath = path.join(directory, "prompt.txt");
    await mkdir(directory, { recursive: true });
    await writeFile(promptPath, content, "utf-8");
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
    return publicPrompt(prompt);
  }

  async update(id: string, input: UpdateCanvasPromptInput): Promise<CanvasPromptNode> {
    const current = this.requirePrompt(id);
    const content =
      input.content === undefined ? this.refresh(current).content : normalizeContent(input.content);
    if (input.content !== undefined) await writeFile(current.path, content, "utf-8");
    const updated: StoredPrompt = {
      ...current,
      name: input.name === undefined ? current.name : normalizeName(input.name),
      content,
      sharedRead:
        current.kind === "shared" && input.sharedRead !== undefined
          ? input.sharedRead
          : current.sharedRead,
      sharedWrite:
        current.kind === "shared" && input.sharedWrite !== undefined
          ? input.sharedWrite
          : current.sharedWrite,
      updatedAt: this.now(),
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
    try {
      const content = readFileSync(prompt.path, "utf-8");
      const fileStat = statSync(prompt.path);
      const refreshed = {
        ...prompt,
        content,
        updatedAt: Math.max(prompt.updatedAt, fileStat.mtimeMs),
      };
      this.prompts.set(prompt.id, refreshed);
      return refreshed;
    } catch {
      return prompt;
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

function normalizeName(value: string): string {
  const name = value.trim();
  if (!name) throw new Error("提示词名称不能为空");
  return name;
}

function normalizeContent(value: string): string {
  if (!value.trim()) throw new Error("提示词内容不能为空");
  return value;
}

function defaultPromptRoot(workspaceRoot: string): string {
  const localDataRoot =
    process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".local", "share");
  const workspaceKey = createHash("sha256")
    .update(workspaceRoot.toLowerCase())
    .digest("hex")
    .slice(0, 12);
  return path.join(localDataRoot, "agent_canvas", "prompts", workspaceKey);
}
