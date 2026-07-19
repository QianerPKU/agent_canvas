import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  constants,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
  type BigIntStats,
  type Dirent,
  type Stats,
} from "node:fs";
import {
  lstat,
  link,
  mkdir,
  open,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  unlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentFileAccess,
  AgentSharedResourceReference,
  BranchDiffSummary,
  BranchOption,
  BranchWorkspace,
  CanvasProjectInspection,
  CanvasProjectSummary,
  ConnectGitHubInput,
  CreateBranchWorkspaceInput,
  CreateCanvasProjectInput,
  CreateSharedResourceInput,
  GitHubConnection,
  OpenCanvasProjectInput,
  SharedResourceMount,
  WorkspaceProject,
} from "@agent-canvas/shared";
import type { AgentStartConfig } from "@agent-canvas/shared";
import {
  WORK_DOCUMENTATION_PATHS,
  WORK_DOCUMENTATION_MANAGED_MARKER,
  ensureSharedBranchIndexEntry,
  isolatedDocumentationIndex,
  sharedBranchDirectory,
  sharedBranchOverview,
  sharedDocumentationIndex,
} from "./workDocumentation.js";
import {
  ManagedFileSafetyError,
  type ManagedFileSnapshot,
  type ManagedTrustedRootBoundary,
  assertManagedTrustedRootBoundary,
  assertManagedTrustedRootBoundarySync,
  captureManagedTrustedRootBoundary,
  readManagedFile,
  readManagedFileSnapshot,
  removeManagedFile,
  writeManagedFileAtomically,
} from "./safeManagedFile.js";

export interface WorkspaceManagerOptions {
  defaultSourcePath: string;
  projectRoot?: string;
  projectsRoot?: string;
  autoOpenDefault?: boolean;
  now?: () => number;
  runGit?: GitRunner;
}

export interface GitRunner {
  (args: string[], options?: { cwd?: string }): Promise<string>;
}

export interface WorkDocumentationOptions {
  workDocumentationEnabled?: boolean;
}

export interface WorkspaceProjectRevision {
  projectId: string;
  projectRoot: string;
  generation: number;
}

export class WorkspaceProjectChangedError extends Error {
  constructor() {
    super("Canvas project changed while the operation was in progress; retry the operation");
    this.name = "WorkspaceProjectChangedError";
  }
}

interface WorkspaceState {
  project?: CanvasProjectSummary;
  repo?: GitHubConnection;
  branches: BranchWorkspace[];
  sharedResources: SharedResourceMount[];
}

interface WorkspaceDocument extends WorkspaceState {
  schema: typeof WORKSPACE_SCHEMA;
  version: typeof WORKSPACE_VERSION;
  project: CanvasProjectSummary;
}

interface RelocatedWorkspace {
  project: CanvasProjectSummary;
  state: WorkspaceState;
  externalSharedResources: CanvasProjectInspection["externalSharedResources"];
}

interface ProjectIndex {
  projects: CanvasProjectSummary[];
}

interface WorkDocumentationContext {
  workspace: BranchWorkspace;
  projectRoot: string;
  projectId: string;
  projectGeneration: number;
  repositoryKey: string;
}

interface RepositoryGitBoundary {
  repositoryIdentity: { dev: number; ino: number };
  gitIdentity: { dev: number; ino: number };
  realRepositoryPath: string;
  realGitPath: string;
}

class RepositoryGitBoundaryError extends Error {
  constructor(repositoryPath: string, cause: unknown) {
    super(`Repository Git administrative boundary is unsafe: ${repositoryPath}`, { cause });
    this.name = "RepositoryGitBoundaryError";
  }
}

interface SharedResourceBranchPlan {
  workspace: BranchWorkspace;
  mountPath: string;
  mountParent: string;
  excludePath: string;
  ownership?: ManagedMountOwnership;
}

interface SharedResourceIgnorePlan {
  path: string;
  parent: string;
  originalSnapshot: ManagedFileSnapshot | undefined;
  nextContent: string;
  committedSnapshot?: ManagedFileSnapshot;
}

interface SharedResourceTransactionJournal {
  createdDirectories: ManagedDirectoryOwnership[];
  createdMounts: ManagedMountOwnership[];
  writtenIgnores: SharedResourceIgnorePlan[];
}

interface ManagedMountOwnership {
  mountPath: string;
  sourcePath: string;
  rawTarget?: string;
  identity: { dev: number; ino: number };
}

interface ManagedDirectoryOwnership {
  path: string;
  identity: { dev: number; ino: number };
}

type ProjectRootBoundary = ManagedTrustedRootBoundary;

interface ManagedWorktreeOwnership extends ManagedDirectoryOwnership {
  repositoryPath: string;
  registered: boolean;
  gitLink?: {
    path: string;
    snapshot: ManagedFileSnapshot;
    adminPath: string;
    adminIdentity: { dev: number; ino: number };
    commonWorktreesRoot: string;
  };
}

interface BranchRefSnapshot {
  repositoryPath: string;
  ref: string;
  previousSha?: string;
  replacementSha: string;
  transactionMarker: string;
  updated: boolean;
}

const DEFAULT_REPO_ID = "repo_1";
const WORKSPACE_STATE_FILE = "workspace.json";
const PROJECT_INDEX_FILE = "index.json";
const WORKSPACE_SCHEMA = "agent-canvas/workspace";
const WORKSPACE_VERSION = 1;

export class WorkspaceManager {
  private readonly defaultSourcePath: string;
  private readonly projectsRoot: string;
  private readonly now: () => number;
  private readonly runGit: GitRunner;
  private projectRoot?: string;
  private currentProject?: CanvasProjectSummary;
  private state: WorkspaceState = { branches: [], sharedResources: [] };
  private stateLoaded = false;
  private branchCounter = 0;
  private resourceCounter = 0;
  private projectRootBoundary?: ProjectRootBoundary;
  private projectsRootBoundary?: ManagedTrustedRootBoundary;
  private documentationPrepareChain: Promise<void> = Promise.resolve();
  private projectMutationChain: Promise<void> = Promise.resolve();
  private readonly ignoreWriteChains = new Map<string, Promise<void>>();
  private readonly preparedWorkDocumentation = new Set<string>();
  private projectGeneration = 0;

  constructor(options: WorkspaceManagerOptions) {
    this.defaultSourcePath = path.resolve(options.defaultSourcePath);
    this.projectsRoot = path.resolve(options.projectsRoot ?? defaultProjectsRoot());
    this.now = options.now ?? Date.now;
    this.runGit = options.runGit ?? defaultRunGit;
    const defaultRoot = path.resolve(
      options.projectRoot ?? defaultProjectRoot(this.defaultSourcePath),
    );
    if (options.autoOpenDefault !== false) {
      this.projectRoot = defaultRoot;
      this.currentProject = {
        id: projectIdFromRoot(defaultRoot),
        name: path.basename(defaultRoot),
        projectRoot: defaultRoot,
        createdAt: this.now(),
      };
    }
  }

  root(): string {
    return this.projectRoot ?? this.projectsRoot;
  }

  projectListRoot(): string {
    return this.projectsRoot;
  }

  currentProjectId(): string | undefined {
    return this.currentProject?.id;
  }

  captureProjectRevision(): WorkspaceProjectRevision {
    const project = this.currentProject;
    const projectRoot = this.projectRoot;
    if (!project || !projectRoot) throw new Error("No Canvas project is currently open");
    return {
      projectId: project.id,
      projectRoot,
      generation: this.projectGeneration,
    };
  }

  assertProjectRevision(revision: WorkspaceProjectRevision): void {
    const current = this.currentProject;
    if (
      !current ||
      revision.generation !== this.projectGeneration ||
      revision.projectId !== current.id ||
      normalizedRootKey(revision.projectRoot) !== normalizedRootKey(this.projectRoot ?? "")
    ) {
      throw new WorkspaceProjectChangedError();
    }
  }

  async listCanvasProjects(): Promise<CanvasProjectSummary[]> {
    if (this.currentProject) await this.ensureProjectOpen();
    const { index, snapshot: indexSnapshot } = await this.readProjectIndexSnapshot();
    const byRoot = new Map<string, CanvasProjectSummary>();
    for (const indexed of index.projects) {
      try {
        const project = await this.readProjectSummary(indexed.projectRoot, indexed);
        byRoot.set(normalizedRootKey(project.projectRoot), project);
      } catch (error) {
        if (error instanceof ManagedFileSafetyError) throw error;
        // Stale and invalid index entries are omitted. A valid custom project can be loaded by path.
      }
    }
    for (const discovered of await this.discoverProjects()) {
      const key = normalizedRootKey(discovered.projectRoot);
      if (!byRoot.has(key)) byRoot.set(key, discovered);
    }
    if (this.currentProject) {
      let current = this.currentProject;
      try {
        current = await this.readProjectSummary(current.projectRoot);
        this.currentProject = current;
      } catch (error) {
        if (error instanceof ManagedFileSafetyError) throw error;
        // A configured project root may be intentionally empty until its first save.
      }
      const key = normalizedRootKey(current.projectRoot);
      byRoot.set(key, { ...byRoot.get(key), ...current });
    }
    const projects = uniqueProjectIds([...byRoot.values()]).sort(
      (a, b) => (b.openedAt ?? b.createdAt) - (a.openedAt ?? a.createdAt),
    );
    await this.writeProjectIndex(projects, indexSnapshot ?? null);
    return projects;
  }

  async createCanvasProject(input: CreateCanvasProjectInput): Promise<CanvasProjectSummary> {
    return await this.queueProjectMutation(() => this.createCanvasProjectInternal(input));
  }

  private async createCanvasProjectInternal(
    input: CreateCanvasProjectInput,
  ): Promise<CanvasProjectSummary> {
    const name = normalizeName(input.name);
    const explicitRoot = normalizeOptionalProjectRoot(input.projectRoot);
    const id = explicitRoot
      ? projectIdFromExplicitRoot(explicitRoot)
      : `${safePathPart(name)}-${this.now().toString(36)}`;
    const projectRoot = explicitRoot ?? path.join(this.projectsRoot, id);
    if (isPathWithin(this.projectsRoot, projectRoot)) {
      throw new Error("项目文件夹不能包含项目列表根目录");
    }
    const project: CanvasProjectSummary = {
      id,
      name,
      projectRoot,
      createdAt: this.now(),
      openedAt: this.now(),
    };
    await this.ensureProjectRootAvailable(projectRoot);
    const projectsRootBoundary = await this.ensureProjectsRootBoundary();
    await readManagedFileSnapshot(this.projectIndexPath(), {
      allowMissing: true,
      label: "Canvas project index",
      trustedRootBoundary: projectsRootBoundary,
    });
    const createdProjectDirectories: ManagedDirectoryOwnership[] = [];
    const previousSelection = {
      projectRoot: this.projectRoot,
      currentProject: this.currentProject,
      state: this.state,
      stateLoaded: this.stateLoaded,
      branchCounter: this.branchCounter,
      resourceCounter: this.resourceCounter,
      projectRootBoundary: this.projectRootBoundary,
    };
    let selected = false;
    try {
      await createDirectoryChainFromNearestParent(projectRoot, createdProjectDirectories);
      await this.selectProject(project, { branches: [], sharedResources: [] });
      selected = true;
      await this.saveState();
      return project;
    } catch (error) {
      if (selected) this.advanceProjectGeneration();
      this.projectRoot = previousSelection.projectRoot;
      this.currentProject = previousSelection.currentProject;
      this.state = previousSelection.state;
      this.stateLoaded = previousSelection.stateLoaded;
      this.branchCounter = previousSelection.branchCounter;
      this.resourceCounter = previousSelection.resourceCounter;
      this.projectRootBoundary = previousSelection.projectRootBoundary;
      const rollbackErrors: unknown[] = [];
      for (const directory of [...createdProjectDirectories].reverse()) {
        await collectRollbackError(rollbackErrors, () => removeCreatedDirectory(directory));
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          `Canvas project creation failed and directory rollback was incomplete: ${errorMessage(error)}`,
        );
      }
      throw error;
    }
  }

  async openCanvasProject(input: OpenCanvasProjectInput): Promise<WorkspaceProject> {
    return await this.queueProjectMutation(() => this.openCanvasProjectInternal(input));
  }

  async closeCanvasProject(): Promise<void> {
    await this.queueProjectMutation(async () => {
      this.advanceProjectGeneration();
      this.projectRoot = undefined;
      this.currentProject = undefined;
      this.state = { branches: [], sharedResources: [] };
      this.stateLoaded = false;
      this.branchCounter = 0;
      this.resourceCounter = 0;
      this.projectRootBoundary = undefined;
    });
  }

  private async openCanvasProjectInternal(
    input: OpenCanvasProjectInput,
  ): Promise<WorkspaceProject> {
    const projectRoot = normalizeOptionalProjectRoot(input.projectRoot);
    const projects = await this.listCanvasProjects();
    const indexed = input.id
      ? projects.find((candidate) => candidate.id === input.id)
      : undefined;
    if (!indexed && !projectRoot) {
      throw new Error(input.id ? `未知 canvas 项目: ${input.id}` : "缺少项目 id 或项目文件夹");
    }
    const resolvedRoot = path.resolve(projectRoot ?? indexed!.projectRoot);
    if (
      indexed &&
      projectRoot &&
      !sameExistingDirectoryIdentitySync(indexed.projectRoot, resolvedRoot)
    ) {
      throw new Error("项目 id 与项目文件夹不匹配");
    }
    const registered =
      indexed ??
      projects.find(
        (candidate) => sameExistingDirectoryIdentitySync(candidate.projectRoot, resolvedRoot),
      );
    const openingBoundary = await captureProjectRootBoundary(resolvedRoot);
    const document = await this.readWorkspaceDocument(resolvedRoot, undefined, openingBoundary);
    await assertProjectRootBoundary(resolvedRoot, openingBoundary);
    const relocated = relocateWorkspace(document, resolvedRoot, {
      requireExternalTrust: !registered,
      trustedExternalResourcePaths: input.trustedExternalResourcePaths,
    });
    await validateRelocatedWorkspaceRoots(resolvedRoot, relocated.state);
    let project = { ...relocated.project, id: registered?.id ?? relocated.project.id };
    if (
      !registered &&
      projects.some(
        (candidate) =>
          candidate.id === project.id &&
          !sameExistingDirectoryIdentitySync(candidate.projectRoot, resolvedRoot),
      )
    ) {
      project = { ...project, id: projectIdFromExplicitRoot(resolvedRoot) };
    }
    const opened = { ...project, projectRoot: resolvedRoot, openedAt: this.now() };
    const previousSelection = {
      projectRoot: this.projectRoot,
      currentProject: this.currentProject,
      state: this.state,
      stateLoaded: this.stateLoaded,
      branchCounter: this.branchCounter,
      resourceCounter: this.resourceCounter,
      projectRootBoundary: this.projectRootBoundary,
    };
    await this.selectProject(opened, { ...relocated.state, project: opened }, openingBoundary);
    try {
      await this.saveState();
      return this.snapshot();
    } catch (error) {
      this.advanceProjectGeneration();
      this.projectRoot = previousSelection.projectRoot;
      this.currentProject = previousSelection.currentProject;
      this.state = previousSelection.state;
      this.stateLoaded = previousSelection.stateLoaded;
      this.branchCounter = previousSelection.branchCounter;
      this.resourceCounter = previousSelection.resourceCounter;
      this.projectRootBoundary = previousSelection.projectRootBoundary;
      throw error;
    }
  }

  async inspectCanvasProject(projectRoot: string): Promise<CanvasProjectInspection> {
    const resolvedRoot = path.resolve(normalizeRequiredProjectRoot(projectRoot));
    const boundary = await captureProjectRootBoundary(resolvedRoot);
    const document = await this.readWorkspaceDocument(resolvedRoot, undefined, boundary);
    const relocated = relocateWorkspace(document, resolvedRoot, {
      requireExternalTrust: false,
    });
    await validateRelocatedWorkspaceRoots(resolvedRoot, relocated.state);
    return {
      project: relocated.project,
      externalSharedResources: relocated.externalSharedResources,
    };
  }

  async deleteCanvasProject(
    id: string,
  ): Promise<CanvasProjectSummary & { cleanupWarning?: string }> {
    return await this.queueProjectMutation(() => this.deleteCanvasProjectInternal(id));
  }

  private async deleteCanvasProjectInternal(
    id: string,
  ): Promise<CanvasProjectSummary & { cleanupWarning?: string }> {
    const project = (await this.listCanvasProjects()).find((candidate) => candidate.id === id);
    if (!project) throw new Error(`未知 canvas 项目: ${id}`);
    const projectRoot = path.resolve(project.projectRoot);
    const boundary = await captureProjectRootBoundary(projectRoot);
    const document = await this.readWorkspaceDocument(projectRoot, undefined, boundary);
    relocateWorkspace(document, projectRoot, { requireExternalTrust: false });
    if (isPathWithin(this.projectsRoot, projectRoot)) {
      throw new Error("不能删除包含项目列表根目录的文件夹");
    }
    if (path.parse(projectRoot).root === projectRoot) throw new Error("不能删除文件系统根目录");
    const deletingCurrentProject =
      normalizedRootKey(this.currentProject?.projectRoot ?? "") ===
      normalizedRootKey(projectRoot);
    const { index, snapshot: indexSnapshot } = await this.readProjectIndexSnapshot();
    const projectStat = await lstat(projectRoot);
    if (!projectStat.isDirectory() || projectStat.isSymbolicLink()) {
      throw new Error("Canvas project root must be an ordinary directory: " + projectRoot);
    }
    const tombstonePath = path.join(
      path.dirname(projectRoot),
      "." + path.basename(projectRoot) + ".agent-canvas-delete-" + randomUUID(),
    );
    await stageOwnedDirectoryRename(projectRoot, tombstonePath, projectStat, {
      operation: "staging Canvas project deletion",
      sourceLabel: "Canvas project root",
      targetLabel: "staged Canvas project",
    });
    try {
      await this.writeProjectIndex(
        index.projects.filter(
          (candidate) =>
            candidate.id !== id &&
            normalizedRootKey(candidate.projectRoot) !== normalizedRootKey(projectRoot),
        ),
        indexSnapshot ?? null,
      );
    } catch (error) {
      try {
        await stageOwnedDirectoryRename(tombstonePath, projectRoot, projectStat, {
          operation: "rolling back Canvas project deletion",
          sourceLabel: "staged Canvas project",
          targetLabel: "Canvas project root",
        });
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Canvas project deletion failed and directory rollback was incomplete: " +
            errorMessage(error),
        );
      }
      throw error;
    }
    if (deletingCurrentProject) this.advanceProjectGeneration();
    if (deletingCurrentProject) {
      this.clearSelectedProject();
    }
    try {
      await rm(tombstonePath, { recursive: true, force: false });
      return project;
    } catch (error) {
      // The index update is the deletion commit point. Returning authoritative
      // success lets the server unload the deleted project's in-memory state;
      // the owned tombstone can be retried or removed by maintenance later.
      return {
        ...project,
        cleanupWarning:
          "Canvas project was deleted, but staged files could not be fully cleaned up: " +
          tombstonePath +
          ": " +
          errorMessage(error),
      };
    }
  }

  async project(): Promise<WorkspaceProject> {
    await this.ensureProjectOpen();
    await this.loadStateIfNeeded();
    return this.snapshot();
  }

  async connect(input: ConnectGitHubInput = {}): Promise<WorkspaceProject> {
    return (await this.connectWithProjectRevision(input)).workspace;
  }

  async connectWithProjectRevision(
    input: ConnectGitHubInput = {},
  ): Promise<{ workspace: WorkspaceProject; revision: WorkspaceProjectRevision }> {
    return await this.queueProjectMutation(async () => {
      const workspace = await this.connectInternal(input);
      return { workspace, revision: this.captureProjectRevision() };
    });
  }

  private async connectInternal(input: ConnectGitHubInput = {}): Promise<WorkspaceProject> {
    await this.ensureProjectOpen();
    await this.loadStateIfNeeded();
    await this.preflightMutableProjectMetadata();
    const projectRoot = this.requireProjectRoot();
    await mkdir(projectRoot, { recursive: true });
    const source = path.resolve(input.localPath ?? this.defaultSourcePath);
    const requestedRemote = normalizeRemoteUrl(input.remoteUrl);
    const cloneSource = requestedRemote ?? source;
    const discoveredRemote = requestedRemote ? undefined : await this.remoteUrlOf(source);
    const remoteUrl = normalizeRepositoryLocation(
      requestedRemote ?? discoveredRemote ?? source,
      requestedRemote ? process.cwd() : source,
    );
    const defaultBranch =
      input.defaultBranch?.trim() || (await this.currentBranch(source)) || "main";
    const localRepoPath = this.localRepoPath(DEFAULT_REPO_ID);
    const previous = {
      state: this.state,
      branchCounter: this.branchCounter,
      resourceCounter: this.resourceCounter,
      projectGeneration: this.projectGeneration,
    };
    const createdParentDirectories: ManagedDirectoryOwnership[] = [];
    let createdRepository: ManagedDirectoryOwnership | undefined;
    await ensureDirectoryWithinRoot(projectRoot, localRepoPath, {
      allowRootMapping: true,
      createMissing: false,
    });
    try {
      const existingRepository = await lstatIfExists(localRepoPath);
      if (!existingRepository) {
        await createDirectoryChainWithinRoot(
          projectRoot,
          path.dirname(localRepoPath),
          createdParentDirectories,
          { allowRootMapping: true },
        );
        const stagedRepositoryPath = path.join(
          path.dirname(localRepoPath),
          `.agent-canvas-repository-${randomUUID()}.tmp`,
        );
        await mkdir(stagedRepositoryPath);
        const stagedStat = await lstat(stagedRepositoryPath);
        createdRepository = {
          path: stagedRepositoryPath,
          identity: { dev: stagedStat.dev, ino: stagedStat.ino },
        };
        await ensureDirectoryWithinRoot(projectRoot, path.dirname(stagedRepositoryPath), {
          allowRootMapping: true,
          createMissing: false,
        });
        await ensureDirectoryWithinRoot(projectRoot, stagedRepositoryPath, {
          allowRootMapping: true,
          createMissing: false,
        });
        assertOwnedOrdinaryDirectory(
          await lstatIfExists(stagedRepositoryPath),
          createdRepository.identity,
          stagedRepositoryPath,
          "staged repository",
        );
        await this.runGit(["clone", cloneSource, stagedRepositoryPath]);
        assertOwnedOrdinaryDirectory(
          await lstatIfExists(stagedRepositoryPath),
          createdRepository.identity,
          stagedRepositoryPath,
          "staged repository",
        );
        await ensureDirectoryWithinRoot(projectRoot, stagedRepositoryPath, {
          allowRootMapping: true,
          createMissing: false,
        });
        const gitDirectory = await lstat(path.join(stagedRepositoryPath, ".git"));
        if (!gitDirectory.isDirectory() || gitDirectory.isSymbolicLink()) {
          throw new Error(`Cloned repository has an unsafe Git directory: ${stagedRepositoryPath}`);
        }
        if (await lstatIfExists(localRepoPath)) {
          throw new Error(`Repository path appeared before commit: ${localRepoPath}`);
        }
        await stageOwnedDirectoryRename(
          stagedRepositoryPath,
          localRepoPath,
          createdRepository.identity,
          {
            operation: "committing cloned repository",
            sourceLabel: "staged repository",
            targetLabel: "repository path",
          },
        );
        createdRepository.path = localRepoPath;
      } else {
        if (!existingRepository.isDirectory() || existingRepository.isSymbolicLink()) {
          throw new Error(`Repository path is unsafe: ${localRepoPath}`);
        }
        const gitDirectory = await lstatIfExists(path.join(localRepoPath, ".git"));
        if (!gitDirectory?.isDirectory() || gitDirectory.isSymbolicLink()) {
          throw new Error(`Repository path already exists without a safe clone: ${localRepoPath}`);
        }
      }
      await ensureDirectoryWithinRoot(projectRoot, localRepoPath, {
        allowRootMapping: true,
        createMissing: false,
      });
      const repo = parseGitHubConnection({
        id: DEFAULT_REPO_ID,
        remoteUrl,
        defaultBranch,
        localRepoPath,
        connectedAt: this.now(),
      });
      this.advanceProjectGeneration();
      this.state = { repo, branches: [], sharedResources: [] };
      this.branchCounter = 0;
      this.resourceCounter = 0;
      await this.createBranchInternal({ branch: defaultBranch });
      return this.snapshot();
    } catch (error) {
      this.state = previous.state;
      this.branchCounter = previous.branchCounter;
      this.resourceCounter = previous.resourceCounter;
      this.projectGeneration = previous.projectGeneration;
      const rollbackErrors: unknown[] = [];
      if (createdRepository) {
        const ownedRepository = createdRepository;
        await collectRollbackError(rollbackErrors, () =>
          removeOwnedDirectoryTree(ownedRepository, "cloned repository"),
        );
      }
      for (const directory of [...createdParentDirectories].reverse()) {
        await collectRollbackError(rollbackErrors, () => removeCreatedDirectory(directory));
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          `Repository connection failed and rollback was incomplete: ${errorMessage(error)}`,
        );
      }
      throw error;
    }
  }

  async listBranches(): Promise<BranchWorkspace[]> {
    await this.ensureProjectOpen();
    await this.loadStateIfNeeded();
    return [...this.state.branches];
  }

  async listBranchOptions(): Promise<BranchOption[]> {
    await this.ensureProjectOpen();
    await this.loadStateIfNeeded();
    const repo = this.state.repo;
    if (!repo) return [];
    const remoteBranches = await this.remoteBranches(repo.localRepoPath);
    const names = new Set<string>([repo.defaultBranch, ...remoteBranches]);
    for (const branch of this.state.branches) names.add(branch.branch);
    return [...names].sort().map((branchName) => {
      const workspace = this.state.branches.find((branch) => branch.branch === branchName);
      return {
        branch: branchName,
        branchWorkspaceId: workspace?.id,
        worktreePath: workspace?.worktreePath,
        hasWorkspace: !!workspace,
        isDefault: branchName === repo.defaultBranch,
      };
    });
  }

  async createBranch(input: CreateBranchWorkspaceInput): Promise<BranchWorkspace> {
    return (await this.createBranchWithProjectRevision(input)).branch;
  }

  async createBranchWithProjectRevision(
    input: CreateBranchWorkspaceInput,
  ): Promise<{ branch: BranchWorkspace; revision: WorkspaceProjectRevision }> {
    return await this.queueProjectMutation(async () => {
      const branch = await this.createBranchInternal(input);
      return { branch, revision: this.captureProjectRevision() };
    });
  }

  private async createBranchInternal(
    input: CreateBranchWorkspaceInput,
  ): Promise<BranchWorkspace> {
    await this.ensureProjectOpen();
    await this.loadStateIfNeeded();
    const repo = this.requireRepo();
    const projectRoot = this.requireProjectRoot();
    const branch = normalizeBranch(input.branch);
    const existing = this.state.branches.find((candidate) => candidate.branch === branch);
    if (existing) return existing;
    await this.preflightMutableProjectMetadata();
    const baseBranch = input.baseBranch
      ? normalizeBranch(input.baseBranch)
      : repo.defaultBranch;
    const nextBranchCounter = this.branchCounter + 1;
    const id = `branch_${nextBranchCounter}`;
    const useBaseClone = this.state.branches.length === 0 && branch === repo.defaultBranch;
    const worktreePath = useBaseClone
      ? repo.localRepoPath
      : this.branchWorktreePath(repo.id, branch);
    const journal: SharedResourceTransactionJournal = {
      createdDirectories: [],
      createdMounts: [],
      writtenIgnores: [],
    };
    const worktreeParentDirectories: ManagedDirectoryOwnership[] = [];
    let createdWorktree: ManagedWorktreeOwnership | undefined;
    let branchRefSnapshot: BranchRefSnapshot | undefined;
    await this.assertRepositoryGitBoundary(repo.localRepoPath);
    await ensureDirectoryWithinRoot(projectRoot, worktreePath, {
      allowRootMapping: true,
      createMissing: false,
    });
    try {
      if (!useBaseClone) {
        await createDirectoryChainWithinRoot(
          projectRoot,
          path.dirname(worktreePath),
          worktreeParentDirectories,
          { allowRootMapping: true },
        );
      }
      if (!useBaseClone) {
        if (await lstatIfExists(worktreePath)) {
          throw new Error(`Branch worktree path already exists: ${worktreePath}`);
        }
        const stagedWorktreePath = path.join(
          path.dirname(worktreePath),
          `.agent-canvas-worktree-${randomUUID()}.tmp`,
        );
        await mkdir(stagedWorktreePath);
        createdWorktree = await this.captureReservedWorktree(
          repo.localRepoPath,
          stagedWorktreePath,
        );
        const startPoint = await this.branchStartPoint(repo, branch, baseBranch);
        const replacementSha = await this.resolveCommit(repo.localRepoPath, startPoint);
        const ref = `refs/heads/${branch}`;
        branchRefSnapshot = {
          repositoryPath: repo.localRepoPath,
          ref,
          previousSha: await this.localRefSha(repo.localRepoPath, ref),
          replacementSha,
          transactionMarker: `agent-canvas-branch-${randomUUID()}`,
          updated: false,
        };
        try {
          const worktreeArgs = [
            "worktree",
            "add",
            "--no-checkout",
            "--detach",
            stagedWorktreePath,
            replacementSha,
          ];
          await this.assertStagedWorktreeBoundary(projectRoot, createdWorktree);
          await this.runRepositoryGit(repo.localRepoPath, worktreeArgs);
          createdWorktree.registered = true;
          await this.captureStagedWorktreeGitLink(projectRoot, createdWorktree);
        } catch (error) {
          try {
            createdWorktree.registered = await this.isRegisteredWorktree(
              repo.localRepoPath,
              stagedWorktreePath,
            );
          } catch {
            // The directory is transaction-owned. Prefer Git-aware cleanup if its
            // registration state cannot be queried after an interrupted add.
            createdWorktree.registered = true;
          }
          throw error;
        }
        await this.assertStagedWorktreeBoundary(projectRoot, createdWorktree);
        if (branchRefSnapshot.previousSha) {
          await this.assertStagedWorktreeBoundary(projectRoot, createdWorktree);
          await this.runGit(["switch", "--no-guess", "--", branch], {
            cwd: stagedWorktreePath,
          });
        } else {
          await this.assertStagedWorktreeBoundary(projectRoot, createdWorktree);
          await this.runGit(["symbolic-ref", "HEAD", ref], {
            cwd: stagedWorktreePath,
          });
        }
        await this.assertStagedWorktreeBoundary(projectRoot, createdWorktree);
        branchRefSnapshot.updated = true;
        try {
          await this.replaceBranchRef(branchRefSnapshot);
        } catch (error) {
          branchRefSnapshot.updated = false;
          try {
            const currentSha = await this.localRefSha(repo.localRepoPath, ref);
            const verifiedOwned =
              currentSha === replacementSha &&
              await this.branchRefHasTransactionMarker(branchRefSnapshot);
            branchRefSnapshot.updated = verifiedOwned;
          } catch (reconciliationError) {
            throw new AggregateError(
              [error, reconciliationError],
              `Branch ref update failed and its result could not be verified: ${ref}`,
            );
          }
          throw error;
        }
        await this.assertStagedWorktreeBoundary(projectRoot, createdWorktree);
        await this.runGit(["read-tree", "--reset", "-u", replacementSha], {
          cwd: stagedWorktreePath,
        });
        await this.assertStagedWorktreeBoundary(projectRoot, createdWorktree);
        await this.runRepositoryGit(
          repo.localRepoPath,
          [
            "update-ref",
            "-m",
            branchRefSnapshot.transactionMarker,
            ref,
            replacementSha,
            replacementSha,
          ],
        );
        try {
          await this.assertStagedWorktreeBoundary(projectRoot, createdWorktree);
          if (await lstatIfExists(worktreePath)) {
            throw new Error(`Branch worktree path appeared before commit: ${worktreePath}`);
          }
          await this.runRepositoryGit(
            repo.localRepoPath,
            ["worktree", "move", stagedWorktreePath, worktreePath],
          );
        } catch (error) {
          if (await this.worktreeOwnershipMatches(createdWorktree, worktreePath)) {
            createdWorktree.path = worktreePath;
          }
          throw error;
        }
        if (!(await this.worktreeOwnershipMatches(createdWorktree, worktreePath))) {
          throw new Error(`Created worktree changed while moving into place: ${worktreePath}`);
        }
        createdWorktree.path = worktreePath;
      }
      await ensureDirectoryWithinRoot(projectRoot, worktreePath, {
        allowRootMapping: true,
        createMissing: false,
      });
      const workspace: BranchWorkspace = {
        id,
        repoId: repo.id,
        branch,
        baseBranch,
        worktreePath,
        scratchRoot: path.join(worktreePath, ".agent-tmp"),
        isDefault: this.state.branches.length === 0,
        createdAt: this.now(),
      };
      await this.applySharedResourcesToNewBranch(workspace, journal);
      const nextState: WorkspaceState = {
        project: this.currentProject,
        repo: this.state.repo,
        branches: [...this.state.branches, workspace],
        sharedResources: [...this.state.sharedResources],
      };
      await this.saveState(nextState);
      this.state = nextState;
      this.branchCounter = nextBranchCounter;
      return workspace;
    } catch (error) {
      const rollbackErrors = await this.rollbackSharedEffects(journal);
      if (createdWorktree) {
        const ownedWorktree = createdWorktree;
        await collectRollbackError(rollbackErrors, () =>
          this.removeCreatedWorktree(ownedWorktree),
        );
      }
      if (branchRefSnapshot) {
        const refSnapshot = branchRefSnapshot;
        await collectRollbackError(rollbackErrors, () => this.restoreBranchRef(refSnapshot));
      }
      for (const directory of [...worktreeParentDirectories].reverse()) {
        await collectRollbackError(rollbackErrors, () => removeCreatedDirectory(directory));
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          `Branch creation failed and rollback was incomplete: ${errorMessage(error)}`,
        );
      }
      throw error;
    }
  }

  async createSharedResource(input: CreateSharedResourceInput): Promise<SharedResourceMount> {
    return await this.queueProjectMutation(() =>
      this.createSharedResourceInternal(input),
    );
  }

  private async createSharedResourceInternal(
    input: CreateSharedResourceInput,
  ): Promise<SharedResourceMount> {
    await this.ensureProjectOpen();
    await this.loadStateIfNeeded();
    const repo = this.requireRepo();
    const projectRoot = this.requireProjectRoot();
    const name = normalizeName(input.name);
    const mountPath = normalizeRelativePath(input.mountPath);
    const nextResourceCounter = this.resourceCounter + 1;
    const id = `shared_${nextResourceCounter}`;
    const sourcePath = resolveSharedResourceSourcePath(
      input.sourcePath?.trim() || path.join(projectRoot, "shared", repo.id, safePathPart(name)),
    );
    const resource: SharedResourceMount = {
      id,
      repoId: repo.id,
      name,
      sourcePath,
      mountPath,
      access: input.access ?? "readOnly",
      createdAt: this.now(),
    };
    const nextState: WorkspaceState = {
      project: this.currentProject,
      repo: this.state.repo,
      branches: [...this.state.branches],
      sharedResources: [...this.state.sharedResources, resource],
    };
    const workspacePath = this.statePath();
    const workspaceOriginal = await readManagedFileSnapshot(workspacePath, {
      allowParentMapping: true,
      label: "Canvas workspace metadata",
      trustedRootBoundary: this.currentProjectRootBoundary(),
    });
    const { branches, ignores } = await this.preflightSharedResourceCreation(resource);
    const journal: SharedResourceTransactionJournal = {
      createdDirectories: [],
      createdMounts: [],
      writtenIgnores: [],
    };

    try {
      await this.createSharedResourceSource(resource, journal.createdDirectories);
      await this.assertSharedResourceSource(resource);
      this.assertSharedResourceCanonicalScope(resource);
      for (const plan of branches) {
        await this.assertSharedResourceSource(resource);
        await ensureDirectoryWithinRoot(projectRoot, plan.workspace.worktreePath, {
          allowRootMapping: true,
          createMissing: false,
        });
        await ensureDirectoryWithinRoot(plan.workspace.worktreePath, plan.mountParent, {
          createMissing: false,
        });
        await createDirectoryChainWithinRoot(
          plan.workspace.worktreePath,
          plan.mountParent,
          journal.createdDirectories,
        );
        await ensureDirectoryWithinRoot(plan.workspace.worktreePath, plan.mountParent, {
          createMissing: false,
        });
        plan.ownership = await createManagedLinkNoClobber(
          resource.sourcePath,
          plan.mountPath,
        );
        journal.createdMounts.push(plan.ownership);
        await this.assertSharedResourceSource(resource);
        await ensureDirectoryWithinRoot(projectRoot, plan.workspace.worktreePath, {
          allowRootMapping: true,
          createMissing: false,
        });
        await ensureDirectoryWithinRoot(plan.workspace.worktreePath, plan.mountParent, {
          createMissing: false,
        });

        const currentExcludePath = await gitPath(
          this.runGit,
          plan.workspace.worktreePath,
          "info/exclude",
        );
        if (!sameFileSystemPath(currentExcludePath, plan.excludePath)) {
          throw new Error(`Git exclude path changed during shared resource creation: ${plan.workspace.branch}`);
        }
      }

      for (const ignore of ignores) {
        await ensureDirectoryWithinRoot(projectRoot, ignore.parent, {
          allowRootMapping: true,
          createMissing: false,
        });
        await createDirectoryChainWithinRoot(
          projectRoot,
          ignore.parent,
          journal.createdDirectories,
          { allowRootMapping: true },
        );
        await ensureDirectoryWithinRoot(projectRoot, ignore.parent, {
          allowRootMapping: true,
          createMissing: false,
        });
        if (ignore.nextContent === ignore.originalSnapshot?.content) {
          const current = await readManagedFileSnapshot(ignore.path, {
            allowMissing: true,
            label: "Git exclude metadata",
          });
          if (!sameManagedFileSnapshot(current, ignore.originalSnapshot)) {
            throw new Error(`Git exclude metadata changed during commit: ${ignore.path}`);
          }
          continue;
        }
        journal.writtenIgnores.push(ignore);
        ignore.committedSnapshot = await writeManagedFileAtomically(
          ignore.path,
          ignore.nextContent,
          {
            label: "Git exclude metadata",
            expectedContent: ignore.originalSnapshot?.content,
            expectedIdentity: ignore.originalSnapshot?.identity,
          },
        );
      }

      await this.assertSharedResourceSource(resource);
      for (const plan of branches) {
        await ensureDirectoryWithinRoot(projectRoot, plan.workspace.worktreePath, {
          allowRootMapping: true,
          createMissing: false,
        });
        await ensureDirectoryWithinRoot(plan.workspace.worktreePath, plan.mountParent, {
          createMissing: false,
        });
        if (!plan.ownership) {
          throw new Error(`Shared resource mount ownership is missing: ${plan.mountPath}`);
        }
        await assertManagedMountOwnership(plan.ownership);
        await assertExistingLinkPointsTo(resource.sourcePath, plan.mountPath);
        const canonicalSourcePath = this.assertSharedResourceCanonicalScope(resource).sourcePath;
        assertSharedResourceMountSync(plan.workspace, resource, canonicalSourcePath);
        const currentExcludePath = await gitPath(
          this.runGit,
          plan.workspace.worktreePath,
          "info/exclude",
        );
        if (!sameFileSystemPath(currentExcludePath, plan.excludePath)) {
          throw new Error(
            `Git exclude path changed before shared resource commit: ${plan.workspace.branch}`,
          );
        }
      }
      for (const ignore of ignores) {
        await ensureDirectoryWithinRoot(projectRoot, ignore.parent, {
          allowRootMapping: true,
          createMissing: false,
        });
        const current = await readManagedFileSnapshot(ignore.path, {
          allowMissing: true,
          label: "Git exclude metadata",
        });
        const expected = ignore.committedSnapshot ?? ignore.originalSnapshot;
        if (!sameManagedFileSnapshot(current, expected)) {
          throw new Error(`Git exclude metadata changed before workspace commit: ${ignore.path}`);
        }
      }
      await this.writeWorkspaceState(nextState, workspaceOriginal!);
      this.state = nextState;
      this.resourceCounter = nextResourceCounter;
      return resource;
    } catch (error) {
      const rollbackErrors = await this.rollbackSharedResourceCreation(
        journal,
        workspacePath,
        workspaceOriginal!,
      );
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          `Shared resource creation failed and rollback was incomplete: ${errorMessage(error)}`,
        );
      }
      throw error;
    }
  }

  private async preflightSharedResourceCreation(
    resource: SharedResourceMount,
  ): Promise<{ branches: SharedResourceBranchPlan[]; ignores: SharedResourceIgnorePlan[] }> {
    const projectRoot = this.requireProjectRoot();
    this.assertSharedResourceLexicalScope(resource);
    const sourceScope = this.assertSharedResourceCanonicalScope(resource, { allowMissing: true });
    if (sourceScope.sourceIsInsideProject) {
      await ensureDirectoryWithinRoot(projectRoot, resource.sourcePath, {
        allowRootMapping: true,
        createMissing: false,
      });
    } else {
      await assertCreatableDirectoryPath(resource.sourcePath);
    }
    const sourceStat = await lstatIfExists(resource.sourcePath);
    if (sourceStat && (!sourceStat.isDirectory() || sourceStat.isSymbolicLink())) {
      throw new Error(`Shared resource source must be an ordinary directory: ${resource.sourcePath}`);
    }

    const branches: SharedResourceBranchPlan[] = [];
    const ignoreInputs = new Map<
      string,
      {
        path: string;
        parent: string;
        originalSnapshot: ManagedFileSnapshot | undefined;
        patterns: Set<string>;
      }
    >();
    for (const workspace of this.state.branches) {
      if (workspace.repoId !== resource.repoId) continue;
      await ensureDirectoryWithinRoot(projectRoot, workspace.worktreePath, {
        allowRootMapping: true,
        createMissing: false,
      });
      const resolvedMount = path.join(workspace.worktreePath, resource.mountPath);
      const mountParent = path.dirname(resolvedMount);
      await ensureDirectoryWithinRoot(workspace.worktreePath, mountParent, {
        createMissing: false,
      });
      if (await lstatIfExists(resolvedMount)) {
        throw new Error(`Shared resource mount already exists: ${resolvedMount}`);
      }

      const excludePath = await gitPath(this.runGit, workspace.worktreePath, "info/exclude");
      const excludeParent = path.dirname(excludePath);
      await ensureDirectoryWithinRoot(projectRoot, excludeParent, {
        allowRootMapping: true,
        createMissing: false,
      });
      const originalSnapshot = await readManagedFileSnapshot(excludePath, {
        allowMissing: true,
        label: "Git exclude metadata",
      });
      const ignorePattern = normalizeIgnorePattern(resource.mountPath);
      const ignoreKey = managedPathKey(excludePath);
      const existingIgnore = ignoreInputs.get(ignoreKey);
      if (existingIgnore) {
        if (!sameManagedFileSnapshot(existingIgnore.originalSnapshot, originalSnapshot)) {
          throw new Error(`Git exclude metadata changed during preflight: ${excludePath}`);
        }
        existingIgnore.patterns.add(ignorePattern);
      } else {
        ignoreInputs.set(ignoreKey, {
          path: excludePath,
          parent: excludeParent,
          originalSnapshot,
          patterns: new Set([ignorePattern]),
        });
      }
      branches.push({
        workspace,
        mountPath: resolvedMount,
        mountParent,
        excludePath,
      });
    }

    return {
      branches,
      ignores: [...ignoreInputs.values()].map((ignore) => ({
        path: ignore.path,
        parent: ignore.parent,
        originalSnapshot: ignore.originalSnapshot,
        nextContent: appendUniqueLineContent(
          ignore.originalSnapshot?.content ?? "",
          [...ignore.patterns],
        ),
      })),
    };
  }

  private async createSharedResourceSource(
    resource: SharedResourceMount,
    createdDirectories: ManagedDirectoryOwnership[],
  ): Promise<void> {
    const projectRoot = this.requireProjectRoot();
    const sourceScope = this.assertSharedResourceCanonicalScope(resource, { allowMissing: true });
    if (sourceScope.sourceIsInsideProject) {
      await createDirectoryChainWithinRoot(
        projectRoot,
        resource.sourcePath,
        createdDirectories,
        { allowRootMapping: true },
      );
      await ensureDirectoryWithinRoot(projectRoot, resource.sourcePath, {
        allowRootMapping: true,
        createMissing: false,
      });
      return;
    }
    await createDirectoryChainFromNearestParent(resource.sourcePath, createdDirectories);
    await assertOrdinaryDirectory(
      resource.sourcePath,
      `Shared resource source must be an ordinary directory: ${resource.sourcePath}`,
    );
  }

  private async assertSharedResourceSource(resource: SharedResourceMount): Promise<void> {
    const projectRoot = this.requireProjectRoot();
    const sourceScope = this.assertSharedResourceCanonicalScope(resource);
    if (sourceScope.sourceIsInsideProject) {
      await ensureDirectoryWithinRoot(projectRoot, resource.sourcePath, {
        allowRootMapping: true,
        createMissing: false,
      });
    }
    await assertOrdinaryDirectory(
      resource.sourcePath,
      `Shared resource source must be an ordinary directory: ${resource.sourcePath}`,
    );
  }

  private async rollbackSharedResourceCreation(
    journal: SharedResourceTransactionJournal,
    workspacePath: string,
    workspaceOriginal: ManagedFileSnapshot,
  ): Promise<unknown[]> {
    const errors: unknown[] = [];
    await collectRollbackError(errors, async () => {
      const current = await readManagedFileSnapshot(workspacePath, {
        allowParentMapping: true,
        label: "Canvas workspace metadata",
        trustedRootBoundary: this.currentProjectRootBoundary(),
      });
      if (!sameManagedFileSnapshot(current, workspaceOriginal)) {
        throw new Error("Canvas workspace metadata changed concurrently during rollback");
      }
    });
    errors.push(...await this.rollbackSharedEffects(journal));
    return errors;
  }

  private async rollbackSharedEffects(
    journal: SharedResourceTransactionJournal,
  ): Promise<unknown[]> {
    const errors: unknown[] = [];
    for (const ignore of [...journal.writtenIgnores].reverse()) {
      await collectRollbackError(errors, async () => {
        const current = await readManagedFileSnapshot(ignore.path, {
          allowMissing: true,
          label: "Git exclude metadata",
        });
        if (sameManagedFileSnapshot(current, ignore.originalSnapshot)) return;
        if (!sameManagedFileSnapshot(current, ignore.committedSnapshot)) {
          throw new Error(`Git exclude metadata changed concurrently during rollback: ${ignore.path}`);
        }
        if (!ignore.originalSnapshot) {
          await removeManagedFile(ignore.path, {
            expectedContent: ignore.committedSnapshot!.content,
            expectedIdentity: ignore.committedSnapshot!.identity,
            label: "Git exclude metadata",
          });
        } else {
          await writeManagedFileAtomically(ignore.path, ignore.originalSnapshot.content, {
            label: "Git exclude metadata",
            expectedContent: ignore.committedSnapshot!.content,
            expectedIdentity: ignore.committedSnapshot!.identity,
          });
        }
      });
    }
    for (const mount of [...journal.createdMounts].reverse()) {
      await collectRollbackError(errors, () => removeManagedMount(mount));
    }
    for (const directory of [...journal.createdDirectories].reverse()) {
      await collectRollbackError(errors, () => removeCreatedDirectory(directory));
    }
    return errors;
  }

  branchOf(id: string | undefined): BranchWorkspace | undefined {
    return id ? this.state.branches.find((branch) => branch.id === id) : undefined;
  }

  branchByName(name: string | undefined): BranchWorkspace | undefined {
    return name ? this.state.branches.find((branch) => branch.branch === name) : undefined;
  }

  defaultBranch(): BranchWorkspace | undefined {
    return this.state.branches.find((branch) => branch.isDefault) ?? this.state.branches[0];
  }

  async diffBetweenBranches(
    fromBranch: string | undefined,
    toBranch: string | undefined,
  ): Promise<BranchDiffSummary | undefined> {
    if (!fromBranch || !toBranch) return undefined;
    return this.diffBranchRefs(fromBranch, toBranch, fromBranch, toBranch);
  }

  async diffPullRequestFiles(
    sourceBranch: string | undefined,
    targetBranch: string | undefined,
  ): Promise<BranchDiffSummary | undefined> {
    if (!sourceBranch || !targetBranch) return undefined;
    return this.diffBranchRefs(
      targetBranch,
      sourceBranch,
      `${targetBranch}...${sourceBranch}`,
    );
  }

  async ensurePullRequestBranchesReady(
    sourceBranch: string | undefined,
    targetBranch: string | undefined,
  ): Promise<void> {
    const source = sourceBranch?.trim();
    const target = targetBranch?.trim();
    if (!source || !target || source === target) return;
    await this.ensureProjectOpen();
    await this.loadStateIfNeeded();
    const repo = this.state.repo;
    if (!repo) return;
    await this.assertRepositoryGitBoundary(repo.localRepoPath);
    let targetRef = target;
    try {
      await this.runRepositoryGit(
        repo.localRepoPath,
        ["fetch", "origin", `+refs/heads/${target}:refs/remotes/origin/${target}`],
      );
      targetRef = `origin/${target}`;
    } catch (error) {
      if (error instanceof RepositoryGitBoundaryError) throw error;
      // Local-only targets can still be checked by branch name.
    }
    try {
      await this.runRepositoryGit(
        repo.localRepoPath,
        ["merge-base", "--is-ancestor", targetRef, source],
      );
    } catch (error) {
      if (error instanceof RepositoryGitBoundaryError) throw error;
      throw new Error(
        `source branch ${source} must include ${targetRef}; pull, merge, or rebase ${target} into ${source} before creating a PR flow`,
      );
    }
  }

  async changedFilesForCommit(
    commitRef: string | undefined,
    sourceBranch: string | undefined,
  ): Promise<Array<{ status: string; path: string }> | undefined> {
    const commit = commitRef?.trim();
    if (!commit) return undefined;
    await this.ensureProjectOpen();
    await this.loadStateIfNeeded();
    const repo = this.state.repo;
    if (!repo) return undefined;
    await this.assertRepositoryGitBoundary(repo.localRepoPath);
    const branch = sourceBranch?.trim();
    if (branch) {
      try {
        await this.runRepositoryGit(
          repo.localRepoPath,
          ["fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
        );
      } catch (error) {
        if (error instanceof RepositoryGitBoundaryError) throw error;
        // The commit may already exist locally, or sourceBranch may be local-only.
      }
    }
    try {
      const output = await this.runRepositoryGit(
        repo.localRepoPath,
        ["show", "--format=", "--name-status", "--find-renames", commit],
      );
      return output
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean)
        .map(parseDiffNameStatus);
    } catch (error) {
      if (error instanceof RepositoryGitBoundaryError) throw error;
      return [];
    }
  }

  private async diffBranchRefs(
    fromBranch: string | undefined,
    toBranch: string | undefined,
    ...refs: string[]
  ): Promise<BranchDiffSummary | undefined> {
    await this.ensureProjectOpen();
    await this.loadStateIfNeeded();
    const repo = this.state.repo;
    if (!repo || !fromBranch || !toBranch || fromBranch === toBranch) return undefined;
    await this.assertRepositoryGitBoundary(repo.localRepoPath);
    try {
      const output = await this.runRepositoryGit(
        repo.localRepoPath,
        ["diff", "--name-status", ...refs],
      );
      return {
        fromBranch,
        toBranch,
        files: output
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .filter(Boolean)
          .map(parseDiffNameStatus),
      };
    } catch (error) {
      if (error instanceof RepositoryGitBoundaryError) throw error;
      return { fromBranch, toBranch, files: [] };
    }
  }

  async prepareAgentWorkspace(
    agentId: string,
    config: Pick<AgentStartConfig, "cwd" | "branchWorkspaceId"> | undefined,
    options: WorkDocumentationOptions = {},
  ): Promise<string | undefined> {
    const workspace = this.branchOf(config?.branchWorkspaceId);
    const cwd = workspace?.worktreePath ?? config?.cwd;
    if (!cwd) return undefined;
    const scratchDirectory = path.join(cwd, ".agent-tmp", agentId);
    if (!workspace) {
      await mkdir(scratchDirectory, { recursive: true });
      return scratchDirectory;
    }

    // Capture the project synchronously so a queued operation cannot accidentally bind a
    // reused branch id to a different project before it enters the mutation chain.
    const workspaceContext = this.captureWorkDocumentationContext(workspace);
    return await this.queueProjectMutation(async () => {
      this.assertWorkDocumentationContextCurrent(workspaceContext);
      await this.validateWorkspaceRootMapping(workspaceContext);
      this.assertWorkDocumentationContextCurrent(workspaceContext);
      await mkdir(scratchDirectory, { recursive: true });
      await this.ensureIgnored(workspace, [".agent-tmp/"]);
      this.assertWorkDocumentationContextCurrent(workspaceContext);
      if (options.workDocumentationEnabled) {
        await this.queueWorkDocumentation(() =>
          this.ensureWorkDocumentation(workspaceContext),
        );
      }
      this.assertWorkDocumentationContextCurrent(workspaceContext);
      return scratchDirectory;
    });
  }

  async prepareWorkDocumentationForAllBranches(
    expectedRevision?: WorkspaceProjectRevision,
  ): Promise<void> {
    await this.queueProjectMutation(async () => {
      await this.ensureProjectOpen();
      const revision = expectedRevision ?? this.captureProjectRevision();
      this.assertProjectRevision(revision);
      await this.loadStateIfNeeded();
      this.assertProjectRevision(revision);
      const contexts = this.state.branches.map((workspace) =>
        this.captureWorkDocumentationContext(workspace, revision),
      );
      await this.queueWorkDocumentation(async () => {
        this.assertProjectRevision(revision);
        for (const context of contexts) {
          await this.ensureWorkDocumentation(context);
        }
        this.assertProjectRevision(revision);
      });
    });
  }

  private resetWorkDocumentationPreparation(): void {
    this.preparedWorkDocumentation.clear();
  }

  accessForAgent(
    config:
      | Pick<AgentStartConfig, "branchWorkspaceId" | "allowSharedResourceWrites">
      | undefined,
    options: WorkDocumentationOptions = {},
  ): AgentFileAccess {
    const workspace = this.branchOf(config?.branchWorkspaceId);
    if (!workspace) {
      return {
        readableFiles: [],
        readableDirectories: [],
        writableFiles: [],
        writableDirectories: [],
        sharedResources: [],
      };
    }
    const resources = this.state.sharedResources.filter(
      (resource) => resource.repoId === workspace.repoId,
    );
    const allowSharedResourceWrites = config?.allowSharedResourceWrites === true;
    const writableSourcePaths = new Map<string, string>();
    for (const resource of resources) {
      if (resource.access === "readWrite" || allowSharedResourceWrites) {
        writableSourcePaths.set(
          resource.id,
          this.assertAgentSharedWriteScope(resource, workspace),
        );
      }
    }
    const agentAuthorizedSharedDirectories = resources
      .filter((resource) => allowSharedResourceWrites && resource.access === "readOnly")
      .map((resource) => writableSourcePaths.get(resource.id)!);
    const sharedResources: AgentSharedResourceReference[] = resources.map((resource) => ({
      name: resource.name,
      mountPath: path.join(workspace.worktreePath, resource.mountPath),
      sourcePath: writableSourcePaths.get(resource.id) ?? resource.sourcePath,
      access: allowSharedResourceWrites ? "readWrite" : resource.access,
    }));
    const documentationContext = options.workDocumentationEnabled
      ? this.captureWorkDocumentationContext(workspace)
      : undefined;
    const documentation =
      documentationContext &&
      this.preparedWorkDocumentation.has(
        this.workDocumentationPreparationKey(documentationContext),
      )
        ? this.workDocumentationPaths(documentationContext)
        : undefined;
    if (documentation) {
      sharedResources.push({
        name: "Agent Canvas 当前 branch 共享概要",
        mountPath: documentation.branchMountDirectory,
        sourcePath: documentation.branchSourceDirectory,
        access: "readWrite",
      });
    }
    return {
      readableFiles: documentation
        ? [
            {
              name: "branch-work-documentation-index.md",
              path: documentation.isolatedIndex,
              previewKind: "markdown",
            },
            {
              name: "shared-work-documentation-index.md",
              path: documentation.sharedIndex,
              previewKind: "markdown",
            },
          ]
        : [],
      readableDirectories: [
        ...resources.map((resource) => resource.sourcePath),
        ...(documentation
          ? [
              documentation.isolatedDirectory,
              documentation.sharedMountDirectory,
            ]
          : []),
      ],
      writableFiles: [],
      sandboxWritableDirectories: documentation
        ? [
            documentation.isolatedDirectory,
            documentation.branchSourceDirectory,
            documentation.branchMountDirectory,
            ...agentAuthorizedSharedDirectories,
          ]
        : agentAuthorizedSharedDirectories,
      writableDirectories: [
        ...resources
          .filter((resource) => resource.access === "readWrite")
          .map((resource) => writableSourcePaths.get(resource.id)!),
      ],
      sharedResources,
    };
  }

  private assertSharedResourceLexicalScope(resource: SharedResourceMount): void {
    const projectRoot = resolveSharedResourceSourcePath(this.requireProjectRoot());
    const sourcePath = resolveSharedResourceSourcePath(resource.sourcePath);
    const repoSharedRoot = path.join(projectRoot, "shared", resource.repoId);
    if (
      (isPathWithin(sourcePath, projectRoot) &&
        !isPathStrictlyWithin(sourcePath, repoSharedRoot)) ||
      isPathWithin(projectRoot, sourcePath)
    ) {
      throw new Error(
        `Shared resource is too broad for Agent-level write access: ${resource.sourcePath}`,
      );
    }
  }

  private assertSharedResourceCanonicalScope(
    resource: SharedResourceMount,
    options: { allowMissing?: boolean; requireWritableIdentity?: boolean } = {},
  ): { sourcePath: string; sourceIsInsideProject: boolean } {
    this.assertSharedResourceLexicalScope(resource);
    const projectRoot = resolveSharedResourceSourcePath(this.requireProjectRoot());
    const projectBoundary = this.currentProjectRootBoundary();
    assertManagedTrustedRootBoundarySync(projectBoundary, "Canvas project root");
    const realProjectRoot = path.resolve(projectBoundary.realPath);
    const repoSharedRoot = path.join(projectRoot, "shared", resource.repoId);
    const realRepoSharedRoot = path.join(
      realProjectRoot,
      path.relative(projectRoot, repoSharedRoot),
    );
    const sourceLogicalPath = resolveSharedResourceSourcePath(resource.sourcePath);
    const requiresVerifiedWritableIdentity =
      resource.access === "readWrite" || options.requireWritableIdentity === true;
    if (
      requiresVerifiedWritableIdentity &&
      process.platform === "win32" &&
      !isPathWithinCaseSensitive(sourceLogicalPath, projectRoot)
    ) {
      assertExternalWindowsSharedResourceRoot(sourceLogicalPath, projectRoot, realProjectRoot);
    }
    const source = inspectSharedResourceDirectorySync(resource.sourcePath, options);
    if (requiresVerifiedWritableIdentity && process.platform === "linux") {
      assertLinuxSharedResourceMountTree(source.realPath, realProjectRoot);
    }
    const projectRootInspection = inspectSharedResourceDirectorySync(projectRoot, {
      allowFinalMapping: true,
    });
    const projectIdentity = projectRootInspection.finalIdentity;
    const sourceIsInsideProject = Boolean(
      projectIdentity &&
        source.ancestors.some((ancestor) =>
          sameSharedResourceIdentity(ancestor.identity, projectIdentity),
        ),
    );
    if (
      requiresVerifiedWritableIdentity &&
      (!projectIdentity || !isComparableFileIdentity(projectIdentity))
    ) {
      throw new Error(`Canvas project filesystem identity cannot be verified safely: ${projectRoot}`);
    }

    if (
      requiresVerifiedWritableIdentity &&
      process.platform === "win32" &&
      !sourceIsInsideProject
    ) {
      assertExternalWindowsSharedResourceRoot(sourceLogicalPath, projectRoot, realProjectRoot);
    }

    if (requiresVerifiedWritableIdentity && !sourceIsInsideProject) {
      const deepestSourceAncestor = source.ancestors.at(-1);
      if (
        !deepestSourceAncestor ||
        !isComparableFileIdentity(deepestSourceAncestor.identity) ||
        !projectIdentity
      ) {
        throw new Error(
          `Shared resource filesystem identity cannot be verified safely: ${resource.sourcePath}`,
        );
      }
      if (
        process.platform === "win32" &&
        (source.ancestors.some((ancestor) => isWindowsUncPath(ancestor.realPath)) ||
          deepestSourceAncestor.identity.dev !== projectIdentity.dev)
      ) {
        throw new Error(
          `External Windows shared resource must use the trusted project volume: ${resource.sourcePath}`,
        );
      }
    }

    if (
      (isPathWithin(source.realPath, realProjectRoot) &&
        !isPathStrictlyWithin(source.realPath, realRepoSharedRoot)) ||
      isPathWithin(realProjectRoot, source.realPath)
    ) {
      throw new Error(
        `Shared resource is too broad for Agent-level write access: ${resource.sourcePath}`,
      );
    }

    assertSharedResourceMappingsMatchProjectBoundary(
      source,
      projectRootInspection,
      sourceIsInsideProject,
    );

    const protectedAncestors = uniqueSharedResourceAncestors([
      ...projectRootInspection.ancestors,
      ...inspectSharedResourceDirectorySync(path.join(projectRoot, "shared"), {
        allowMissing: true,
        allowFinalMapping: true,
      }).ancestors,
      ...inspectSharedResourceDirectorySync(repoSharedRoot, {
        allowMissing: true,
        allowFinalMapping: true,
      }).ancestors,
      ...inspectSharedResourceDirectorySync(realProjectRoot, {
        allowFinalMapping: true,
      }).ancestors,
      ...inspectSharedResourceDirectorySync(path.join(realProjectRoot, "shared"), {
        allowMissing: true,
        allowFinalMapping: true,
      }).ancestors,
      ...inspectSharedResourceDirectorySync(realRepoSharedRoot, {
        allowMissing: true,
        allowFinalMapping: true,
      }).ancestors,
    ]);
    for (const sourceAncestor of source.ancestors) {
      const protectedAlias = protectedAncestors.find(
        (protectedAncestor) =>
          sameSharedResourceIdentity(sourceAncestor.identity, protectedAncestor.identity) &&
          !sameFileSystemPath(sourceAncestor.logicalPath, protectedAncestor.logicalPath) &&
          !(
            sourceIsInsideProject &&
            isTrustedSharedResourceBoundaryAlias(
              sourceAncestor,
              protectedAncestor,
              source.mappings,
            )
          ),
      );
      if (protectedAlias) {
        throw new Error(
          `Shared resource path aliases a protected project directory: ${sourceAncestor.logicalPath}`,
        );
      }
    }

    const overlappingOtherRepoResource = this.state.sharedResources.find((candidate) => {
      if (candidate.repoId === resource.repoId) return false;
      const candidateLogicalPath = resolveSharedResourceSourcePath(candidate.sourcePath);
      if (
        requiresVerifiedWritableIdentity &&
        process.platform === "win32" &&
        !isPathWithinCaseSensitive(candidateLogicalPath, projectRoot)
      ) {
        assertExternalWindowsSharedResourceRoot(
          candidateLogicalPath,
          projectRoot,
          realProjectRoot,
        );
      }
      const candidateSource = inspectSharedResourceDirectorySync(candidate.sourcePath);
      const candidateIsInsideProject = Boolean(
        projectIdentity &&
          candidateSource.ancestors.some((ancestor) =>
            sameSharedResourceIdentity(ancestor.identity, projectIdentity),
          ),
      );
      if (
        requiresVerifiedWritableIdentity &&
        !candidateIsInsideProject
      ) {
        if (process.platform === "win32") {
          assertExternalWindowsSharedResourceRoot(
            candidateLogicalPath,
            projectRoot,
            realProjectRoot,
          );
        }
      }
      if (requiresVerifiedWritableIdentity) {
        assertSharedResourceMappingsMatchProjectBoundary(
          candidateSource,
          projectRootInspection,
          candidateIsInsideProject,
        );
        if (process.platform === "linux") {
          assertLinuxSharedResourceMountTree(candidateSource.realPath, realProjectRoot);
        }
        assertSharedResourceOverlapCandidateComparable(
          candidate,
          candidateSource,
          projectIdentity!,
        );
      }
      return (
        isPathWithin(candidateSource.realPath, source.realPath) ||
        isPathWithin(source.realPath, candidateSource.realPath) ||
        sharedResourceInspectionsOverlapByIdentity(source, candidateSource)
      );
    });
    if (overlappingOtherRepoResource) {
      throw new Error(
        `Shared resource contains another repo resource and cannot be Agent-writable: ${resource.sourcePath}`,
      );
    }
    return { sourcePath: source.realPath, sourceIsInsideProject };
  }

  private assertAgentSharedWriteScope(
    resource: SharedResourceMount,
    workspace: BranchWorkspace,
  ): string {
    if (resource.repoId !== workspace.repoId) {
      throw new Error(`Shared resource does not belong to Agent workspace: ${resource.sourcePath}`);
    }
    const sourcePath = this.assertSharedResourceCanonicalScope(resource, {
      requireWritableIdentity: true,
    }).sourcePath;
    assertSharedResourceMountSync(workspace, resource, sourcePath);
    return sourcePath;
  }

  resolveAgentSettings<T extends { branchWorkspaceId?: string; cwd?: string; branch?: string }>(
    settings: T,
  ): T {
    const workspace =
      this.branchOf(settings.branchWorkspaceId) ??
      this.branchByName(settings.branch) ??
      (settings.branchWorkspaceId || settings.branch ? undefined : this.defaultBranch());
    if (!workspace) return settings;
    return {
      ...settings,
      branchWorkspaceId: workspace.id,
      branch: workspace.branch,
      cwd: workspace.worktreePath,
    };
  }

  private async selectProject(
    project: CanvasProjectSummary,
    state?: WorkspaceState,
    boundary?: ProjectRootBoundary,
  ): Promise<void> {
    const resolvedRoot = path.resolve(project.projectRoot);
    const selectedBoundary = boundary ?? await captureProjectRootBoundary(resolvedRoot);
    await assertProjectRootBoundary(resolvedRoot, selectedBoundary);
    this.advanceProjectGeneration();
    this.currentProject = { ...project, projectRoot: resolvedRoot };
    this.projectRoot = this.currentProject.projectRoot;
    this.projectRootBoundary = selectedBoundary;
    this.state = state ?? { branches: [], sharedResources: [] };
    this.stateLoaded = state !== undefined;
    this.branchCounter = maxNumericSuffix(this.state.branches.map((branch) => branch.id));
    this.resourceCounter = maxNumericSuffix(
      this.state.sharedResources.map((resource) => resource.id),
    );
  }

  private clearSelectedProject(): void {
    this.projectRootBoundary = undefined;
    this.projectRoot = undefined;
    this.currentProject = undefined;
    this.state = { branches: [], sharedResources: [] };
    this.stateLoaded = false;
    this.branchCounter = 0;
    this.resourceCounter = 0;
  }

  private async ensureProjectOpen(): Promise<void> {
    if (this.projectRoot && this.currentProject) {
      let stat = await lstatIfExists(this.projectRoot);
      if (!stat) {
        await mkdir(this.projectRoot, { recursive: true });
        stat = await lstat(this.projectRoot);
      }
      if (!this.projectRootBoundary) {
        this.projectRootBoundary = await captureProjectRootBoundary(this.projectRoot);
      } else {
        await assertProjectRootBoundary(this.projectRoot, this.projectRootBoundary);
      }
      return;
    }
    throw new Error("尚未打开 canvas 项目");
  }

  async validateCurrentProjectRoot(): Promise<void> {
    await this.ensureProjectOpen();
    if (!this.projectRootBoundary) {
      throw new Error(`Canvas project root does not exist: ${this.requireProjectRoot()}`);
    }
    await assertProjectRootBoundary(this.requireProjectRoot(), this.projectRootBoundary);
  }

  currentProjectRootBoundary(): ManagedTrustedRootBoundary {
    if (!this.projectRootBoundary) {
      throw new Error(`Canvas project root boundary is unavailable: ${this.requireProjectRoot()}`);
    }
    return {
      ...this.projectRootBoundary,
      logicalIdentity: { ...this.projectRootBoundary.logicalIdentity },
      realIdentity: { ...this.projectRootBoundary.realIdentity },
    };
  }

  currentProjectRootBoundaryIfAvailable(): ManagedTrustedRootBoundary | undefined {
    return this.projectRootBoundary ? this.currentProjectRootBoundary() : undefined;
  }

  private async ensureProjectsRootBoundary(): Promise<ManagedTrustedRootBoundary> {
    if (this.projectsRootBoundary) {
      await assertManagedTrustedRootBoundary(
        this.projectsRootBoundary,
        "Canvas projects root",
      );
      return this.projectsRootBoundary;
    }
    await assertOrdinaryExistingAncestorChain(this.projectsRoot, "Canvas projects root");
    if (!await lstatIfExists(this.projectsRoot)) {
      await createDirectoryChainFromNearestParent(this.projectsRoot, []);
    }
    await ensureDirectoryWithinRoot(path.parse(this.projectsRoot).root, this.projectsRoot, {
      createMissing: false,
    });
    this.projectsRootBoundary = await captureManagedTrustedRootBoundary(
      this.projectsRoot,
      "Canvas projects root",
    );
    if (this.projectsRootBoundary.logicalMapping) {
      this.projectsRootBoundary = undefined;
      throw new ManagedFileSafetyError(
        `Canvas projects root must be an ordinary directory: ${this.projectsRoot}`,
      );
    }
    return this.projectsRootBoundary;
  }

  private requireProjectRoot(): string {
    if (!this.projectRoot) throw new Error("尚未打开 canvas 项目");
    return this.projectRoot;
  }

  private async loadStateIfNeeded(): Promise<void> {
    if (this.stateLoaded) {
      await validateRelocatedWorkspaceRoots(this.requireProjectRoot(), this.state);
      return;
    }
    const projectRoot = this.requireProjectRoot();
    const workspaceSnapshot = await readManagedFileSnapshot(this.statePath(), {
      allowMissing: true,
      allowParentMapping: true,
      label: "Canvas workspace metadata",
      trustedRootBoundary: this.currentProjectRootBoundary(),
    });
    if (!workspaceSnapshot) {
      this.state = { project: this.currentProject, branches: [], sharedResources: [] };
      this.branchCounter = 0;
      this.resourceCounter = 0;
      this.stateLoaded = true;
      return;
    }
    const document = await this.readWorkspaceDocument(projectRoot, workspaceSnapshot);
    const relocated = relocateWorkspace(document, projectRoot, {
      requireExternalTrust: !sameExistingDirectoryIdentitySync(
        document.project.projectRoot,
        projectRoot,
      ),
    });
    await validateRelocatedWorkspaceRoots(projectRoot, relocated.state);
    this.currentProject = relocated.project;
    this.state = relocated.state;
    this.branchCounter = maxNumericSuffix(this.state.branches.map((branch) => branch.id));
    this.resourceCounter = maxNumericSuffix(
      this.state.sharedResources.map((resource) => resource.id),
    );
    this.stateLoaded = true;
  }

  private async preflightMutableProjectMetadata(): Promise<void> {
    const projectsRootBoundary = await this.ensureProjectsRootBoundary();
    await Promise.all([
      readManagedFileSnapshot(this.statePath(), {
        allowMissing: true,
        allowParentMapping: true,
        label: "Canvas workspace metadata",
        trustedRootBoundary: this.currentProjectRootBoundary(),
      }),
      readManagedFileSnapshot(this.projectIndexPath(), {
        allowMissing: true,
        label: "Canvas project index",
        trustedRootBoundary: projectsRootBoundary,
      }),
    ]);
  }

  private async saveState(state: WorkspaceState = this.state): Promise<void> {
    const projectsRootBoundary = await this.ensureProjectsRootBoundary();
    const [workspaceSnapshot, indexSnapshot] = await Promise.all([
      readManagedFileSnapshot(this.statePath(), {
        allowMissing: true,
        allowParentMapping: true,
        label: "Canvas workspace metadata",
        trustedRootBoundary: this.currentProjectRootBoundary(),
      }),
      readManagedFileSnapshot(this.projectIndexPath(), {
        allowMissing: true,
        label: "Canvas project index",
        trustedRootBoundary: projectsRootBoundary,
      }),
    ]);
    state.project = this.currentProject;
    const committedWorkspace = await this.writeWorkspaceState(
      state,
      workspaceSnapshot ?? null,
    );
    if (!this.currentProject) return;
    try {
      const index = parseProjectIndex(indexSnapshot?.content);
      const projects = [
        this.currentProject,
        ...index.projects.filter(
          (candidate) =>
            candidate.id !== this.currentProject!.id &&
            normalizedRootKey(candidate.projectRoot) !==
              normalizedRootKey(this.currentProject!.projectRoot),
        ),
      ];
      await this.writeProjectIndex(projects, indexSnapshot ?? null);
    } catch (error) {
      try {
        if (workspaceSnapshot) {
          await writeManagedFileAtomically(this.statePath(), workspaceSnapshot.content, {
            allowParentMapping: true,
            label: "Canvas workspace metadata",
            trustedRootBoundary: this.currentProjectRootBoundary(),
            expectedContent: committedWorkspace.content,
            expectedIdentity: committedWorkspace.identity,
          });
        } else {
          await removeManagedFile(this.statePath(), {
            allowParentMapping: true,
            trustedRootBoundary: this.currentProjectRootBoundary(),
            expectedContent: committedWorkspace.content,
            expectedIdentity: committedWorkspace.identity,
            label: "Canvas workspace metadata",
          });
        }
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `Canvas metadata persistence failed and workspace rollback was incomplete: ${errorMessage(error)}`,
        );
      }
      throw error;
    }
  }

  private workspaceDocument(state: WorkspaceState): WorkspaceDocument {
    return {
      schema: WORKSPACE_SCHEMA,
      version: WORKSPACE_VERSION,
      project: this.currentProject!,
      repo: state.repo,
      branches: state.branches,
      sharedResources: state.sharedResources,
    };
  }

  private async writeWorkspaceState(
    state: WorkspaceState,
    expectedSnapshot?: ManagedFileSnapshot | null,
  ): Promise<ManagedFileSnapshot> {
    await this.validateCurrentProjectRoot();
    const written = await writeManagedFileAtomically(
      this.statePath(),
      this.workspaceStateContent(state),
      {
        allowParentMapping: true,
        label: "Canvas workspace metadata",
        trustedRootBoundary: this.currentProjectRootBoundary(),
        ...(expectedSnapshot !== undefined
          ? {
              expectedContent: expectedSnapshot?.content,
              expectedIdentity: expectedSnapshot?.identity,
            }
          : {}),
      },
    );
    return written;
  }

  private workspaceStateContent(state: WorkspaceState): string {
    return `${JSON.stringify(this.workspaceDocument(state), undefined, 2)}\n`;
  }

  private statePath(): string {
    return path.join(this.requireProjectRoot(), WORKSPACE_STATE_FILE);
  }

  private snapshot(): WorkspaceProject {
    return {
      canvasProject: this.currentProject,
      revision: this.projectGeneration,
      projectRoot: this.requireProjectRoot(),
      repo: this.state.repo,
      branches: [...this.state.branches],
      sharedResources: [...this.state.sharedResources],
    };
  }

  private requireRepo(): GitHubConnection {
    if (!this.state.repo) throw new Error("尚未连接 GitHub 仓库");
    return this.state.repo;
  }

  private localRepoPath(repoId: string): string {
    return path.join(this.requireProjectRoot(), "repos", repoId, "repo");
  }

  private branchWorktreePath(repoId: string, branch: string): string {
    return path.join(this.requireProjectRoot(), "worktrees", repoId, safePathPart(branch));
  }

  private async assertRepositoryGitBoundary(
    repositoryPath: string,
    expected?: RepositoryGitBoundary,
  ): Promise<RepositoryGitBoundary> {
    try {
      await this.validateCurrentProjectRoot();
      const projectRoot = this.requireProjectRoot();
      const resolvedRepositoryPath = path.resolve(repositoryPath);
      await ensureDirectoryWithinRoot(projectRoot, resolvedRepositoryPath, {
        allowRootMapping: true,
        createMissing: false,
      });
      const repositoryBefore = await lstatIfExists(resolvedRepositoryPath);
      if (!repositoryBefore?.isDirectory() || repositoryBefore.isSymbolicLink()) {
        throw new Error(`Repository root must be an ordinary directory: ${resolvedRepositoryPath}`);
      }
      const gitPath = path.join(resolvedRepositoryPath, ".git");
      const gitBefore = await lstatIfExists(gitPath);
      if (!gitBefore?.isDirectory() || gitBefore.isSymbolicLink()) {
        throw new Error(`Repository .git must be an ordinary directory: ${gitPath}`);
      }
      const [realProjectRoot, realRepositoryPath, realGitPath] = await Promise.all([
        realpath(projectRoot),
        realpath(resolvedRepositoryPath),
        realpath(gitPath),
      ]);
      if (!isPathInside(realRepositoryPath, realProjectRoot)) {
        throw new Error(`Repository root resolves outside the Canvas project: ${repositoryPath}`);
      }
      if (
        !isPathInside(realGitPath, realRepositoryPath) ||
        !isPathInside(realGitPath, realProjectRoot)
      ) {
        throw new Error(`Repository .git resolves outside the repository: ${gitPath}`);
      }
      const [repositoryAfter, gitAfter] = await Promise.all([
        lstatIfExists(resolvedRepositoryPath),
        lstatIfExists(gitPath),
      ]);
      if (
        !repositoryAfter?.isDirectory() ||
        repositoryAfter.isSymbolicLink() ||
        !sameFileIdentity(repositoryBefore, repositoryAfter)
      ) {
        throw new Error(`Repository root changed during validation: ${resolvedRepositoryPath}`);
      }
      if (
        !gitAfter?.isDirectory() ||
        gitAfter.isSymbolicLink() ||
        !sameFileIdentity(gitBefore, gitAfter)
      ) {
        throw new Error(`Repository .git changed during validation: ${gitPath}`);
      }
      const boundary: RepositoryGitBoundary = {
        repositoryIdentity: { dev: repositoryAfter.dev, ino: repositoryAfter.ino },
        gitIdentity: { dev: gitAfter.dev, ino: gitAfter.ino },
        realRepositoryPath,
        realGitPath,
      };
      if (
        expected &&
        (expected.repositoryIdentity.dev !== boundary.repositoryIdentity.dev ||
          expected.repositoryIdentity.ino !== boundary.repositoryIdentity.ino ||
          expected.gitIdentity.dev !== boundary.gitIdentity.dev ||
          expected.gitIdentity.ino !== boundary.gitIdentity.ino ||
          !sameFileSystemPath(expected.realRepositoryPath, boundary.realRepositoryPath) ||
          !sameFileSystemPath(expected.realGitPath, boundary.realGitPath))
      ) {
        throw new Error(`Repository Git boundary changed while Git was running: ${repositoryPath}`);
      }
      return boundary;
    } catch (error) {
      if (error instanceof RepositoryGitBoundaryError) throw error;
      throw new RepositoryGitBoundaryError(repositoryPath, error);
    }
  }

  private async runRepositoryGit(repositoryPath: string, args: string[]): Promise<string> {
    const boundary = await this.assertRepositoryGitBoundary(repositoryPath);
    let output: string;
    try {
      output = await this.runGit(args, { cwd: repositoryPath });
    } catch (error) {
      await this.assertRepositoryGitBoundary(repositoryPath, boundary);
      throw error;
    }
    await this.assertRepositoryGitBoundary(repositoryPath, boundary);
    return output;
  }

  private async branchStartPoint(
    repo: GitHubConnection,
    branch: string,
    baseBranch: string,
  ): Promise<string> {
    await this.assertRepositoryGitBoundary(repo.localRepoPath);
    try {
      await this.runRepositoryGit(
        repo.localRepoPath,
        ["fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
      );
      return `origin/${branch}`;
    } catch (error) {
      if (error instanceof RepositoryGitBoundaryError) throw error;
      // New local branch: prefer the selected base branch's remote ref when it exists.
    }
    try {
      await this.runRepositoryGit(
        repo.localRepoPath,
        ["fetch", "origin", `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`],
      );
      return `origin/${baseBranch}`;
    } catch (error) {
      if (error instanceof RepositoryGitBoundaryError) throw error;
      return baseBranch;
    }
  }

  private async remoteBranches(cwd: string): Promise<string[]> {
    try {
      const output = await this.runGit(["ls-remote", "--heads", "origin"], { cwd });
      return output
        .split(/\r?\n/u)
        .map((line) => line.match(/refs\/heads\/(.+)$/u)?.[1])
        .filter((branch): branch is string => !!branch)
        .map((branch) => branch.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  private async applySharedResourcesToNewBranch(
    workspace: BranchWorkspace,
    journal: SharedResourceTransactionJournal,
  ): Promise<void> {
    const projectRoot = this.requireProjectRoot();
    await ensureDirectoryWithinRoot(projectRoot, workspace.worktreePath, {
      allowRootMapping: true,
      createMissing: false,
    });
    await ensureDirectoryWithinRoot(workspace.worktreePath, workspace.scratchRoot, {
      createMissing: false,
    });
    const plans: Array<{
      resource: SharedResourceMount;
      mountPath: string;
      mountParent: string;
      ownership?: ManagedMountOwnership;
    }> = [];
    for (const resource of this.state.sharedResources) {
      if (resource.repoId !== workspace.repoId) continue;
      await this.assertSharedResourceSource(resource);
      await ensureDirectoryWithinRoot(projectRoot, workspace.worktreePath, {
        allowRootMapping: true,
        createMissing: false,
      });
      const mountPath = path.join(workspace.worktreePath, resource.mountPath);
      const mountParent = path.dirname(mountPath);
      await ensureDirectoryWithinRoot(workspace.worktreePath, mountParent, {
        createMissing: false,
      });
      await assertLinkCanPointTo(resource.sourcePath, mountPath);
      plans.push({ resource, mountPath, mountParent });
    }

    const excludePath = await gitPath(this.runGit, workspace.worktreePath, "info/exclude");
    const excludeParent = path.dirname(excludePath);
    await ensureDirectoryWithinRoot(projectRoot, excludeParent, {
      allowRootMapping: true,
      createMissing: false,
    });
    const originalSnapshot = await readManagedFileSnapshot(excludePath, {
      allowMissing: true,
      label: "Git exclude metadata",
    });
    const ignore: SharedResourceIgnorePlan = {
      path: excludePath,
      parent: excludeParent,
      originalSnapshot,
      nextContent: appendUniqueLineContent(
        originalSnapshot?.content ?? "",
        [".agent-tmp/", ...plans.map((plan) => plan.resource.mountPath)].map(
          normalizeIgnorePattern,
        ),
      ),
    };

    await createDirectoryChainWithinRoot(
      workspace.worktreePath,
      workspace.scratchRoot,
      journal.createdDirectories,
    );
    await ensureDirectoryWithinRoot(projectRoot, workspace.scratchRoot, {
      allowRootMapping: true,
      createMissing: false,
    });

    for (const plan of plans) {
      await this.assertSharedResourceSource(plan.resource);
      await ensureDirectoryWithinRoot(projectRoot, workspace.worktreePath, {
        allowRootMapping: true,
        createMissing: false,
      });
      await ensureDirectoryWithinRoot(workspace.worktreePath, plan.mountParent, {
        createMissing: false,
      });
      await createDirectoryChainWithinRoot(
        workspace.worktreePath,
        plan.mountParent,
        journal.createdDirectories,
      );
      await ensureDirectoryWithinRoot(projectRoot, workspace.worktreePath, {
        allowRootMapping: true,
        createMissing: false,
      });
      const ownership = await ensureManagedLink(
        plan.resource.sourcePath,
        plan.mountPath,
      );
      if (ownership) {
        plan.ownership = ownership;
        journal.createdMounts.push(ownership);
      }
      await this.assertSharedResourceSource(plan.resource);
      await ensureDirectoryWithinRoot(projectRoot, workspace.worktreePath, {
        allowRootMapping: true,
        createMissing: false,
      });
      await ensureDirectoryWithinRoot(workspace.worktreePath, plan.mountParent, {
        createMissing: false,
      });
      await assertExistingLinkPointsTo(plan.resource.sourcePath, plan.mountPath);
    }

    const currentExcludePath = await gitPath(
      this.runGit,
      workspace.worktreePath,
      "info/exclude",
    );
    if (!sameFileSystemPath(currentExcludePath, excludePath)) {
      throw new Error(`Git exclude path changed during branch creation: ${workspace.branch}`);
    }
    await createDirectoryChainWithinRoot(
      projectRoot,
      excludeParent,
      journal.createdDirectories,
      { allowRootMapping: true },
    );
    if (ignore.nextContent === originalSnapshot?.content) {
      const current = await readManagedFileSnapshot(excludePath, {
        allowMissing: true,
        label: "Git exclude metadata",
      });
      if (!sameManagedFileSnapshot(current, originalSnapshot)) {
        throw new Error(`Git exclude metadata changed during branch creation: ${excludePath}`);
      }
    } else {
      journal.writtenIgnores.push(ignore);
      ignore.committedSnapshot = await writeManagedFileAtomically(
        excludePath,
        ignore.nextContent,
        {
          label: "Git exclude metadata",
          expectedContent: originalSnapshot?.content,
          expectedIdentity: originalSnapshot?.identity,
        },
      );
    }

    await ensureDirectoryWithinRoot(projectRoot, workspace.worktreePath, {
      allowRootMapping: true,
      createMissing: false,
    });
    for (const plan of plans) {
      await this.assertSharedResourceSource(plan.resource);
      await ensureDirectoryWithinRoot(workspace.worktreePath, plan.mountParent, {
        createMissing: false,
      });
      if (plan.ownership) await assertManagedMountOwnership(plan.ownership);
      await assertExistingLinkPointsTo(plan.resource.sourcePath, plan.mountPath);
    }
    const finalExcludePath = await gitPath(
      this.runGit,
      workspace.worktreePath,
      "info/exclude",
    );
    if (!sameFileSystemPath(finalExcludePath, excludePath)) {
      throw new Error(`Git exclude path changed before branch commit: ${workspace.branch}`);
    }
    const currentIgnore = await readManagedFileSnapshot(excludePath, {
      allowMissing: true,
      label: "Git exclude metadata",
    });
    if (!sameManagedFileSnapshot(currentIgnore, ignore.committedSnapshot ?? originalSnapshot)) {
      throw new Error(`Git exclude metadata changed before branch commit: ${excludePath}`);
    }
  }

  private async removeCreatedWorktree(
    ownership: ManagedWorktreeOwnership,
  ): Promise<void> {
    const before = await lstatIfExists(ownership.path);
    if (!before) {
      if (ownership.registered) {
        await this.runRepositoryGit(
          ownership.repositoryPath,
          ["worktree", "remove", "--force", ownership.path],
        );
      }
      return;
    }
    if (
      !before.isDirectory() ||
      before.isSymbolicLink() ||
      before.dev !== ownership.identity.dev ||
      before.ino !== ownership.identity.ino
    ) {
      throw new Error(`Created worktree changed before rollback: ${ownership.path}`);
    }
    let gitError: unknown;
    if (ownership.registered) {
      try {
        await this.runRepositoryGit(
          ownership.repositoryPath,
          ["worktree", "remove", "--force", ownership.path],
        );
      } catch (error) {
        gitError = error;
      }
    }
    const remaining = await lstatIfExists(ownership.path);
    if (remaining) {
      if (
        !remaining.isDirectory() ||
        remaining.isSymbolicLink() ||
        remaining.dev !== ownership.identity.dev ||
        remaining.ino !== ownership.identity.ino
      ) {
        throw new Error(`Created worktree changed during rollback: ${ownership.path}`);
      }
      await rm(ownership.path, { recursive: true });
    }
    if (gitError) throw gitError;
  }

  private async captureReservedWorktree(
    repositoryPath: string,
    worktreePath: string,
  ): Promise<ManagedWorktreeOwnership> {
    const stat = await lstat(worktreePath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Reserved branch worktree is not an ordinary directory: ${worktreePath}`);
    }
    return {
      path: worktreePath,
      repositoryPath,
      identity: { dev: stat.dev, ino: stat.ino },
      registered: false,
    };
  }

  private async assertStagedWorktreeBoundary(
    projectRoot: string,
    ownership: ManagedWorktreeOwnership,
  ): Promise<void> {
    await ensureDirectoryWithinRoot(projectRoot, path.dirname(ownership.path), {
      allowRootMapping: true,
      createMissing: false,
    });
    await ensureDirectoryWithinRoot(projectRoot, ownership.path, {
      allowRootMapping: true,
      createMissing: false,
    });
    await this.assertWorktreeOwnership(ownership);
    const gitEntry = await lstatIfExists(path.join(ownership.path, ".git"));
    if (
      gitEntry &&
      (gitEntry.isSymbolicLink() ||
        (!gitEntry.isDirectory() && (!gitEntry.isFile() || gitEntry.nlink !== 1)))
    ) {
      throw new Error(`Created worktree has an unsafe Git administrative path: ${ownership.path}`);
    }
    if (ownership.gitLink) {
      const current = await readManagedFileSnapshot(ownership.gitLink.path, {
        label: "created worktree Git link",
        trustedRoot: projectRoot,
      });
      if (!sameManagedFileSnapshot(current, ownership.gitLink.snapshot)) {
        throw new Error(`Created worktree Git link changed: ${ownership.gitLink.path}`);
      }
      await ensureDirectoryWithinRoot(
        ownership.gitLink.commonWorktreesRoot,
        ownership.gitLink.adminPath,
        { createMissing: false },
      );
      const adminStat = await lstat(ownership.gitLink.adminPath);
      if (
        !adminStat.isDirectory() ||
        adminStat.isSymbolicLink() ||
        adminStat.dev !== ownership.gitLink.adminIdentity.dev ||
        adminStat.ino !== ownership.gitLink.adminIdentity.ino
      ) {
        throw new Error(
          `Created worktree Git administration changed: ${ownership.gitLink.adminPath}`,
        );
      }
    }
  }

  private async captureStagedWorktreeGitLink(
    projectRoot: string,
    ownership: ManagedWorktreeOwnership,
  ): Promise<void> {
    const gitLinkPath = path.join(ownership.path, ".git");
    const gitEntry = await lstat(gitLinkPath);
    if (gitEntry.isDirectory() && !gitEntry.isSymbolicLink()) return;
    const snapshot = await readManagedFileSnapshot(gitLinkPath, {
      label: "created worktree Git link",
      trustedRoot: projectRoot,
    });
    const match = snapshot?.content.match(/^gitdir:\s*(.+?)\s*$/u);
    if (!match?.[1]) {
      throw new Error(`Created worktree has an invalid Git link: ${gitLinkPath}`);
    }
    const commonDirOutput = (
      await this.runRepositoryGit(
        ownership.repositoryPath,
        ["rev-parse", "--git-common-dir"],
      )
    ).trim();
    if (!commonDirOutput) throw new Error("Git returned an empty common directory");
    const commonDir = path.resolve(ownership.repositoryPath, commonDirOutput);
    await ensureDirectoryWithinRoot(ownership.repositoryPath, commonDir, {
      allowRootMapping: true,
      createMissing: false,
    });
    const commonWorktreesRoot = path.join(commonDir, "worktrees");
    const adminPath = path.resolve(ownership.path, match[1]);
    await ensureDirectoryWithinRoot(commonWorktreesRoot, adminPath, {
      createMissing: false,
    });
    const adminStat = await lstat(adminPath);
    if (!adminStat.isDirectory() || adminStat.isSymbolicLink()) {
      throw new Error(`Created worktree Git administration is unsafe: ${adminPath}`);
    }
    ownership.gitLink = {
      path: gitLinkPath,
      snapshot: snapshot!,
      adminPath,
      adminIdentity: { dev: adminStat.dev, ino: adminStat.ino },
      commonWorktreesRoot,
    };
  }

  private async assertWorktreeOwnership(
    ownership: ManagedWorktreeOwnership,
  ): Promise<void> {
    if (!(await this.worktreeOwnershipMatches(ownership, ownership.path))) {
      throw new Error(`Created worktree changed during provisioning: ${ownership.path}`);
    }
  }

  private async worktreeOwnershipMatches(
    ownership: ManagedWorktreeOwnership,
    candidatePath: string,
  ): Promise<boolean> {
    const stat = await lstatIfExists(candidatePath);
    return !!(
      stat &&
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      stat.dev === ownership.identity.dev &&
      stat.ino === ownership.identity.ino
    );
  }

  private async isRegisteredWorktree(
    repositoryPath: string,
    worktreePath: string,
  ): Promise<boolean> {
    const output = await this.runRepositoryGit(
      repositoryPath,
      ["worktree", "list", "--porcelain"],
    );
    return output
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("worktree "))
      .some((line) => sameFileSystemPath(line.slice("worktree ".length), worktreePath));
  }

  private async resolveCommit(repositoryPath: string, startPoint: string): Promise<string> {
    const sha = (
      await this.runRepositoryGit(
        repositoryPath,
        ["rev-parse", "--verify", "--end-of-options", `${startPoint}^{commit}`],
      )
    ).trim();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(sha)) {
      throw new Error(`Git did not resolve ${startPoint} to a complete commit object id`);
    }
    return sha;
  }

  private async localRefSha(
    repositoryPath: string,
    ref: string,
  ): Promise<string | undefined> {
    const output = await this.runRepositoryGit(
      repositoryPath,
      ["for-each-ref", "--format=%(refname)%09%(objectname)", "--", ref],
    );
    for (const line of output.split(/\r?\n/u)) {
      const separator = line.indexOf("\t");
      if (separator < 0 || line.slice(0, separator) !== ref) continue;
      const sha = line.slice(separator + 1).trim();
      if (!sha) throw new Error(`Git returned an empty object id for ${ref}`);
      return sha;
    }
    return undefined;
  }

  private async replaceBranchRef(snapshot: BranchRefSnapshot): Promise<void> {
    const expectedSha =
      snapshot.previousSha ?? "0".repeat(snapshot.replacementSha.length);
    await this.runRepositoryGit(
      snapshot.repositoryPath,
      [
        "update-ref",
        "--create-reflog",
        "-m",
        snapshot.transactionMarker,
        snapshot.ref,
        snapshot.replacementSha,
        expectedSha,
      ],
    );
  }

  private async branchRefHasTransactionMarker(
    snapshot: BranchRefSnapshot,
  ): Promise<boolean> {
    const marker = (
      await this.runRepositoryGit(
        snapshot.repositoryPath,
        ["reflog", "show", "-1", "--format=%gs", snapshot.ref],
      )
    ).trim();
    return marker === snapshot.transactionMarker;
  }

  private async restoreBranchRef(snapshot: BranchRefSnapshot): Promise<void> {
    if (!snapshot.updated) return;
    const currentSha = await this.localRefSha(snapshot.repositoryPath, snapshot.ref);
    if (currentSha === snapshot.previousSha) return;
    if (!(await this.branchRefHasTransactionMarker(snapshot))) {
      throw new Error(`Branch ref ownership changed before rollback: ${snapshot.ref}`);
    }
    if (snapshot.previousSha) {
      await this.runRepositoryGit(
        snapshot.repositoryPath,
        [
          "update-ref",
          snapshot.ref,
          snapshot.previousSha,
          snapshot.replacementSha,
        ],
      );
      return;
    }
    await this.runRepositoryGit(
      snapshot.repositoryPath,
      ["update-ref", "-d", snapshot.ref, snapshot.replacementSha],
    );
  }

  private captureWorkDocumentationContext(
    workspace: BranchWorkspace,
    revision: WorkspaceProjectRevision = this.captureProjectRevision(),
  ): WorkDocumentationContext {
    this.assertProjectRevision(revision);
    return {
      workspace: { ...workspace },
      projectRoot: revision.projectRoot,
      projectId: revision.projectId,
      projectGeneration: revision.generation,
      repositoryKey: this.workDocumentationRepositoryKey(workspace),
    };
  }

  private workDocumentationPreparationKey(context: WorkDocumentationContext): string {
    return [
      context.projectId,
      context.projectGeneration,
      context.projectRoot,
      context.repositoryKey,
      context.workspace.worktreePath,
      context.workspace.branch,
    ].join("\u0000");
  }

  private workDocumentationPaths(context: WorkDocumentationContext) {
    const { workspace } = context;
    const isolatedDirectory = path.join(
      workspace.worktreePath,
      WORK_DOCUMENTATION_PATHS.isolatedDirectory,
    );
    const sharedSourceDirectory = path.join(
      context.projectRoot,
      "shared",
      "_agent-canvas",
      context.repositoryKey,
      WORK_DOCUMENTATION_PATHS.sharedSourceDirectory,
    );
    const sharedMountDirectory = path.join(
      workspace.worktreePath,
      WORK_DOCUMENTATION_PATHS.sharedMountDirectory,
    );
    const branchDirectory = sharedBranchDirectory(workspace.branch);
    const branchSourceDirectory = path.join(
      sharedSourceDirectory,
      "branches",
      branchDirectory,
    );
    const branchMountDirectory = path.join(
      sharedMountDirectory,
      "branches",
      branchDirectory,
    );
    return {
      isolatedDirectory,
      isolatedIndex: path.join(isolatedDirectory, "index.md"),
      sharedSourceDirectory,
      sharedMountDirectory,
      sharedIndex: path.join(sharedMountDirectory, "index.md"),
      sharedSourceIndex: path.join(sharedSourceDirectory, "index.md"),
      branchDirectory,
      branchSourceDirectory,
      branchMountDirectory,
      branchOverview: path.join(branchSourceDirectory, "overview.md"),
    };
  }

  private async ensureWorkDocumentation(context: WorkDocumentationContext): Promise<void> {
    const preparationKey = this.workDocumentationPreparationKey(context);
    const { workspace } = context;
    const documentation = this.workDocumentationPaths(context);
    this.assertWorkDocumentationContextCurrent(context);
    if (this.preparedWorkDocumentation.has(preparationKey)) {
      try {
        await this.validatePreparedWorkDocumentation(context, documentation);
        this.assertWorkDocumentationContextCurrent(context);
        return;
      } catch (error) {
        this.preparedWorkDocumentation.delete(preparationKey);
        throw error;
      }
    }

    await this.preflightWorkDocumentation(context, documentation);
    this.assertWorkDocumentationContextCurrent(context);
    await this.ensureIgnored(workspace, [
      WORK_DOCUMENTATION_PATHS.isolatedDirectory,
      WORK_DOCUMENTATION_PATHS.sharedMountDirectory,
    ]);
    this.assertWorkDocumentationContextCurrent(context);

    await ensureDirectoryWithinRoot(
      workspace.worktreePath,
      documentation.isolatedDirectory,
    );
    const isolatedMarker = path.join(
      documentation.isolatedDirectory,
      WORK_DOCUMENTATION_MANAGED_MARKER,
    );
    await ensureFile(
      isolatedMarker,
      "Agent Canvas managed work documentation. Do not commit or remove this marker.\n",
    );
    await assertRegularFile(
      isolatedMarker,
      `${WORK_DOCUMENTATION_PATHS.isolatedDirectory}/ 缺少有效的 Agent Canvas 管理标记`,
    );
    this.assertWorkDocumentationContextCurrent(context);

    await ensureDirectoryWithinRoot(
      context.projectRoot,
      documentation.sharedSourceDirectory,
      { allowRootMapping: true },
    );
    const sharedMarker = path.join(
      documentation.sharedSourceDirectory,
      WORK_DOCUMENTATION_MANAGED_MARKER,
    );
    await ensureFile(
      sharedMarker,
      "Agent Canvas managed shared work documentation. Do not commit or remove this marker.\n",
    );
    await assertRegularFile(
      sharedMarker,
      `${WORK_DOCUMENTATION_PATHS.sharedMountDirectory}/ 缺少有效的 Agent Canvas 管理标记`,
    );
    await ensureDirectoryWithinRoot(
      documentation.sharedSourceDirectory,
      documentation.branchSourceDirectory,
    );
    await ensureFile(
      documentation.isolatedIndex,
      isolatedDocumentationIndex(workspace.branch),
    );
    await ensureFile(documentation.sharedSourceIndex, sharedDocumentationIndex());
    await ensureFile(documentation.branchOverview, sharedBranchOverview(workspace.branch));
    await assertRegularFile(
      documentation.isolatedIndex,
      `${WORK_DOCUMENTATION_PATHS.isolatedIndex} 必须是普通文件`,
    );
    await assertRegularFile(
      documentation.sharedSourceIndex,
      `${WORK_DOCUMENTATION_PATHS.sharedIndex} 必须是普通文件`,
    );
    await assertRegularFile(
      documentation.branchOverview,
      "共享 branch 概要必须是普通文件",
    );
    await ensureLink(documentation.sharedSourceDirectory, documentation.sharedMountDirectory);
    this.assertWorkDocumentationContextCurrent(context);

    const sharedIndexSnapshot = await readManagedFileSnapshot(
      documentation.sharedSourceIndex,
      { label: "shared work-documentation index" },
    );
    const sharedIndex = sharedIndexSnapshot!.content;
    const nextSharedIndex = ensureSharedBranchIndexEntry(
      sharedIndex,
      workspace.branch,
      documentation.branchDirectory,
    );
    if (nextSharedIndex !== sharedIndex) {
      await writeManagedFileAtomically(
        documentation.sharedSourceIndex,
        nextSharedIndex,
        {
          label: "shared work-documentation index",
          expectedContent: sharedIndex,
          expectedIdentity: sharedIndexSnapshot!.identity,
        },
      );
    }
    this.assertWorkDocumentationContextCurrent(context);
    await this.validatePreparedWorkDocumentation(context, documentation);
    this.assertWorkDocumentationContextCurrent(context);
    this.preparedWorkDocumentation.add(preparationKey);
  }

  private async validateWorkspaceRootMapping(context: WorkDocumentationContext): Promise<void> {
    await validateRelocatedWorkspaceRoots(context.projectRoot, this.state);
  }

  private async preflightWorkDocumentation(
    context: WorkDocumentationContext,
    documentation: ReturnType<WorkspaceManager["workDocumentationPaths"]>,
  ): Promise<void> {
    const { workspace } = context;
    this.assertWorkDocumentationContextCurrent(context);
    await this.validateWorkspaceRootMapping(context);
    this.assertWorkDocumentationContextCurrent(context);
    await this.assertWorkDocumentationUntracked(workspace);
    this.assertWorkDocumentationContextCurrent(context);

    const isolatedMarker = path.join(
      documentation.isolatedDirectory,
      WORK_DOCUMENTATION_MANAGED_MARKER,
    );
    const isolatedStat = await lstatIfExists(documentation.isolatedDirectory);
    if (isolatedStat) {
      if (!isolatedStat.isDirectory() || isolatedStat.isSymbolicLink()) {
        throw new Error(
          `${WORK_DOCUMENTATION_PATHS.isolatedDirectory}/ 已存在且不是 Agent Canvas 管理的文档目录`,
        );
      }
      await assertRegularFile(
        isolatedMarker,
        `${WORK_DOCUMENTATION_PATHS.isolatedDirectory}/ 缺少有效的 Agent Canvas 管理标记`,
      );
      await assertRegularFileIfExists(
        documentation.isolatedIndex,
        `${WORK_DOCUMENTATION_PATHS.isolatedIndex} 必须是普通文件`,
      );
    }

    const sharedSourceStat = await lstatIfExists(documentation.sharedSourceDirectory);
    await ensureDirectoryWithinRoot(
      context.projectRoot,
      documentation.sharedSourceDirectory,
      { allowRootMapping: true, createMissing: false },
    );
    if (sharedSourceStat) {
      const sharedMarker = path.join(
        documentation.sharedSourceDirectory,
        WORK_DOCUMENTATION_MANAGED_MARKER,
      );
      await assertRegularFile(
        sharedMarker,
        `${WORK_DOCUMENTATION_PATHS.sharedMountDirectory}/ 缺少有效的 Agent Canvas 管理标记`,
      );
      await assertRegularFileIfExists(
        documentation.sharedSourceIndex,
        `${WORK_DOCUMENTATION_PATHS.sharedIndex} 必须是普通文件`,
      );
      await ensureDirectoryWithinRoot(
        documentation.sharedSourceDirectory,
        documentation.branchSourceDirectory,
        { createMissing: false },
      );
      await assertRegularFileIfExists(
        documentation.branchOverview,
        "共享 branch 概要必须是普通文件",
      );
    }
    await assertLinkCanPointTo(
      documentation.sharedSourceDirectory,
      documentation.sharedMountDirectory,
    );
  }

  private async validatePreparedWorkDocumentation(
    context: WorkDocumentationContext,
    documentation: ReturnType<WorkspaceManager["workDocumentationPaths"]>,
  ): Promise<void> {
    const { workspace } = context;
    this.assertWorkDocumentationContextCurrent(context);
    await this.validateWorkspaceRootMapping(context);
    this.assertWorkDocumentationContextCurrent(context);
    await this.assertWorkDocumentationUntracked(workspace);
    this.assertWorkDocumentationContextCurrent(context);

    await assertOrdinaryDirectory(
      documentation.isolatedDirectory,
      `${WORK_DOCUMENTATION_PATHS.isolatedDirectory}/ 必须是普通目录`,
    );
    await ensureDirectoryWithinRoot(workspace.worktreePath, documentation.isolatedDirectory, {
      createMissing: false,
    });
    await assertRegularFile(
      path.join(documentation.isolatedDirectory, WORK_DOCUMENTATION_MANAGED_MARKER),
      `${WORK_DOCUMENTATION_PATHS.isolatedDirectory}/ 缺少有效的 Agent Canvas 管理标记`,
    );
    await assertRegularFile(
      documentation.isolatedIndex,
      `${WORK_DOCUMENTATION_PATHS.isolatedIndex} 必须是普通文件`,
    );

    await assertOrdinaryDirectory(
      documentation.sharedSourceDirectory,
      `${WORK_DOCUMENTATION_PATHS.sharedMountDirectory}/ 的共享源必须是普通目录`,
    );
    await ensureDirectoryWithinRoot(
      context.projectRoot,
      documentation.sharedSourceDirectory,
      { allowRootMapping: true, createMissing: false },
    );
    await assertRegularFile(
      path.join(documentation.sharedSourceDirectory, WORK_DOCUMENTATION_MANAGED_MARKER),
      `${WORK_DOCUMENTATION_PATHS.sharedMountDirectory}/ 缺少有效的 Agent Canvas 管理标记`,
    );
    await assertRegularFile(
      documentation.sharedSourceIndex,
      `${WORK_DOCUMENTATION_PATHS.sharedIndex} 必须是普通文件`,
    );
    await assertOrdinaryDirectory(
      documentation.branchSourceDirectory,
      "当前 branch 共享概要目录必须是普通目录",
    );
    await ensureDirectoryWithinRoot(
      documentation.sharedSourceDirectory,
      documentation.branchSourceDirectory,
      { createMissing: false },
    );
    await assertRegularFile(
      documentation.branchOverview,
      "共享 branch 概要必须是普通文件",
    );
    await assertExistingLinkPointsTo(
      documentation.sharedSourceDirectory,
      documentation.sharedMountDirectory,
    );
    await assertSameFileSystemIdentity(
      documentation.sharedSourceIndex,
      documentation.sharedIndex,
      "共享工作文档索引映射已改变",
    );
    await assertSameFileSystemIdentity(
      documentation.branchSourceDirectory,
      documentation.branchMountDirectory,
      "当前 branch 共享概要映射已改变",
    );
  }

  private async assertWorkDocumentationUntracked(workspace: BranchWorkspace): Promise<void> {
    const trackedDocumentation = await this.runGit(
      [
        "ls-files",
        "--",
        WORK_DOCUMENTATION_PATHS.isolatedDirectory,
        WORK_DOCUMENTATION_PATHS.sharedMountDirectory,
      ],
      { cwd: workspace.worktreePath },
    );
    if (trackedDocumentation.trim()) {
      throw new Error(
        `${WORK_DOCUMENTATION_PATHS.isolatedDirectory}/ 或 ${WORK_DOCUMENTATION_PATHS.sharedMountDirectory}/ 已包含 Git 跟踪文件，无法启用工作文档维护`,
      );
    }
  }

  private assertWorkDocumentationContextCurrent(context: WorkDocumentationContext): void {
    this.assertProjectRevision({
      projectId: context.projectId,
      projectRoot: context.projectRoot,
      generation: context.projectGeneration,
    });
    const currentWorkspace = this.branchOf(context.workspace.id);
    if (
      !currentWorkspace ||
      currentWorkspace.repoId !== context.workspace.repoId ||
      currentWorkspace.branch !== context.workspace.branch ||
      normalizedRootKey(currentWorkspace.worktreePath) !==
        normalizedRootKey(context.workspace.worktreePath)
    ) {
      throw new WorkspaceProjectChangedError();
    }
  }

  private workDocumentationRepositoryKey(workspace: BranchWorkspace): string {
    const repo = this.state.repo?.id === workspace.repoId ? this.state.repo : undefined;
    const identity = repo?.remoteUrl || workspace.repoId;
    const normalizedIdentity = normalizeRepositoryIdentity(identity);
    return createHash("sha256").update(normalizedIdentity).digest("hex").slice(0, 16);
  }

  private async queueWorkDocumentation<T>(task: () => Promise<T>): Promise<T> {
    const result = this.documentationPrepareChain.then(task, task);
    this.documentationPrepareChain = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }

  private async queueProjectMutation<T>(task: () => Promise<T>): Promise<T> {
    const result = this.projectMutationChain.then(task, task);
    this.projectMutationChain = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }

  private advanceProjectGeneration(): void {
    this.projectGeneration += 1;
    this.resetWorkDocumentationPreparation();
  }

  private async ensureIgnored(workspace: BranchWorkspace, patterns: string[]): Promise<void> {
    const excludePath = await gitPath(this.runGit, workspace.worktreePath, "info/exclude");
    const projectRoot = this.requireProjectRoot();
    const normalized = patterns.map((pattern) => normalizeIgnorePattern(pattern));
    const key = process.platform === "win32"
      ? path.resolve(excludePath).toLowerCase()
      : path.resolve(excludePath);
    const previous = this.ignoreWriteChains.get(key) ?? Promise.resolve();
    const append = async () => {
      const parent = path.dirname(excludePath);
      await ensureDirectoryWithinRoot(projectRoot, parent, {
        allowRootMapping: true,
        createMissing: false,
      });
      await mkdir(parent, { recursive: true });
      await ensureDirectoryWithinRoot(projectRoot, parent, {
        allowRootMapping: true,
        createMissing: false,
      });
      await appendUniqueLines(excludePath, normalized);
    };
    const result = previous.then(
      append,
      append,
    );
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.ignoreWriteChains.set(key, settled);
    try {
      await result;
    } finally {
      if (this.ignoreWriteChains.get(key) === settled) {
        this.ignoreWriteChains.delete(key);
      }
    }
  }

  private async currentBranch(cwd: string): Promise<string | undefined> {
    try {
      return await this.runGit(["branch", "--show-current"], { cwd });
    } catch {
      return undefined;
    }
  }

  private async remoteUrlOf(cwd: string): Promise<string | undefined> {
    try {
      return await this.runGit(["remote", "get-url", "origin"], { cwd });
    } catch {
      return undefined;
    }
  }

  private async readProjectIndex(): Promise<ProjectIndex> {
    return (await this.readProjectIndexSnapshot()).index;
  }

  private async readProjectIndexSnapshot(): Promise<{
    index: ProjectIndex;
    snapshot: ManagedFileSnapshot | undefined;
  }> {
    try {
      const projectsRootBoundary = await this.ensureProjectsRootBoundary();
      const snapshot = await readManagedFileSnapshot(this.projectIndexPath(), {
        allowMissing: true,
        label: "Canvas project index",
        trustedRootBoundary: projectsRootBoundary,
      });
      return {
        index: parseProjectIndex(snapshot?.content),
        snapshot,
      };
    } catch (error) {
      if (error instanceof ManagedFileSafetyError) throw error;
      throw error;
    }
  }

  private async writeProjectIndex(
    projects: CanvasProjectSummary[],
    expectedSnapshot?: ManagedFileSnapshot | null,
  ): Promise<ManagedFileSnapshot> {
    const projectsRootBoundary = await this.ensureProjectsRootBoundary();
    return await writeManagedFileAtomically(
      this.projectIndexPath(),
      `${JSON.stringify({ projects }, undefined, 2)}\n`,
      {
        label: "Canvas project index",
        trustedRootBoundary: projectsRootBoundary,
        ...(expectedSnapshot !== undefined
          ? {
              expectedContent: expectedSnapshot?.content,
              expectedIdentity: expectedSnapshot?.identity,
            }
          : {}),
      },
    );
  }

  private async discoverProjects(): Promise<CanvasProjectSummary[]> {
    const projectsRootBoundary = await this.ensureProjectsRootBoundary();
    let entries: Dirent[];
    try {
      entries = await readdir(projectsRootBoundary.realPath, { withFileTypes: true });
      await assertManagedTrustedRootBoundary(projectsRootBoundary, "Canvas projects root");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const projects = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          try {
            return await this.readProjectSummary(path.join(projectsRootBoundary.realPath, entry.name));
          } catch (error) {
            if (error instanceof ManagedFileSafetyError) throw error;
            return undefined;
          }
        }),
    );
    return projects.filter((project): project is CanvasProjectSummary => !!project);
  }

  private async readProjectSummary(
    projectRoot: string,
    fallback?: CanvasProjectSummary,
  ): Promise<CanvasProjectSummary> {
    const resolvedRoot = path.resolve(projectRoot);
    const boundary = await captureProjectRootBoundary(resolvedRoot);
    const document = await this.readWorkspaceDocument(resolvedRoot, undefined, boundary);
    const relocated = relocateWorkspace(document, resolvedRoot, {
      requireExternalTrust: !sameExistingDirectoryIdentitySync(
        document.project.projectRoot,
        resolvedRoot,
      ),
    });
    await validateRelocatedWorkspaceRoots(resolvedRoot, relocated.state);
    const project = relocated.project;
    return fallback && normalizedRootKey(fallback.projectRoot) === normalizedRootKey(resolvedRoot)
      ? { ...project, id: fallback.id }
      : project;
  }

  private async readWorkspaceDocument(
    projectRoot: string,
    snapshot?: ManagedFileSnapshot,
    boundary?: ProjectRootBoundary,
  ): Promise<WorkspaceDocument> {
    const resolvedRoot = path.resolve(projectRoot);
    const trustedRootBoundary = boundary ??
      (sameFileSystemPath(resolvedRoot, this.projectRoot ?? "")
        ? this.currentProjectRootBoundary()
        : await captureProjectRootBoundary(resolvedRoot));
    let parsed: unknown;
    try {
      const content = snapshot?.content ?? await readManagedFile(
        path.join(resolvedRoot, WORKSPACE_STATE_FILE),
        {
          allowParentMapping: true,
          label: "Canvas workspace metadata",
          trustedRootBoundary,
        },
      );
      parsed = JSON.parse(content!);
    } catch (error) {
      if (error instanceof ManagedFileSafetyError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`所选文件夹不是 Canvas 项目: ${resolvedRoot}`);
      }
      throw new Error(`无法读取 Canvas 项目 ${resolvedRoot}: ${errorMessage(error)}`);
    }
    return parseWorkspaceDocument(parsed, resolvedRoot);
  }

  private async ensureProjectRootAvailable(projectRoot: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(projectRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (entries.length === 0) return;
    if (entries.includes(WORKSPACE_STATE_FILE)) {
      throw new Error(`文件夹中已有 Canvas 项目，请使用“加载项目”: ${projectRoot}`);
    }
    throw new Error(`项目文件夹必须为空: ${projectRoot}`);
  }

  private projectIndexPath(): string {
    return path.join(this.projectsRoot, PROJECT_INDEX_FILE);
  }
}

async function defaultRunGit(args: string[], options: { cwd?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: options.cwd, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || error.message).trim()));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function gitPath(runGit: GitRunner, cwd: string, key: string): Promise<string> {
  const value = await runGit(["rev-parse", "--git-path", key], { cwd });
  return path.isAbsolute(value) ? value : path.resolve(cwd, value);
}

async function ensureLink(sourcePath: string, mountPath: string): Promise<void> {
  const existing = await lstatIfExists(mountPath);
  if (existing) {
    const stat = existing;
    if (stat.isSymbolicLink()) {
      await assertSameFileSystemIdentity(
        sourcePath,
        mountPath,
        `共享资源挂载点已映射到其他目录: ${mountPath}`,
      );
      return;
    }
    throw new Error(`共享资源挂载点已存在且不是映射: ${mountPath}`);
  }
  const type = process.platform === "win32" ? "junction" : "dir";
  await symlink(path.resolve(sourcePath), mountPath, type);
}

async function createManagedLinkNoClobber(
  sourcePath: string,
  mountPath: string,
): Promise<ManagedMountOwnership> {
  const type = process.platform === "win32" ? "junction" : "dir";
  if (await lstatIfExists(mountPath)) {
    throw new Error(`Shared resource mount already exists: ${mountPath}`);
  }
  const resolvedSource = path.resolve(sourcePath);
  const stagingPath = path.join(
    path.dirname(mountPath),
    `.${path.basename(mountPath)}.agent-canvas-link-${randomUUID()}.tmp`,
  );
  let stagedIdentity: { dev: number; ino: number } | undefined;
  let publicationError: unknown;
  try {
    let stagingCreationError: unknown;
    try {
      await symlink(resolvedSource, stagingPath, type);
    } catch (error) {
      stagingCreationError = error;
    }
    const staged = await lstatIfExists(stagingPath);
    if (!staged?.isSymbolicLink()) {
      throw stagingCreationError ??
        new Error(`Shared resource staging mount is not a link: ${stagingPath}`);
    }
    stagedIdentity = { dev: staged.dev, ino: staged.ino };
    const stagedRawTarget = await readlink(stagingPath);
    if (!rawLinkTargetMatches(stagedRawTarget, stagingPath, resolvedSource)) {
      throw new Error(`Shared resource staging mount points to an unexpected target: ${stagingPath}`);
    }
    await assertSameFileSystemIdentity(
      resolvedSource,
      stagingPath,
      `Shared resource staging mount points to an unexpected target: ${stagingPath}`,
    );
    if (process.platform === "win32") {
      try {
        await rename(stagingPath, mountPath);
      } catch (error) {
        publicationError = error;
      }
    } else {
      try {
        await link(stagingPath, mountPath);
      } catch (error) {
        publicationError = error;
      }
      const published = await lstatIfExists(mountPath);
      if (published && sameFileIdentity(staged, published)) {
        await rm(stagingPath);
      }
    }

    const published = await lstatIfExists(mountPath);
    const stagingRemaining = await lstatIfExists(stagingPath);
    if (
      !published?.isSymbolicLink() ||
      published.dev !== staged.dev ||
      published.ino !== staged.ino ||
      stagingRemaining
    ) {
      throw publicationError ??
        new Error(`Shared resource mount publication was not atomic: ${mountPath}`);
    }
    const ownership: ManagedMountOwnership = {
      mountPath,
      sourcePath,
      identity: { dev: staged.dev, ino: staged.ino },
    };
    ownership.rawTarget = await readlink(mountPath);
    await assertManagedMountOwnership(ownership);
    await assertSameFileSystemIdentity(
      sourcePath,
      mountPath,
      `Shared resource mount points to an unexpected target: ${mountPath}`,
    );
    await assertManagedMountOwnership(ownership);
    return ownership;
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    if (stagedIdentity) {
      const published = await lstatIfExists(mountPath);
      if (
        published?.isSymbolicLink() &&
        published.dev === stagedIdentity.dev &&
        published.ino === stagedIdentity.ino
      ) {
        await collectRollbackError(rollbackErrors, () =>
          removeManagedMount({ mountPath, sourcePath, identity: stagedIdentity! }),
        );
      }
      const staging = await lstatIfExists(stagingPath);
      if (
        staging?.isSymbolicLink() &&
        staging.dev === stagedIdentity.dev &&
        staging.ino === stagedIdentity.ino
      ) {
        await collectRollbackError(rollbackErrors, () => rm(stagingPath));
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [publicationError ?? error, ...rollbackErrors],
        `Shared resource mount validation failed and rollback was incomplete: ${mountPath}`,
      );
    }
    throw publicationError ?? error;
  } finally {
    const staging = await lstatIfExists(stagingPath).catch(() => undefined);
    if (
      stagedIdentity &&
      staging?.isSymbolicLink() &&
      staging.dev === stagedIdentity.dev &&
      staging.ino === stagedIdentity.ino
    ) {
      await rm(stagingPath, { force: true }).catch(() => undefined);
    }
  }
}

function rawLinkTargetMatches(rawTarget: string, mountPath: string, sourcePath: string): boolean {
  const withoutWindowsNamespace = rawTarget.startsWith("\\\\?\\")
    ? rawTarget.slice(4)
    : rawTarget;
  const resolvedTarget = path.isAbsolute(withoutWindowsNamespace)
    ? path.resolve(withoutWindowsNamespace)
    : path.resolve(path.dirname(mountPath), withoutWindowsNamespace);
  return sameFileSystemPath(resolvedTarget, path.resolve(sourcePath));
}

async function ensureManagedLink(
  sourcePath: string,
  mountPath: string,
): Promise<ManagedMountOwnership | undefined> {
  const existing = await lstatIfExists(mountPath);
  if (existing) {
    await assertExistingLinkPointsTo(sourcePath, mountPath);
    return undefined;
  }
  return await createManagedLinkNoClobber(sourcePath, mountPath);
}

async function assertLinkCanPointTo(sourcePath: string, mountPath: string): Promise<void> {
  const mountStat = await lstatIfExists(mountPath);
  if (!mountStat) return;
  if (!mountStat.isSymbolicLink()) {
    throw new Error(`共享资源挂载点已存在且不是映射: ${mountPath}`);
  }
  const sourceStat = await lstatIfExists(sourcePath);
  if (!sourceStat) {
    throw new Error(`共享资源挂载点已存在，但目标文档目录不存在: ${mountPath}`);
  }
  await assertSameFileSystemIdentity(
    sourcePath,
    mountPath,
    `共享资源挂载点已映射到其他目录: ${mountPath}`,
  );
}

async function assertExistingLinkPointsTo(
  sourcePath: string,
  mountPath: string,
): Promise<void> {
  const mountStat = await lstatIfExists(mountPath);
  if (!mountStat?.isSymbolicLink()) {
    throw new Error(`共享资源挂载点缺失或不是映射: ${mountPath}`);
  }
  await assertSameFileSystemIdentity(
    sourcePath,
    mountPath,
    `共享资源挂载点已映射到其他目录: ${mountPath}`,
  );
}

async function assertSameFileSystemIdentity(
  expectedPath: string,
  actualPath: string,
  message: string,
): Promise<void> {
  let expected: BigIntStats;
  let actual: BigIntStats;
  try {
    [expected, actual] = await Promise.all([
      stat(expectedPath, { bigint: true }),
      stat(actualPath, { bigint: true }),
    ]);
  } catch (error) {
    throw new Error(`${message}（文件系统身份无法安全解析）`, { cause: error });
  }
  const expectedIdentity = comparableResolvedFileSystemIdentity(expected);
  const actualIdentity = comparableResolvedFileSystemIdentity(actual);
  if (!expectedIdentity || !actualIdentity) {
    throw new Error(`${message}（文件系统身份无法安全比较）`);
  }
  if (!sameResolvedFileSystemIdentity(expectedIdentity, actualIdentity)) throw new Error(message);
}

interface ResolvedFileSystemIdentity {
  dev: bigint;
  ino: bigint;
}

function comparableResolvedFileSystemIdentity(
  stat: BigIntStats,
): ResolvedFileSystemIdentity | undefined {
  return stat.dev > 0n && stat.ino > 0n ? { dev: stat.dev, ino: stat.ino } : undefined;
}

function sameResolvedFileSystemIdentity(
  left: ResolvedFileSystemIdentity,
  right: ResolvedFileSystemIdentity,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileSystemPath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

interface SharedResourceDirectoryInspection {
  logicalPath: string;
  realPath: string;
  mappings: Array<{ logicalPath: string; realPath: string }>;
  ancestors: SharedResourceDirectoryAncestor[];
  finalIdentity?: SharedResourceFileIdentity;
}

type SharedResourceFileIdentity = ResolvedFileSystemIdentity;

interface SharedResourceDirectoryAncestor {
  logicalPath: string;
  realPath: string;
  identity: SharedResourceFileIdentity;
}

function resolveSharedResourceSourcePath(sourcePath: string): string {
  if (process.platform !== "win32") return path.resolve(sourcePath);

  const windowsPath = sourcePath.replaceAll("/", "\\");
  const extendedPrefix = "\\\\?\\";
  if (windowsPath.startsWith(extendedPrefix)) {
    const namespacedPath = windowsPath.slice(extendedPrefix.length);
    if (/^[a-z]:\\/iu.test(namespacedPath)) return path.resolve(namespacedPath);
    if (namespacedPath.toUpperCase().startsWith("UNC\\")) {
      const uncPath = namespacedPath.slice(4);
      const [server, share] = uncPath.split("\\");
      if (server && share) return path.resolve(`\\\\${uncPath}`);
    }
    throw new Error(`Unsupported Windows namespace for shared resource: ${sourcePath}`);
  }

  if (
    windowsPath.startsWith("\\\\.\\") ||
    windowsPath.startsWith("\\??\\") ||
    windowsPath.startsWith("\\\\??\\")
  ) {
    throw new Error(`Unsupported Windows namespace for shared resource: ${sourcePath}`);
  }
  return path.resolve(sourcePath);
}

function canonicalDirectoryPathSync(directoryPath: string, label: string): string {
  const resolved = resolveSharedResourceSourcePath(directoryPath);
  let stat: Stats;
  let canonical: string;
  try {
    stat = statSync(resolved);
    canonical = realpathSync.native(resolved);
  } catch (error) {
    throw new Error(`${label} cannot be resolved safely: ${resolved}`, { cause: error });
  }
  if (!stat.isDirectory()) throw new Error(`${label} must be a directory: ${resolved}`);
  return path.resolve(canonical);
}

function inspectSharedResourceDirectorySync(
  sourcePath: string,
  options: { allowMissing?: boolean; allowFinalMapping?: boolean } = {},
): SharedResourceDirectoryInspection {
  const logicalPath = resolveSharedResourceSourcePath(sourcePath);
  const root = path.parse(logicalPath).root;
  const segments = path.relative(root, logicalPath).split(path.sep).filter(Boolean);
  const candidates = [
    root,
    ...segments.map((_, index) => path.join(root, ...segments.slice(0, index + 1))),
  ];
  const mappings: SharedResourceDirectoryInspection["mappings"] = [];
  const ancestors: SharedResourceDirectoryAncestor[] = [];
  let deepestExistingLogicalPath: string | undefined;
  let deepestExistingRealPath: string | undefined;
  let finalEntryStat: BigIntStats | undefined;
  let finalTargetStat: BigIntStats | undefined;

  for (const candidate of candidates) {
    let entryStat: BigIntStats;
    let targetStat: BigIntStats;
    let realCandidate: string;
    try {
      entryStat = lstatSync(candidate, { bigint: true });
      targetStat = statSync(candidate, { bigint: true });
      realCandidate = path.resolve(realpathSync.native(candidate));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && options.allowMissing) break;
      throw new Error(`Shared resource path cannot be resolved safely: ${candidate}`, {
        cause: error,
      });
    }
    if (!targetStat.isDirectory()) {
      throw new Error(`Shared resource path contains a non-directory: ${candidate}`);
    }
    if (entryStat.isSymbolicLink()) {
      mappings.push({ logicalPath: candidate, realPath: realCandidate });
    }
    ancestors.push({
      logicalPath: candidate,
      realPath: realCandidate,
      identity: { dev: targetStat.dev, ino: targetStat.ino },
    });
    deepestExistingLogicalPath = candidate;
    deepestExistingRealPath = realCandidate;
    if (sameFileSystemPath(candidate, logicalPath)) {
      finalEntryStat = entryStat;
      finalTargetStat = targetStat;
    }
  }

  if (!deepestExistingLogicalPath || !deepestExistingRealPath) {
    throw new Error(`Shared resource path has no resolvable ancestor: ${logicalPath}`);
  }
  if (finalEntryStat) {
    const allowedFinalMapping =
      finalEntryStat.isSymbolicLink() && options.allowFinalMapping === true;
    if (
      (!finalEntryStat.isDirectory() && !allowedFinalMapping) ||
      (finalEntryStat.isSymbolicLink() && !allowedFinalMapping)
    ) {
      throw new Error(`Shared resource source must be an ordinary directory: ${logicalPath}`);
    }
  }
  if (!finalEntryStat && !options.allowMissing) {
    throw new Error(`Shared resource source does not exist: ${logicalPath}`);
  }
  const realPath = finalEntryStat
    ? path.resolve(realpathSync.native(logicalPath))
    : path.resolve(
        deepestExistingRealPath,
        path.relative(deepestExistingLogicalPath, logicalPath),
      );
  return {
    logicalPath,
    realPath,
    mappings,
    ancestors,
    finalIdentity: finalTargetStat
      ? { dev: finalTargetStat.dev, ino: finalTargetStat.ino }
      : undefined,
  };
}

function assertExternalWindowsSharedResourceRoot(
  sourcePath: string,
  projectRoot: string,
  realProjectRoot: string,
): void {
  // Node does not expose enough Win32 volume metadata to prove that a UNC/admin share or a
  // different drive letter is not another spelling of the protected project tree. Writable
  // external roots therefore fail closed unless they stay on the trusted project volume.
  if (isWindowsUncPath(sourcePath)) {
    throw new Error(`External UNC shared resources cannot be Agent-writable: ${sourcePath}`);
  }
  const sourceRoot = path.parse(sourcePath).root;
  const trustedRoots = [path.parse(projectRoot).root, path.parse(realProjectRoot).root];
  if (!trustedRoots.some((trustedRoot) => sameFileSystemPath(sourceRoot, trustedRoot))) {
    throw new Error(
      `External Windows shared resource must use the trusted project volume: ${sourcePath}`,
    );
  }
}

function assertLinuxSharedResourceMountTree(
  sourcePath: string,
  realProjectRoot: string,
): void {
  const mountEntries = linuxMountEntries();
  const resolvedSourcePath = path.resolve(sourcePath);
  const sourceMount = linuxMountEntryForPath(resolvedSourcePath, mountEntries);
  const projectMount = linuxMountEntryForPath(realProjectRoot, mountEntries);
  if (sourceMount.mountId !== projectMount.mountId) {
    throw new Error(
      `Linux shared resource must use the trusted project mount: ${sourcePath}`,
    );
  }
  const nestedMount = mountEntries.find((entry) =>
    isPathStrictlyWithin(entry.mountPoint, resolvedSourcePath),
  );
  if (nestedMount) {
    throw new Error(
      `Linux shared resource contains a nested mount and cannot be Agent-writable: ${nestedMount.mountPoint}`,
    );
  }
}

interface LinuxMountEntry {
  mountId: string;
  mountPoint: string;
}

function linuxMountEntries(): LinuxMountEntry[] {
  let mountInfo: string;
  try {
    mountInfo = readFileSync("/proc/self/mountinfo", "utf-8");
  } catch (error) {
    throw new Error("Linux mount identity cannot be verified safely", {
      cause: error,
    });
  }
  const mountEntries: LinuxMountEntry[] = [];
  for (const line of mountInfo.split("\n")) {
    if (!line) continue;
    const fields = line.split(" ");
    const mountId = fields[0];
    const encodedMountPoint = fields[4];
    if (!mountId || !/^\d+$/u.test(mountId) || !encodedMountPoint) continue;
    mountEntries.push({
      mountId,
      mountPoint: path.resolve(decodeLinuxMountInfoPath(encodedMountPoint)),
    });
  }
  if (mountEntries.length === 0) {
    throw new Error("Linux mount identity cannot be verified safely");
  }
  return mountEntries;
}

function linuxMountEntryForPath(
  candidatePath: string,
  mountEntries: LinuxMountEntry[],
): LinuxMountEntry {
  const resolvedCandidate = path.resolve(candidatePath);
  let bestMount: LinuxMountEntry | undefined;
  for (const mountEntry of mountEntries) {
    if (
      isPathWithin(resolvedCandidate, mountEntry.mountPoint) &&
      (!bestMount || mountEntry.mountPoint.length >= bestMount.mountPoint.length)
    ) {
      bestMount = mountEntry;
    }
  }
  if (!bestMount) {
    throw new Error(`Linux mount identity cannot be verified safely: ${candidatePath}`);
  }
  return bestMount;
}

function decodeLinuxMountInfoPath(value: string): string {
  return value.replace(/\\([0-7]{3})/gu, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

function isWindowsUncPath(candidatePath: string): boolean {
  if (process.platform !== "win32") return false;
  const windowsPath = candidatePath.replaceAll("/", "\\");
  const upperPath = windowsPath.toUpperCase();
  return upperPath.startsWith("\\\\?\\UNC\\") ||
    (!upperPath.startsWith("\\\\?\\") && upperPath.startsWith("\\\\"));
}

function isComparableFileIdentity(identity: SharedResourceFileIdentity): boolean {
  return identity.dev > 0n && identity.ino > 0n;
}

function assertSharedResourceOverlapCandidateComparable(
  resource: SharedResourceMount,
  source: SharedResourceDirectoryInspection,
  projectIdentity: SharedResourceFileIdentity,
): void {
  if (
    source.ancestors.some((ancestor) =>
      sameSharedResourceIdentity(ancestor.identity, projectIdentity),
    )
  ) {
    return;
  }
  const deepestAncestor = source.ancestors.at(-1);
  if (
    !deepestAncestor ||
    !isComparableFileIdentity(deepestAncestor.identity) ||
    !isComparableFileIdentity(projectIdentity)
  ) {
    throw new Error(
      `Other repo shared resource identity cannot be compared safely: ${resource.sourcePath}`,
    );
  }
  if (process.platform === "win32") {
    if (
      source.ancestors.some((ancestor) => isWindowsUncPath(ancestor.realPath)) ||
      deepestAncestor.identity.dev !== projectIdentity.dev
    ) {
      throw new Error(
        `Other repo Windows shared resource identity cannot be compared safely: ${resource.sourcePath}`,
      );
    }
  }
}

function sameSharedResourceIdentity(
  left: SharedResourceFileIdentity,
  right: SharedResourceFileIdentity,
): boolean {
  return (
    isComparableFileIdentity(left) &&
    isComparableFileIdentity(right) &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

function uniqueSharedResourceAncestors(
  ancestors: SharedResourceDirectoryAncestor[],
): SharedResourceDirectoryAncestor[] {
  const unique = new Map<string, SharedResourceDirectoryAncestor>();
  for (const ancestor of ancestors) {
    const key = process.platform === "win32"
      ? ancestor.logicalPath.toLowerCase()
      : ancestor.logicalPath;
    unique.set(key, ancestor);
  }
  return [...unique.values()];
}

function isTrustedSharedResourceBoundaryAlias(
  sourceAncestor: SharedResourceDirectoryAncestor,
  protectedAncestor: SharedResourceDirectoryAncestor,
  trustedMappings: SharedResourceDirectoryInspection["mappings"],
): boolean {
  return trustedMappings.some((mapping) => {
    if (!isPathWithin(sourceAncestor.logicalPath, mapping.logicalPath)) return false;
    const relativePath = path.relative(mapping.logicalPath, sourceAncestor.logicalPath);
    const expectedRealPath = path.resolve(mapping.realPath, relativePath);
    return (
      sameFileSystemPath(expectedRealPath, protectedAncestor.logicalPath) ||
      sameFileSystemPath(expectedRealPath, protectedAncestor.realPath)
    );
  });
}

function assertSharedResourceMappingsMatchProjectBoundary(
  source: SharedResourceDirectoryInspection,
  projectRoot: SharedResourceDirectoryInspection,
  sourceIsInsideLogicalProject: boolean,
): void {
  for (const mapping of source.mappings) {
    const mappingMatchesProjectBoundary =
      sourceIsInsideLogicalProject &&
      projectRoot.mappings.some(
        (projectMapping) =>
          sameFileSystemPath(mapping.logicalPath, projectMapping.logicalPath) &&
          sameFileSystemPath(mapping.realPath, projectMapping.realPath),
      );
    if (!mappingMatchesProjectBoundary) {
      throw new Error(
        `Shared resource path contains an unsafe ancestor mapping: ${mapping.logicalPath}`,
      );
    }
  }
}

function sharedResourceInspectionsOverlapByIdentity(
  left: SharedResourceDirectoryInspection,
  right: SharedResourceDirectoryInspection,
): boolean {
  return (
    (left.finalIdentity !== undefined &&
      right.ancestors.some((ancestor) =>
        sameSharedResourceIdentity(left.finalIdentity!, ancestor.identity),
      )) ||
    (right.finalIdentity !== undefined &&
      left.ancestors.some((ancestor) =>
        sameSharedResourceIdentity(right.finalIdentity!, ancestor.identity),
      ))
  );
}

function assertSharedResourceMountSync(
  workspace: BranchWorkspace,
  resource: SharedResourceMount,
  expectedSourcePath: string,
): void {
  const workspaceRoot = path.resolve(workspace.worktreePath);
  const mountPath = path.resolve(workspaceRoot, resource.mountPath);
  if (!isPathStrictlyWithin(mountPath, workspaceRoot)) {
    throw new Error(`Shared resource mount escapes Agent workspace: ${mountPath}`);
  }

  const mountParent = path.dirname(mountPath);
  const relativeParent = path.relative(workspaceRoot, mountParent);
  const parentSegments = relativeParent.split(path.sep).filter(Boolean);
  const parentCandidates = [
    workspaceRoot,
    ...parentSegments.map((_, index) =>
      path.join(workspaceRoot, ...parentSegments.slice(0, index + 1)),
    ),
  ];
  const realWorkspaceRoot = canonicalDirectoryPathSync(workspaceRoot, "Agent workspace root");
  for (const candidate of parentCandidates) {
    const stat = lstatSync(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Shared resource mount path contains an unsafe mapping: ${candidate}`);
    }
    const realCandidate = realpathSync.native(candidate);
    if (!isPathWithin(realCandidate, realWorkspaceRoot)) {
      throw new Error(`Shared resource mount path escapes Agent workspace: ${candidate}`);
    }
  }

  const mountStat = lstatSync(mountPath);
  if (!mountStat.isSymbolicLink()) {
    throw new Error(`Shared resource mount is no longer a managed mapping: ${mountPath}`);
  }
  canonicalDirectoryPathSync(mountPath, "Shared resource mount");
  let mountIdentity: ResolvedFileSystemIdentity | undefined;
  let expectedIdentity: ResolvedFileSystemIdentity | undefined;
  try {
    const mountTargetStat = statSync(mountPath, { bigint: true });
    const expectedSourceStat = statSync(expectedSourcePath, { bigint: true });
    mountIdentity = comparableResolvedFileSystemIdentity(mountTargetStat);
    expectedIdentity = comparableResolvedFileSystemIdentity(expectedSourceStat);
  } catch (error) {
    throw new Error(
      `Shared resource mount identity cannot be resolved safely: ${mountPath}`,
      { cause: error },
    );
  }
  if (!mountIdentity || !expectedIdentity) {
    throw new Error(`Shared resource mount identity cannot be compared safely: ${mountPath}`);
  }
  if (!sameResolvedFileSystemIdentity(mountIdentity, expectedIdentity)) {
    throw new Error(`Shared resource mount points to a different directory: ${mountPath}`);
  }
}

function parseProjectIndex(content: string | undefined): ProjectIndex {
  if (content === undefined) return { projects: [] };
  try {
    const parsed = JSON.parse(content) as ProjectIndex;
    return { projects: Array.isArray(parsed.projects) ? parsed.projects : [] };
  } catch (error) {
    if (error instanceof SyntaxError) return { projects: [] };
    throw error;
  }
}

async function ensureFile(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      filePath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    await assertRegularFile(filePath, `工作文档托管文件必须是单链接普通文件: ${filePath}`);
    return;
  }
  try {
    const stat = await handle.stat();
    assertSingleLinkRegularFile(
      stat,
      `工作文档托管文件必须是单链接普通文件: ${filePath}`,
    );
    await handle.writeFile(content, { encoding: "utf-8" });
    await handle.sync();
    const pathStat = await lstatIfExists(filePath);
    assertSingleLinkRegularFile(
      pathStat,
      `工作文档托管文件必须是单链接普通文件: ${filePath}`,
    );
    if (!sameFileIdentity(stat, pathStat!)) {
      throw new Error(`工作文档托管文件在创建期间发生变化: ${filePath}`);
    }
  } finally {
    await handle.close();
  }
  await assertRegularFile(filePath, `工作文档托管文件必须是单链接普通文件: ${filePath}`);
}

async function validateRelocatedWorkspaceRoots(
  projectRoot: string,
  state: WorkspaceState,
): Promise<void> {
  const candidates = [
    ...(state.repo ? [state.repo.localRepoPath] : []),
    ...state.branches.flatMap((branch) => [branch.worktreePath, branch.scratchRoot]),
    ...state.sharedResources
      .filter((resource) => isPathWithin(resource.sourcePath, projectRoot))
      .map((resource) => resource.sourcePath),
  ];
  for (const candidate of new Set(candidates.map((entry) => path.resolve(entry)))) {
    await ensureDirectoryWithinRoot(projectRoot, candidate, {
      allowRootMapping: true,
      createMissing: false,
    });
  }
}

async function ensureDirectoryWithinRoot(
  root: string,
  target: string,
  options: { allowRootMapping?: boolean; createMissing?: boolean } = {},
): Promise<void> {
  const createMissing = options.createMissing !== false;
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (!isPathInside(resolvedTarget, resolvedRoot)) {
    throw new Error(`工作文档目录越出项目边界: ${resolvedTarget}`);
  }
  if (createMissing) await mkdir(resolvedRoot, { recursive: true });
  const rootStat = await lstat(resolvedRoot);
  if (
    (!rootStat.isDirectory() && !rootStat.isSymbolicLink()) ||
    (!options.allowRootMapping && rootStat.isSymbolicLink())
  ) {
    throw new Error(`工作文档根目录不是安全的普通目录: ${resolvedRoot}`);
  }
  const relative = path.relative(resolvedRoot, resolvedTarget);
  let current = resolvedRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    const next = path.join(current, segment);
    const stat = await lstatIfExists(next);
    if (!stat) {
      if (!createMissing) break;
      await mkdir(next);
      current = next;
      continue;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`工作文档目录包含不安全的映射或非目录路径: ${next}`);
    }
    current = next;
  }
  const [realRoot, realCurrent] = await Promise.all([
    realpath(resolvedRoot),
    realpath(current),
  ]);
  if (!isPathInside(realCurrent, realRoot)) {
    throw new Error(`工作文档目录越出项目真实路径边界: ${realCurrent}`);
  }
}

async function createDirectoryChainWithinRoot(
  root: string,
  target: string,
  createdDirectories: ManagedDirectoryOwnership[],
  options: { allowRootMapping?: boolean } = {},
): Promise<void> {
  await ensureDirectoryWithinRoot(root, target, {
    allowRootMapping: options.allowRootMapping,
    createMissing: false,
  });
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  let current = resolvedRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    const next = path.join(current, segment);
    const stat = await lstatIfExists(next);
    if (stat) {
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`Directory path contains an unsafe mapping or non-directory: ${next}`);
      }
    } else {
      await createOwnedDirectory(next, createdDirectories);
    }
    current = next;
  }
  await ensureDirectoryWithinRoot(root, target, {
    allowRootMapping: options.allowRootMapping,
    createMissing: false,
  });
}

async function assertCreatableDirectoryPath(target: string): Promise<void> {
  let current = path.resolve(target);
  while (true) {
    const stat = await lstatIfExists(current);
    if (stat) {
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`Shared resource path contains an unsafe mapping: ${current}`);
      }
      return;
    }
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`No usable parent exists for shared resource: ${target}`);
    current = parent;
  }
}

async function assertOrdinaryExistingAncestorChain(
  target: string,
  label: string,
): Promise<void> {
  const resolved = path.resolve(target);
  const root = path.parse(resolved).root;
  const segments = path.relative(root, resolved).split(path.sep).filter(Boolean);
  const candidates = [root, ...segments.map((segment, index) =>
    path.join(root, ...segments.slice(0, index + 1))
  )];
  for (const candidate of candidates) {
    const stat = await lstatIfExists(candidate);
    if (!stat) continue;
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new ManagedFileSafetyError(`${label} contains an unsafe mapping: ${candidate}`);
    }
  }
}

async function createDirectoryChainFromNearestParent(
  target: string,
  createdDirectories: ManagedDirectoryOwnership[],
): Promise<void> {
  const missing: string[] = [];
  let current = path.resolve(target);
  while (true) {
    const stat = await lstatIfExists(current);
    if (stat) {
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`Shared resource path contains an unsafe mapping: ${current}`);
      }
      break;
    }
    missing.unshift(current);
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`No usable parent exists for shared resource: ${target}`);
    current = parent;
  }
  for (const directory of missing) {
    await createOwnedDirectory(directory, createdDirectories);
  }
}

async function createOwnedDirectory(
  directory: string,
  createdDirectories: ManagedDirectoryOwnership[],
): Promise<void> {
  let mkdirError: unknown;
  try {
    await mkdir(directory);
  } catch (error) {
    mkdirError = error;
  }
  const stat = await lstatIfExists(directory);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw mkdirError ?? new Error(`Directory path changed while being created: ${directory}`);
  }
  if ((mkdirError as NodeJS.ErrnoException | undefined)?.code === "EEXIST") {
    throw mkdirError;
  }
  // Promise wrappers and filesystem shims can report an error after mkdir has
  // already committed.  The path was absent immediately before this call and
  // the observed ordinary-directory identity is therefore the only safe
  // rollback token.  Journal it before propagating the error so a transaction
  // never leaks its just-created directory.
  createdDirectories.push({
    path: directory,
    identity: { dev: stat.dev, ino: stat.ino },
  });
  if (mkdirError) throw mkdirError;
}

async function assertManagedMountOwnership(ownership: ManagedMountOwnership): Promise<void> {
  const stat = await lstatIfExists(ownership.mountPath);
  if (!stat) {
    throw new Error(`Shared resource mount disappeared: ${ownership.mountPath}`);
  }
  if (
    !stat.isSymbolicLink() ||
    stat.dev !== ownership.identity.dev ||
    stat.ino !== ownership.identity.ino
  ) {
    throw new Error(`Shared resource mount identity changed: ${ownership.mountPath}`);
  }
  if (ownership.rawTarget !== undefined) {
    const rawTarget = await readlink(ownership.mountPath);
    if (rawTarget !== ownership.rawTarget) {
      throw new Error(`Shared resource mount target changed: ${ownership.mountPath}`);
    }
  }
}

async function removeManagedMount(ownership: ManagedMountOwnership): Promise<void> {
  if (!(await lstatIfExists(ownership.mountPath))) return;
  await assertManagedMountOwnership(ownership);
  const quarantinePath = path.join(
    path.dirname(ownership.mountPath),
    `.${path.basename(ownership.mountPath)}.agent-canvas-remove-${randomUUID()}.tmp`,
  );
  if (await lstatIfExists(quarantinePath)) {
    throw new Error(`Shared resource mount quarantine already exists: ${quarantinePath}`);
  }

  let renameError: unknown;
  try {
    await rename(ownership.mountPath, quarantinePath);
  } catch (error) {
    renameError = error;
  }
  const [source, quarantined] = await Promise.all([
    lstatIfExists(ownership.mountPath),
    lstatIfExists(quarantinePath),
  ]);
  const quarantinedOwned = !!(
    quarantined?.isSymbolicLink() &&
    quarantined.dev === ownership.identity.dev &&
    quarantined.ino === ownership.identity.ino
  );
  if (!source && quarantinedOwned) {
    let unlinkError: unknown;
    try {
      await unlink(quarantinePath);
    } catch (error) {
      unlinkError = error;
    }
    if (!(await lstatIfExists(quarantinePath))) return;
    throw unlinkError ?? new Error(`Shared resource mount quarantine remains: ${quarantinePath}`);
  }
  if (
    source?.isSymbolicLink() &&
    source.dev === ownership.identity.dev &&
    source.ino === ownership.identity.ino &&
    !quarantined
  ) {
    throw renameError ?? new Error(`Shared resource mount was not quarantined: ${ownership.mountPath}`);
  }
  throw new Error(
    `Shared resource mount removal became ambiguous; no unverified path was deleted: ${ownership.mountPath}`,
    { cause: renameError },
  );
}

async function removeCreatedDirectory(ownership: ManagedDirectoryOwnership): Promise<void> {
  const stat = await lstatIfExists(ownership.path);
  if (!stat) return;
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.dev !== ownership.identity.dev ||
    stat.ino !== ownership.identity.ino
  ) {
    throw new Error(`Created directory changed before rollback: ${ownership.path}`);
  }
  const current = await lstat(ownership.path);
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    current.dev !== ownership.identity.dev ||
    current.ino !== ownership.identity.ino
  ) {
    throw new Error(`Created directory changed during rollback: ${ownership.path}`);
  }
  await rmdir(ownership.path);
}

async function removeOwnedDirectoryTree(
  ownership: ManagedDirectoryOwnership,
  label: string,
): Promise<void> {
  const current = await lstatIfExists(ownership.path);
  if (!current) return;
  assertOwnedOrdinaryDirectory(current, ownership.identity, ownership.path, label);
  const tombstone = path.join(
    path.dirname(ownership.path),
    `.${path.basename(ownership.path)}.agent-canvas-rollback-${randomUUID()}`,
  );
  await stageOwnedDirectoryRename(ownership.path, tombstone, ownership.identity, {
    operation: `staging ${label} rollback`,
    sourceLabel: label,
    targetLabel: `${label} rollback tombstone`,
  });
  await rm(tombstone, { recursive: true, force: false });
}

async function stageOwnedDirectoryRename(
  sourcePath: string,
  targetPath: string,
  expected: { dev: number; ino: number },
  labels: {
    operation: string;
    sourceLabel: string;
    targetLabel: string;
  },
): Promise<void> {
  const sourceBefore = await lstatIfExists(sourcePath);
  assertOwnedOrdinaryDirectory(sourceBefore, expected, sourcePath, labels.sourceLabel);
  if (await lstatIfExists(targetPath)) {
    throw new Error(`${labels.targetLabel} already exists: ${targetPath}`);
  }

  let renameError: unknown;
  try {
    await rename(sourcePath, targetPath);
  } catch (error) {
    renameError = error;
  }

  try {
    const [sourceAfter, targetAfter] = await Promise.all([
      lstatIfExists(sourcePath),
      lstatIfExists(targetPath),
    ]);
    if (!sourceAfter && ownedOrdinaryDirectoryMatches(targetAfter, expected)) {
      // A wrapped/platform rename may report an error after committing. Treat the
      // observed, identity-checked move as authoritative success.
      return;
    }
    if (ownedOrdinaryDirectoryMatches(sourceAfter, expected) && !targetAfter) {
      throw renameError ?? new Error(`${labels.operation} did not move ${sourcePath}`);
    }
    throw new Error(`${labels.operation} left an ambiguous directory state: ${sourcePath}`);
  } catch (validationError) {
    try {
      await rollbackOwnedDirectoryRename(sourcePath, targetPath, expected, labels);
    } catch (rollbackError) {
      throw new AggregateError(
        [renameError ?? validationError, rollbackError],
        `${labels.operation} failed and directory rollback was incomplete`,
      );
    }
    throw renameError ?? validationError;
  }
}

async function rollbackOwnedDirectoryRename(
  sourcePath: string,
  targetPath: string,
  expected: { dev: number; ino: number },
  labels: { operation: string; sourceLabel: string; targetLabel: string },
): Promise<void> {
  const [source, target] = await Promise.all([
    lstatIfExists(sourcePath),
    lstatIfExists(targetPath),
  ]);
  if (ownedOrdinaryDirectoryMatches(source, expected) && !target) return;
  if (source || !ownedOrdinaryDirectoryMatches(target, expected)) {
    throw new Error(`${labels.operation} cannot safely restore ${labels.sourceLabel}`);
  }

  let rollbackRenameError: unknown;
  try {
    await rename(targetPath, sourcePath);
  } catch (error) {
    rollbackRenameError = error;
  }
  const [restoredSource, remainingTarget] = await Promise.all([
    lstatIfExists(sourcePath),
    lstatIfExists(targetPath),
  ]);
  if (ownedOrdinaryDirectoryMatches(restoredSource, expected) && !remainingTarget) return;
  throw new Error(
    `${labels.operation} could not restore ${labels.sourceLabel}: ${errorMessage(rollbackRenameError)}`,
    { cause: rollbackRenameError },
  );
}

function assertOwnedOrdinaryDirectory(
  actual: Stats | undefined,
  expected: { dev: number; ino: number },
  directoryPath: string,
  label: string,
): asserts actual is Stats {
  if (!ownedOrdinaryDirectoryMatches(actual, expected)) {
    throw new Error(`${label} changed or became unsafe: ${directoryPath}`);
  }
}

function ownedOrdinaryDirectoryMatches(
  actual: Stats | undefined,
  expected: { dev: number; ino: number },
): boolean {
  return !!actual &&
    actual.isDirectory() &&
    !actual.isSymbolicLink() &&
    actual.dev === expected.dev &&
    actual.ino === expected.ino;
}

async function collectRollbackError(
  errors: unknown[],
  rollback: () => Promise<void>,
): Promise<void> {
  try {
    await rollback();
  } catch (error) {
    errors.push(error);
  }
}

function managedPathKey(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function sameManagedFileSnapshot(
  left: ManagedFileSnapshot | undefined,
  right: ManagedFileSnapshot | undefined,
): boolean {
  return (
    (!left && !right) ||
    (!!left &&
      !!right &&
      left.content === right.content &&
      left.identity.dev === right.identity.dev &&
      left.identity.ino === right.identity.ino)
  );
}

function appendUniqueLineContent(content: string, lines: string[]): string {
  const existing = new Set(content.split(/\r?\n/u).filter(Boolean));
  const next = lines.filter((line) => !existing.has(line));
  if (next.length === 0) return content;
  const prefix = content && !content.endsWith("\n") ? "\n" : "";
  return `${content}${prefix}${next.join("\n")}\n`;
}

async function assertRegularFile(filePath: string, message: string): Promise<void> {
  const stat = await lstatIfExists(filePath);
  assertSingleLinkRegularFile(stat, message);
}

async function assertOrdinaryDirectory(directoryPath: string, message: string): Promise<void> {
  const stat = await lstatIfExists(directoryPath);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error(message);
}

async function captureProjectRootBoundary(projectRoot: string): Promise<ProjectRootBoundary> {
  return await captureManagedTrustedRootBoundary(projectRoot, "Canvas project root");
}

async function assertProjectRootBoundary(
  projectRoot: string,
  expected: ProjectRootBoundary,
): Promise<void> {
  if (!sameFileSystemPath(expected.path, projectRoot)) {
    throw new Error(`Canvas project root boundary does not match: ${projectRoot}`);
  }
  try {
    await assertManagedTrustedRootBoundary(expected, "Canvas project root");
  } catch (error) {
    throw new Error(`Canvas project root identity changed: ${projectRoot}`, { cause: error });
  }
}

async function assertRegularFileIfExists(filePath: string, message: string): Promise<void> {
  const stat = await lstatIfExists(filePath);
  if (stat) assertSingleLinkRegularFile(stat, message);
}

async function readRegularFile(filePath: string): Promise<string> {
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const pathStat = await lstatIfExists(filePath);
  assertSingleLinkRegularFile(
    pathStat,
    `工作文档索引必须是单链接普通文件: ${filePath}`,
  );
  const handle = await open(filePath, constants.O_RDONLY | noFollow);
  try {
    const stat = await handle.stat();
    assertSingleLinkRegularFile(stat, `工作文档索引必须是单链接普通文件: ${filePath}`);
    if (!sameFileIdentity(pathStat!, stat)) {
      throw new Error(`工作文档索引在读取前发生变化: ${filePath}`);
    }
    const content = await handle.readFile({ encoding: "utf-8" });
    const after = await lstatIfExists(filePath);
    assertSingleLinkRegularFile(after, `工作文档索引必须是单链接普通文件: ${filePath}`);
    if (!sameFileIdentity(stat, after!)) {
      throw new Error(`工作文档索引在读取期间发生变化: ${filePath}`);
    }
    return content;
  } finally {
    await handle.close();
  }
}

async function replaceRegularFileAtomically(filePath: string, content: string): Promise<void> {
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const original = await lstatIfExists(filePath);
  assertSingleLinkRegularFile(
    original,
    `工作文档索引必须是单链接普通文件: ${filePath}`,
  );
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.agent-canvas-${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
      original!.mode & 0o777,
    );
    const temporary = await handle.stat();
    assertSingleLinkRegularFile(
      temporary,
      `工作文档临时索引必须是单链接普通文件: ${temporaryPath}`,
    );
    await handle.writeFile(content, { encoding: "utf-8" });
    await handle.sync();
    await handle.close();
    handle = undefined;

    const temporaryPathStat = await lstatIfExists(temporaryPath);
    assertSingleLinkRegularFile(
      temporaryPathStat,
      `工作文档临时索引必须是单链接普通文件: ${temporaryPath}`,
    );
    if (!sameFileIdentity(temporary, temporaryPathStat!)) {
      throw new Error(`工作文档临时索引在写入期间发生变化: ${temporaryPath}`);
    }
    const current = await lstatIfExists(filePath);
    assertSingleLinkRegularFile(
      current,
      `工作文档索引必须是单链接普通文件: ${filePath}`,
    );
    if (!sameFileIdentity(original!, current!)) {
      throw new Error(`工作文档索引在替换前发生变化: ${filePath}`);
    }
    await rename(temporaryPath, filePath);
    const replaced = await lstatIfExists(filePath);
    assertSingleLinkRegularFile(
      replaced,
      `工作文档索引必须是单链接普通文件: ${filePath}`,
    );
    if (!sameFileIdentity(temporary, replaced!)) {
      throw new Error(`工作文档索引原子替换校验失败: ${filePath}`);
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function assertSingleLinkRegularFile(
  stat: Stats | undefined,
  message: string,
): asserts stat is Stats {
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error(`${message}（必须是单链接普通文件）`);
  }
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function lstatIfExists(filePath: string) {
  try {
    return await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function appendUniqueLines(filePath: string, lines: string[]): Promise<void> {
  await ensureFile(filePath, "");
  const snapshot = await readManagedFileSnapshot(filePath, {
    label: "Git exclude metadata",
  });
  const content = snapshot!.content;
  const existing = new Set(content.split(/\r?\n/u).filter(Boolean));
  const next = lines.filter((line) => !existing.has(line));
  if (next.length === 0) return;
  const prefix = content && !content.endsWith("\n") ? "\n" : "";
  await writeManagedFileAtomically(
    filePath,
    `${content}${prefix}${next.join("\n")}\n`,
    {
      label: "Git exclude metadata",
      expectedContent: content,
      expectedIdentity: snapshot!.identity,
    },
  );
}

function parseGitHubConnection(connection: GitHubConnection): GitHubConnection {
  const parsed =
    connection.remoteUrl.match(/github\.com[:/](?<owner>[^/]+)\/(?<repo>[^/.]+)(?:\.git)?$/u)
      ?.groups ?? {};
  return {
    ...connection,
    owner: parsed.owner,
    repo: parsed.repo,
  };
}

function parseDiffNameStatus(line: string): { status: string; path: string } {
  const [status = "", ...rest] = line.split(/\s+/u);
  return { status, path: rest.join(" ") };
}

function normalizeRemoteUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function normalizeRepositoryLocation(value: string, relativeTo: string): string {
  if (/^file:/iu.test(value) || path.isAbsolute(value)) return value;
  if (/^[a-z][a-z\d+.-]*:\/\//iu.test(value)) return value;
  if (/^(?:[^@/\\]+@)?[^:/\\]+:.+/u.test(value)) return value;
  return path.resolve(relativeTo, value);
}

function normalizeBranch(value: string): string {
  const branch = value.trim();
  if (!branch) throw new Error("branch 不能为空");
  if (
    /[\u0000-\u001f ~^:?*\\]/u.test(branch) ||
    branch.includes("..") ||
    branch.startsWith("-") ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.includes("//")
  ) {
    throw new Error("branch 名称不合法");
  }
  return branch;
}

function normalizeName(value: string): string {
  const name = value.trim();
  if (!name) throw new Error("名称不能为空");
  return name;
}

function normalizeOptionalProjectRoot(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? path.resolve(trimmed) : undefined;
}

function normalizeRequiredProjectRoot(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("项目文件夹不能为空");
  return path.resolve(trimmed);
}

function normalizeRelativePath(value: string): string {
  const normalized = value.replace(/\\/gu, "/").trim();
  if (
    !normalized ||
    normalized.startsWith("/") ||
    path.posix.isAbsolute(normalized) ||
    path.win32.isAbsolute(normalized) ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("共享资源挂载路径必须是工作区内的相对路径");
  }
  return normalized;
}

function normalizeIgnorePattern(value: string): string {
  const normalized = value
    .replace(/\\/gu, "/")
    .replace(/^\/+/u, "")
    .replace(/\/+$/u, "");
  return `/${normalized}`;
}

function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function safePathPart(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return sanitized || createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function maxNumericSuffix(ids: string[]): number {
  return ids.reduce((max, id) => {
    const value = Number(id.match(/_(\d+)$/u)?.[1] ?? 0);
    return Number.isFinite(value) ? Math.max(max, value) : max;
  }, 0);
}

function projectIdFromRoot(root: string): string {
  return safePathPart(path.basename(root)) || createHash("sha256").update(root).digest("hex").slice(0, 12);
}

function projectIdFromExplicitRoot(root: string): string {
  const name = safePathPart(path.basename(root));
  const hash = createHash("sha256")
    .update(normalizedRootKey(root))
    .digest("hex")
    .slice(0, 12);
  return name ? `${name}-${hash}` : hash;
}

function parseWorkspaceDocument(value: unknown, projectRoot: string): WorkspaceDocument {
  if (!isRecord(value)) throw invalidWorkspace(projectRoot, "根节点必须是对象");
  if (value.schema !== WORKSPACE_SCHEMA) {
    throw invalidWorkspace(projectRoot, `schema 必须为 ${WORKSPACE_SCHEMA}`);
  }
  if (value.version !== WORKSPACE_VERSION) {
    throw invalidWorkspace(projectRoot, `不支持的 version: ${String(value.version)}`);
  }
  const project = parseProjectSummary(value.project, projectRoot);
  const repo = value.repo === undefined ? undefined : parseRepository(value.repo, projectRoot);
  const branches = parseArray(value.branches, "branches", projectRoot).map((branch) =>
    parseBranchWorkspace(branch, projectRoot),
  );
  const sharedResources = parseArray(
    value.sharedResources,
    "sharedResources",
    projectRoot,
  ).map((resource) => parseSharedResource(resource, projectRoot));
  ensureUniqueIds(branches, "branch", projectRoot);
  ensureUniqueIds(sharedResources, "shared resource", projectRoot);
  if (!repo && (branches.length > 0 || sharedResources.length > 0)) {
    throw invalidWorkspace(projectRoot, "未连接 repo 时不能包含 branch 或 shared resource");
  }
  if (repo) {
    if (branches.some((branch) => branch.repoId !== repo.id)) {
      throw invalidWorkspace(projectRoot, "branch.repoId 与 repo.id 不匹配");
    }
    if (sharedResources.some((resource) => resource.repoId !== repo.id)) {
      throw invalidWorkspace(projectRoot, "sharedResource.repoId 与 repo.id 不匹配");
    }
  }
  return {
    schema: WORKSPACE_SCHEMA,
    version: WORKSPACE_VERSION,
    project,
    repo,
    branches,
    sharedResources,
  };
}

function parseProjectSummary(value: unknown, projectRoot: string): CanvasProjectSummary {
  const record = requiredRecord(value, "project", projectRoot);
  const storedRoot = requiredAbsolutePath(record.projectRoot, "project.projectRoot", projectRoot);
  const openedAt = optionalTimestamp(record.openedAt, "project.openedAt", projectRoot);
  return {
    id: requiredIdentifier(record.id, "project.id", projectRoot),
    name: requiredString(record.name, "project.name", projectRoot),
    projectRoot: storedRoot,
    createdAt: requiredTimestamp(record.createdAt, "project.createdAt", projectRoot),
    ...(openedAt === undefined ? {} : { openedAt }),
  };
}

function parseRepository(value: unknown, projectRoot: string): GitHubConnection {
  const record = requiredRecord(value, "repo", projectRoot);
  const owner = optionalString(record.owner, "repo.owner", projectRoot);
  const repoName = optionalString(record.repo, "repo.repo", projectRoot);
  return {
    id: requiredIdentifier(record.id, "repo.id", projectRoot),
    remoteUrl: requiredString(record.remoteUrl, "repo.remoteUrl", projectRoot),
    ...(owner === undefined ? {} : { owner }),
    ...(repoName === undefined ? {} : { repo: repoName }),
    defaultBranch: normalizeBranch(requiredString(record.defaultBranch, "repo.defaultBranch", projectRoot)),
    localRepoPath: requiredAbsolutePath(record.localRepoPath, "repo.localRepoPath", projectRoot),
    connectedAt: requiredTimestamp(record.connectedAt, "repo.connectedAt", projectRoot),
  };
}

function parseBranchWorkspace(value: unknown, projectRoot: string): BranchWorkspace {
  const record = requiredRecord(value, "branch", projectRoot);
  const baseBranch = optionalString(record.baseBranch, "branch.baseBranch", projectRoot);
  return {
    id: requiredIdentifier(record.id, "branch.id", projectRoot),
    repoId: requiredIdentifier(record.repoId, "branch.repoId", projectRoot),
    branch: normalizeBranch(requiredString(record.branch, "branch.branch", projectRoot)),
    ...(baseBranch === undefined ? {} : { baseBranch: normalizeBranch(baseBranch) }),
    worktreePath: requiredAbsolutePath(record.worktreePath, "branch.worktreePath", projectRoot),
    scratchRoot: requiredAbsolutePath(record.scratchRoot, "branch.scratchRoot", projectRoot),
    isDefault: requiredBoolean(record.isDefault, "branch.isDefault", projectRoot),
    createdAt: requiredTimestamp(record.createdAt, "branch.createdAt", projectRoot),
  };
}

function parseSharedResource(value: unknown, projectRoot: string): SharedResourceMount {
  const record = requiredRecord(value, "shared resource", projectRoot);
  const access = record.access;
  if (access !== "readOnly" && access !== "readWrite") {
    throw invalidWorkspace(projectRoot, "sharedResource.access 必须为 readOnly 或 readWrite");
  }
  return {
    id: requiredIdentifier(record.id, "sharedResource.id", projectRoot),
    repoId: requiredIdentifier(record.repoId, "sharedResource.repoId", projectRoot),
    name: requiredString(record.name, "sharedResource.name", projectRoot),
    sourcePath: requiredAbsolutePath(record.sourcePath, "sharedResource.sourcePath", projectRoot),
    mountPath: validateStoredRelativePath(
      requiredString(record.mountPath, "sharedResource.mountPath", projectRoot),
      projectRoot,
    ),
    access,
    createdAt: requiredTimestamp(record.createdAt, "sharedResource.createdAt", projectRoot),
  };
}

function relocateWorkspace(
  document: WorkspaceDocument,
  targetRoot: string,
  options: {
    requireExternalTrust: boolean;
    trustedExternalResourcePaths?: string[];
  },
): RelocatedWorkspace {
  const oldRoot = path.resolve(document.project.projectRoot);
  const nextRoot = path.resolve(targetRoot);
  const trustedExternalIdentities = options.requireExternalTrust
    ? (options.trustedExternalResourcePaths ?? []).map((resourcePath) => {
        const resolvedPath = path.resolve(resourcePath);
        const identity = resolvedDirectoryIdentitySync(resolvedPath);
        if (!identity) {
          throw new Error(`外部共享资源授权路径的文件系统身份无法安全验证: ${resolvedPath}`);
        }
        return identity;
      })
    : [];
  const relocateInternal = (storedPath: string, label: string): string => {
    if (!isPathWithinCaseSensitive(storedPath, oldRoot)) {
      throw invalidWorkspace(targetRoot, `${label} 必须位于项目目录内`);
    }
    const relative = path.relative(oldRoot, storedPath);
    return path.resolve(nextRoot, relative);
  };
  const repo = document.repo
    ? {
        ...document.repo,
        localRepoPath: relocateInternal(document.repo.localRepoPath, "repo.localRepoPath"),
      }
    : undefined;
  if (repo && !isRepoStoragePath(repo.localRepoPath, nextRoot, repo.id)) {
    throw invalidWorkspace(targetRoot, "repo.localRepoPath 不符合项目内部目录约定");
  }
  const branches = document.branches.map((branch) => {
    const worktreePath = relocateInternal(branch.worktreePath, "branch.worktreePath");
    const scratchRoot = relocateInternal(branch.scratchRoot, "branch.scratchRoot");
    if (!isBranchStoragePath(worktreePath, nextRoot, branch.repoId, repo?.localRepoPath)) {
      throw invalidWorkspace(targetRoot, `branch ${branch.id} 的 worktreePath 不合法`);
    }
    if (normalizedRootKey(scratchRoot) !== normalizedRootKey(path.join(worktreePath, ".agent-tmp"))) {
      throw invalidWorkspace(targetRoot, `branch ${branch.id} 的 scratchRoot 不合法`);
    }
    return { ...branch, worktreePath, scratchRoot };
  });
  const externalSharedResources: CanvasProjectInspection["externalSharedResources"] = [];
  const sharedResources = document.sharedResources.map((resource) => {
    let sourcePath: string;
    if (isPathWithinCaseSensitive(resource.sourcePath, oldRoot)) {
      sourcePath = relocateInternal(resource.sourcePath, "sharedResource.sourcePath");
      if (!isPathWithinCaseSensitive(sourcePath, path.join(nextRoot, "shared"))) {
        throw invalidWorkspace(targetRoot, `shared resource ${resource.id} 的内部路径不合法`);
      }
    } else {
      sourcePath = path.resolve(resource.sourcePath);
      externalSharedResources.push({
        id: resource.id,
        name: resource.name,
        sourcePath,
        access: resource.access,
      });
      if (options.requireExternalTrust) {
        const sourceIdentity = resolvedDirectoryIdentitySync(sourcePath);
        if (
          !sourceIdentity ||
          !trustedExternalIdentities.some((trustedIdentity) =>
            sameResolvedFileSystemIdentity(sourceIdentity, trustedIdentity),
          )
        ) {
          throw new Error(`外部共享资源需要重新授权: ${sourcePath}`);
        }
      }
    }
    return { ...resource, sourcePath };
  });
  const project = { ...document.project, projectRoot: nextRoot };
  return {
    project,
    state: { project, repo, branches, sharedResources },
    externalSharedResources,
  };
}

function isRepoStoragePath(candidate: string, projectRoot: string, repoId: string): boolean {
  return normalizedRootKey(candidate) === normalizedRootKey(path.join(projectRoot, "repos", repoId, "repo"));
}

function isBranchStoragePath(
  candidate: string,
  projectRoot: string,
  repoId: string,
  localRepoPath: string | undefined,
): boolean {
  if (localRepoPath && normalizedRootKey(candidate) === normalizedRootKey(localRepoPath)) return true;
  return isPathWithin(candidate, path.join(projectRoot, "worktrees", repoId));
}

function validateStoredRelativePath(value: string, projectRoot: string): string {
  const normalized = value.replace(/\\/gu, "/").trim();
  if (
    !normalized ||
    normalized.startsWith("/") ||
    path.posix.isAbsolute(normalized) ||
    path.win32.isAbsolute(normalized) ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw invalidWorkspace(projectRoot, "sharedResource.mountPath 必须是安全相对路径");
  }
  return normalized;
}

function requiredRecord(
  value: unknown,
  field: string,
  projectRoot: string,
): Record<string, unknown> {
  if (!isRecord(value)) throw invalidWorkspace(projectRoot, `${field} 必须是对象`);
  return value;
}

function parseArray(value: unknown, field: string, projectRoot: string): unknown[] {
  if (!Array.isArray(value)) throw invalidWorkspace(projectRoot, `${field} 必须是数组`);
  return value;
}

function requiredString(value: unknown, field: string, projectRoot: string): string {
  const parsed = nonEmptyString(value);
  if (!parsed) throw invalidWorkspace(projectRoot, `${field} 必须是非空字符串`);
  return parsed;
}

function optionalString(value: unknown, field: string, projectRoot: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, field, projectRoot);
}

function requiredIdentifier(value: unknown, field: string, projectRoot: string): string {
  const parsed = requiredString(value, field, projectRoot);
  if (!/^[a-zA-Z0-9._-]+$/u.test(parsed)) {
    throw invalidWorkspace(projectRoot, `${field} 包含非法字符`);
  }
  return parsed;
}

function requiredAbsolutePath(value: unknown, field: string, projectRoot: string): string {
  const parsed = requiredString(value, field, projectRoot);
  if (!path.isAbsolute(parsed)) throw invalidWorkspace(projectRoot, `${field} 必须是绝对路径`);
  return path.resolve(parsed);
}

function requiredTimestamp(value: unknown, field: string, projectRoot: string): number {
  const parsed = finiteTimestamp(value);
  if (parsed === undefined) throw invalidWorkspace(projectRoot, `${field} 必须是有效时间戳`);
  return parsed;
}

function optionalTimestamp(value: unknown, field: string, projectRoot: string): number | undefined {
  if (value === undefined) return undefined;
  return requiredTimestamp(value, field, projectRoot);
}

function requiredBoolean(value: unknown, field: string, projectRoot: string): boolean {
  if (typeof value !== "boolean") throw invalidWorkspace(projectRoot, `${field} 必须是布尔值`);
  return value;
}

function ensureUniqueIds(
  values: Array<{ id: string }>,
  label: string,
  projectRoot: string,
): void {
  const ids = new Set<string>();
  for (const value of values) {
    if (ids.has(value.id)) throw invalidWorkspace(projectRoot, `${label} id 重复: ${value.id}`);
    ids.add(value.id);
  }
}

function invalidWorkspace(projectRoot: string, message: string): Error {
  return new Error(`Canvas 项目配置格式不合法 (${path.resolve(projectRoot)}): ${message}`);
}

function uniqueProjectIds(projects: CanvasProjectSummary[]): CanvasProjectSummary[] {
  const rootsById = new Map<string, string>();
  return projects.map((project) => {
    const rootKey = normalizedRootKey(project.projectRoot);
    const existingRoot = rootsById.get(project.id);
    if (!existingRoot || existingRoot === rootKey) {
      rootsById.set(project.id, rootKey);
      return project;
    }
    const id = projectIdFromExplicitRoot(project.projectRoot);
    rootsById.set(id, rootKey);
    return { ...project, id };
  });
}

function normalizedRootKey(root: string): string {
  const resolved = path.resolve(root);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function normalizeRepositoryIdentity(identity: string): string {
  const trimmed = identity.trim();
  if (/^file:/iu.test(trimmed)) {
    try {
      return normalizedRootKey(fileURLToPath(trimmed));
    } catch {
      // Preserve invalid/opaque values exactly; lower-casing them can merge distinct identities.
      return trimmed;
    }
  }
  if (path.isAbsolute(trimmed)) return normalizedRootKey(trimmed);
  const isRemoteUrl = /^[a-z][a-z\d+.-]*:\/\//iu.test(trimmed);
  const isScpRemote = /^(?:[^@/\\]+@)?[^:/\\]+:.+/u.test(trimmed);
  if (isRemoteUrl || isScpRemote) {
    // Preserve the existing remote-repository key scheme so an upgrade does not silently
    // detach a branch from its established shared documentation directory. Local filesystem
    // identities are the only identities whose case semantics depend on the host platform.
    return trimmed.toLowerCase();
  }
  const normalized = path.normalize(trimmed);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isPathWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`) && relative !== "..")
  );
}

function isPathWithinCaseSensitive(candidate: string, parent: string): boolean {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedParent = path.resolve(parent);
  if (resolvedCandidate === resolvedParent) return true;
  const parentPrefix = resolvedParent.endsWith(path.sep)
    ? resolvedParent
    : `${resolvedParent}${path.sep}`;
  return resolvedCandidate.startsWith(parentPrefix);
}

function resolvedDirectoryIdentitySync(candidatePath: string): ResolvedFileSystemIdentity | undefined {
  try {
    const candidate = statSync(candidatePath, { bigint: true });
    return candidate.isDirectory() ? comparableResolvedFileSystemIdentity(candidate) : undefined;
  } catch {
    return undefined;
  }
}

function sameExistingDirectoryIdentitySync(leftPath: string, rightPath: string): boolean {
  const left = resolvedDirectoryIdentitySync(path.resolve(leftPath));
  const right = resolvedDirectoryIdentitySync(path.resolve(rightPath));
  return Boolean(left && right && sameResolvedFileSystemIdentity(left, right));
}

function isPathStrictlyWithin(candidate: string, parent: string): boolean {
  return !sameFileSystemPath(candidate, parent) && isPathWithin(candidate, parent);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finiteTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultProjectRoot(defaultSourcePath: string): string {
  const key = createHash("sha256")
    .update(normalizedRootKey(defaultSourcePath))
    .digest("hex")
    .slice(0, 12);
  return path.join(defaultProjectsRoot(), key);
}

function defaultProjectsRoot(): string {
  const localDataRoot =
    process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".local", "share");
  return path.join(localDataRoot, "agent_canvas", "projects");
}
