import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
  type BigIntStats,
  type Stats,
} from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm, rmdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AgentFileAccess,
  AgentFileReference,
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
  maxRetainedAccessScopesPerAgent?: number;
  maxRetainedAccessBytesPerAgent?: number;
  maxRetainedAccessScopes?: number;
  maxRetainedAccessBytes?: number;
  /** Internal observation hook used to deterministically exercise concurrent file changes. */
  readChunkObserver?: (event: {
    purpose: "stage" | "copy" | "preview";
    filePath: string;
    bytesRead: number;
  }) => void | Promise<void>;
  /** Internal observation hook used to deterministically exercise path/handle races. */
  referencedFileInspectionObserver?: (event: {
    phase: "opened";
    requestedPath: string;
    canonicalPath: string;
    identity: TrustedReferencedFileIdentity;
  }) => void | Promise<void>;
  /** Internal hook used to deterministically exercise snapshot cleanup failures. */
  accessSnapshotPathRemover?: (targetPath: string) => Promise<void>;
}

export interface ImportFileStateOptions {
  trustedReferencedFiles?: TrustedReferencedFileAuthorization[];
}

/**
 * A short-lived authorization lease captured after canonicalizing an external file path.
 * Paths are compared exactly: on case-insensitive volumes realpath naturally converges casing,
 * while case-sensitive Windows directories keep distinct files distinct.
 */
export interface TrustedReferencedFileAuthorization {
  path: string;
  identity: TrustedReferencedFileIdentity;
}

export interface TrustedReferencedFileIdentity {
  dev: string;
  ino: string;
}

interface StagedPickedFile {
  path: string;
  identity: ManagedFileIdentity;
  authorizationIdentity: TrustedReferencedFileIdentity;
  size: number;
  modifiedAt: number;
  changedAt: number;
  contentDigest?: string;
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
  authorizationIdentity?: TrustedReferencedFileIdentity;
  isolatedContext?: {
    trustedRoot?: string;
    trustedRootBoundary?: ManagedTrustedRootBoundary;
  };
}

interface FileAccessStateSnapshot {
  generation: number;
  fileGeneration: number;
  files: Array<readonly [string, CanvasFileNode]>;
  connections: Array<readonly [string, CanvasFileConnection]>;
}

interface PreparedAgentFileAccess {
  generation: number;
  sequence: number;
  scopePath: string;
  referencedFiles: Map<string, AgentFileReference>;
}

interface AccessSnapshotDirectoryIdentity {
  dev: bigint;
  ino: bigint;
}

interface AccessSnapshotDirectoryOwnership {
  path: string;
  identity: AccessSnapshotDirectoryIdentity;
}

interface RetainedAccessSnapshotScope {
  agentId: string;
  sequence: number;
  scopePath: string;
  scopeIdentity: AccessSnapshotDirectoryIdentity;
  bytes: number;
}

export interface FileAccessCheckpoint {
  readonly agentId: string;
  readonly sequence: number;
}

export const DEFAULT_MAX_PICKED_FILE_BYTES = 100 * 1024 * 1024;
export const DEFAULT_MAX_PICKED_BATCH_BYTES = 500 * 1024 * 1024;
export const DEFAULT_PICKED_SELECTION_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_MAX_RETAINED_ACCESS_SCOPES_PER_AGENT = 8;
export const DEFAULT_MAX_RETAINED_ACCESS_BYTES_PER_AGENT = 1024 * 1024 * 1024;
export const DEFAULT_MAX_RETAINED_ACCESS_SCOPES = 64;
export const DEFAULT_MAX_RETAINED_ACCESS_BYTES = 4 * 1024 * 1024 * 1024;

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
  private readonly referencedFileAuthorizationIdentities =
    new Map<string, TrustedReferencedFileIdentity>();
  private readonly pickedFileSelections = new Map<string, StagedPickedFileSelection>();
  private readonly importingPickedFileSelections = new Set<string>();
  private readonly preparedAccessByAgent = new Map<string, PreparedAgentFileAccess>();
  private readonly accessSnapshotScopes = new Map<number, RetainedAccessSnapshotScope>();
  private readonly accessSnapshotScopesByAgent =
    new Map<string, Map<number, RetainedAccessSnapshotScope>>();
  private readonly orphanedAccessSnapshotScopes =
    new Set<AccessSnapshotDirectoryOwnership>();
  private readonly lastAccessDispatchSequenceByAgent = new Map<string, number>();
  private readonly accessCheckpoints = new WeakSet<object>();
  private readonly accessSnapshotRoot = path.join(
    realpathSync(os.tmpdir()),
    `agent-canvas-file-access-${randomUUID()}`,
  );
  private readonly accessSnapshotParentIdentity = accessSnapshotDirectoryIdentitySync(
    path.dirname(this.accessSnapshotRoot),
    "agent file access snapshot parent",
  );
  private accessSnapshotRootReady: Promise<void> | undefined;
  private accessSnapshotRootIdentity: AccessSnapshotDirectoryIdentity | undefined;
  private readonly workspaceRoot: string;
  private isolatedRoot: string;
  private trustedRoot: string | undefined;
  private trustedRootBoundary: ManagedTrustedRootBoundary | undefined;
  private readonly now: () => number;
  private readonly maxPickedFileBytes: number;
  private readonly maxPickedBatchBytes: number;
  private readonly pickedSelectionTtlMs: number;
  private readonly maxRetainedAccessScopesPerAgent: number;
  private readonly maxRetainedAccessBytesPerAgent: number;
  private readonly maxRetainedAccessScopes: number;
  private readonly maxRetainedAccessBytes: number;
  private readonly readChunkObserver: FileManagerOptions["readChunkObserver"];
  private readonly referencedFileInspectionObserver:
    FileManagerOptions["referencedFileInspectionObserver"];
  private readonly accessSnapshotPathRemover:
    NonNullable<FileManagerOptions["accessSnapshotPathRemover"]>;
  private fileStateGeneration = 0;
  private accessGeneration = 0;
  private accessDispatchSequence = 0;
  private retainedAccessBytes = 0;
  private accessLifecycleTail: Promise<void> = Promise.resolve();
  private accessSnapshotsDisposed = false;
  private disposeAccessSnapshotsPromise: Promise<void> | undefined;
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
    this.maxRetainedAccessScopesPerAgent = positiveIntegerOption(
      options.maxRetainedAccessScopesPerAgent,
      DEFAULT_MAX_RETAINED_ACCESS_SCOPES_PER_AGENT,
      "maxRetainedAccessScopesPerAgent",
    );
    this.maxRetainedAccessBytesPerAgent = positiveIntegerOption(
      options.maxRetainedAccessBytesPerAgent,
      DEFAULT_MAX_RETAINED_ACCESS_BYTES_PER_AGENT,
      "maxRetainedAccessBytesPerAgent",
    );
    this.maxRetainedAccessScopes = positiveIntegerOption(
      options.maxRetainedAccessScopes,
      DEFAULT_MAX_RETAINED_ACCESS_SCOPES,
      "maxRetainedAccessScopes",
    );
    this.maxRetainedAccessBytes = positiveIntegerOption(
      options.maxRetainedAccessBytes,
      DEFAULT_MAX_RETAINED_ACCESS_BYTES,
      "maxRetainedAccessBytes",
    );
    this.readChunkObserver = options.readChunkObserver;
    this.referencedFileInspectionObserver = options.referencedFileInspectionObserver;
    this.accessSnapshotPathRemover =
      options.accessSnapshotPathRemover ?? removeAccessSnapshotPath;
  }

  list(): CanvasFileNode[] {
    return [...this.files.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  setIsolatedRoot(
    isolatedRoot: string,
    trustedRoot?: string,
    trustedRootBoundary?: ManagedTrustedRootBoundary,
  ): void {
    const nextIsolatedRoot = path.resolve(isolatedRoot);
    const nextTrustedRoot = trustedRoot ? path.resolve(trustedRoot) : undefined;
    if (
      sameResolvedPath(this.isolatedRoot, nextIsolatedRoot) &&
      sameOptionalResolvedPath(this.trustedRoot, nextTrustedRoot) &&
      sameTrustedRootBoundary(this.trustedRootBoundary, trustedRootBoundary)
    ) {
      return;
    }
    this.fileStateGeneration += 1;
    this.invalidatePreparedAccess();
    this.pickedFileSelections.clear();
    this.referencedFileAuthorizationIdentities.clear();
    this.isolatedRoot = nextIsolatedRoot;
    this.trustedRoot = nextTrustedRoot;
    this.trustedRootBoundary = trustedRootBoundary;
  }

  exportState(): PersistedFileState {
    return {
      files: this.list(),
      connections: this.listConnections(),
    };
  }

  /**
   * Immediately revoke every file-node capability held by the in-memory canvas
   * state. Retained snapshot scopes deliberately stay in their ownership ledger:
   * a failed OS cleanup is not permission to forget paths that must be retried at
   * the next exact lifecycle barrier.
   */
  revokeInMemoryAccess(): void {
    this.fileStateGeneration += 1;
    this.invalidatePreparedAccess();
    this.files.clear();
    this.connections.clear();
    this.fileIdentities.clear();
    this.referencedFileAuthorizationIdentities.clear();
    this.pickedFileSelections.clear();
    this.importingPickedFileSelections.clear();
    this.preparedAccessByAgent.clear();
    this.fileCounter = 0;
    this.connectionCounter = 0;
  }

  async importState(
    state: PersistedFileState | undefined,
    options: ImportFileStateOptions = {},
  ): Promise<void> {
    const importGeneration = ++this.fileStateGeneration;
    this.invalidatePreparedAccess();
    this.activeStateImports += 1;
    try {
      this.pickedFileSelections.clear();
      await this.resetAccessSnapshotsForImport();
      const nextFiles = new Map<string, CanvasFileNode>();
      const nextConnections = new Map<string, CanvasFileConnection>();
      const nextIdentities = new Map<string, ManagedFileIdentity>();
      const nextReferencedFileAuthorizationIdentities =
        new Map<string, TrustedReferencedFileIdentity>();
      const trustedReferencedFiles = await trustedReferencedFileAuthorizations(options);
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
          const lexicalAuthorization = trustedReferencedFiles.get(persistedPath);
          let inspected: InspectedReferencedFile | undefined;
          let unavailable = false;
          try {
            inspected = await inspectReferencedFile(persistedPath, {
              allowMissing: true,
              label: `persisted referenced file ${id}`,
              observer: this.referencedFileInspectionObserver,
            });
          } catch (error) {
            if (!isReferencedUnavailableError(error)) throw error;
            unavailable = true;
          }
          const lexicalPathTrusted = lexicalAuthorization !== undefined &&
            sameCanonicalExternalPath(lexicalAuthorization.path, persistedPath);
          if (unavailable) {
            if (!lexicalPathTrusted) {
              throw new Error(`Persisted referenced file path is not trusted: ${persistedPath}`);
            }
            filePath = persistedPath;
            availability = "missing";
            nextReferencedFileAuthorizationIdentities.set(id, lexicalAuthorization.identity);
          } else if (inspected?.availability === "missing") {
            const inspectedAuthorization = trustedReferencedFiles.get(inspected.path);
            if (!inspectedAuthorization && !lexicalPathTrusted) {
              throw new Error(`Persisted referenced file path is not trusted: ${persistedPath}`);
            }
            const authorization = inspectedAuthorization ?? lexicalAuthorization!;
            filePath = inspectedAuthorization ? inspected.path : persistedPath;
            availability = "missing";
            nextReferencedFileAuthorizationIdentities.set(id, authorization.identity);
          } else {
            const inspectedAuthorization = inspected === undefined
              ? undefined
              : trustedReferencedFiles.get(inspected.path);
            if (
              inspected === undefined ||
              inspectedAuthorization === undefined ||
              !authorizationIdentityMatches(
                inspectedAuthorization.identity,
                inspected.authorizationIdentity,
              )
            ) {
              throw new Error(
                `Persisted referenced file authorization identity changed: ${persistedPath}`,
              );
            }
            filePath = inspected.path;
            availability = "available";
            identity = inspected.identity;
            nextReferencedFileAuthorizationIdentities.set(
              id,
              inspectedAuthorization.identity,
            );
          }
          const source = filenameParts(path.basename(filePath));
          if (extension !== source.extension) {
            throw new Error(`Persisted referenced file extension does not match its source: ${id}`);
          }
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
      this.referencedFileAuthorizationIdentities.clear();
      for (const [id, file] of nextFiles) this.files.set(id, file);
      for (const [id, connection] of nextConnections) this.connections.set(id, connection);
      for (const [id, identity] of nextIdentities) this.fileIdentities.set(id, identity);
      for (const [id, identity] of nextReferencedFileAuthorizationIdentities) {
        this.referencedFileAuthorizationIdentities.set(id, identity);
      }
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
        observer: this.referencedFileInspectionObserver,
      });
      this.assertFileStateGeneration(generation);
      const parts = filenameParts(path.basename(inspected.path));
      staged.push({
        path: inspected.path,
        identity: inspected.identity!,
        authorizationIdentity: inspected.authorizationIdentity!,
        size: inspected.size!,
        modifiedAt: inspected.modifiedAt!,
        changedAt: inspected.changedAt!,
        file: {
          ...parts,
          size: inspected.size!,
        },
      });
    }
    const copyEligible =
      staged.every(({ size }) => size <= this.maxPickedFileBytes) &&
      staged.reduce((total, { size }) => total + size, 0) <= this.maxPickedBatchBytes;
    if (copyEligible) {
      for (const picked of staged) {
        picked.contentDigest = await digestPickedFile(
          picked.path,
          picked,
          this.readChunkObserver,
        );
        this.assertFileStateGeneration(generation);
      }
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
          observer: this.referencedFileInspectionObserver,
        });
        this.assertFileStateGeneration(generation);
        if (!sameCanonicalExternalPath(inspected.path, picked.path)) {
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
              this.readChunkObserver,
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
          inspected.authorizationIdentity!,
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

  async relinkReferenced(
    id: string,
    sourceAuthorization: TrustedReferencedFileAuthorization,
  ): Promise<CanvasFileNode> {
    if (this.activeStateImports > 0) {
      throw new Error("Cannot relink files while file state is loading");
    }
    const generation = this.fileStateGeneration;
    const current = this.requireFile(id);
    if (current.storage !== "referenced") {
      throw new Error(`Only referenced file nodes can be relinked: ${id}`);
    }
    const authorization = requiredTrustedReferencedFileAuthorization(
      sourceAuthorization,
      `referenced file ${id}`,
    );
    const inspected = await inspectReferencedFile(authorization.path, {
      allowMissing: false,
      label: `referenced file ${id}`,
      observer: this.referencedFileInspectionObserver,
    });
    this.assertCurrentFileState(generation, current);
    if (
      !sameCanonicalExternalPath(authorization.path, inspected.path) ||
      !authorizationIdentityMatches(authorization.identity, inspected.authorizationIdentity)
    ) {
      throw new Error(`Referenced file ${id} changed its canonical target before relinking`);
    }
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
    this.referencedFileAuthorizationIdentities.set(id, authorization.identity);
    this.invalidatePreparedAccess();
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
      this.invalidatePreparedAccess();
      return updated;
    }

    let inspected: InspectedReferencedFile;
    try {
      inspected = await inspectReferencedFile(current.path, {
        allowMissing: true,
        label: `referenced file ${id}`,
        observer: this.referencedFileInspectionObserver,
      });
    } catch (error) {
      this.assertCurrentFileState(generation, current);
      if (isReferencedUnavailableError(error)) {
        return this.markReferencedMissing(current, generation);
      }
      throw error;
    }
    this.assertCurrentFileState(generation, current);
    if (!sameCanonicalExternalPath(current.path, inspected.path)) {
      return this.markReferencedMissing(current, generation);
    }
    if (inspected.availability === "missing") {
      return this.markReferencedMissing(current, generation);
    }
    const pendingIdentity = this.referencedFileAuthorizationIdentities.get(id);
    if (
      pendingIdentity === undefined ||
      !authorizationIdentityMatches(pendingIdentity, inspected.authorizationIdentity)
    ) {
      return this.markReferencedMissing(current, generation);
    }

    if (
      current.availability === "available" &&
      sameCanonicalExternalPath(current.path, inspected.path) &&
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
    this.referencedFileAuthorizationIdentities.set(
      id,
      inspected.authorizationIdentity!,
    );
    this.invalidatePreparedAccess();
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
    const generation = this.fileStateGeneration;
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
      this.invalidatePreparedAccess();
      return updated;
    }
    const currentIdentity = await this.validateCurrentFile(current);
    this.assertCurrentFileState(generation, current);
    this.fileIdentities.set(current.id, currentIdentity);
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
    this.invalidatePreparedAccess();
    return updated;
  }

  async readPreview(
    id: string,
    maxBytes = 256 * 1024,
  ): Promise<{ content: string; truncated: boolean }> {
    const generation = this.fileStateGeneration;
    const file = this.requireTextFile(id);
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes >= Number.MAX_SAFE_INTEGER) {
      throw new Error("Preview byte limit must be a positive safe integer");
    }
    try {
      const result = await this.readCurrentFilePrefix(file, maxBytes + 1);
      this.commitReadIdentity(generation, file, result.identity);
      return {
        content: result.buffer.subarray(0, maxBytes).toString("utf-8"),
        truncated: result.buffer.length > maxBytes,
      };
    } catch (error) {
      return this.rejectCurrentFileOperation(generation, file, error);
    }
  }

  async readContent(id: string): Promise<{ content: string; truncated: false }> {
    const generation = this.fileStateGeneration;
    const file = this.requireTextFile(id);
    try {
      const result = await this.readCurrentFile(file);
      this.commitReadIdentity(generation, file, result.identity);
      return { content: result.buffer.toString("utf-8"), truncated: false };
    } catch (error) {
      return this.rejectCurrentFileOperation(generation, file, error);
    }
  }

  async readRaw(id: string): Promise<{ file: CanvasFileNode; data: Buffer }> {
    const generation = this.fileStateGeneration;
    const file = this.requireFile(id);
    try {
      const result = await this.readCurrentFile(file);
      this.commitReadIdentity(generation, file, result.identity);
      return { file, data: result.buffer };
    } catch (error) {
      return this.rejectCurrentFileOperation(generation, file, error);
    }
  }

  async validatedOpenPath(id: string): Promise<string> {
    if (this.activeStateImports > 0) {
      throw new Error("Cannot open files while file state is loading");
    }
    const generation = this.fileStateGeneration;
    const file = this.requireFile(id);
    try {
      const identity = await this.validateCurrentFile(file);
      this.commitReadIdentity(generation, file, identity);
      return file.path;
    } catch (error) {
      return this.rejectCurrentFileOperation(generation, file, error);
    }
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
    this.invalidatePreparedAccess();
    return connection;
  }

  disconnect(id: string): boolean {
    const deleted = this.connections.delete(id);
    if (deleted) this.invalidatePreparedAccess();
    return deleted;
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

  async prepareAccessFor(agentId: string): Promise<void> {
    this.assertAccessSnapshotsOpen();
    return this.enqueueAccessLifecycle(async () => {
      this.assertAccessSnapshotsOpen();
      if (this.activeStateImports > 0) {
        throw new Error("Cannot prepare file access while file state is loading");
      }
      await this.cleanupOrphanedAccessSnapshotScopes();
      const expected = this.captureAccessState();
      const referencedFiles = this.readableReferencedFilesFor(agentId, expected);
      if (referencedFiles.length === 0) {
        this.assertAccessState(expected);
        this.assertAccessSnapshotsOpen();
        // A successful empty preparation is still a dispatch boundary. Advancing the
        // watermark lets a queued turn with no file grants retire the previous turn's scope
        // without allocating a directory or consuming snapshot quota.
        const sequence = this.nextAccessDispatchSequence();
        this.preparedAccessByAgent.delete(agentId);
        this.lastAccessDispatchSequenceByAgent.set(agentId, sequence);
        return;
      }

      const scopePath = path.join(this.accessSnapshotRoot, randomUUID());
      let scopeOwnership: AccessSnapshotDirectoryOwnership | undefined;
      const preparedFiles = new Map<string, AgentFileReference>();
      const identities = new Map<string, ManagedFileIdentity>();
      let batchBytes = 0;
      try {
        await this.ensureAccessSnapshotRoot();
        await this.assertAccessSnapshotRootIdentity();
        await mkdir(scopePath, { mode: 0o700 });
        scopeOwnership = {
          path: scopePath,
          identity: await captureAccessSnapshotDirectoryIdentity(
            scopePath,
            "agent file access snapshot scope",
          ),
        };
        await this.assertAccessSnapshotRootIdentity();
        for (const file of referencedFiles) {
          let snapshot: { buffer: Buffer; identity: ManagedFileIdentity };
          try {
            snapshot = await this.readCurrentFile(file);
          } catch (error) {
            this.assertAccessState(expected);
            if (isReferencedUnavailableError(error)) {
              this.markReferencedMissing(file, expected.fileGeneration);
              throw referencedUnavailableError(file, error);
            }
            throw error;
          }
          batchBytes += snapshot.buffer.length;
          if (batchBytes > this.maxPickedBatchBytes) {
            throw new Error(
              `Referenced file access batch exceeds the ${this.maxPickedBatchBytes} byte snapshot limit`,
            );
          }
          const snapshotPath = path.join(scopePath, `${file.id}-${file.filename}`);
          await createManagedFileAtomically(snapshotPath, snapshot.buffer, {
            label: `agent file access snapshot ${file.id}`,
          });
          await this.assertAccessSnapshotRootIdentity();
          await assertAccessSnapshotDirectoryIdentity(
            scopeOwnership.path,
            scopeOwnership.identity,
            "agent file access snapshot scope",
          );
          identities.set(file.id, snapshot.identity);
          preparedFiles.set(file.id, {
            name: file.filename,
            path: snapshotPath,
            previewKind: file.previewKind,
          });
        }
        this.assertAccessState(expected);
        this.assertAccessSnapshotsOpen();
        this.assertRetainedAccessCapacity(agentId, batchBytes);
        const sequence = this.nextAccessDispatchSequence();
        const scope: RetainedAccessSnapshotScope = {
          agentId,
          sequence,
          scopePath,
          scopeIdentity: scopeOwnership.identity,
          bytes: batchBytes,
        };
        for (const [id, identity] of identities) this.fileIdentities.set(id, identity);
        this.retainAccessSnapshotScope(scope);
        this.preparedAccessByAgent.set(agentId, {
          generation: expected.generation,
          sequence,
          scopePath,
          referencedFiles: preparedFiles,
        });
      } catch (error) {
        if (!scopeOwnership) throw error;
        try {
          await this.removeUnpublishedAccessSnapshotScope(scopeOwnership);
        } catch (rollbackError) {
          this.orphanedAccessSnapshotScopes.add(scopeOwnership);
          throw new AggregateError(
            [error, rollbackError],
            "File access snapshot preparation failed and rollback was incomplete",
          );
        }
        throw error;
      }
    });
  }

  captureAccessCheckpoint(agentId: string): FileAccessCheckpoint {
    this.assertAccessSnapshotsOpen();
    const checkpoint = Object.freeze({
      agentId,
      sequence: this.lastAccessDispatchSequenceByAgent.get(agentId) ?? 0,
    });
    this.accessCheckpoints.add(checkpoint);
    return checkpoint;
  }

  async retireAccessBefore(checkpoint: FileAccessCheckpoint): Promise<void> {
    this.assertAccessSnapshotsOpen();
    this.assertAccessCheckpoint(checkpoint);
    return this.enqueueAccessLifecycle(async () => {
      await this.retireAccessScopes(checkpoint, false);
    });
  }

  async retireAccessThrough(checkpoint: FileAccessCheckpoint): Promise<void> {
    this.assertAccessSnapshotsOpen();
    this.assertAccessCheckpoint(checkpoint);
    return this.enqueueAccessLifecycle(async () => {
      await this.retireAccessScopes(checkpoint, true);
    });
  }

  disposeAccessSnapshots(): Promise<void> {
    if (this.disposeAccessSnapshotsPromise) return this.disposeAccessSnapshotsPromise;
    this.accessSnapshotsDisposed = true;
    this.invalidatePreparedAccess();
    this.preparedAccessByAgent.clear();
    let disposal!: Promise<void>;
    disposal = this.enqueueAccessLifecycle(async () => {
      await this.removeAllAccessSnapshotDirectories();
      this.lastAccessDispatchSequenceByAgent.clear();
    }).catch((error: unknown) => {
      if (this.disposeAccessSnapshotsPromise === disposal) {
        // Keep the exact retained-scope ledger and allow a later cleanup retry. The preparation
        // gate remains permanently closed, so no new scope can appear between attempts.
        this.disposeAccessSnapshotsPromise = undefined;
      }
      throw error;
    });
    this.disposeAccessSnapshotsPromise = disposal;
    return disposal;
  }

  accessFor(agentId: string): AgentFileAccess {
    const readable = new Map<string, AgentFileReference>();
    const writable = new Map<string, AgentFileReference>();
    const writableDirectories = new Set<string>();
    const readableDirectories = new Set<string>();
    const available = new Set<string>();
    const prepared = this.preparedAccessByAgent.get(agentId);
    const currentPrepared = prepared?.generation === this.accessGeneration
      ? prepared
      : undefined;
    for (const file of this.files.values()) {
      if (file.storage === "referenced") {
        const snapshot = currentPrepared?.referencedFiles.get(file.id);
        if (file.availability !== "available" || !snapshot) continue;
        available.add(file.id);
        if (file.kind === "shared" && file.sharedRead) readable.set(file.id, snapshot);
        continue;
      }
      if (!this.validateCurrentFileSync(file)) continue;
      available.add(file.id);
      const reference = this.agentFileReference(file);
      if (file.kind === "shared" && file.sharedRead) readable.set(file.id, reference);
      if (file.kind === "shared" && file.sharedWrite) {
        writable.set(file.id, reference);
        writableDirectories.add(path.dirname(file.path));
      }
    }
    for (const connection of this.connections.values()) {
      if (connection.agentId !== agentId) continue;
      const file = this.files.get(connection.fileId);
      if (!file || !available.has(file.id)) continue;
      const reference = file.storage === "referenced"
        ? currentPrepared!.referencedFiles.get(file.id)!
        : this.agentFileReference(file);
      if (connection.access === "read") readable.set(file.id, reference);
      if (file.storage === "isolated" && connection.access === "write") {
        writable.set(file.id, reference);
        writableDirectories.add(path.dirname(file.path));
      }
    }
    if (
      currentPrepared &&
      [...currentPrepared.referencedFiles.keys()].some((id) => readable.has(id))
    ) {
      readableDirectories.add(currentPrepared.scopePath);
    }
    return {
      readableFiles: [...readable.values()],
      readableDirectories: [...readableDirectories],
      writableFiles: [...writable.values()],
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
    authorizationIdentity: TrustedReferencedFileIdentity,
    kind: CanvasFileKind,
  ): CreatedFileCandidate {
    const at = this.now();
    return {
      identity,
      authorizationIdentity,
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
    for (const { node, identity, authorizationIdentity } of candidates) {
      this.files.set(node.id, node);
      this.fileIdentities.set(node.id, identity);
      if (node.storage === "referenced" && authorizationIdentity) {
        this.referencedFileAuthorizationIdentities.set(node.id, authorizationIdentity);
      }
    }
    this.fileCounter = Math.max(
      this.fileCounter,
      maxNumericSuffix(candidates.map(({ node }) => node.id)),
    );
    if (candidates.length > 0) this.invalidatePreparedAccess();
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

  private invalidatePreparedAccess(): void {
    this.accessGeneration += 1;
  }

  private captureAccessState(): FileAccessStateSnapshot {
    return {
      generation: this.accessGeneration,
      fileGeneration: this.fileStateGeneration,
      files: [...this.files.entries()],
      connections: [...this.connections.entries()],
    };
  }

  private assertAccessState(expected: FileAccessStateSnapshot): void {
    if (this.activeStateImports > 0 || this.accessGeneration !== expected.generation) {
      throw new Error("File access changed while snapshots were being prepared");
    }
    if (
      this.files.size !== expected.files.length ||
      this.connections.size !== expected.connections.length
    ) {
      throw new Error("File access nodes changed while snapshots were being prepared");
    }
    for (const [id, file] of expected.files) {
      if (this.files.get(id) !== file) {
        throw new Error(`File node changed while access was being prepared: ${id}`);
      }
    }
    for (const [id, connection] of expected.connections) {
      if (this.connections.get(id) !== connection) {
        throw new Error(`File connection changed while access was being prepared: ${id}`);
      }
    }
  }

  private readableReferencedFilesFor(
    agentId: string,
    state: FileAccessStateSnapshot,
  ): CanvasFileNode[] {
    const readableIds = new Set<string>();
    const files = new Map(state.files);
    for (const [, file] of state.files) {
      if (
        file.storage === "referenced" &&
        file.availability === "available" &&
        file.kind === "shared" &&
        file.sharedRead
      ) {
        readableIds.add(file.id);
      }
    }
    for (const [, connection] of state.connections) {
      if (connection.agentId !== agentId || connection.access !== "read") continue;
      const file = files.get(connection.fileId);
      if (file?.storage === "referenced" && file.availability === "available") {
        readableIds.add(file.id);
      }
    }
    return state.files
      .map(([, file]) => file)
      .filter((file) => readableIds.has(file.id));
  }

  private agentFileReference(file: CanvasFileNode): AgentFileReference {
    return {
      name: file.filename,
      path: file.path,
      previewKind: file.previewKind,
    };
  }

  private assertAccessSnapshotsOpen(): void {
    if (this.accessSnapshotsDisposed) {
      throw new Error("File access snapshots have been disposed");
    }
  }

  private enqueueAccessLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.accessLifecycleTail.then(operation);
    this.accessLifecycleTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async resetAccessSnapshotsForImport(): Promise<void> {
    await this.enqueueAccessLifecycle(async () => {
      await this.removeAllAccessSnapshotDirectories();
      this.lastAccessDispatchSequenceByAgent.clear();
    });
  }

  private assertAccessCheckpoint(checkpoint: FileAccessCheckpoint): void {
    if (
      !checkpoint ||
      typeof checkpoint !== "object" ||
      !this.accessCheckpoints.has(checkpoint) ||
      !Object.isFrozen(checkpoint)
    ) {
      throw new Error("Invalid file access checkpoint");
    }
  }

  private nextAccessDispatchSequence(): number {
    if (this.accessDispatchSequence >= Number.MAX_SAFE_INTEGER) {
      throw new Error("File access snapshot sequence is exhausted");
    }
    this.accessDispatchSequence += 1;
    return this.accessDispatchSequence;
  }

  private assertRetainedAccessCapacity(agentId: string, addedBytes: number): void {
    const agentScopes = this.accessSnapshotScopesByAgent.get(agentId);
    const agentScopeCount = agentScopes?.size ?? 0;
    const agentBytes = agentScopes
      ? [...agentScopes.values()].reduce((total, scope) => total + scope.bytes, 0)
      : 0;
    if (agentScopeCount >= this.maxRetainedAccessScopesPerAgent) {
      throw new Error(
        `Agent file access snapshots exceed the ${this.maxRetainedAccessScopesPerAgent} retained scope limit`,
      );
    }
    if (addedBytes > this.maxRetainedAccessBytesPerAgent - agentBytes) {
      throw new Error(
        `Agent file access snapshots exceed the ${this.maxRetainedAccessBytesPerAgent} retained byte limit`,
      );
    }
    if (this.accessSnapshotScopes.size >= this.maxRetainedAccessScopes) {
      throw new Error(
        `File access snapshots exceed the ${this.maxRetainedAccessScopes} retained scope limit`,
      );
    }
    if (addedBytes > this.maxRetainedAccessBytes - this.retainedAccessBytes) {
      throw new Error(
        `File access snapshots exceed the ${this.maxRetainedAccessBytes} retained byte limit`,
      );
    }
  }

  private retainAccessSnapshotScope(scope: RetainedAccessSnapshotScope): void {
    this.accessSnapshotScopes.set(scope.sequence, scope);
    let agentScopes = this.accessSnapshotScopesByAgent.get(scope.agentId);
    if (!agentScopes) {
      agentScopes = new Map();
      this.accessSnapshotScopesByAgent.set(scope.agentId, agentScopes);
    }
    agentScopes.set(scope.sequence, scope);
    this.lastAccessDispatchSequenceByAgent.set(scope.agentId, scope.sequence);
    this.retainedAccessBytes += scope.bytes;
  }

  private async retireAccessScopes(
    checkpoint: FileAccessCheckpoint,
    inclusive: boolean,
  ): Promise<void> {
    const agentScopes = this.accessSnapshotScopesByAgent.get(checkpoint.agentId);
    if (!agentScopes) return;
    const scopes = [...agentScopes.values()]
      .filter((scope) => inclusive
        ? scope.sequence <= checkpoint.sequence
        : scope.sequence < checkpoint.sequence)
      .sort((left, right) => left.sequence - right.sequence);
    for (const scope of scopes) {
      await this.removeRetainedAccessSnapshotScope(scope);
    }
  }

  private async removeRetainedAccessSnapshotScope(
    scope: RetainedAccessSnapshotScope,
  ): Promise<void> {
    await this.removeUnpublishedAccessSnapshotScope({
      path: scope.scopePath,
      identity: scope.scopeIdentity,
    });
    if (this.accessSnapshotScopes.get(scope.sequence) !== scope) return;
    this.accessSnapshotScopes.delete(scope.sequence);
    const agentScopes = this.accessSnapshotScopesByAgent.get(scope.agentId);
    if (agentScopes?.get(scope.sequence) === scope) {
      agentScopes.delete(scope.sequence);
      if (agentScopes.size === 0) {
        this.accessSnapshotScopesByAgent.delete(scope.agentId);
      }
    }
    this.retainedAccessBytes -= scope.bytes;
    const prepared = this.preparedAccessByAgent.get(scope.agentId);
    if (prepared?.sequence === scope.sequence) {
      this.preparedAccessByAgent.delete(scope.agentId);
    }
  }

  private async removeUnpublishedAccessSnapshotScope(
    scope: AccessSnapshotDirectoryOwnership,
  ): Promise<void> {
    if (path.dirname(scope.path) !== this.accessSnapshotRoot) {
      throw new Error(`Refusing to remove an unknown access snapshot scope: ${scope.path}`);
    }
    await this.assertAccessSnapshotRootIdentity();
    await removeOwnedAccessSnapshotDirectory(
      scope,
      {
        path: path.dirname(scope.path),
        identity: this.accessSnapshotRootIdentity!,
      },
      "agent file access snapshot scope",
      this.accessSnapshotPathRemover,
    );
  }

  private async cleanupOrphanedAccessSnapshotScopes(): Promise<void> {
    for (const scope of this.orphanedAccessSnapshotScopes) {
      await this.removeUnpublishedAccessSnapshotScope(scope);
      this.orphanedAccessSnapshotScopes.delete(scope);
    }
  }

  private ensureAccessSnapshotRoot(): Promise<void> {
    this.accessSnapshotRootReady ??= (async () => {
      await assertAccessSnapshotDirectoryIdentity(
        path.dirname(this.accessSnapshotRoot),
        this.accessSnapshotParentIdentity,
        "agent file access snapshot parent",
      );
      await mkdir(this.accessSnapshotRoot, {
        recursive: false,
        mode: 0o700,
      });
      this.accessSnapshotRootIdentity = await captureAccessSnapshotDirectoryIdentity(
        this.accessSnapshotRoot,
        "agent file access snapshot root",
      );
      await assertAccessSnapshotDirectoryIdentity(
        path.dirname(this.accessSnapshotRoot),
        this.accessSnapshotParentIdentity,
        "agent file access snapshot parent",
      );
    })();
    return this.accessSnapshotRootReady.then(() => this.assertAccessSnapshotRootIdentity());
  }

  private async assertAccessSnapshotRootIdentity(): Promise<void> {
    const identity = this.accessSnapshotRootIdentity;
    if (!identity) {
      throw new ManagedFileSafetyError("Agent file access snapshot root is unavailable");
    }
    await assertAccessSnapshotDirectoryIdentity(
      path.dirname(this.accessSnapshotRoot),
      this.accessSnapshotParentIdentity,
      "agent file access snapshot parent",
    );
    await assertAccessSnapshotDirectoryIdentity(
      this.accessSnapshotRoot,
      identity,
      "agent file access snapshot root",
    );
  }

  private async removeAllAccessSnapshotDirectories(): Promise<void> {
    if (!this.accessSnapshotRootIdentity) {
      const unexpected = await lstatBigIntIfExists(this.accessSnapshotRoot);
      if (unexpected) {
        throw new ManagedFileSafetyError(
          `Refusing to remove an unowned agent file access snapshot root: ${this.accessSnapshotRoot}`,
        );
      }
      this.preparedAccessByAgent.clear();
      return;
    }

    await this.assertAccessSnapshotRootIdentity();
    for (const scope of [...this.accessSnapshotScopes.values()]
      .sort((left, right) => left.sequence - right.sequence)) {
      await this.removeRetainedAccessSnapshotScope(scope);
    }
    for (const scope of [...this.orphanedAccessSnapshotScopes]) {
      await this.removeUnpublishedAccessSnapshotScope(scope);
      this.orphanedAccessSnapshotScopes.delete(scope);
    }
    await this.assertAccessSnapshotRootIdentity();
    const unexpectedEntries = await readdir(this.accessSnapshotRoot);
    if (unexpectedEntries.length > 0) {
      throw new ManagedFileSafetyError(
        `Agent file access snapshot root contains unowned entries: ${unexpectedEntries.join(", ")}`,
      );
    }
    await removeOwnedAccessSnapshotDirectory(
      {
        path: this.accessSnapshotRoot,
        identity: this.accessSnapshotRootIdentity,
      },
      {
        path: path.dirname(this.accessSnapshotRoot),
        identity: this.accessSnapshotParentIdentity,
      },
      "agent file access snapshot root",
      this.accessSnapshotPathRemover,
    );
    this.preparedAccessByAgent.clear();
    this.accessSnapshotRootIdentity = undefined;
    this.accessSnapshotRootReady = undefined;
    this.accessSnapshotScopes.clear();
    this.accessSnapshotScopesByAgent.clear();
    this.orphanedAccessSnapshotScopes.clear();
    this.retainedAccessBytes = 0;
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

  private async validateCurrentFile(file: CanvasFileNode): Promise<ManagedFileIdentity> {
    if (file.storage === "referenced" && file.availability === "missing") {
      throw new Error(`Referenced file is missing: ${file.path}`);
    }
    if (file.storage === "referenced") {
      const expectedIdentity = this.referencedFileAuthorizationIdentities.get(file.id);
      const inspected = await inspectReferencedFile(file.path, {
        allowMissing: false,
        label: `referenced file node ${file.id}`,
        observer: this.referencedFileInspectionObserver,
      });
      if (
        expectedIdentity === undefined ||
        !sameCanonicalExternalPath(file.path, inspected.path) ||
        !authorizationIdentityMatches(expectedIdentity, inspected.authorizationIdentity)
      ) {
        throw new ManagedFileSafetyError(
          `Referenced file node ${file.id} changed after authorization`,
        );
      }
      return inspected.identity!;
    }
    return await validateManagedFile(file.path, this.validationOptions(file));
  }

  private async readCurrentFile(
    file: CanvasFileNode,
  ): Promise<{ buffer: Buffer; identity: ManagedFileIdentity }> {
    if (file.storage === "referenced" && file.availability === "missing") {
      throw new Error(`Referenced file is missing: ${file.path}`);
    }
    if (file.storage === "referenced") {
      const readLimit = Math.min(this.maxPickedFileBytes + 1, Number.MAX_SAFE_INTEGER);
      const result = await this.readCurrentFilePrefix(file, readLimit);
      if (result.buffer.length > this.maxPickedFileBytes) {
        throw new Error(
          `Referenced file exceeds the ${this.maxPickedFileBytes} byte read limit: ${file.path}`,
        );
      }
      return result;
    }
    const snapshot = await readManagedFileBufferSnapshot(
      file.path,
      this.validationOptions(file),
    );
    return { buffer: snapshot.content, identity: snapshot.identity };
  }

  private async readCurrentFilePrefix(
    file: CanvasFileNode,
    readLimit: number,
  ): Promise<{ buffer: Buffer; identity: ManagedFileIdentity }> {
    if (file.storage === "referenced" && file.availability === "missing") {
      throw new Error(`Referenced file is missing: ${file.path}`);
    }
    const options = this.validationOptions(file);
    const before = await validateManagedFile(file.path, options);
    const handle = await open(file.path, constants.O_RDONLY | pickedNoFollowFlag());
    try {
      const opened = await handle.stat();
      assertOpenFileIdentity(opened, before, options.label);
      const openedAuthorizationIdentity = file.storage === "referenced"
        ? trustedReferencedFileIdentity(await handle.stat({ bigint: true }))
        : undefined;
      const expectedAuthorizationIdentity = file.storage === "referenced"
        ? this.referencedFileAuthorizationIdentities.get(file.id)
        : undefined;
      if (
        file.storage === "referenced" &&
        (
          expectedAuthorizationIdentity === undefined ||
          !authorizationIdentityMatches(
            expectedAuthorizationIdentity,
            openedAuthorizationIdentity,
          )
        )
      ) {
        throw new ManagedFileSafetyError(
          `Referenced file node ${file.id} changed after authorization`,
        );
      }
      const chunks: Buffer[] = [];
      let total = 0;
      while (total < readLimit) {
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, readLimit - total));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (bytesRead === 0) break;
        total += bytesRead;
        chunks.push(chunk.subarray(0, bytesRead));
        await this.readChunkObserver?.({
          purpose: "preview",
          filePath: file.path,
          bytesRead: total,
        });
      }
      assertUnchangedOpenFile(await handle.stat(), opened, options.label);
      if (file.storage === "referenced") {
        const handleAfter = await handle.stat({ bigint: true });
        const pathAfter = await lstat(file.path, { bigint: true });
        assertReferencedBigIntFile(handleAfter, file.path, options.label);
        assertReferencedBigIntFile(pathAfter, file.path, options.label);
        if (
          !authorizationIdentityMatches(
            expectedAuthorizationIdentity!,
            trustedReferencedFileIdentity(handleAfter),
          ) ||
          !sameBigIntFileIdentity(handleAfter, pathAfter) ||
          !sameCanonicalExternalPath(file.path, await realpath(file.path))
        ) {
          throw new ManagedFileSafetyError(
            `Referenced file node ${file.id} changed while reading`,
          );
        }
      }
      const after = await validateManagedFile(file.path, options);
      if (!sameIdentity(before, after)) {
        throw new ManagedFileSafetyError(`${options.label} changed while reading preview`);
      }
      assertUnchangedOpenFile(await lstat(file.path), opened, options.label);
      return { buffer: Buffer.concat(chunks, total), identity: after };
    } finally {
      await handle.close();
    }
  }

  private commitReadIdentity(
    expectedGeneration: number,
    expectedFile: CanvasFileNode,
    identity: ManagedFileIdentity,
  ): void {
    this.assertCurrentFileState(expectedGeneration, expectedFile);
    this.fileIdentities.set(expectedFile.id, identity);
  }

  private rejectCurrentFileOperation(
    expectedGeneration: number,
    expectedFile: CanvasFileNode,
    error: unknown,
  ): never {
    this.assertCurrentFileState(expectedGeneration, expectedFile);
    if (expectedFile.storage === "referenced" && isReferencedUnavailableError(error)) {
      this.markReferencedMissing(expectedFile, expectedGeneration);
      throw referencedUnavailableError(expectedFile, error);
    }
    throw error;
  }

  private validateCurrentFileSync(file: CanvasFileNode): boolean {
    if (file.storage === "referenced" && file.availability === "missing") return false;
    const generation = this.fileStateGeneration;
    try {
      if (file.storage === "referenced") {
        const expectedIdentity = this.referencedFileAuthorizationIdentities.get(file.id);
        const inspected = inspectReferencedFileSync(
          file.path,
          `referenced file node ${file.id}`,
        );
        if (
          expectedIdentity === undefined ||
          !sameCanonicalExternalPath(file.path, inspected.path) ||
          !authorizationIdentityMatches(expectedIdentity, inspected.authorizationIdentity)
        ) {
          throw new ManagedFileSafetyError(
            `Referenced file node ${file.id} changed after authorization`,
          );
        }
        this.assertCurrentFileState(generation, file);
        this.fileIdentities.set(file.id, inspected.identity);
        return true;
      }
      const actual = validateManagedFileSync(file.path, this.validationOptions(file));
      this.assertCurrentFileState(generation, file);
      this.fileIdentities.set(file.id, actual);
      return true;
    } catch (error) {
      if (file.storage === "referenced" && isReferencedUnavailableError(error)) {
        this.markReferencedMissing(file, generation);
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

  private markReferencedMissing(
    expectedFile: CanvasFileNode,
    expectedGeneration: number,
  ): CanvasFileNode {
    this.assertCurrentFileState(expectedGeneration, expectedFile);
    if (
      expectedFile.availability === "missing" &&
      !this.fileIdentities.has(expectedFile.id)
    ) {
      return expectedFile;
    }
    this.fileIdentities.delete(expectedFile.id);
    const missing: CanvasFileNode = {
      ...expectedFile,
      availability: "missing",
      updatedAt: this.now(),
    };
    this.files.set(expectedFile.id, missing);
    this.invalidatePreparedAccess();
    return missing;
  }
}

interface InspectedReferencedFile {
  path: string;
  availability: CanvasFileNode["availability"];
  identity?: ManagedFileIdentity;
  authorizationIdentity?: TrustedReferencedFileIdentity;
  size?: number;
  modifiedAt?: number;
  changedAt?: number;
}

async function inspectReferencedFile(
  sourcePath: string,
  options: {
    allowMissing: boolean;
    label: string;
    observer?: FileManagerOptions["referencedFileInspectionObserver"];
  },
): Promise<InspectedReferencedFile> {
  if (typeof sourcePath !== "string" || sourcePath.length === 0) {
    throw new Error(`${options.label} path is required`);
  }
  const requestedPath = path.resolve(sourcePath);
  let requestedBefore: BigIntStats;
  try {
    requestedBefore = await lstat(requestedPath, { bigint: true });
  } catch (error) {
    if (options.allowMissing && isMissingFilesystemError(error)) {
      return {
        path: await canonicalizeMissingReferencedPath(requestedPath, options.label),
        availability: "missing",
      };
    }
    throw error;
  }
  assertReferencedBigIntFile(requestedBefore, requestedPath, options.label);
  const canonicalPath = await realpath(requestedPath);
  const canonicalBefore = await lstat(canonicalPath, { bigint: true });
  assertReferencedBigIntFile(canonicalBefore, canonicalPath, options.label);
  if (!sameBigIntFileIdentity(requestedBefore, canonicalBefore)) {
    throw new ManagedFileSafetyError(
      `${options.label} must resolve to a regular file: ${requestedPath}`,
    );
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(canonicalPath, constants.O_RDONLY | pickedNoFollowFlag());
    const openedIdentity = await handle.stat({ bigint: true });
    assertReferencedBigIntFile(openedIdentity, canonicalPath, options.label);
    if (!sameBigIntFileIdentity(canonicalBefore, openedIdentity)) {
      throw new ManagedFileSafetyError(
        `${options.label} changed before it was opened: ${requestedPath}`,
      );
    }
    const opened = await handle.stat();
    assertReferencedFile(opened, canonicalPath, options.label);
    const authorizationIdentity = trustedReferencedFileIdentity(openedIdentity);
    await options.observer?.({
      phase: "opened",
      requestedPath,
      canonicalPath,
      identity: authorizationIdentity,
    });
    const requestedAfter = await lstat(requestedPath, { bigint: true });
    const canonicalAfter = await lstat(canonicalPath, { bigint: true });
    const resolvedAfter = await realpath(requestedPath);
    assertReferencedBigIntFile(requestedAfter, requestedPath, options.label);
    assertReferencedBigIntFile(canonicalAfter, canonicalPath, options.label);
    if (
      !sameCanonicalExternalPath(canonicalPath, resolvedAfter) ||
      !sameBigIntFileIdentity(openedIdentity, requestedAfter) ||
      !sameBigIntFileIdentity(openedIdentity, canonicalAfter)
    ) {
      throw new ManagedFileSafetyError(
        `${options.label} changed while it was being inspected: ${requestedPath}`,
      );
    }
    return {
      path: canonicalPath,
      availability: "available",
      identity: { dev: opened.dev, ino: opened.ino },
      authorizationIdentity,
      size: opened.size,
      modifiedAt: opened.mtimeMs,
      changedAt: opened.ctimeMs,
    };
  } catch (error) {
    if (isMissingFilesystemError(error)) {
      throw new ManagedFileSafetyError(
        `${options.label} disappeared while it was being inspected: ${requestedPath}`,
      );
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

function inspectReferencedFileSync(
  sourcePath: string,
  label: string,
): {
  path: string;
  identity: ManagedFileIdentity;
  authorizationIdentity: TrustedReferencedFileIdentity;
} {
  if (typeof sourcePath !== "string" || sourcePath.length === 0) {
    throw new Error(`${label} path is required`);
  }
  const requestedPath = path.resolve(sourcePath);
  const requestedBefore = lstatSync(requestedPath, { bigint: true });
  assertReferencedBigIntFile(requestedBefore, requestedPath, label);
  const canonicalPath = realpathSync(requestedPath);
  const canonicalBefore = lstatSync(canonicalPath, { bigint: true });
  assertReferencedBigIntFile(canonicalBefore, canonicalPath, label);
  if (!sameBigIntFileIdentity(requestedBefore, canonicalBefore)) {
    throw new ManagedFileSafetyError(
      `${label} must resolve to a regular file: ${requestedPath}`,
    );
  }
  const descriptor = openSync(canonicalPath, constants.O_RDONLY | pickedNoFollowFlag());
  try {
    const openedIdentity = fstatSync(descriptor, { bigint: true });
    const opened = fstatSync(descriptor);
    assertReferencedBigIntFile(openedIdentity, canonicalPath, label);
    assertReferencedFile(opened, canonicalPath, label);
    if (!sameBigIntFileIdentity(canonicalBefore, openedIdentity)) {
      throw new ManagedFileSafetyError(`${label} changed before it was opened: ${requestedPath}`);
    }
    const requestedAfter = lstatSync(requestedPath, { bigint: true });
    const canonicalAfter = lstatSync(canonicalPath, { bigint: true });
    const resolvedAfter = realpathSync(requestedPath);
    assertReferencedBigIntFile(requestedAfter, requestedPath, label);
    assertReferencedBigIntFile(canonicalAfter, canonicalPath, label);
    if (
      !sameCanonicalExternalPath(canonicalPath, resolvedAfter) ||
      !sameBigIntFileIdentity(openedIdentity, requestedAfter) ||
      !sameBigIntFileIdentity(openedIdentity, canonicalAfter)
    ) {
      throw new ManagedFileSafetyError(`${label} changed while it was inspected: ${requestedPath}`);
    }
    return {
      path: canonicalPath,
      identity: { dev: opened.dev, ino: opened.ino },
      authorizationIdentity: trustedReferencedFileIdentity(openedIdentity),
    };
  } finally {
    closeSync(descriptor);
  }
}

function assertReferencedBigIntFile(
  stat: BigIntStats,
  filePath: string,
  label: string,
): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) {
    throw new ManagedFileSafetyError(
      `${label} must be a single-link regular non-symbolic-link file: ${filePath}`,
    );
  }
}

function assertReferencedFile(stat: Stats, filePath: string, label: string): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new ManagedFileSafetyError(
      `${label} must be a single-link regular non-symbolic-link file: ${filePath}`,
    );
  }
}

function trustedReferencedFileIdentity(stat: BigIntStats): TrustedReferencedFileIdentity {
  return { dev: stat.dev.toString(), ino: stat.ino.toString() };
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
        throw new ManagedFileSafetyError(
          `${label} missing path has a non-directory ancestor: ${ancestor}`,
        );
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

async function trustedReferencedFileAuthorizations(
  options: ImportFileStateOptions,
): Promise<Map<string, TrustedReferencedFileAuthorization>> {
  const trusted = new Map<string, TrustedReferencedFileAuthorization>();
  for (const authorization of options.trustedReferencedFiles ?? []) {
    addTrustedReferencedFileAuthorization(trusted, authorization);
  }
  return trusted;
}

function addTrustedReferencedFileAuthorization(
  trusted: Map<string, TrustedReferencedFileAuthorization>,
  authorization: TrustedReferencedFileAuthorization,
): void {
  const normalized = requiredTrustedReferencedFileAuthorization(
    authorization,
    "referenced file authorization",
  );
  trusted.set(normalized.path, normalized);
}

function authorizationIdentityMatches(
  authorization: TrustedReferencedFileIdentity,
  identity: TrustedReferencedFileIdentity | undefined,
): boolean {
  return identity !== undefined &&
    authorization.dev === identity.dev &&
    authorization.ino === identity.ino;
}

function requiredTrustedReferencedFileAuthorization(
  authorization: TrustedReferencedFileAuthorization,
  label: string,
): TrustedReferencedFileAuthorization {
  if (
    !authorization ||
    typeof authorization.path !== "string" ||
    !path.isAbsolute(authorization.path)
  ) {
    throw new Error(`${label} authorization path must be absolute`);
  }
  return {
    path: path.resolve(authorization.path),
    identity: requiredTrustedReferencedFileIdentity(authorization.identity, label),
  };
}

function requiredTrustedReferencedFileIdentity(
  identity: TrustedReferencedFileIdentity,
  label: string,
): TrustedReferencedFileIdentity {
  if (
    !identity ||
    typeof identity.dev !== "string" ||
    typeof identity.ino !== "string" ||
    !/^\d+$/u.test(identity.dev) ||
    !/^\d+$/u.test(identity.ino)
  ) {
    throw new Error(`${label} identity must contain decimal dev and ino strings`);
  }
  return { dev: identity.dev, ino: identity.ino };
}

function sameCanonicalExternalPath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

async function readPickedFileWithinLimit(
  filePath: string,
  expected: StagedPickedFile,
  maxBytes: number,
  observer?: FileManagerOptions["readChunkObserver"],
): Promise<Buffer> {
  const label = `picked file ${expected.file.filename}`;
  const before = await lstat(filePath);
  assertPickedFileStat(before, expected, label);
  assertPickedFileAuthorizationIdentity(
    await lstat(filePath, { bigint: true }),
    expected,
    label,
  );
  if (before.size > maxBytes) {
    throw new Error(`${label} exceeds the ${maxBytes} byte copy limit`);
  }
  if (!expected.contentDigest) {
    throw new Error(`${label} was not staged for copying`);
  }
  const handle = await open(filePath, constants.O_RDONLY | pickedNoFollowFlag());
  try {
    const opened = await handle.stat();
    assertPickedFileStat(opened, expected, label);
    assertPickedFileAuthorizationIdentity(
      await handle.stat({ bigint: true }),
      expected,
      label,
    );
    const chunks: Buffer[] = [];
    const digest = createHash("sha256");
    let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes - total + 1));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) {
        throw new Error(`${label} exceeds the ${maxBytes} byte copy limit`);
      }
      const bytes = chunk.subarray(0, bytesRead);
      chunks.push(bytes);
      digest.update(bytes);
      await observer?.({ purpose: "copy", filePath, bytesRead: total });
    }
    const afterHandle = await handle.stat();
    assertPickedFileStat(afterHandle, expected, label);
    assertPickedFileAuthorizationIdentity(
      await handle.stat({ bigint: true }),
      expected,
      label,
    );
    const afterPath = await lstat(filePath);
    assertPickedFileStat(afterPath, expected, label);
    assertPickedFileAuthorizationIdentity(
      await lstat(filePath, { bigint: true }),
      expected,
      label,
    );
    if (digest.digest("hex") !== expected.contentDigest) {
      throw new Error(`${label} content changed after it was selected`);
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

async function digestPickedFile(
  filePath: string,
  expected: StagedPickedFile,
  observer?: FileManagerOptions["readChunkObserver"],
): Promise<string> {
  const label = `picked file ${expected.file.filename}`;
  const before = await lstat(filePath);
  assertPickedFileStat(before, expected, label);
  assertPickedFileAuthorizationIdentity(
    await lstat(filePath, { bigint: true }),
    expected,
    label,
  );
  const handle = await open(filePath, constants.O_RDONLY | pickedNoFollowFlag());
  try {
    const opened = await handle.stat();
    assertPickedFileStat(opened, expected, label);
    assertPickedFileAuthorizationIdentity(
      await handle.stat({ bigint: true }),
      expected,
      label,
    );
    const digest = createHash("sha256");
    let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(64 * 1024);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > expected.size) {
        throw new Error(`${label} changed while its content was being staged`);
      }
      digest.update(chunk.subarray(0, bytesRead));
      await observer?.({ purpose: "stage", filePath, bytesRead: total });
    }
    if (total !== expected.size) {
      throw new Error(`${label} changed while its content was being staged`);
    }
    assertPickedFileStat(await handle.stat(), expected, label);
    assertPickedFileAuthorizationIdentity(
      await handle.stat({ bigint: true }),
      expected,
      label,
    );
    assertPickedFileStat(await lstat(filePath), expected, label);
    assertPickedFileAuthorizationIdentity(
      await lstat(filePath, { bigint: true }),
      expected,
      label,
    );
    return digest.digest("hex");
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
    stat.mtimeMs !== expected.modifiedAt ||
    stat.ctimeMs !== expected.changedAt
  ) {
    throw new Error(`${label} changed after it was selected`);
  }
}

function assertPickedFileAuthorizationIdentity(
  stat: BigIntStats,
  expected: StagedPickedFile,
  label: string,
): void {
  assertReferencedBigIntFile(stat, expected.path, label);
  if (
    !authorizationIdentityMatches(
      expected.authorizationIdentity,
      trustedReferencedFileIdentity(stat),
    )
  ) {
    throw new Error(`${label} changed after it was selected`);
  }
}

function assertUnchangedOpenFile(stat: Stats, expected: Stats, label: string): void {
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    !sameIdentity(expected, stat)
  ) {
    throw new ManagedFileSafetyError(`${label} changed while opening or reading`);
  }
  if (
    stat.size !== expected.size ||
    stat.mtimeMs !== expected.mtimeMs ||
    stat.ctimeMs !== expected.ctimeMs
  ) {
    throw new FileSnapshotChangedError(`${label} changed while opening or reading`);
  }
}

class FileSnapshotChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileSnapshotChangedError";
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
    authorizationIdentityMatches(
      expected.authorizationIdentity,
      actual.authorizationIdentity,
    ) &&
    actual.size === expected.size &&
    actual.modifiedAt === expected.modifiedAt &&
    actual.changedAt === expected.changedAt &&
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
  return resolvedFileSystemPathKey(value);
}

/** Exact path key used for storage-root identity; Windows directories may be case-sensitive. */
export function resolvedFileSystemPathKey(
  value: string,
  pathApi: Pick<typeof path, "resolve"> = path,
): string {
  return pathApi.resolve(value);
}

function sameResolvedPath(left: string, right: string): boolean {
  return normalizedFilePathKey(left) === normalizedFilePathKey(right);
}

function sameOptionalResolvedPath(
  left: string | undefined,
  right: string | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return sameResolvedPath(left, right);
}

function sameTrustedRootBoundary(
  left: ManagedTrustedRootBoundary | undefined,
  right: ManagedTrustedRootBoundary | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    sameResolvedPath(left.path, right.path) &&
    left.logicalMapping === right.logicalMapping &&
    sameIdentity(left.logicalIdentity, right.logicalIdentity) &&
    sameResolvedPath(left.realPath, right.realPath) &&
    sameIdentity(left.realIdentity, right.realIdentity)
  );
}

function sameIdentity(left: ManagedFileIdentity, right: ManagedFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameBigIntFileIdentity(
  left: { dev: bigint; ino: bigint },
  right: { dev: bigint; ino: bigint },
): boolean {
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
    code === "ELOOP" ||
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

async function removeAccessSnapshotPath(targetPath: string): Promise<void> {
  await rm(targetPath, { recursive: true, force: true });
}

function accessSnapshotDirectoryIdentitySync(
  directoryPath: string,
  label: string,
): AccessSnapshotDirectoryIdentity {
  const stat = lstatSync(directoryPath, { bigint: true });
  assertAccessSnapshotDirectory(stat, directoryPath, label);
  return { dev: stat.dev, ino: stat.ino };
}

async function captureAccessSnapshotDirectoryIdentity(
  directoryPath: string,
  label: string,
): Promise<AccessSnapshotDirectoryIdentity> {
  const before = await lstat(directoryPath, { bigint: true });
  assertAccessSnapshotDirectory(before, directoryPath, label);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directoryPath, constants.O_RDONLY | pickedNoFollowFlag());
    const opened = await handle.stat({ bigint: true });
    assertAccessSnapshotDirectory(opened, directoryPath, label);
    if (!sameBigIntFileIdentity(before, opened)) {
      throw new ManagedFileSafetyError(`${label} changed before its identity was captured`);
    }
    const after = await lstat(directoryPath, { bigint: true });
    assertAccessSnapshotDirectory(after, directoryPath, label);
    if (!sameBigIntFileIdentity(opened, after)) {
      throw new ManagedFileSafetyError(`${label} changed while its identity was captured`);
    }
    return { dev: opened.dev, ino: opened.ino };
  } finally {
    await handle?.close();
  }
}

async function assertAccessSnapshotDirectoryIdentity(
  directoryPath: string,
  expected: AccessSnapshotDirectoryIdentity,
  label: string,
): Promise<void> {
  const actual = await lstatBigIntIfExists(directoryPath);
  if (!ownedAccessSnapshotDirectoryMatches(actual, expected)) {
    throw new ManagedFileSafetyError(`${label} changed or became unsafe: ${directoryPath}`);
  }
}

async function removeOwnedAccessSnapshotDirectory(
  ownership: AccessSnapshotDirectoryOwnership,
  parent: AccessSnapshotDirectoryOwnership,
  label: string,
  remover: (targetPath: string) => Promise<void>,
): Promise<void> {
  if (path.dirname(ownership.path) !== parent.path) {
    throw new ManagedFileSafetyError(`${label} escaped its owned parent: ${ownership.path}`);
  }
  await assertAccessSnapshotDirectoryIdentity(parent.path, parent.identity, `${label} parent`);
  await assertAccessSnapshotDirectoryIdentity(ownership.path, ownership.identity, label);
  const tombstonePath = path.join(
    parent.path,
    `.${path.basename(ownership.path)}.agent-canvas-remove-${randomUUID()}`,
  );
  if (await lstatBigIntIfExists(tombstonePath)) {
    throw new ManagedFileSafetyError(`${label} tombstone already exists: ${tombstonePath}`);
  }

  let renameError: unknown;
  try {
    await rename(ownership.path, tombstonePath);
  } catch (error) {
    renameError = error;
  }

  const parentAfter = await lstatBigIntIfExists(parent.path);
  const sourceAfter = await lstatBigIntIfExists(ownership.path);
  const tombstoneAfter = await lstatBigIntIfExists(tombstonePath);
  if (
    !ownedAccessSnapshotDirectoryMatches(parentAfter, parent.identity) ||
    ownedAccessSnapshotDirectoryMatches(sourceAfter, ownership.identity) ||
    !ownedAccessSnapshotDirectoryMatches(tombstoneAfter, ownership.identity)
  ) {
    if (
      !sourceAfter &&
      tombstoneAfter &&
      isAccessSnapshotDirectory(tombstoneAfter) &&
      ownedAccessSnapshotDirectoryMatches(parentAfter, parent.identity)
    ) {
      try {
        await restoreAccessSnapshotDirectory(
          tombstonePath,
          ownership.path,
          { dev: tombstoneAfter.dev, ino: tombstoneAfter.ino },
          parent,
          `${label} replacement`,
        );
      } catch (rollbackError) {
        throw new AggregateError(
          [renameError ?? new ManagedFileSafetyError(`${label} changed during quarantine`), rollbackError],
          `${label} quarantine failed and rollback was incomplete`,
        );
      }
    }
    throw renameError ?? new ManagedFileSafetyError(`${label} changed during quarantine`);
  }

  try {
    await assertAccessSnapshotDirectoryIdentity(parent.path, parent.identity, `${label} parent`);
    await assertAccessSnapshotDirectoryIdentity(tombstonePath, ownership.identity, label);
    await remover(tombstonePath);
    const remaining = await lstatBigIntIfExists(tombstonePath);
    if (remaining) {
      throw new ManagedFileSafetyError(`${label} remover left the quarantined directory behind`);
    }
  } catch (error) {
    const [currentSource, currentTombstone, currentParent] = await Promise.all([
      lstatBigIntIfExists(ownership.path),
      lstatBigIntIfExists(tombstonePath),
      lstatBigIntIfExists(parent.path),
    ]);
    if (!currentSource && !currentTombstone) {
      // Some platforms or injected removers can report an error after committing deletion.
      return;
    }
    if (
      !currentSource &&
      ownedAccessSnapshotDirectoryMatches(currentTombstone, ownership.identity) &&
      ownedAccessSnapshotDirectoryMatches(currentParent, parent.identity)
    ) {
      try {
        await restoreAccessSnapshotDirectory(
          tombstonePath,
          ownership.path,
          ownership.identity,
          parent,
          label,
        );
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `${label} removal failed and rollback was incomplete`,
        );
      }
    }
    throw error;
  }
}

async function restoreAccessSnapshotDirectory(
  tombstonePath: string,
  sourcePath: string,
  expected: AccessSnapshotDirectoryIdentity,
  parent: AccessSnapshotDirectoryOwnership,
  label: string,
): Promise<void> {
  await assertAccessSnapshotDirectoryIdentity(parent.path, parent.identity, `${label} parent`);
  if (await lstatBigIntIfExists(sourcePath)) {
    throw new ManagedFileSafetyError(`${label} cannot be restored without clobbering: ${sourcePath}`);
  }
  await assertAccessSnapshotDirectoryIdentity(tombstonePath, expected, label);
  let renameError: unknown;
  try {
    await rename(tombstonePath, sourcePath);
  } catch (error) {
    renameError = error;
  }
  const [restored, remaining, parentAfter] = await Promise.all([
    lstatBigIntIfExists(sourcePath),
    lstatBigIntIfExists(tombstonePath),
    lstatBigIntIfExists(parent.path),
  ]);
  if (
    ownedAccessSnapshotDirectoryMatches(restored, expected) &&
    !remaining &&
    ownedAccessSnapshotDirectoryMatches(parentAfter, parent.identity)
  ) {
    return;
  }
  throw new ManagedFileSafetyError(
    `${label} could not be restored after quarantine: ${String(renameError)}`,
  );
}

async function lstatBigIntIfExists(filePath: string): Promise<BigIntStats | undefined> {
  try {
    return await lstat(filePath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function assertAccessSnapshotDirectory(
  stat: BigIntStats,
  directoryPath: string,
  label: string,
): void {
  if (!isAccessSnapshotDirectory(stat)) {
    throw new ManagedFileSafetyError(
      `${label} must be an ordinary non-symbolic-link directory: ${directoryPath}`,
    );
  }
}

function isAccessSnapshotDirectory(stat: BigIntStats): boolean {
  return stat.isDirectory() && !stat.isSymbolicLink();
}

function ownedAccessSnapshotDirectoryMatches(
  actual: BigIntStats | undefined,
  expected: AccessSnapshotDirectoryIdentity,
): boolean {
  return !!actual &&
    isAccessSnapshotDirectory(actual) &&
    actual.dev === expected.dev &&
    actual.ino === expected.ino;
}

function defaultIsolatedRoot(workspaceRoot: string): string {
  const localDataRoot =
    process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".local", "share");
  const workspaceKey = createHash("sha256")
    .update(resolvedFileSystemPathKey(workspaceRoot))
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
