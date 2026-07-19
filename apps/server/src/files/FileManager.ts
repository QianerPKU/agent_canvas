import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, rmdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AgentFileAccess,
  CanvasFileImportMode,
  CanvasFileConnection,
  CanvasFileNode,
  CanvasFileOrigin,
  CanvasFileKind,
  CreateCanvasFileInput,
  FileConnectionAccess,
  FilePreviewKind,
  PickedCanvasFile,
  PickedCanvasFileSelection,
  UpdateCanvasFileInput,
  PersistedFileState,
} from "@agent-canvas/shared";
import {
  createManagedFileAtomically,
  ManagedFileSafetyError,
  readManagedFileBufferSnapshot,
  removeManagedFile,
  type ManagedFileIdentity,
  type ManagedTrustedRootBoundary,
  validateManagedFile,
  validateManagedFileSync,
} from "../workspaces/safeManagedFile.js";

export interface FileManagerOptions {
  workspaceRoot?: string;
  isolatedRoot?: string;
  trustedRoot?: string;
  trustedRootBoundary?: ManagedTrustedRootBoundary;
  now?: () => number;
  maxPickedFileBytes?: number;
  maxPickedBatchBytes?: number;
  pickedSelectionTtlMs?: number;
}

export interface ImportFileStateOptions {
  trustedReferencedPaths?: string[];
}

interface StagedPickedFile {
  path: string;
  identity: ManagedFileIdentity;
  size: number;
  modifiedAt: number;
  file: PickedCanvasFile;
}

interface StagedPickedFileSelection {
  files: StagedPickedFile[];
  expiresAt: number;
  generation: number;
}

interface CreatedFileCandidate {
  node: CanvasFileNode;
  identity: ManagedFileIdentity;
  isolatedContext?: {
    trustedRoot?: string;
    trustedRootBoundary?: ManagedTrustedRootBoundary;
  };
}

export const DEFAULT_MAX_PICKED_FILE_BYTES = 100 * 1024 * 1024;
export const DEFAULT_MAX_PICKED_BATCH_BYTES = 500 * 1024 * 1024;
export const DEFAULT_PICKED_SELECTION_TTL_MS = 5 * 60 * 1000;

export class PickedFileSelectionExpiredError extends Error {
  constructor(selectionId: string) {
    super(`Unknown or expired picked file selection: ${selectionId}`);
    this.name = "PickedFileSelectionExpiredError";
  }
}

export class FileManager {
  private readonly files = new Map<string, CanvasFileNode>();
  private readonly connections = new Map<string, CanvasFileConnection>();
  private readonly fileIdentities = new Map<string, ManagedFileIdentity>();
  private readonly pickedFileSelections = new Map<string, StagedPickedFileSelection>();
  private readonly importingPickedFileSelections = new Set<string>();
  private readonly workspaceRoot: string;
  private isolatedRoot: string;
  private trustedRoot: string | undefined;
  private trustedRootBoundary: ManagedTrustedRootBoundary | undefined;
  private readonly now: () => number;
  private readonly maxPickedFileBytes: number;
  private readonly maxPickedBatchBytes: number;
  private readonly pickedSelectionTtlMs: number;
  private fileStateGeneration = 0;
  private activeStateImports = 0;
  private fileCounter = 0;
  private connectionCounter = 0;

  constructor(options: FileManagerOptions = {}) {
    this.workspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd());
    this.isolatedRoot = path.resolve(
      options.isolatedRoot ?? defaultIsolatedRoot(this.workspaceRoot),
    );
    this.trustedRoot = options.trustedRoot ? path.resolve(options.trustedRoot) : undefined;
    this.trustedRootBoundary = options.trustedRootBoundary;
    this.now = options.now ?? Date.now;
    this.maxPickedFileBytes = positiveIntegerOption(
      options.maxPickedFileBytes,
      DEFAULT_MAX_PICKED_FILE_BYTES,
      "maxPickedFileBytes",
    );
    this.maxPickedBatchBytes = positiveIntegerOption(
      options.maxPickedBatchBytes,
      DEFAULT_MAX_PICKED_BATCH_BYTES,
      "maxPickedBatchBytes",
    );
    this.pickedSelectionTtlMs = positiveIntegerOption(
      options.pickedSelectionTtlMs,
      DEFAULT_PICKED_SELECTION_TTL_MS,
      "pickedSelectionTtlMs",
    );
  }

  list(): CanvasFileNode[] {
    return [...this.files.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  setIsolatedRoot(
    isolatedRoot: string,
    trustedRoot?: string,
    trustedRootBoundary?: ManagedTrustedRootBoundary,
  ): void {
    this.fileStateGeneration += 1;
    this.pickedFileSelections.clear();
    this.isolatedRoot = path.resolve(isolatedRoot);
    this.trustedRoot = trustedRoot ? path.resolve(trustedRoot) : undefined;
    this.trustedRootBoundary = trustedRootBoundary;
  }

  exportState(): PersistedFileState {
    return {
      files: this.list(),
      connections: this.listConnections(),
    };
  }

  async importState(
    state: PersistedFileState | undefined,
    options: ImportFileStateOptions = {},
  ): Promise<void> {
    const importGeneration = ++this.fileStateGeneration;
    this.activeStateImports += 1;
    try {
      this.pickedFileSelections.clear();
      const nextFiles = new Map<string, CanvasFileNode>();
      const nextConnections = new Map<string, CanvasFileConnection>();
      const nextIdentities = new Map<string, ManagedFileIdentity>();
      const trustedReferencedPaths = normalizedTrustedReferencedPaths(
        options.trustedReferencedPaths ?? [],
      );
      for (const file of state?.files ?? []) {
        const id = persistedIdentifier(file.id, /^file_[1-9]\d*$/u, "file id");
        const { name, extension, filename } = persistedFilenameParts(
          file.name,
          file.extension,
        );
        if (nextFiles.has(id)) throw new Error(`Duplicate persisted file id: ${id}`);
        if (file.storage !== "isolated" && file.storage !== "referenced") {
          throw new Error(`Invalid persisted file storage: ${id}`);
        }
        const kind = normalizeKind(file.kind);
        if (typeof file.sharedRead !== "boolean" || typeof file.sharedWrite !== "boolean") {
          throw new Error(`Invalid persisted file sharing flags: ${id}`);
        }
        if (
          file.availability !== undefined &&
          file.availability !== "available" &&
          file.availability !== "missing"
        ) {
          throw new Error(`Invalid persisted file availability: ${id}`);
        }

        let filePath: string;
        let availability: CanvasFileNode["availability"] = "available";
        let identity: ManagedFileIdentity | undefined;
        if (file.storage === "isolated") {
          filePath = path.join(this.isolatedRoot, id, filename);
          identity = await validateManagedFile(filePath, {
            label: `persisted file ${id}`,
            trustedRoot: this.trustedRoot,
            trustedRootBoundary: this.trustedRootBoundary,
          });
        } else {
          if (file.sharedWrite) {
            throw new Error(`Referenced file nodes cannot grant shared write access: ${id}`);
          }
          if (typeof file.path !== "string" || !path.isAbsolute(file.path)) {
            throw new Error(`Invalid persisted referenced file path: ${id}`);
          }
          const persistedPath = path.resolve(file.path);
          const inspected = await inspectReferencedFile(persistedPath, {
            allowMissing: true,
            label: `persisted referenced file ${id}`,
          });
          if (!trustedReferencedPaths.has(normalizedFilePathKey(inspected.path))) {
            throw new Error(`Persisted referenced file path is not trusted: ${persistedPath}`);
          }
          const source = filenameParts(path.basename(inspected.path));
          if (extension !== source.extension) {
            throw new Error(`Persisted referenced file extension does not match its source: ${id}`);
          }
          filePath = inspected.path;
          availability = inspected.availability;
          identity = inspected.identity;
        }
        this.assertFileStateGeneration(importGeneration);
        nextFiles.set(id, {
          ...file,
          id,
          name,
          extension,
          filename,
          path: filePath,
          storage: file.storage,
          availability,
          kind,
          sharedWrite: file.storage === "referenced" ? false : file.sharedWrite,
          previewKind: previewKindForExtension(extension),
          mimeType: mimeTypeForExtension(extension),
        });
        if (identity) nextIdentities.set(id, identity);
      }
      for (const connection of state?.connections ?? []) {
        const id = persistedIdentifier(
          connection.id,
          /^file_connection_[1-9]\d*$/u,
          "file connection id",
        );
        if (nextConnections.has(id)) {
          throw new Error(`Duplicate persisted file connection id: ${id}`);
        }
        if (!nextFiles.has(connection.fileId)) {
          throw new Error(`Persisted file connection references an unknown file: ${id}`);
        }
        if (typeof connection.agentId !== "string" || !connection.agentId.trim()) {
          throw new Error(`Invalid persisted file connection agent: ${id}`);
        }
        if (connection.access !== "read" && connection.access !== "write") {
          throw new Error(`Invalid persisted file connection access: ${id}`);
        }
        if (
          connection.access === "write" &&
          nextFiles.get(connection.fileId)?.storage === "referenced"
        ) {
          throw new Error(`Referenced file nodes cannot restore write connections: ${id}`);
        }
        nextConnections.set(id, { ...connection, id });
      }
      this.assertFileStateGeneration(importGeneration);
      this.files.clear();
      this.connections.clear();
      this.fileIdentities.clear();
      for (const [id, file] of nextFiles) this.files.set(id, file);
      for (const [id, connection] of nextConnections) this.connections.set(id, connection);
      for (const [id, identity] of nextIdentities) this.fileIdentities.set(id, identity);
      this.fileCounter = maxNumericSuffix([...nextFiles.keys()]);
      this.connectionCounter = maxNumericSuffix([...nextConnections.keys()]);
    } finally {
      this.activeStateImports -= 1;
    }
  }

  get(id: string): CanvasFileNode | undefined {
    return this.files.get(id);
  }

  async stagePickedFiles(paths: string[]): Promise<PickedCanvasFileSelection> {
    this.purgeExpiredPickedSelections();
    if (this.activeStateImports > 0) {
      throw new Error("Cannot pick files while file state is loading");
    }
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new Error("At least one picked file is required");
    }
    const generation = this.fileStateGeneration;
    const staged: StagedPickedFile[] = [];
    for (const sourcePath of paths) {
      const inspected = await inspectReferencedFile(sourcePath, {
        allowMissing: false,
        label: "picked file",
      });
      this.assertFileStateGeneration(generation);
      const parts = filenameParts(path.basename(inspected.path));
      staged.push({
        path: inspected.path,
        identity: inspected.identity!,
        size: inspected.size!,
        modifiedAt: inspected.modifiedAt!,
        file: {
          ...parts,
          size: inspected.size!,
        },
      });
    }
    this.assertFileStateGeneration(generation);
    const id = `file_selection_${randomUUID()}`;
    this.pickedFileSelections.set(id, {
      files: staged,
      expiresAt: this.now() + this.pickedSelectionTtlMs,
      generation,
    });
    return {
      id,
      files: staged.map(({ file }) => ({ ...file })),
    };
  }

  releasePickedSelection(selectionId: string): boolean {
    this.purgeExpiredPickedSelections();
    if (this.importingPickedFileSelections.has(selectionId)) return false;
    return this.pickedFileSelections.delete(selectionId);
  }

  pickedSelectionPaths(selectionId: string): string[] {
    return this.requirePickedSelection(selectionId).files.map(({ path: sourcePath }) => sourcePath);
  }

  async importPicked(
    selectionId: string,
    mode: CanvasFileImportMode,
    kind: CanvasFileKind,
  ): Promise<CanvasFileNode[]> {
    if (this.activeStateImports > 0) {
      throw new Error("Cannot import picked files while file state is loading");
    }
    if (mode !== "copy" && mode !== "reference") {
      throw new Error(`Unsupported picked file import mode: ${String(mode)}`);
    }
    const normalizedKind = normalizeKind(kind);
    const selection = this.requirePickedSelection(selectionId);
    const generation = selection.generation;
    if (this.importingPickedFileSelections.has(selectionId)) {
      throw new Error(`Picked file selection is already being imported: ${selectionId}`);
    }
    this.importingPickedFileSelections.add(selectionId);
    try {
      const current: Array<{
        picked: StagedPickedFile;
        inspected: InspectedReferencedFile;
      }> = [];
      let batchBytes = 0;
      for (const picked of selection.files) {
        const inspected = await inspectReferencedFile(picked.path, {
          allowMissing: false,
          label: `picked file ${picked.file.filename}`,
        });
        this.assertFileStateGeneration(generation);
        if (normalizedFilePathKey(inspected.path) !== normalizedFilePathKey(picked.path)) {
          throw new Error(`Picked file changed its canonical target: ${picked.file.filename}`);
        }
        if (!samePickedFingerprint(picked, inspected)) {
          throw new Error(`Picked file changed before import: ${picked.file.filename}`);
        }
        if (mode === "copy") {
          if (inspected.size! > this.maxPickedFileBytes) {
            throw new Error(
              `Picked file exceeds the ${this.maxPickedFileBytes} byte copy limit: ${picked.file.filename}`,
            );
          }
          batchBytes += inspected.size!;
          if (batchBytes > this.maxPickedBatchBytes) {
            throw new Error(
              `Picked file batch exceeds the ${this.maxPickedBatchBytes} byte copy limit`,
            );
          }
        }
        current.push({ picked, inspected });
      }

      if (mode === "copy") {
        const created: CreatedFileCandidate[] = [];
        try {
          for (const [index, item] of current.entries()) {
            const content = await readPickedFileWithinLimit(
              item.inspected.path,
              item.picked,
              this.maxPickedFileBytes,
            );
            this.assertFileStateGeneration(generation);
            const candidate = await this.createIsolatedCandidate(
              `file_${this.fileCounter + index + 1}`,
              item.picked.file,
              content,
              normalizedKind,
            );
            created.push(candidate);
            this.assertFileStateGeneration(generation);
          }
          this.assertFileStateGeneration(generation);
          this.publishCandidates(created);
        } catch (error) {
          const rollbackErrors = await this.rollbackCreatedCandidates(created);
          if (rollbackErrors.length > 0) {
            throw new AggregateError(
              [error, ...rollbackErrors],
              "Picked file import failed and rollback was incomplete",
            );
          }
          throw error;
        }
        this.pickedFileSelections.delete(selectionId);
        return created.map(({ node }) => node);
      }

      const referenced = current.map(({ picked, inspected }, index) =>
        this.createReferencedCandidate(
          `file_${this.fileCounter + index + 1}`,
          picked.file,
          inspected.path,
          inspected.identity!,
          normalizedKind,
        ),
      );
      this.assertFileStateGeneration(generation);
      this.publishCandidates(referenced);
      this.pickedFileSelections.delete(selectionId);
      return referenced.map(({ node }) => node);
    } finally {
      this.importingPickedFileSelections.delete(selectionId);
    }
  }

  async createUploaded(
    filename: string,
    content: Buffer,
    kind: CanvasFileKind,
  ): Promise<CanvasFileNode> {
    if (!Buffer.isBuffer(content)) throw new Error("Uploaded file content must be binary data");
    const parts = filenameParts(filename);
    return await this.createAndPublishIsolated(parts, content, normalizeKind(kind));
  }

  async relinkReferenced(id: string, sourcePath: string): Promise<CanvasFileNode> {
    if (this.activeStateImports > 0) {
      throw new Error("Cannot relink files while file state is loading");
    }
    const generation = this.fileStateGeneration;
    const current = this.requireFile(id);
    if (current.storage !== "referenced") {
      throw new Error(`Only referenced file nodes can be relinked: ${id}`);
    }
    const inspected = await inspectReferencedFile(sourcePath, {
      allowMissing: false,
      label: `referenced file ${id}`,
    });
    this.assertCurrentFileState(generation, current);
    const source = filenameParts(path.basename(inspected.path));
    const updated: CanvasFileNode = {
      ...current,
      extension: source.extension,
      filename: makeFilename(current.name, source.extension),
      path: inspected.path,
      availability: "available",
      sharedWrite: false,
      previewKind: previewKindForExtension(source.extension),
      mimeType: mimeTypeForExtension(source.extension),
      updatedAt: this.now(),
    };
    this.files.set(id, updated);
    this.fileIdentities.set(id, inspected.identity!);
    return updated;
  }

  async refreshAvailability(id: string): Promise<CanvasFileNode> {
    if (this.activeStateImports > 0) {
      throw new Error("Cannot refresh files while file state is loading");
    }
    const generation = this.fileStateGeneration;
    const current = this.requireFile(id);
    const previousIdentity = this.fileIdentities.get(id);
    if (current.storage === "isolated") {
      const identity = await validateManagedFile(current.path, this.validationOptions(current));
      this.assertCurrentFileState(generation, current);
      if (
        current.availability === "available" &&
        previousIdentity !== undefined &&
        sameIdentity(previousIdentity, identity)
      ) {
        return current;
      }
      const updated = { ...current, availability: "available" as const, updatedAt: this.now() };
      this.files.set(id, updated);
      this.fileIdentities.set(id, identity);
      return updated;
    }

    const inspected = await inspectReferencedFile(current.path, {
      allowMissing: true,
      label: `referenced file ${id}`,
    });
    this.assertCurrentFileState(generation, current);
    if (normalizedFilePathKey(current.path) !== normalizedFilePathKey(inspected.path)) {
      return this.markReferencedMissing(current);
    }
    if (inspected.availability === "missing") {
      return this.markReferencedMissing(current);
    }

    if (
      current.availability === "available" &&
      normalizedFilePathKey(current.path) === normalizedFilePathKey(inspected.path) &&
      previousIdentity !== undefined &&
      sameIdentity(previousIdentity, inspected.identity!)
    ) {
      return current;
    }
    const updated = {
      ...current,
      path: inspected.path,
      availability: "available" as const,
      updatedAt: this.now(),
    };
    this.files.set(id, updated);
    this.fileIdentities.set(id, inspected.identity!);
    return updated;
  }

  async create(input: CreateCanvasFileInput): Promise<CanvasFileNode> {
    return await this.createWithContent(input, "");
  }

  async createWithContent(
    input: CreateCanvasFileInput,
    content: string | Buffer,
    options: { origin?: CanvasFileOrigin } = {},
  ): Promise<CanvasFileNode> {
    this.storageDirectory(`file_${this.fileCounter + 1}`, input);
    const name = normalizeName(input.name);
    const extension = normalizeExtension(input.extension);
    return await this.createAndPublishIsolated(
      {
        name,
        extension,
        filename: makeFilename(name, extension),
        size: typeof content === "string" ? Buffer.byteLength(content) : content.byteLength,
      },
      content,
      normalizeKind(input.kind),
      options.origin,
    );
  }

  async update(id: string, input: UpdateCanvasFileInput): Promise<CanvasFileNode> {
    const current = this.requireFile(id);
    if (current.storage === "referenced") {
      if (input.extension !== undefined && input.extension !== current.extension) {
        throw new Error("Referenced file extensions are derived from the source file");
      }
      if (input.sharedWrite === true) {
        throw new Error("Referenced file nodes cannot grant shared write access");
      }
      const name = input.name === undefined ? current.name : normalizeName(input.name);
      const updated: CanvasFileNode = {
        ...current,
        name,
        filename: makeFilename(name, current.extension),
        sharedRead:
          current.kind === "shared" && input.sharedRead !== undefined
            ? input.sharedRead
            : current.sharedRead,
        sharedWrite: false,
        updatedAt: this.now(),
      };
      this.files.set(id, updated);
      return updated;
    }
    await this.validateCurrentFile(current);
    let name = current.name;
    let extension = current.extension;
    let filePath = current.path;

    if (input.name !== undefined || input.extension !== undefined) {
      name = input.name === undefined ? current.name : normalizeName(input.name);
      extension =
        input.extension === undefined || input.extension === current.extension
          ? current.extension
          : normalizeExtension(input.extension);
      const filename = makeFilename(name, extension);
      const nextPath = path.join(path.dirname(current.path), filename);
      if (nextPath !== current.path) {
        const source = await readManagedFileBufferSnapshot(current.path, {
          label: `file node ${id}`,
          trustedRoot: this.trustedRoot,
          trustedRootBoundary: this.trustedRootBoundary,
        });
        this.fileIdentities.set(id, source.identity);
        const movedIdentity = await createManagedFileAtomically(nextPath, source.content, {
          label: `file node ${id} rename target`,
          trustedRoot: this.trustedRoot,
          trustedRootBoundary: this.trustedRootBoundary,
        });
        try {
          await removeManagedFile(current.path, {
            label: `file node ${id} rename source`,
            trustedRoot: this.trustedRoot,
            trustedRootBoundary: this.trustedRootBoundary,
            expectedContent: source.content,
            expectedIdentity: source.identity,
          });
        } catch (error) {
          try {
            await removeManagedFile(nextPath, {
              label: `file node ${id} rename target rollback`,
              trustedRoot: this.trustedRoot,
              trustedRootBoundary: this.trustedRootBoundary,
              expectedContent: source.content,
              expectedIdentity: movedIdentity,
            });
          } catch (rollbackError) {
            throw new AggregateError(
              [error, rollbackError],
              `File node ${id} rename failed and target rollback was incomplete`,
            );
          }
          throw error;
        }
        this.fileIdentities.set(id, movedIdentity);
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
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes >= Number.MAX_SAFE_INTEGER) {
      throw new Error("Preview byte limit must be a positive safe integer");
    }
    const buffer = await this.readCurrentFilePrefix(file, maxBytes + 1);
    return {
      content: buffer.subarray(0, maxBytes).toString("utf-8"),
      truncated: buffer.length > maxBytes,
    };
  }

  async readContent(id: string): Promise<{ content: string; truncated: false }> {
    const file = this.requireTextFile(id);
    const buffer = await this.readCurrentFile(file);
    return {
      content: buffer.toString("utf-8"),
      truncated: false,
    };
  }

  async readRaw(id: string): Promise<{ file: CanvasFileNode; data: Buffer }> {
    const file = this.requireFile(id);
    return { file, data: await this.readCurrentFile(file) };
  }

  async validatedOpenPath(id: string): Promise<string> {
    if (this.activeStateImports > 0) {
      throw new Error("Cannot open files while file state is loading");
    }
    const generation = this.fileStateGeneration;
    const file = this.requireFile(id);
    await this.validateCurrentFile(file);
    this.assertCurrentFileState(generation, file);
    return file.path;
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
    if (file.storage === "referenced" && access === "write") {
      throw new Error("Referenced file nodes are read-only");
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
    const available = new Set<string>();
    for (const file of this.files.values()) {
      if (!this.validateCurrentFileSync(file)) continue;
      available.add(file.id);
      if (file.kind === "shared" && file.sharedRead) readable.set(file.id, file);
      if (file.storage === "isolated" && file.kind === "shared" && file.sharedWrite) {
        writable.set(file.id, file);
        writableDirectories.add(path.dirname(file.path));
      }
    }
    for (const connection of this.connections.values()) {
      if (connection.agentId !== agentId) continue;
      const file = this.files.get(connection.fileId);
      if (!file || !available.has(file.id)) continue;
      if (connection.access === "read") readable.set(file.id, file);
      if (file.storage === "isolated" && connection.access === "write") {
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

  private async createIsolatedCandidate(
    id: string,
    picked: PickedCanvasFile,
    content: string | Buffer,
    kind: CanvasFileKind,
    origin?: CanvasFileOrigin,
  ): Promise<CreatedFileCandidate> {
    const isolatedRoot = this.isolatedRoot;
    const trustedRoot = this.trustedRoot;
    const trustedRootBoundary = this.trustedRootBoundary;
    const filePath = path.join(isolatedRoot, id, picked.filename);
    const identity = await createManagedFileAtomically(filePath, content, {
      label: `file node ${id}`,
      trustedRoot,
      trustedRootBoundary,
    });
    const at = this.now();
    return {
      identity,
      isolatedContext: { trustedRoot, trustedRootBoundary },
      node: {
        id,
        name: picked.name,
        extension: picked.extension,
        filename: picked.filename,
        path: filePath,
        storage: "isolated",
        availability: "available",
        kind,
        sharedRead: false,
        sharedWrite: false,
        previewKind: previewKindForExtension(picked.extension),
        mimeType: mimeTypeForExtension(picked.extension),
        createdAt: at,
        updatedAt: at,
        origin,
      },
    };
  }

  private async createAndPublishIsolated(
    picked: PickedCanvasFile,
    content: string | Buffer,
    kind: CanvasFileKind,
    origin?: CanvasFileOrigin,
  ): Promise<CanvasFileNode> {
    if (this.activeStateImports > 0) {
      throw new Error("Cannot create files while file state is loading");
    }
    const generation = this.fileStateGeneration;
    const candidate = await this.createIsolatedCandidate(
      `file_${this.fileCounter + 1}`,
      picked,
      content,
      kind,
      origin,
    );
    try {
      this.assertFileStateGeneration(generation);
      this.publishCandidates([candidate]);
      return candidate.node;
    } catch (error) {
      const rollbackErrors = await this.rollbackCreatedCandidates([candidate]);
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          "File creation failed and rollback was incomplete",
        );
      }
      throw error;
    }
  }

  private createReferencedCandidate(
    id: string,
    picked: PickedCanvasFile,
    sourcePath: string,
    identity: ManagedFileIdentity,
    kind: CanvasFileKind,
  ): CreatedFileCandidate {
    const at = this.now();
    return {
      identity,
      node: {
        id,
        name: picked.name,
        extension: picked.extension,
        filename: picked.filename,
        path: sourcePath,
        storage: "referenced",
        availability: "available",
        kind,
        sharedRead: false,
        sharedWrite: false,
        previewKind: previewKindForExtension(picked.extension),
        mimeType: mimeTypeForExtension(picked.extension),
        createdAt: at,
        updatedAt: at,
      },
    };
  }

  private publishCandidates(candidates: CreatedFileCandidate[]): void {
    for (const { node } of candidates) {
      if (this.files.has(node.id)) throw new Error(`File node id already exists: ${node.id}`);
    }
    for (const { node, identity } of candidates) {
      this.files.set(node.id, node);
      this.fileIdentities.set(node.id, identity);
    }
    this.fileCounter = Math.max(
      this.fileCounter,
      maxNumericSuffix(candidates.map(({ node }) => node.id)),
    );
  }

  private async rollbackCreatedCandidates(
    candidates: CreatedFileCandidate[],
  ): Promise<unknown[]> {
    const errors: unknown[] = [];
    for (const { node, identity, isolatedContext } of [...candidates].reverse()) {
      try {
        const snapshot = await readManagedFileBufferSnapshot(node.path, {
          label: `picked file rollback ${node.id}`,
          trustedRoot: isolatedContext?.trustedRoot,
          trustedRootBoundary: isolatedContext?.trustedRootBoundary,
        });
        await removeManagedFile(node.path, {
          label: `picked file rollback ${node.id}`,
          trustedRoot: isolatedContext?.trustedRoot,
          trustedRootBoundary: isolatedContext?.trustedRootBoundary,
          expectedContent: snapshot.content,
          expectedIdentity: identity,
        });
        await rmdir(path.dirname(node.path));
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }

  private requirePickedSelection(selectionId: string): StagedPickedFileSelection {
    const selection = this.pickedFileSelections.get(selectionId);
    if (
      !selection ||
      selection.expiresAt <= this.now() ||
      selection.generation !== this.fileStateGeneration
    ) {
      if (selection) this.pickedFileSelections.delete(selectionId);
      throw new PickedFileSelectionExpiredError(selectionId);
    }
    return selection;
  }

  private assertFileStateGeneration(expected: number): void {
    if (this.fileStateGeneration !== expected) {
      throw new Error("File state changed while picked files were being processed");
    }
  }

  private assertCurrentFileState(expectedGeneration: number, expectedFile: CanvasFileNode): void {
    this.assertFileStateGeneration(expectedGeneration);
    if (this.files.get(expectedFile.id) !== expectedFile) {
      throw new Error(`File node changed while it was being processed: ${expectedFile.id}`);
    }
  }

  private purgeExpiredPickedSelections(): void {
    const now = this.now();
    for (const [id, selection] of this.pickedFileSelections) {
      if (selection.expiresAt <= now && !this.importingPickedFileSelections.has(id)) {
        this.pickedFileSelections.delete(id);
      }
    }
  }

  private storageDirectory(id: string, input: CreateCanvasFileInput): string {
    if (input.storage && input.storage !== "isolated") {
      throw new Error("文件节点固定使用隔离目录");
    }
    return path.join(this.isolatedRoot, id);
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

  private async validateCurrentFile(file: CanvasFileNode): Promise<void> {
    if (file.storage === "referenced" && file.availability === "missing") {
      throw new Error(`Referenced file is missing: ${file.path}`);
    }
    try {
      const actual = await validateManagedFile(file.path, this.validationOptions(file));
      if (file.storage === "isolated") this.fileIdentities.set(file.id, actual);
    } catch (error) {
      if (file.storage === "referenced" && isReferencedUnavailableError(error)) {
        this.markReferencedMissing(file);
        throw referencedUnavailableError(file, error);
      }
      throw error;
    }
  }

  private async readCurrentFile(file: CanvasFileNode): Promise<Buffer> {
    if (file.storage === "referenced" && file.availability === "missing") {
      throw new Error(`Referenced file is missing: ${file.path}`);
    }
    if (file.storage === "referenced") {
      const readLimit = Math.min(this.maxPickedFileBytes + 1, Number.MAX_SAFE_INTEGER);
      const buffer = await this.readCurrentFilePrefix(file, readLimit);
      if (buffer.length > this.maxPickedFileBytes) {
        throw new Error(
          `Referenced file exceeds the ${this.maxPickedFileBytes} byte read limit: ${file.path}`,
        );
      }
      return buffer;
    }
    const snapshot = await readManagedFileBufferSnapshot(
      file.path,
      this.validationOptions(file),
    );
    this.fileIdentities.set(file.id, snapshot.identity);
    return snapshot.content;
  }

  private async readCurrentFilePrefix(file: CanvasFileNode, readLimit: number): Promise<Buffer> {
    if (file.storage === "referenced" && file.availability === "missing") {
      throw new Error(`Referenced file is missing: ${file.path}`);
    }
    try {
      const options = this.validationOptions(file);
      const before = await validateManagedFile(file.path, options);
      const handle = await open(file.path, constants.O_RDONLY | pickedNoFollowFlag());
      try {
        const opened = await handle.stat();
        assertOpenFileIdentity(opened, before, options.label);
        const chunks: Buffer[] = [];
        let total = 0;
        while (total < readLimit) {
          const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, readLimit - total));
          const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
          if (bytesRead === 0) break;
          total += bytesRead;
          chunks.push(chunk.subarray(0, bytesRead));
        }
        assertOpenFileIdentity(await handle.stat(), before, options.label);
        const after = await validateManagedFile(file.path, options);
        if (!sameIdentity(before, after)) {
          throw new ManagedFileSafetyError(`${options.label} changed while reading preview`);
        }
        if (file.storage === "isolated") this.fileIdentities.set(file.id, after);
        return Buffer.concat(chunks, total);
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (file.storage === "referenced" && isReferencedUnavailableError(error)) {
        this.markReferencedMissing(file);
        throw referencedUnavailableError(file, error);
      }
      throw error;
    }
  }

  private validateCurrentFileSync(file: CanvasFileNode): boolean {
    if (file.storage === "referenced" && file.availability === "missing") return false;
    try {
      const actual = validateManagedFileSync(file.path, this.validationOptions(file));
      if (file.storage === "isolated") this.fileIdentities.set(file.id, actual);
      return true;
    } catch (error) {
      if (file.storage === "referenced" && isReferencedUnavailableError(error)) {
        this.markReferencedMissing(file);
        return false;
      }
      throw error;
    }
  }

  private validationOptions(file: CanvasFileNode): {
    label: string;
    trustedRoot?: string;
    trustedRootBoundary?: ManagedTrustedRootBoundary;
  } {
    return file.storage === "isolated"
      ? {
          label: `file node ${file.id}`,
          trustedRoot: this.trustedRoot,
          trustedRootBoundary: this.trustedRootBoundary,
        }
      : { label: `referenced file node ${file.id}` };
  }

  private markReferencedMissing(file: CanvasFileNode): CanvasFileNode {
    const current = this.files.get(file.id) ?? file;
    if (current.availability === "missing" && !this.fileIdentities.has(file.id)) {
      return current;
    }
    this.fileIdentities.delete(file.id);
    const missing: CanvasFileNode = {
      ...current,
      availability: "missing",
      updatedAt: this.now(),
    };
    this.files.set(file.id, missing);
    return missing;
  }
}

interface InspectedReferencedFile {
  path: string;
  availability: CanvasFileNode["availability"];
  identity?: ManagedFileIdentity;
  size?: number;
  modifiedAt?: number;
}

async function inspectReferencedFile(
  sourcePath: string,
  options: { allowMissing: boolean; label: string },
): Promise<InspectedReferencedFile> {
  if (typeof sourcePath !== "string" || sourcePath.length === 0) {
    throw new Error(`${options.label} path is required`);
  }
  const requestedPath = path.resolve(sourcePath);
  let requestedStat: Awaited<ReturnType<typeof lstat>>;
  try {
    requestedStat = await lstat(requestedPath);
  } catch (error) {
    if (options.allowMissing && isMissingFilesystemError(error)) {
      return {
        path: await canonicalizeMissingReferencedPath(requestedPath, options.label),
        availability: "missing",
      };
    }
    throw error;
  }
  if (!requestedStat.isFile() || requestedStat.isSymbolicLink()) {
    throw new Error(`${options.label} must be a regular non-symbolic-link file: ${requestedPath}`);
  }
  const canonicalPath = await realpath(requestedPath);
  const canonicalStat = await lstat(canonicalPath);
  if (
    !canonicalStat.isFile() ||
    canonicalStat.isSymbolicLink() ||
    !sameIdentity(requestedStat, canonicalStat)
  ) {
    throw new Error(`${options.label} must resolve to a regular file: ${requestedPath}`);
  }
  const identity = await validateManagedFile(canonicalPath, { label: options.label });
  const validatedStat = await lstat(canonicalPath);
  if (
    !validatedStat.isFile() ||
    validatedStat.isSymbolicLink() ||
    !sameIdentity(requestedStat, validatedStat) ||
    !sameIdentity(identity, validatedStat)
  ) {
    throw new Error(`${options.label} changed while it was being inspected: ${requestedPath}`);
  }
  return {
    path: canonicalPath,
    availability: "available",
    identity,
    size: validatedStat.size,
    modifiedAt: validatedStat.mtimeMs,
  };
}

function filenameParts(filenameValue: string): PickedCanvasFile {
  if (typeof filenameValue !== "string") throw new Error("File name is required");
  const filename = validateImportedFilename(filenameValue);
  const suffix = path.extname(filename);
  const hasExtension = suffix.length > 1;
  const name = hasExtension ? filename.slice(0, -suffix.length) : filename;
  const extension = hasExtension ? suffix.slice(1) : "";
  return {
    name,
    extension,
    filename,
    size: 0,
  };
}

function persistedFilenameParts(
  nameValue: unknown,
  extensionValue: unknown,
): PickedCanvasFile {
  if (typeof nameValue !== "string" || typeof extensionValue !== "string") {
    throw new Error("Invalid persisted file name or extension");
  }
  if (!nameValue || nameValue === "." || nameValue === "..") {
    throw new Error("Invalid persisted file name");
  }
  if (/[/\\\u0000-\u001f]/u.test(nameValue)) {
    throw new Error("Invalid persisted file name");
  }
  if (/[/\\.\u0000-\u001f]/u.test(extensionValue)) {
    throw new Error("Invalid persisted file extension");
  }
  const filename = validateImportedFilename(makeFilename(nameValue, extensionValue));
  return { name: nameValue, extension: extensionValue, filename, size: 0 };
}

function validateImportedFilename(value: string): string {
  if (
    !value ||
    value === "." ||
    value === ".." ||
    value !== path.basename(value) ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    /[/\\\u0000-\u001f]/u.test(value)
  ) {
    throw new Error("File name must be a safe basename without a directory path");
  }
  if (process.platform === "win32" && (/[<>:"|?*]/u.test(value) || /[. ]$/u.test(value))) {
    throw new Error("File name contains characters unsupported by this platform");
  }
  return value;
}

async function canonicalizeMissingReferencedPath(
  requestedPath: string,
  label: string,
): Promise<string> {
  let ancestor = requestedPath;
  const missingSegments: string[] = [];
  for (;;) {
    try {
      const ancestorStat = await lstat(ancestor);
      const canonicalAncestor = await realpath(ancestor);
      const canonicalStat = await lstat(canonicalAncestor);
      if (
        (!ancestorStat.isDirectory() && !ancestorStat.isSymbolicLink()) ||
        !canonicalStat.isDirectory() ||
        canonicalStat.isSymbolicLink()
      ) {
        throw new Error(`${label} missing path has a non-directory ancestor: ${ancestor}`);
      }
      const canonicalPath = path.join(canonicalAncestor, ...missingSegments);
      try {
        await lstat(canonicalPath);
      } catch (error) {
        if (isMissingFilesystemError(error)) return canonicalPath;
        throw error;
      }
      return (await inspectReferencedFile(canonicalPath, { allowMissing: false, label })).path;
    } catch (error) {
      if (!isMissingFilesystemError(error)) throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) {
        // An unavailable drive or network share has no existing ancestor to resolve. Preserve
        // the absolute lexical path so an already-authorized reference can remain missing and be
        // relinked without blocking the whole Canvas project.
        return path.resolve(ancestor, ...missingSegments);
      }
      missingSegments.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

function normalizedTrustedReferencedPaths(paths: string[]): Set<string> {
  const trusted = new Set<string>();
  for (const trustedPath of paths) {
    if (typeof trustedPath !== "string" || !path.isAbsolute(trustedPath)) {
      throw new Error(`Trusted referenced file path must be absolute: ${String(trustedPath)}`);
    }
    trusted.add(normalizedFilePathKey(path.resolve(trustedPath)));
  }
  return trusted;
}

async function readPickedFileWithinLimit(
  filePath: string,
  expected: StagedPickedFile,
  maxBytes: number,
): Promise<Buffer> {
  const label = `picked file ${expected.file.filename}`;
  const before = await lstat(filePath);
  assertPickedFileStat(before, expected, label);
  if (before.size > maxBytes) {
    throw new Error(`${label} exceeds the ${maxBytes} byte copy limit`);
  }
  const handle = await open(filePath, constants.O_RDONLY | pickedNoFollowFlag());
  try {
    const opened = await handle.stat();
    assertPickedFileStat(opened, expected, label);
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes - total + 1));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) {
        throw new Error(`${label} exceeds the ${maxBytes} byte copy limit`);
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const afterHandle = await handle.stat();
    assertPickedFileStat(afterHandle, expected, label);
    const afterPath = await lstat(filePath);
    assertPickedFileStat(afterPath, expected, label);
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

function assertPickedFileStat(
  stat: Stats,
  expected: StagedPickedFile,
  label: string,
): void {
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    !sameIdentity(expected.identity, stat) ||
    stat.size !== expected.size ||
    stat.mtimeMs !== expected.modifiedAt
  ) {
    throw new Error(`${label} changed after it was selected`);
  }
}

function assertOpenFileIdentity(
  stat: Stats,
  expected: ManagedFileIdentity,
  label: string,
): void {
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    !sameIdentity(expected, stat)
  ) {
    throw new ManagedFileSafetyError(`${label} changed while opening or reading`);
  }
}

function samePickedFingerprint(
  expected: StagedPickedFile,
  actual: InspectedReferencedFile,
): boolean {
  return (
    actual.identity !== undefined &&
    actual.size === expected.size &&
    actual.modifiedAt === expected.modifiedAt &&
    sameIdentity(expected.identity, actual.identity)
  );
}

function pickedNoFollowFlag(): number {
  return process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
}

function positiveIntegerOption(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return resolved;
}

function normalizeKind(value: CanvasFileKind): CanvasFileKind {
  if (value !== "normal" && value !== "shared") {
    throw new Error(`Invalid file node kind: ${String(value)}`);
  }
  return value;
}

function normalizedFilePathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function sameIdentity(left: ManagedFileIdentity, right: ManagedFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isMissingFilesystemError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function isReferencedUnavailableError(error: unknown): boolean {
  if (error instanceof ManagedFileSafetyError) return true;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return (
    code === "UNSAFE_MANAGED_FILE" ||
    code === "ENOENT" ||
    code === "ENOTDIR" ||
    code === "EACCES" ||
    code === "EPERM" ||
    code === "EBUSY" ||
    code === "ESTALE" ||
    code === "EIO" ||
    code === "ENODEV" ||
    code === "ENXIO"
  );
}

function referencedUnavailableError(file: CanvasFileNode, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`Referenced file is missing or unavailable: ${file.path}. ${detail}`);
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
    await lstat(filePath);
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
    .update(process.platform === "win32" ? workspaceRoot.toLowerCase() : workspaceRoot)
    .digest("hex")
    .slice(0, 12);
  return path.join(localDataRoot, "agent_canvas", "files", workspaceKey);
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
