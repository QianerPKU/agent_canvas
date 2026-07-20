import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  type Stats,
} from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";

export class ManagedFileSafetyError extends Error {
  readonly code = "UNSAFE_MANAGED_FILE";

  constructor(message: string) {
    super(message);
    this.name = "ManagedFileSafetyError";
  }
}

export interface ManagedFileIdentity {
  dev: number;
  ino: number;
}

export interface ManagedFileSnapshot {
  content: string;
  identity: ManagedFileIdentity;
  modifiedAt: number;
}

export interface ManagedFileBufferSnapshot {
  content: Buffer;
  identity: ManagedFileIdentity;
  modifiedAt: number;
}

export interface ManagedTrustedRootBoundary {
  path: string;
  logicalIdentity: ManagedFileIdentity;
  logicalMapping: boolean;
  realPath: string;
  realIdentity: ManagedFileIdentity;
}

export interface ManagedPathOptions {
  allowParentMapping?: boolean;
  trustedRoot?: string;
  trustedRootBoundary?: ManagedTrustedRootBoundary;
  label?: string;
}

export async function captureManagedTrustedRootBoundary(
  trustedRoot: string,
  label = "managed trusted root",
): Promise<ManagedTrustedRootBoundary> {
  const resolvedRoot = path.resolve(trustedRoot);
  const logical = await lstat(resolvedRoot);
  const logicalMapping = logical.isSymbolicLink();
  if (!logical.isDirectory() && !logicalMapping) {
    throw new ManagedFileSafetyError(`${label} is not a directory: ${resolvedRoot}`);
  }
  const resolved = await realpath(resolvedRoot);
  const real = await lstat(resolved);
  if (!real.isDirectory() || real.isSymbolicLink()) {
    throw new ManagedFileSafetyError(`${label} target is unsafe: ${resolvedRoot}`);
  }
  return {
    path: resolvedRoot,
    logicalIdentity: { dev: logical.dev, ino: logical.ino },
    logicalMapping,
    realPath: resolved,
    realIdentity: { dev: real.dev, ino: real.ino },
  };
}

export async function assertManagedTrustedRootBoundary(
  expected: ManagedTrustedRootBoundary,
  label = "managed trusted root",
): Promise<void> {
  await assertManagedTrustedRootBoundaryIdentity(expected, label);
}

export function assertManagedTrustedRootBoundarySync(
  expected: ManagedTrustedRootBoundary,
  label = "managed trusted root",
): void {
  assertManagedTrustedRootBoundaryIdentitySync(expected, label);
}

export async function readManagedFile(
  filePath: string,
  options: ManagedPathOptions & { allowMissing?: boolean } = {},
): Promise<string | undefined> {
  return (await readManagedFileSnapshot(filePath, options))?.content;
}

export async function readManagedFileSnapshot(
  filePath: string,
  options: ManagedPathOptions & { allowMissing?: boolean } = {},
): Promise<ManagedFileSnapshot | undefined> {
  const label = options.label ?? "managed file";
  const operationPath = await resolveManagedOperationPath(filePath, options, label);
  filePath = operationPath.filePath;
  const trustedRoot = operationPath.trustedRoot;
  const parent = path.dirname(filePath);
  let parentSnapshot: ManagedParentSnapshot;
  try {
    parentSnapshot = await snapshotManagedParent(
      parent,
      label,
      options.allowParentMapping === true,
      trustedRoot,
    );
  } catch (error) {
    if (options.allowMissing && isMissingFileError(error)) return undefined;
    throw error;
  }
  filePath = path.join(parentSnapshot.realPath, path.basename(filePath));
  let pathStat: Stats;
  try {
    pathStat = await lstat(filePath);
  } catch (error) {
    if (options.allowMissing && isMissingFileError(error)) return undefined;
    throw error;
  }
  assertSingleLinkRegularFile(pathStat, filePath, label);

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filePath, constants.O_RDONLY | noFollowFlag());
    const openedStat = await handle.stat();
    assertSingleLinkRegularFile(openedStat, filePath, label);
    assertSameIdentity(pathStat, openedStat, filePath, `${label} changed before reading`);
    const content = await handle.readFile({ encoding: "utf-8" });
    const after = await lstat(filePath);
    assertSingleLinkRegularFile(after, filePath, label);
    assertSameIdentity(openedStat, after, filePath, `${label} changed while reading`);
    await assertManagedParentIdentity(parent, parentSnapshot, label);
    await assertOperationTrustedRootBoundary(options, label);
    return {
      content,
      identity: { dev: openedStat.dev, ino: openedStat.ino },
      modifiedAt: after.mtimeMs,
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new ManagedFileSafetyError(`${label} disappeared while reading: ${filePath}`);
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function validateManagedFile(
  filePath: string,
  options: ManagedPathOptions = {},
): Promise<ManagedFileIdentity> {
  const label = options.label ?? "managed file";
  const operationPath = await resolveManagedOperationPath(filePath, options, label);
  filePath = operationPath.filePath;
  const trustedRoot = operationPath.trustedRoot;
  const parent = path.dirname(filePath);
  const parentSnapshot = await snapshotManagedParent(
    parent,
    label,
    options.allowParentMapping === true,
    trustedRoot,
  );
  filePath = path.join(parentSnapshot.realPath, path.basename(filePath));
  const pathStat = await lstat(filePath);
  assertSingleLinkRegularFile(pathStat, filePath, label);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filePath, constants.O_RDONLY | noFollowFlag());
    const openedStat = await handle.stat();
    assertSingleLinkRegularFile(openedStat, filePath, label);
    assertSameIdentity(pathStat, openedStat, filePath, `${label} changed before validation`);
    const after = await lstat(filePath);
    assertSingleLinkRegularFile(after, filePath, label);
    assertSameIdentity(openedStat, after, filePath, `${label} changed during validation`);
    await assertManagedParentIdentity(parent, parentSnapshot, label);
    await assertOperationTrustedRootBoundary(options, label);
    return { dev: openedStat.dev, ino: openedStat.ino };
  } finally {
    await handle?.close();
  }
}

export async function readManagedFileBufferSnapshot(
  filePath: string,
  options: ManagedPathOptions = {},
): Promise<ManagedFileBufferSnapshot> {
  const label = options.label ?? "managed file";
  const operationPath = await resolveManagedOperationPath(filePath, options, label);
  filePath = operationPath.filePath;
  const trustedRoot = operationPath.trustedRoot;
  const parent = path.dirname(filePath);
  const parentSnapshot = await snapshotManagedParent(
    parent,
    label,
    options.allowParentMapping === true,
    trustedRoot,
  );
  filePath = path.join(parentSnapshot.realPath, path.basename(filePath));
  const pathStat = await lstat(filePath);
  assertSingleLinkRegularFile(pathStat, filePath, label);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filePath, constants.O_RDONLY | noFollowFlag());
    const openedStat = await handle.stat();
    assertSingleLinkRegularFile(openedStat, filePath, label);
    assertSameIdentity(pathStat, openedStat, filePath, `${label} changed before reading`);
    const content = await handle.readFile();
    const after = await lstat(filePath);
    assertSingleLinkRegularFile(after, filePath, label);
    assertSameIdentity(openedStat, after, filePath, `${label} changed while reading`);
    await assertManagedParentIdentity(parent, parentSnapshot, label);
    await assertOperationTrustedRootBoundary(options, label);
    return {
      content,
      identity: { dev: openedStat.dev, ino: openedStat.ino },
      modifiedAt: after.mtimeMs,
    };
  } finally {
    await handle?.close();
  }
}

export function readManagedFileSnapshotSync(
  filePath: string,
  options: ManagedPathOptions = {},
): ManagedFileSnapshot {
  const label = options.label ?? "managed file";
  const operationPath = resolveManagedOperationPathSync(filePath, options, label);
  filePath = operationPath.filePath;
  const trustedRoot = operationPath.trustedRoot;
  const parent = path.dirname(filePath);
  assertExistingManagedAncestorChainSync(
    parent,
    label,
    options.allowParentMapping === true,
    trustedRoot,
  );
  const pathStat = lstatSync(filePath);
  assertSingleLinkRegularFile(pathStat, filePath, label);
  const descriptor = openSync(filePath, constants.O_RDONLY | noFollowFlag());
  try {
    const openedStat = fstatSync(descriptor);
    assertSingleLinkRegularFile(openedStat, filePath, label);
    assertSameIdentity(pathStat, openedStat, filePath, `${label} changed before reading`);
    const content = readFileSync(descriptor, "utf-8");
    const after = lstatSync(filePath);
    assertSingleLinkRegularFile(after, filePath, label);
    assertSameIdentity(openedStat, after, filePath, `${label} changed while reading`);
    assertExistingManagedAncestorChainSync(
      parent,
      label,
      options.allowParentMapping === true,
      trustedRoot,
    );
    if (options.trustedRootBoundary) {
      assertManagedTrustedRootBoundaryIdentitySync(options.trustedRootBoundary, label);
    }
    return {
      content,
      identity: { dev: openedStat.dev, ino: openedStat.ino },
      modifiedAt: after.mtimeMs,
    };
  } finally {
    closeSync(descriptor);
  }
}

export function validateManagedFileSync(
  filePath: string,
  options: ManagedPathOptions = {},
): ManagedFileIdentity {
  const label = options.label ?? "managed file";
  const operationPath = resolveManagedOperationPathSync(filePath, options, label);
  filePath = operationPath.filePath;
  const trustedRoot = operationPath.trustedRoot;
  const parent = path.dirname(filePath);
  assertExistingManagedAncestorChainSync(
    parent,
    label,
    options.allowParentMapping === true,
    trustedRoot,
  );
  const pathStat = lstatSync(filePath);
  assertSingleLinkRegularFile(pathStat, filePath, label);
  const descriptor = openSync(filePath, constants.O_RDONLY | noFollowFlag());
  try {
    const openedStat = fstatSync(descriptor);
    assertSingleLinkRegularFile(openedStat, filePath, label);
    assertSameIdentity(pathStat, openedStat, filePath, `${label} changed before validation`);
    const after = lstatSync(filePath);
    assertSingleLinkRegularFile(after, filePath, label);
    assertSameIdentity(openedStat, after, filePath, `${label} changed during validation`);
    assertExistingManagedAncestorChainSync(
      parent,
      label,
      options.allowParentMapping === true,
      trustedRoot,
    );
    if (options.trustedRootBoundary) {
      assertManagedTrustedRootBoundaryIdentitySync(options.trustedRootBoundary, label);
    }
    return { dev: openedStat.dev, ino: openedStat.ino };
  } finally {
    closeSync(descriptor);
  }
}

export async function writeManagedFileAtomically(
  filePath: string,
  content: string,
  options: ManagedPathOptions & {
    expectedContent?: string | undefined;
    expectedIdentity?: ManagedFileIdentity;
  } = {},
): Promise<ManagedFileSnapshot> {
  const label = options.label ?? "managed file";
  const operationPath = await resolveManagedOperationPath(filePath, options, label);
  filePath = operationPath.filePath;
  const trustedRoot = operationPath.trustedRoot;
  const parent = path.dirname(filePath);
  await ensureManagedParent(
    parent,
    label,
    options.allowParentMapping === true,
    trustedRoot,
  );
  const parentIdentity = await snapshotManagedParent(
    parent,
    label,
    options.allowParentMapping === true,
    trustedRoot,
  );
  filePath = path.join(parentIdentity.realPath, path.basename(filePath));
  const original = await snapshotManagedTarget(filePath, label);
  const hasExpectedContent = Object.prototype.hasOwnProperty.call(
    options,
    "expectedContent",
  );
  if (hasExpectedContent) {
    if (options.expectedContent === undefined) {
      if (original) {
        throw new ManagedFileSafetyError(`${label} appeared before creation: ${filePath}`);
      }
    } else if (!original || original.content !== options.expectedContent) {
      throw new ManagedFileSafetyError(`${label} content changed before persistence: ${filePath}`);
    }
  }
  if (
    options.expectedIdentity &&
    (!original ||
      original.stat.dev !== options.expectedIdentity.dev ||
      original.stat.ino !== options.expectedIdentity.ino)
  ) {
    throw new ManagedFileSafetyError(`${label} identity changed before persistence: ${filePath}`);
  }
  await assertManagedParentIdentity(parent, parentIdentity, label);
  await assertOperationTrustedRootBoundary(options, label);
  const temporaryPath = path.join(
    parentIdentity.realPath,
    `.${path.basename(filePath)}.agent-canvas-${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let temporaryIdentity: Stats | undefined;
  let committed = false;
  try {
    await assertManagedParentIdentity(parent, parentIdentity, label);
    await assertOperationTrustedRootBoundary(options, label);
    handle = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollowFlag(),
      original?.stat.mode ? original.stat.mode & 0o777 : 0o600,
    );
    const created = await handle.stat();
    temporaryIdentity = created;
    assertSingleLinkRegularFile(created, temporaryPath, `${label} temporary file`);
    await handle.writeFile(content, { encoding: "utf-8" });
    await handle.sync();
    const written = await handle.stat();
    assertSingleLinkRegularFile(written, temporaryPath, `${label} temporary file`);
    assertSameIdentity(
      created,
      written,
      temporaryPath,
      `${label} temporary file changed while writing`,
    );
    await handle.close();
    handle = undefined;

    const temporaryPathStat = await lstat(temporaryPath);
    assertSingleLinkRegularFile(
      temporaryPathStat,
      temporaryPath,
      `${label} temporary file`,
    );
    assertSameIdentity(
      created,
      temporaryPathStat,
      temporaryPath,
      `${label} temporary path changed before replacement`,
    );

    await assertManagedParentIdentity(parent, parentIdentity, label);
    await assertOperationTrustedRootBoundary(options, label);
    const current = await snapshotManagedTarget(filePath, label);
    if (original) {
      if (!current) {
        throw new ManagedFileSafetyError(`${label} disappeared before replacement: ${filePath}`);
      }
      assertSameIdentity(
        original.stat,
        current.stat,
        filePath,
        `${label} changed before replacement`,
      );
      if (current.content !== original.content) {
        throw new ManagedFileSafetyError(
          `${label} content changed before replacement: ${filePath}`,
        );
      }
    } else if (current) {
      throw new ManagedFileSafetyError(`${label} appeared before creation: ${filePath}`);
    }

    await assertManagedParentIdentity(parent, parentIdentity, label);
    await assertOperationTrustedRootBoundary(options, label);

    if (original) {
      let renameError: unknown;
      try {
        await rename(temporaryPath, filePath);
      } catch (error) {
        renameError = error;
      }
      if (renameError) {
        const published = await snapshotManagedTarget(filePath, label).catch(() => undefined);
        if (
          !published ||
          published.stat.dev !== temporaryPathStat.dev ||
          published.stat.ino !== temporaryPathStat.ino ||
          published.content !== content
        ) {
          throw renameError;
        }
      }
    } else {
      // Linking a fully-written sibling into place gives creation no-clobber semantics.
      // A plain rename would silently replace a target that appeared after the check above.
      let linkError: unknown;
      try {
        await link(temporaryPath, filePath);
      } catch (error) {
        linkError = error;
      }
      if (linkError) {
        const [published, temporary] = await Promise.all([
          lstatIfExists(filePath),
          lstatIfExists(temporaryPath),
        ]);
        if (
          !published?.isFile() ||
          published.isSymbolicLink() ||
          !temporary?.isFile() ||
          temporary.isSymbolicLink() ||
          published.dev !== temporaryPathStat.dev ||
          published.ino !== temporaryPathStat.ino ||
          temporary.dev !== temporaryPathStat.dev ||
          temporary.ino !== temporaryPathStat.ino
        ) {
          throw linkError;
        }
      }
      try {
        await rm(temporaryPath);
      } catch (error) {
        if (await publishedCreationIsCommitted(filePath, temporaryPath, temporaryPathStat)) {
          committed = true;
          return {
            content,
            identity: { dev: temporaryPathStat.dev, ino: temporaryPathStat.ino },
            modifiedAt: temporaryPathStat.mtimeMs,
          };
        }
        try {
          await removePublishedCreation(filePath, temporaryPath, temporaryPathStat, label);
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            `${label} creation failed and its published link could not be rolled back`,
          );
        }
        throw error;
      }
    }
    committed = true;
    // The rename/link+unlink call above is the commit point. Everything after it is
    // deliberately non-throwing so callers can always journal a successful commit
    // instead of observing an error after the old inode is gone.
    return {
      content,
      identity: { dev: temporaryPathStat.dev, ino: temporaryPathStat.ino },
      modifiedAt: temporaryPathStat.mtimeMs,
    };
  } finally {
    await handle?.close().catch(() => undefined);
    if (!committed && temporaryIdentity) {
      await removeOwnedTemporaryFile(temporaryPath, temporaryIdentity).catch(() => undefined);
    }
  }
}

export async function createManagedFileAtomically(
  filePath: string,
  content: string | Uint8Array,
  options: ManagedPathOptions = {},
): Promise<ManagedFileIdentity> {
  const label = options.label ?? "managed file";
  const operationPath = await resolveManagedOperationPath(filePath, options, label);
  filePath = operationPath.filePath;
  const trustedRoot = operationPath.trustedRoot;
  const parent = path.dirname(filePath);
  await ensureManagedParent(
    parent,
    label,
    options.allowParentMapping === true,
    trustedRoot,
  );
  const parentIdentity = await snapshotManagedParent(
    parent,
    label,
    options.allowParentMapping === true,
    trustedRoot,
  );
  filePath = path.join(parentIdentity.realPath, path.basename(filePath));
  if (await snapshotManagedTarget(filePath, label)) {
    throw new ManagedFileSafetyError(`${label} already exists: ${filePath}`);
  }
  const temporaryPath = path.join(
    parentIdentity.realPath,
    `.${path.basename(filePath)}.agent-canvas-${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let temporaryIdentity: Stats | undefined;
  let committed = false;
  try {
    await assertManagedParentIdentity(parent, parentIdentity, label);
    await assertOperationTrustedRootBoundary(options, label);
    handle = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollowFlag(),
      0o600,
    );
    const created = await handle.stat();
    temporaryIdentity = created;
    assertSingleLinkRegularFile(created, temporaryPath, `${label} temporary file`);
    await handle.writeFile(content);
    await handle.sync();
    const written = await handle.stat();
    assertSingleLinkRegularFile(written, temporaryPath, `${label} temporary file`);
    assertSameIdentity(
      created,
      written,
      temporaryPath,
      `${label} temporary file changed while writing`,
    );
    await handle.close();
    handle = undefined;

    const temporaryPathStat = await lstat(temporaryPath);
    assertSingleLinkRegularFile(
      temporaryPathStat,
      temporaryPath,
      `${label} temporary file`,
    );
    assertSameIdentity(
      created,
      temporaryPathStat,
      temporaryPath,
      `${label} temporary path changed before publication`,
    );
    await assertManagedParentIdentity(parent, parentIdentity, label);
    await assertOperationTrustedRootBoundary(options, label);
    if (await snapshotManagedTarget(filePath, label)) {
      throw new ManagedFileSafetyError(`${label} appeared before publication: ${filePath}`);
    }
    await assertManagedParentIdentity(parent, parentIdentity, label);
    await assertOperationTrustedRootBoundary(options, label);
    let linkError: unknown;
    try {
      await link(temporaryPath, filePath);
    } catch (error) {
      linkError = error;
    }
    if (linkError) {
      const [published, temporary] = await Promise.all([
        lstatIfExists(filePath),
        lstatIfExists(temporaryPath),
      ]);
      if (
        !published?.isFile() ||
        published.isSymbolicLink() ||
        !temporary?.isFile() ||
        temporary.isSymbolicLink() ||
        published.dev !== temporaryPathStat.dev ||
        published.ino !== temporaryPathStat.ino ||
        temporary.dev !== temporaryPathStat.dev ||
        temporary.ino !== temporaryPathStat.ino
      ) {
        throw linkError;
      }
    }
    try {
      await rm(temporaryPath);
    } catch (error) {
      if (await publishedCreationIsCommitted(filePath, temporaryPath, temporaryPathStat)) {
        committed = true;
        return { dev: temporaryPathStat.dev, ino: temporaryPathStat.ino };
      }
      try {
        await removePublishedCreation(filePath, temporaryPath, temporaryPathStat, label);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `${label} creation failed and its published link could not be rolled back`,
        );
      }
      throw error;
    }
    committed = true;
    return { dev: temporaryPathStat.dev, ino: temporaryPathStat.ino };
  } finally {
    await handle?.close().catch(() => undefined);
    if (!committed && temporaryIdentity) {
      await removeOwnedTemporaryFile(temporaryPath, temporaryIdentity).catch(() => undefined);
    }
  }
}

async function removeOwnedTemporaryFile(temporaryPath: string, expected: Stats): Promise<void> {
  const actual = await lstatIfExists(temporaryPath);
  if (!actual) return;
  assertSingleLinkRegularFile(actual, temporaryPath, "managed temporary file");
  assertSameIdentity(
    expected,
    actual,
    temporaryPath,
    "managed temporary file changed before cleanup",
  );
  await rm(temporaryPath);
}

async function ensureManagedParent(
  parent: string,
  label: string,
  allowMapping: boolean,
  trustedRoot?: string,
): Promise<void> {
  const resolvedParent = path.resolve(parent);
  const resolvedTrustedRoot = trustedRoot ? path.resolve(trustedRoot) : undefined;
  if (resolvedTrustedRoot && !isPathAtOrWithin(resolvedTrustedRoot, resolvedParent)) {
    throw new ManagedFileSafetyError(
      `${label} path escapes its trusted root: ${resolvedParent}`,
    );
  }
  const root = resolvedTrustedRoot ?? path.parse(resolvedParent).root;
  const trustedRootSnapshot = resolvedTrustedRoot
    ? await snapshotTrustedRoot(resolvedTrustedRoot, label)
    : undefined;
  let current = trustedRootSnapshot?.realPath ?? await realpath(root);
  let currentStat = await lstat(current);
  if (!currentStat.isDirectory() || currentStat.isSymbolicLink()) {
    throw new ManagedFileSafetyError(`${label} path root is unsafe: ${root}`);
  }
  const relative = path.relative(root, resolvedParent);
  const segments = relative ? relative.split(path.sep) : [];
  for (const [index, segment] of segments.entries()) {
    const next = path.join(current, segment);
    const isFinal = index === segments.length - 1;
    let nextStat = await lstatIfExists(next);
    if (!nextStat) {
      const parentBefore = await lstat(current);
      assertSameIdentity(
        currentStat,
        parentBefore,
        current,
        `${label} ancestor changed before directory creation`,
      );
      await mkdir(next);
      nextStat = await lstat(next);
      const parentAfter = await lstat(current);
      assertSameIdentity(
        parentBefore,
        parentAfter,
        current,
        `${label} ancestor changed during directory creation`,
      );
    }
    const mappingAllowedHere = allowMapping && isFinal && nextStat.isSymbolicLink();
    if (
      (!nextStat.isDirectory() && !mappingAllowedHere) ||
      (nextStat.isSymbolicLink() && !mappingAllowedHere)
    ) {
      throw new ManagedFileSafetyError(`${label} path contains an unsafe mapping: ${next}`);
    }
    const nextRealPath = await realpath(next);
    if (
      trustedRootSnapshot &&
      !isPathAtOrWithin(trustedRootSnapshot.realPath, nextRealPath)
    ) {
      throw new ManagedFileSafetyError(`${label} path escapes its trusted root: ${next}`);
    }
    current = nextRealPath;
    currentStat = await lstat(current);
    if (!currentStat.isDirectory() || currentStat.isSymbolicLink()) {
      throw new ManagedFileSafetyError(`${label} path target is unsafe: ${next}`);
    }
  }
  if (trustedRootSnapshot) await assertTrustedRootIdentity(trustedRootSnapshot, label);
}

async function removePublishedCreation(
  filePath: string,
  temporaryPath: string,
  expected: Stats,
  label: string,
): Promise<void> {
  const [published, temporary] = await Promise.all([
    lstat(filePath),
    lstat(temporaryPath),
  ]);
  for (const [candidatePath, candidate] of [
    [filePath, published],
    [temporaryPath, temporary],
  ] as const) {
    if (!candidate.isFile() || candidate.isSymbolicLink()) {
      throw new ManagedFileSafetyError(
        `${label} creation path became unsafe during rollback: ${candidatePath}`,
      );
    }
    assertSameIdentity(
      expected,
      candidate,
      candidatePath,
      `${label} creation path changed during rollback`,
    );
  }
  await rm(filePath);
}

async function publishedCreationIsCommitted(
  filePath: string,
  temporaryPath: string,
  expected: Stats,
): Promise<boolean> {
  const [published, temporary] = await Promise.all([
    lstatIfExists(filePath),
    lstatIfExists(temporaryPath),
  ]);
  return !!(
    !temporary &&
    published?.isFile() &&
    !published.isSymbolicLink() &&
    published.nlink === 1 &&
    published.dev === expected.dev &&
    published.ino === expected.ino
  );
}

export async function removeManagedFile(
  filePath: string,
  options: ManagedPathOptions & {
    expectedContent: string | Uint8Array;
    expectedIdentity?: ManagedFileIdentity;
  },
): Promise<void> {
  const label = options.label ?? "managed file";
  const operationPath = await resolveManagedOperationPath(filePath, options, label);
  filePath = operationPath.filePath;
  const trustedRoot = operationPath.trustedRoot;
  const parent = path.dirname(filePath);
  const parentIdentity = await snapshotManagedParent(
    parent,
    label,
    options.allowParentMapping === true,
    trustedRoot,
  );
  filePath = path.join(parentIdentity.realPath, path.basename(filePath));
  const expectedContent = contentBuffer(options.expectedContent);
  const original = await snapshotManagedBufferTarget(filePath, label);
  if (!original || !original.content.equals(expectedContent)) {
    throw new ManagedFileSafetyError(`${label} content changed before removal: ${filePath}`);
  }
  if (
    options.expectedIdentity &&
    (original.stat.dev !== options.expectedIdentity.dev ||
      original.stat.ino !== options.expectedIdentity.ino)
  ) {
    throw new ManagedFileSafetyError(`${label} identity changed before removal: ${filePath}`);
  }
  await assertManagedParentIdentity(parent, parentIdentity, label);
  await assertOperationTrustedRootBoundary(options, label);
  const current = await snapshotManagedBufferTarget(filePath, label);
  if (!current) {
    throw new ManagedFileSafetyError(`${label} disappeared before removal: ${filePath}`);
  }
  assertSameIdentity(
    original.stat,
    current.stat,
    filePath,
    `${label} changed before removal`,
  );
  if (!current.content.equals(original.content)) {
    throw new ManagedFileSafetyError(`${label} content changed before removal: ${filePath}`);
  }
  await assertManagedParentIdentity(parent, parentIdentity, label);
  await assertOperationTrustedRootBoundary(options, label);
  const tombstonePath = path.join(
    parentIdentity.realPath,
    `.${path.basename(filePath)}.agent-canvas-remove-${randomUUID()}`,
  );
  let renameError: unknown;
  try {
    await rename(filePath, tombstonePath);
  } catch (error) {
    renameError = error;
  }
  const [sourceAfter, tombstoneAfter] = await Promise.all([
    lstatIfExists(filePath),
    lstatIfExists(tombstonePath),
  ]);
  if (
    !sourceAfter &&
    tombstoneAfter?.isFile() &&
    !tombstoneAfter.isSymbolicLink() &&
    tombstoneAfter.nlink === 1 &&
    tombstoneAfter.dev === original.stat.dev &&
    tombstoneAfter.ino === original.stat.ino
  ) {
    const quarantined = await snapshotManagedBufferTarget(
      tombstonePath,
      `${label} quarantined file`,
    );
    if (
      !quarantined ||
      quarantined.stat.dev !== original.stat.dev ||
      quarantined.stat.ino !== original.stat.ino ||
      !quarantined.content.equals(original.content)
    ) {
      if (quarantined) {
        await restoreQuarantinedForeignFile(
          tombstonePath,
          filePath,
          quarantined.stat,
          label,
        );
      }
      throw new ManagedFileSafetyError(
        `${label} content changed while being quarantined: ${filePath}`,
      );
    }
    // Moving the caller-owned inode to an unpredictable sibling is the logical
    // removal commit point. Re-reading it after quarantine closes the check/rename
    // window without decoding binary bytes. Cleanup is best-effort once ownership
    // and content have both been re-established.
    await rm(tombstonePath).catch(() => undefined);
    return;
  }
  if (tombstoneAfter && !sourceAfter) {
    await restoreQuarantinedForeignFile(tombstonePath, filePath, tombstoneAfter, label);
    throw new ManagedFileSafetyError(`${label} changed while being quarantined: ${filePath}`);
  }
  if (sourceAfter && !tombstoneAfter) {
    throw renameError ?? new ManagedFileSafetyError(`${label} was not removed: ${filePath}`);
  }
  throw new ManagedFileSafetyError(`${label} removal left an ambiguous state: ${filePath}`);
}

async function restoreQuarantinedForeignFile(
  tombstonePath: string,
  filePath: string,
  expected: Stats,
  label: string,
): Promise<void> {
  assertSingleLinkRegularFile(expected, tombstonePath, `${label} quarantined replacement`);
  if (await lstatIfExists(filePath)) {
    throw new ManagedFileSafetyError(
      `${label} replacement could not be restored without clobbering: ${filePath}`,
    );
  }
  await link(tombstonePath, filePath);
  const restored = await lstat(filePath);
  assertSameIdentity(
    expected,
    restored,
    filePath,
    `${label} replacement changed while being restored`,
  );
  await rm(tombstonePath);
}

async function snapshotManagedTarget(
  filePath: string,
  label: string,
): Promise<{ stat: Stats; content: string } | undefined> {
  const snapshot = await snapshotManagedBufferTarget(filePath, label);
  return snapshot
    ? { stat: snapshot.stat, content: snapshot.content.toString("utf-8") }
    : undefined;
}

async function snapshotManagedBufferTarget(
  filePath: string,
  label: string,
): Promise<{ stat: Stats; content: Buffer } | undefined> {
  const pathStat = await lstatIfExists(filePath);
  if (!pathStat) return undefined;
  assertSingleLinkRegularFile(pathStat, filePath, label);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filePath, constants.O_RDONLY | noFollowFlag());
    const openedStat = await handle.stat();
    assertSingleLinkRegularFile(openedStat, filePath, label);
    assertSameIdentity(
      pathStat,
      openedStat,
      filePath,
      `${label} changed during persistence preflight`,
    );
    const content = await handle.readFile();
    const after = await lstat(filePath);
    assertSingleLinkRegularFile(after, filePath, label);
    assertSameIdentity(
      openedStat,
      after,
      filePath,
      `${label} changed during persistence preflight`,
    );
    return { stat: after, content };
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new ManagedFileSafetyError(
        `${label} disappeared during persistence preflight: ${filePath}`,
      );
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

function contentBuffer(content: string | Uint8Array): Buffer {
  return typeof content === "string"
    ? Buffer.from(content, "utf-8")
    : Buffer.from(content);
}

interface ManagedParentSnapshot {
  pathStat: Stats;
  realPath: string;
  realStat: Stats;
  allowMapping: boolean;
  trustedRoot?: ManagedTrustedRootSnapshot;
}

interface ManagedTrustedRootSnapshot {
  path: string;
  pathStat: Stats;
  realPath: string;
  realStat: Stats;
}

async function snapshotManagedParent(
  parent: string,
  label: string,
  allowMapping: boolean,
  trustedRoot?: string,
): Promise<ManagedParentSnapshot> {
  const trustedRootSnapshot = trustedRoot
    ? await snapshotTrustedRoot(path.resolve(trustedRoot), label)
    : undefined;
  if (trustedRootSnapshot && !isPathAtOrWithin(trustedRootSnapshot.path, parent)) {
    throw new ManagedFileSafetyError(`${label} parent escapes its trusted root: ${parent}`);
  }
  await assertExistingManagedAncestorChain(
    parent,
    label,
    allowMapping,
    trustedRootSnapshot,
  );
  const pathStat = await lstat(parent);
  const trustedParentMapping = !!trustedRootSnapshot && samePath(parent, trustedRootSnapshot.path);
  if (
    (!pathStat.isDirectory() && !((allowMapping || trustedParentMapping) && pathStat.isSymbolicLink())) ||
    (!(allowMapping || trustedParentMapping) && pathStat.isSymbolicLink())
  ) {
    throw new ManagedFileSafetyError(
      `${label} parent must be an ordinary directory: ${parent}`,
    );
  }
  const resolved = await realpath(parent);
  if (trustedRootSnapshot && !isPathAtOrWithin(trustedRootSnapshot.realPath, resolved)) {
    throw new ManagedFileSafetyError(
      `${label} parent target escapes its trusted root: ${parent}`,
    );
  }
  const realStat = await lstat(resolved);
  if (!realStat.isDirectory() || realStat.isSymbolicLink()) {
    throw new ManagedFileSafetyError(`${label} parent mapping is not a directory: ${parent}`);
  }
  return {
    pathStat,
    realPath: resolved,
    realStat,
    allowMapping: allowMapping || trustedParentMapping,
    trustedRoot: trustedRootSnapshot,
  };
}

async function assertManagedParentIdentity(
  parent: string,
  expected: ManagedParentSnapshot,
  label: string,
): Promise<void> {
  await assertExistingManagedAncestorChain(
    parent,
    label,
    expected.allowMapping,
    expected.trustedRoot,
  );
  let actual: Stats;
  try {
    actual = await lstat(parent);
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new ManagedFileSafetyError(`${label} parent disappeared: ${parent}`);
    }
    throw error;
  }
  if (
    (!actual.isDirectory() && !(expected.allowMapping && actual.isSymbolicLink())) ||
    (!expected.allowMapping && actual.isSymbolicLink())
  ) {
    throw new ManagedFileSafetyError(`${label} parent changed to an unsafe mapping: ${parent}`);
  }
  assertSameIdentity(expected.pathStat, actual, parent, `${label} parent changed`);
  const resolved = await realpath(parent);
  if (!samePath(expected.realPath, resolved)) {
    throw new ManagedFileSafetyError(`${label} parent target changed: ${parent}`);
  }
  const realStat = await lstat(resolved);
  if (!realStat.isDirectory() || realStat.isSymbolicLink()) {
    throw new ManagedFileSafetyError(`${label} parent target became unsafe: ${parent}`);
  }
  assertSameIdentity(expected.realStat, realStat, resolved, `${label} parent target changed`);
  if (expected.trustedRoot) {
    await assertTrustedRootIdentity(expected.trustedRoot, label);
    if (!isPathAtOrWithin(expected.trustedRoot.realPath, resolved)) {
      throw new ManagedFileSafetyError(
        `${label} parent target escapes its trusted root: ${parent}`,
      );
    }
  }
}

async function assertExistingManagedAncestorChain(
  parent: string,
  label: string,
  allowFinalMapping: boolean,
  trustedRoot?: ManagedTrustedRootSnapshot,
): Promise<void> {
  const resolvedParent = path.resolve(parent);
  const root = trustedRoot?.path ?? path.parse(resolvedParent).root;
  if (!isPathAtOrWithin(root, resolvedParent)) {
    throw new ManagedFileSafetyError(`${label} parent escapes its trusted root: ${parent}`);
  }
  if (!trustedRoot) {
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new ManagedFileSafetyError(`${label} path root is unsafe: ${root}`);
    }
  }
  let current = root;
  const relative = path.relative(root, resolvedParent);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const currentStat = await lstat(current);
    const isFinal = samePath(current, resolvedParent);
    const finalMapping = allowFinalMapping && isFinal && currentStat.isSymbolicLink();
    if (
      (!currentStat.isDirectory() && !finalMapping) ||
      (currentStat.isSymbolicLink() && !finalMapping)
    ) {
      throw new ManagedFileSafetyError(`${label} path contains an unsafe mapping: ${current}`);
    }
  }
  if (trustedRoot) {
    await assertTrustedRootIdentity(trustedRoot, label);
    const resolved = await realpath(resolvedParent);
    if (!isPathAtOrWithin(trustedRoot.realPath, resolved)) {
      throw new ManagedFileSafetyError(
        `${label} parent target escapes its trusted root: ${parent}`,
      );
    }
  }
}

function assertExistingManagedAncestorChainSync(
  parent: string,
  label: string,
  allowFinalMapping: boolean,
  trustedRoot?: string,
): void {
  const resolvedParent = path.resolve(parent);
  const root = trustedRoot ? path.resolve(trustedRoot) : path.parse(resolvedParent).root;
  if (!isPathAtOrWithin(root, resolvedParent)) {
    throw new ManagedFileSafetyError(`${label} parent escapes its trusted root: ${parent}`);
  }
  const rootStat = lstatSync(root);
  const trustedRootMapping = !!trustedRoot && rootStat.isSymbolicLink();
  if (
    (!rootStat.isDirectory() && !trustedRootMapping) ||
    (!trustedRoot && rootStat.isSymbolicLink())
  ) {
    throw new ManagedFileSafetyError(`${label} path root is unsafe: ${root}`);
  }
  const rootRealPath = realpathSync(root);
  const rootRealStat = lstatSync(rootRealPath);
  if (!rootRealStat.isDirectory() || rootRealStat.isSymbolicLink()) {
    throw new ManagedFileSafetyError(`${label} trusted root target is unsafe: ${root}`);
  }
  let current = root;
  const relative = path.relative(root, resolvedParent);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const currentStat = lstatSync(current);
    const isFinal = samePath(current, resolvedParent);
    const finalMapping = allowFinalMapping && isFinal && currentStat.isSymbolicLink();
    if (
      (!currentStat.isDirectory() && !finalMapping) ||
      (currentStat.isSymbolicLink() && !finalMapping)
    ) {
      throw new ManagedFileSafetyError(`${label} path contains an unsafe mapping: ${current}`);
    }
  }
  const parentRealPath = realpathSync(resolvedParent);
  if (trustedRoot && !isPathAtOrWithin(rootRealPath, parentRealPath)) {
    throw new ManagedFileSafetyError(
      `${label} parent target escapes its trusted root: ${parent}`,
    );
  }
}

async function snapshotTrustedRoot(
  trustedRoot: string,
  label: string,
): Promise<ManagedTrustedRootSnapshot> {
  const pathStat = await lstat(trustedRoot);
  if (!pathStat.isDirectory() && !pathStat.isSymbolicLink()) {
    throw new ManagedFileSafetyError(`${label} trusted root is not a directory: ${trustedRoot}`);
  }
  const resolved = await realpath(trustedRoot);
  const realStat = await lstat(resolved);
  if (!realStat.isDirectory() || realStat.isSymbolicLink()) {
    throw new ManagedFileSafetyError(`${label} trusted root target is unsafe: ${trustedRoot}`);
  }
  return { path: trustedRoot, pathStat, realPath: resolved, realStat };
}

async function resolveManagedOperationPath(
  filePath: string,
  options: ManagedPathOptions,
  label: string,
): Promise<{ filePath: string; trustedRoot?: string }> {
  const boundary = options.trustedRootBoundary;
  if (!boundary) {
    return { filePath: path.resolve(filePath), trustedRoot: options.trustedRoot };
  }
  await assertManagedTrustedRootBoundaryIdentity(boundary, label);
  const requested = path.resolve(filePath);
  if (!isPathAtOrWithin(boundary.path, requested)) {
    throw new ManagedFileSafetyError(
      `${label} path escapes its persisted trusted root: ${requested}`,
    );
  }
  const relative = path.relative(boundary.path, requested);
  return {
    filePath: path.join(boundary.realPath, relative),
    trustedRoot: boundary.realPath,
  };
}

function resolveManagedOperationPathSync(
  filePath: string,
  options: ManagedPathOptions,
  label: string,
): { filePath: string; trustedRoot?: string } {
  const boundary = options.trustedRootBoundary;
  if (!boundary) {
    return { filePath: path.resolve(filePath), trustedRoot: options.trustedRoot };
  }
  assertManagedTrustedRootBoundaryIdentitySync(boundary, label);
  const requested = path.resolve(filePath);
  if (!isPathAtOrWithin(boundary.path, requested)) {
    throw new ManagedFileSafetyError(
      `${label} path escapes its persisted trusted root: ${requested}`,
    );
  }
  const relative = path.relative(boundary.path, requested);
  return {
    filePath: path.join(boundary.realPath, relative),
    trustedRoot: boundary.realPath,
  };
}

async function assertOperationTrustedRootBoundary(
  options: ManagedPathOptions,
  label: string,
): Promise<void> {
  if (options.trustedRootBoundary) {
    await assertManagedTrustedRootBoundaryIdentity(options.trustedRootBoundary, label);
  }
}

async function assertTrustedRootIdentity(
  expected: ManagedTrustedRootSnapshot,
  label: string,
): Promise<void> {
  const actual = await lstat(expected.path);
  if (!actual.isDirectory() && !actual.isSymbolicLink()) {
    throw new ManagedFileSafetyError(`${label} trusted root became unsafe: ${expected.path}`);
  }
  assertSameIdentity(expected.pathStat, actual, expected.path, `${label} trusted root changed`);
  const resolved = await realpath(expected.path);
  if (!samePath(expected.realPath, resolved)) {
    throw new ManagedFileSafetyError(`${label} trusted root target changed: ${expected.path}`);
  }
  const realStat = await lstat(resolved);
  if (!realStat.isDirectory() || realStat.isSymbolicLink()) {
    throw new ManagedFileSafetyError(`${label} trusted root target became unsafe: ${expected.path}`);
  }
  assertSameIdentity(
    expected.realStat,
    realStat,
    resolved,
    `${label} trusted root target changed`,
  );
}

async function assertManagedTrustedRootBoundaryIdentity(
  expected: ManagedTrustedRootBoundary,
  label: string,
): Promise<void> {
  const logical = await lstatIfExists(expected.path);
  if (
    !logical ||
    logical.isSymbolicLink() !== expected.logicalMapping ||
    (!logical.isDirectory() && !logical.isSymbolicLink()) ||
    logical.dev !== expected.logicalIdentity.dev ||
    logical.ino !== expected.logicalIdentity.ino
  ) {
    throw new ManagedFileSafetyError(`${label} persisted trusted root changed: ${expected.path}`);
  }
  const resolved = await realpath(expected.path);
  if (!samePath(expected.realPath, resolved)) {
    throw new ManagedFileSafetyError(
      `${label} persisted trusted root target changed: ${expected.path}`,
    );
  }
  const real = await lstatIfExists(resolved);
  if (
    !real?.isDirectory() ||
    real.isSymbolicLink() ||
    real.dev !== expected.realIdentity.dev ||
    real.ino !== expected.realIdentity.ino
  ) {
    throw new ManagedFileSafetyError(
      `${label} persisted trusted root target identity changed: ${expected.path}`,
    );
  }
}

function assertManagedTrustedRootBoundaryIdentitySync(
  expected: ManagedTrustedRootBoundary,
  label: string,
): void {
  let logical: Stats;
  try {
    logical = lstatSync(expected.path);
  } catch {
    throw new ManagedFileSafetyError(`${label} persisted trusted root changed: ${expected.path}`);
  }
  if (
    logical.isSymbolicLink() !== expected.logicalMapping ||
    (!logical.isDirectory() && !logical.isSymbolicLink()) ||
    logical.dev !== expected.logicalIdentity.dev ||
    logical.ino !== expected.logicalIdentity.ino
  ) {
    throw new ManagedFileSafetyError(`${label} persisted trusted root changed: ${expected.path}`);
  }
  const resolved = realpathSync(expected.path);
  if (!samePath(expected.realPath, resolved)) {
    throw new ManagedFileSafetyError(
      `${label} persisted trusted root target changed: ${expected.path}`,
    );
  }
  const real = lstatSync(resolved);
  if (
    !real.isDirectory() ||
    real.isSymbolicLink() ||
    real.dev !== expected.realIdentity.dev ||
    real.ino !== expected.realIdentity.ino
  ) {
    throw new ManagedFileSafetyError(
      `${label} persisted trusted root target identity changed: ${expected.path}`,
    );
  }
}

function samePath(left: string, right: string): boolean {
  return resolvedManagedPathKey(left) === resolvedManagedPathKey(right);
}

function isPathAtOrWithin(root: string, candidate: string): boolean {
  return isManagedPathAtOrWithin(root, candidate);
}

/** Exact lexical key for a filesystem safety boundary. */
export function resolvedManagedPathKey(
  value: string,
  pathApi: Pick<typeof path, "resolve"> = path,
): string {
  return pathApi.resolve(value);
}

/**
 * Exact containment check that does not inherit win32's process-wide
 * case-insensitive `path.relative` behavior. Case-insensitive volumes converge
 * through realpath; case-sensitive Windows directories remain distinct.
 */
export function isManagedPathAtOrWithin(
  root: string,
  candidate: string,
  pathApi: Pick<typeof path, "resolve" | "sep"> = path,
): boolean {
  const resolvedRoot = pathApi.resolve(root);
  const resolvedCandidate = pathApi.resolve(candidate);
  if (resolvedCandidate === resolvedRoot) return true;
  const prefix = resolvedRoot.endsWith(pathApi.sep)
    ? resolvedRoot
    : `${resolvedRoot}${pathApi.sep}`;
  return resolvedCandidate.startsWith(prefix);
}

function assertSingleLinkRegularFile(
  stat: Stats,
  filePath: string,
  label: string,
): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new ManagedFileSafetyError(
      `${label} must be a no-follow single-link regular file: ${filePath}`,
    );
  }
}

function assertSameIdentity(
  expected: Stats,
  actual: Stats,
  filePath: string,
  message: string,
): void {
  if (expected.dev !== actual.dev || expected.ino !== actual.ino) {
    throw new ManagedFileSafetyError(`${message}: ${filePath}`);
  }
}

function noFollowFlag(): number {
  return process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
}

async function lstatIfExists(filePath: string): Promise<Stats | undefined> {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
}

export function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}
