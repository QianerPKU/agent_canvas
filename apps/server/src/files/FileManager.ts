import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AgentFileAccess,
  CanvasFileConnection,
  CanvasFileNode,
  CreateCanvasFileInput,
  FileConnectionAccess,
  FilePreviewKind,
  UpdateCanvasFileInput,
} from "@agent-canvas/shared";

export interface FileManagerOptions {
  workspaceRoot?: string;
  isolatedRoot?: string;
  resolveAgentCwd?: (agentId: string) => string | undefined;
  now?: () => number;
}

export class FileManager {
  private readonly files = new Map<string, CanvasFileNode>();
  private readonly connections = new Map<string, CanvasFileConnection>();
  private readonly workspaceRoot: string;
  private readonly isolatedRoot: string;
  private readonly resolveAgentCwd: (agentId: string) => string | undefined;
  private readonly now: () => number;
  private fileCounter = 0;
  private connectionCounter = 0;

  constructor(options: FileManagerOptions = {}) {
    this.workspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd());
    this.isolatedRoot = path.resolve(
      options.isolatedRoot ?? defaultIsolatedRoot(this.workspaceRoot),
    );
    this.resolveAgentCwd = options.resolveAgentCwd ?? (() => undefined);
    this.now = options.now ?? Date.now;
  }

  list(): CanvasFileNode[] {
    return [...this.files.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): CanvasFileNode | undefined {
    return this.files.get(id);
  }

  async create(input: CreateCanvasFileInput): Promise<CanvasFileNode> {
    const id = `file_${++this.fileCounter}`;
    const name = normalizeName(input.name);
    const extension = normalizeExtension(input.extension);
    const filename = makeFilename(name, extension);
    const baseDirectory = this.storageDirectory(id, input);
    await mkdir(baseDirectory, { recursive: true });
    const filePath = path.join(baseDirectory, filename);
    await ensureMissing(filePath);
    await writeFile(filePath, "");

    const at = this.now();
    const node: CanvasFileNode = {
      id,
      name,
      extension,
      filename,
      path: filePath,
      storage: input.storage,
      agentId: input.storage === "agent" ? input.agentId : undefined,
      kind: input.kind,
      sharedRead: false,
      sharedWrite: false,
      previewKind: previewKindForExtension(extension),
      mimeType: mimeTypeForExtension(extension),
      createdAt: at,
      updatedAt: at,
    };
    this.files.set(id, node);
    return node;
  }

  async update(id: string, input: UpdateCanvasFileInput): Promise<CanvasFileNode> {
    const current = this.requireFile(id);
    let name = current.name;
    let extension = current.extension;
    let filePath = current.path;

    if (input.name !== undefined || input.extension !== undefined) {
      name = input.name === undefined ? current.name : normalizeName(input.name);
      extension =
        input.extension === undefined ? current.extension : normalizeExtension(input.extension);
      const filename = makeFilename(name, extension);
      const nextPath = path.join(path.dirname(current.path), filename);
      if (nextPath !== current.path) {
        await ensureMissing(nextPath);
        await rename(current.path, nextPath);
        filePath = nextPath;
      }
    }

    const sharedRead =
      current.kind === "shared" && input.sharedRead !== undefined
        ? input.sharedRead
        : current.sharedRead;
    const sharedWrite =
      current.kind === "shared" && input.sharedWrite !== undefined
        ? input.sharedWrite
        : current.sharedWrite;
    const updated: CanvasFileNode = {
      ...current,
      name,
      extension,
      filename: makeFilename(name, extension),
      path: filePath,
      sharedRead,
      sharedWrite,
      previewKind: previewKindForExtension(extension),
      mimeType: mimeTypeForExtension(extension),
      updatedAt: this.now(),
    };
    this.files.set(id, updated);
    return updated;
  }

  async readPreview(
    id: string,
    maxBytes = 256 * 1024,
  ): Promise<{ content: string; truncated: boolean }> {
    const file = this.requireTextFile(id);
    const buffer = await readFile(file.path);
    return {
      content: buffer.subarray(0, maxBytes).toString("utf-8"),
      truncated: buffer.length > maxBytes,
    };
  }

  async readContent(id: string): Promise<{ content: string; truncated: false }> {
    const file = this.requireTextFile(id);
    return {
      content: await readFile(file.path, "utf-8"),
      truncated: false,
    };
  }

  async readRaw(id: string): Promise<{ file: CanvasFileNode; data: Buffer }> {
    const file = this.requireFile(id);
    return { file, data: await readFile(file.path) };
  }

  connect(
    fileId: string,
    agentId: string,
    access: FileConnectionAccess,
  ): CanvasFileConnection {
    const file = this.requireFile(fileId);
    if (file.kind !== "normal") {
      throw new Error("共享文件通过读写开关授权，不使用连线");
    }
    const existing = this.listConnections().find(
      (connection) =>
        connection.fileId === fileId &&
        connection.agentId === agentId &&
        connection.access === access,
    );
    if (existing) return existing;
    const connection: CanvasFileConnection = {
      id: `file_connection_${++this.connectionCounter}`,
      fileId,
      agentId,
      access,
    };
    this.connections.set(connection.id, connection);
    return connection;
  }

  disconnect(id: string): boolean {
    return this.connections.delete(id);
  }

  listConnections(): CanvasFileConnection[] {
    return [...this.connections.values()];
  }

  copyAgentConnections(sourceAgentId: string, targetAgentId: string): CanvasFileConnection[] {
    const copied: CanvasFileConnection[] = [];
    for (const connection of this.connections.values()) {
      if (connection.agentId !== sourceAgentId) continue;
      copied.push(this.connect(connection.fileId, targetAgentId, connection.access));
    }
    return copied;
  }

  accessFor(agentId: string): AgentFileAccess {
    const readable = new Map<string, CanvasFileNode>();
    const writable = new Map<string, CanvasFileNode>();
    const writableDirectories = new Set<string>();
    for (const file of this.files.values()) {
      if (file.kind === "shared" && file.sharedRead) readable.set(file.id, file);
      if (file.kind === "shared" && file.sharedWrite) {
        writable.set(file.id, file);
        writableDirectories.add(path.dirname(file.path));
      }
    }
    for (const connection of this.connections.values()) {
      if (connection.agentId !== agentId) continue;
      const file = this.files.get(connection.fileId);
      if (!file) continue;
      if (connection.access === "read") readable.set(file.id, file);
      if (connection.access === "write") {
        writable.set(file.id, file);
        writableDirectories.add(path.dirname(file.path));
      }
    }
    return {
      readableFiles: [...readable.values()].map((file) => ({
        name: file.filename,
        path: file.path,
        previewKind: file.previewKind,
      })),
      readableDirectories: [],
      writableFiles: [...writable.values()].map((file) => ({
        name: file.filename,
        path: file.path,
        previewKind: file.previewKind,
      })),
      writableDirectories: [...writableDirectories],
      sharedResources: [],
    };
  }

  private storageDirectory(id: string, input: CreateCanvasFileInput): string {
    if (input.storage === "isolated") return path.join(this.isolatedRoot, id);
    if (input.directory?.trim()) return path.resolve(input.directory);
    if (!input.agentId) throw new Error("存放到 agent 工作目录时必须选择 agent");
    const cwd = this.resolveAgentCwd(input.agentId) ?? this.workspaceRoot;
    return path.resolve(cwd);
  }

  private requireFile(id: string): CanvasFileNode {
    const file = this.files.get(id);
    if (!file) throw new Error(`未知文件节点: ${id}`);
    return file;
  }

  private requireTextFile(id: string): CanvasFileNode {
    const file = this.requireFile(id);
    if (file.previewKind === "image" || file.previewKind === "none") {
      throw new Error(`文件 ${file.filename} 不支持文本预览`);
    }
    return file;
  }
}

export function previewKindForExtension(extension: string): FilePreviewKind {
  switch (extension.toLowerCase()) {
    case "md":
    case "markdown":
      return "markdown";
    case "csv":
      return "csv";
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "webp":
      return "image";
    case "txt":
    case "json":
    case "jsonl":
    case "ts":
    case "tsx":
    case "js":
    case "jsx":
    case "css":
    case "html":
    case "xml":
    case "yaml":
    case "yml":
    case "toml":
    case "py":
    case "go":
    case "rs":
    case "java":
    case "c":
    case "cpp":
    case "h":
      return "text";
    default:
      return "none";
  }
}

function mimeTypeForExtension(extension: string): string {
  switch (extension.toLowerCase()) {
    case "md":
    case "markdown":
      return "text/markdown; charset=utf-8";
    case "csv":
      return "text/csv; charset=utf-8";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "json":
      return "application/json; charset=utf-8";
    default:
      return previewKindForExtension(extension) === "text"
        ? "text/plain; charset=utf-8"
        : "application/octet-stream";
  }
}

function normalizeName(value: string): string {
  const name = value.trim();
  if (!name) throw new Error("文件名不能为空");
  if (name !== path.basename(name) || /[<>:"/\\|?*\u0000-\u001f]/u.test(name)) {
    throw new Error("文件名包含非法字符");
  }
  if (/[. ]$/u.test(name)) throw new Error("文件名不能以点或空格结尾");
  return name;
}

function normalizeExtension(value: string | undefined): string {
  const extension = (value ?? "").trim().replace(/^\./u, "").toLowerCase();
  if (!extension) return "";
  if (!/^[a-z0-9][a-z0-9_-]{0,15}$/u.test(extension)) {
    throw new Error("文件后缀名不合法");
  }
  return extension;
}

function makeFilename(name: string, extension: string): string {
  return extension ? `${name}.${extension}` : name;
}

async function ensureMissing(filePath: string): Promise<void> {
  try {
    await stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`文件已存在: ${filePath}`);
}

function defaultIsolatedRoot(workspaceRoot: string): string {
  const localDataRoot =
    process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".local", "share");
  const workspaceKey = createHash("sha256")
    .update(workspaceRoot.toLowerCase())
    .digest("hex")
    .slice(0, 12);
  return path.join(localDataRoot, "agent_canvas", "files", workspaceKey);
}
