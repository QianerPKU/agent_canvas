import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants, type Dirent } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
    const index = await this.readProjectIndex();
    const byRoot = new Map<string, CanvasProjectSummary>();
    for (const indexed of index.projects) {
      try {
        const project = await this.readProjectSummary(indexed.projectRoot, indexed);
        byRoot.set(normalizedRootKey(project.projectRoot), project);
      } catch {
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
      } catch {
        // A configured project root may be intentionally empty until its first save.
      }
      const key = normalizedRootKey(current.projectRoot);
      byRoot.set(key, { ...byRoot.get(key), ...current });
    }
    const projects = uniqueProjectIds([...byRoot.values()]).sort(
      (a, b) => (b.openedAt ?? b.createdAt) - (a.openedAt ?? a.createdAt),
    );
    await this.writeProjectIndex(projects);
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
    await mkdir(projectRoot, { recursive: true });
    this.selectProject(project, { branches: [], sharedResources: [] });
    await this.saveState();
    return project;
  }

  async openCanvasProject(input: OpenCanvasProjectInput): Promise<WorkspaceProject> {
    return await this.queueProjectMutation(() => this.openCanvasProjectInternal(input));
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
    if (
      indexed &&
      projectRoot &&
      normalizedRootKey(indexed.projectRoot) !== normalizedRootKey(projectRoot)
    ) {
      throw new Error("项目 id 与项目文件夹不匹配");
    }
    const resolvedRoot = path.resolve(projectRoot ?? indexed!.projectRoot);
    const registered =
      indexed ??
      projects.find(
        (candidate) => normalizedRootKey(candidate.projectRoot) === normalizedRootKey(resolvedRoot),
      );
    const document = await this.readWorkspaceDocument(resolvedRoot);
    const relocated = relocateWorkspace(document, resolvedRoot, {
      requireExternalTrust: !registered,
      trustedExternalResourcePaths: input.trustedExternalResourcePaths,
    });
    let project = { ...relocated.project, id: registered?.id ?? relocated.project.id };
    if (
      !registered &&
      projects.some(
        (candidate) =>
          candidate.id === project.id &&
          normalizedRootKey(candidate.projectRoot) !== normalizedRootKey(resolvedRoot),
      )
    ) {
      project = { ...project, id: projectIdFromExplicitRoot(resolvedRoot) };
    }
    const opened = { ...project, projectRoot: resolvedRoot, openedAt: this.now() };
    this.selectProject(opened, { ...relocated.state, project: opened });
    await this.saveState();
    return this.snapshot();
  }

  async inspectCanvasProject(projectRoot: string): Promise<CanvasProjectInspection> {
    const resolvedRoot = path.resolve(normalizeRequiredProjectRoot(projectRoot));
    const document = await this.readWorkspaceDocument(resolvedRoot);
    const relocated = relocateWorkspace(document, resolvedRoot, {
      requireExternalTrust: false,
    });
    return {
      project: relocated.project,
      externalSharedResources: relocated.externalSharedResources,
    };
  }

  async deleteCanvasProject(id: string): Promise<CanvasProjectSummary> {
    return await this.queueProjectMutation(() => this.deleteCanvasProjectInternal(id));
  }

  private async deleteCanvasProjectInternal(id: string): Promise<CanvasProjectSummary> {
    const project = (await this.listCanvasProjects()).find((candidate) => candidate.id === id);
    if (!project) throw new Error(`未知 canvas 项目: ${id}`);
    const projectRoot = path.resolve(project.projectRoot);
    const document = await this.readWorkspaceDocument(projectRoot);
    relocateWorkspace(document, projectRoot, { requireExternalTrust: false });
    if (isPathWithin(this.projectsRoot, projectRoot)) {
      throw new Error("不能删除包含项目列表根目录的文件夹");
    }
    if (path.parse(projectRoot).root === projectRoot) throw new Error("不能删除文件系统根目录");
    const deletingCurrentProject =
      normalizedRootKey(this.currentProject?.projectRoot ?? "") ===
      normalizedRootKey(projectRoot);
    if (deletingCurrentProject) this.advanceProjectGeneration();
    await rm(projectRoot, { recursive: true, force: false });
    const index = await this.readProjectIndex();
    await this.writeProjectIndex(
      index.projects.filter(
        (candidate) =>
          candidate.id !== id &&
          normalizedRootKey(candidate.projectRoot) !== normalizedRootKey(projectRoot),
      ),
    );
    if (deletingCurrentProject) {
      this.projectRoot = undefined;
      this.currentProject = undefined;
      this.state = { branches: [], sharedResources: [] };
      this.stateLoaded = false;
      this.branchCounter = 0;
      this.resourceCounter = 0;
    }
    return project;
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
    const projectRoot = this.requireProjectRoot();
    await mkdir(projectRoot, { recursive: true });
    const source = path.resolve(input.localPath ?? this.defaultSourcePath);
    const cloneSource = normalizeRemoteUrl(input.remoteUrl) ?? source;
    const remoteUrl = normalizeRemoteUrl(input.remoteUrl) ?? (await this.remoteUrlOf(source)) ?? source;
    const defaultBranch =
      input.defaultBranch?.trim() || (await this.currentBranch(source)) || "main";
    const localRepoPath = this.localRepoPath(DEFAULT_REPO_ID);
    await ensureCloned(this.runGit, cloneSource, localRepoPath);
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
    await this.saveState();
    return this.snapshot();
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
    const branch = normalizeBranch(input.branch);
    const existing = this.state.branches.find((candidate) => candidate.branch === branch);
    if (existing) return existing;
    const baseBranch = input.baseBranch?.trim() || repo.defaultBranch;
    const id = `branch_${++this.branchCounter}`;
    const useBaseClone = this.state.branches.length === 0 && branch === repo.defaultBranch;
    const worktreePath = useBaseClone
      ? repo.localRepoPath
      : this.branchWorktreePath(repo.id, branch);
    if (!useBaseClone) await mkdir(path.dirname(worktreePath), { recursive: true });
    if (!useBaseClone && !(await exists(worktreePath))) {
      const startPoint = await this.branchStartPoint(repo, branch, baseBranch);
      await this.runGit(["worktree", "add", "-B", branch, worktreePath, startPoint], {
        cwd: repo.localRepoPath,
      });
    }
    const scratchRoot = path.join(worktreePath, ".agent-tmp");
    await mkdir(scratchRoot, { recursive: true });
    const workspace: BranchWorkspace = {
      id,
      repoId: repo.id,
      branch,
      baseBranch,
      worktreePath,
      scratchRoot,
      isDefault: this.state.branches.length === 0,
      createdAt: this.now(),
    };
    this.state.branches.push(workspace);
    await this.ensureIgnored(workspace, [".agent-tmp/"]);
    await this.applySharedResources(workspace);
    await this.saveState();
    return workspace;
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
    const id = `shared_${++this.resourceCounter}`;
    const sourcePath = path.resolve(
      input.sourcePath?.trim() || path.join(projectRoot, "shared", repo.id, safePathPart(name)),
    );
    await mkdir(sourcePath, { recursive: true });
    const resource: SharedResourceMount = {
      id,
      repoId: repo.id,
      name,
      sourcePath,
      mountPath,
      access: input.access ?? "readOnly",
      createdAt: this.now(),
    };
    this.state.sharedResources.push(resource);
    await this.applyResourceToAllBranches(resource);
    await this.saveState();
    return resource;
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
    let targetRef = target;
    try {
      await this.runGit(
        ["fetch", "origin", `+refs/heads/${target}:refs/remotes/origin/${target}`],
        { cwd: repo.localRepoPath },
      );
      targetRef = `origin/${target}`;
    } catch {
      // Local-only targets can still be checked by branch name.
    }
    try {
      await this.runGit(["merge-base", "--is-ancestor", targetRef, source], {
        cwd: repo.localRepoPath,
      });
    } catch {
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
    const branch = sourceBranch?.trim();
    if (branch) {
      try {
        await this.runGit(
          ["fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
          { cwd: repo.localRepoPath },
        );
      } catch {
        // The commit may already exist locally, or sourceBranch may be local-only.
      }
    }
    try {
      const output = await this.runGit(
        ["show", "--format=", "--name-status", "--find-renames", commit],
        { cwd: repo.localRepoPath },
      );
      return output
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean)
        .map(parseDiffNameStatus);
    } catch {
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
    try {
      const output = await this.runGit(["diff", "--name-status", ...refs], {
        cwd: repo.localRepoPath,
      });
      return {
        fromBranch,
        toBranch,
        files: output
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .filter(Boolean)
          .map(parseDiffNameStatus),
      };
    } catch {
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
    config: Pick<AgentStartConfig, "branchWorkspaceId"> | undefined,
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
    const sharedResources: AgentSharedResourceReference[] = resources.map((resource) => ({
      name: resource.name,
      mountPath: path.join(workspace.worktreePath, resource.mountPath),
      sourcePath: resource.sourcePath,
      access: resource.access,
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
          ]
        : [],
      writableDirectories: [
        ...resources
          .filter((resource) => resource.access === "readWrite")
          .map((resource) => resource.sourcePath),
      ],
      sharedResources,
    };
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

  private selectProject(project: CanvasProjectSummary, state?: WorkspaceState): void {
    this.advanceProjectGeneration();
    this.currentProject = { ...project, projectRoot: path.resolve(project.projectRoot) };
    this.projectRoot = this.currentProject.projectRoot;
    this.state = state ?? { branches: [], sharedResources: [] };
    this.stateLoaded = state !== undefined;
    this.branchCounter = maxNumericSuffix(this.state.branches.map((branch) => branch.id));
    this.resourceCounter = maxNumericSuffix(
      this.state.sharedResources.map((resource) => resource.id),
    );
  }

  private async ensureProjectOpen(): Promise<void> {
    if (this.projectRoot && this.currentProject) return;
    throw new Error("尚未打开 canvas 项目");
  }

  private requireProjectRoot(): string {
    if (!this.projectRoot) throw new Error("尚未打开 canvas 项目");
    return this.projectRoot;
  }

  private async loadStateIfNeeded(): Promise<void> {
    if (this.stateLoaded) return;
    if (!(await exists(this.statePath()))) {
      this.state = { project: this.currentProject, branches: [], sharedResources: [] };
      this.branchCounter = 0;
      this.resourceCounter = 0;
      this.stateLoaded = true;
      return;
    }
    try {
      const projectRoot = this.requireProjectRoot();
      const document = await this.readWorkspaceDocument(projectRoot);
      const relocated = relocateWorkspace(document, projectRoot, {
        requireExternalTrust:
          normalizedRootKey(document.project.projectRoot) !== normalizedRootKey(projectRoot),
      });
      this.currentProject = relocated.project;
      this.state = relocated.state;
      this.branchCounter = maxNumericSuffix(this.state.branches.map((branch) => branch.id));
      this.resourceCounter = maxNumericSuffix(
        this.state.sharedResources.map((resource) => resource.id),
      );
      this.stateLoaded = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.state = { project: this.currentProject, branches: [], sharedResources: [] };
      this.branchCounter = 0;
      this.resourceCounter = 0;
      this.stateLoaded = true;
    }
  }

  private async saveState(): Promise<void> {
    const statePath = this.statePath();
    this.state.project = this.currentProject;
    const document: WorkspaceDocument = {
      schema: WORKSPACE_SCHEMA,
      version: WORKSPACE_VERSION,
      project: this.currentProject!,
      repo: this.state.repo,
      branches: this.state.branches,
      sharedResources: this.state.sharedResources,
    };
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(
      statePath,
      `${JSON.stringify(document, undefined, 2)}\n`,
      "utf-8",
    );
    if (this.currentProject) await this.upsertProject(this.currentProject);
  }

  private statePath(): string {
    return path.join(this.requireProjectRoot(), WORKSPACE_STATE_FILE);
  }

  private snapshot(): WorkspaceProject {
    return {
      canvasProject: this.currentProject,
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

  private async branchStartPoint(
    repo: GitHubConnection,
    branch: string,
    baseBranch: string,
  ): Promise<string> {
    try {
      await this.runGit(
        ["fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
        { cwd: repo.localRepoPath },
      );
      return `origin/${branch}`;
    } catch {
      // New local branch: prefer the selected base branch's remote ref when it exists.
    }
    try {
      await this.runGit(
        ["fetch", "origin", `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`],
        { cwd: repo.localRepoPath },
      );
      return `origin/${baseBranch}`;
    } catch {
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

  private async applyResourceToAllBranches(resource: SharedResourceMount): Promise<void> {
    for (const workspace of this.state.branches) {
      if (workspace.repoId === resource.repoId) await this.applyResource(workspace, resource);
    }
  }

  private async applySharedResources(workspace: BranchWorkspace): Promise<void> {
    for (const resource of this.state.sharedResources) {
      if (resource.repoId === workspace.repoId) await this.applyResource(workspace, resource);
    }
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
      { allowRootMapping: true },
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

    const sharedIndex = await readRegularFile(documentation.sharedSourceIndex);
    const nextSharedIndex = ensureSharedBranchIndexEntry(
      sharedIndex,
      workspace.branch,
      documentation.branchDirectory,
    );
    if (nextSharedIndex !== sharedIndex) {
      await writeRegularFile(documentation.sharedSourceIndex, nextSharedIndex);
    }
    this.assertWorkDocumentationContextCurrent(context);
    await this.validatePreparedWorkDocumentation(context, documentation);
    this.assertWorkDocumentationContextCurrent(context);
    this.preparedWorkDocumentation.add(preparationKey);
  }

  private async preflightWorkDocumentation(
    context: WorkDocumentationContext,
    documentation: ReturnType<WorkspaceManager["workDocumentationPaths"]>,
  ): Promise<void> {
    const { workspace } = context;
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
    await this.assertWorkDocumentationUntracked(workspace);
    this.assertWorkDocumentationContextCurrent(context);

    await assertOrdinaryDirectory(
      documentation.isolatedDirectory,
      `${WORK_DOCUMENTATION_PATHS.isolatedDirectory}/ 必须是普通目录`,
    );
    await ensureDirectoryWithinRoot(workspace.worktreePath, documentation.isolatedDirectory, {
      allowRootMapping: true,
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
    await assertSameRealPath(
      documentation.sharedSourceIndex,
      documentation.sharedIndex,
      "共享工作文档索引映射已改变",
    );
    await assertSameRealPath(
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
    return createHash("sha256").update(identity.toLowerCase()).digest("hex").slice(0, 16);
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

  private async applyResource(
    workspace: BranchWorkspace,
    resource: SharedResourceMount,
  ): Promise<void> {
    const mount = path.join(workspace.worktreePath, resource.mountPath);
    await mkdir(path.dirname(mount), { recursive: true });
    await ensureLink(resource.sourcePath, mount);
    await this.ensureIgnored(workspace, [resource.mountPath]);
  }

  private async ensureIgnored(workspace: BranchWorkspace, patterns: string[]): Promise<void> {
    const excludePath = await gitPath(this.runGit, workspace.worktreePath, "info/exclude");
    const normalized = patterns.map((pattern) => normalizeIgnorePattern(pattern));
    const key = process.platform === "win32"
      ? path.resolve(excludePath).toLowerCase()
      : path.resolve(excludePath);
    const previous = this.ignoreWriteChains.get(key) ?? Promise.resolve();
    const result = previous.then(
      () => appendUniqueLines(excludePath, normalized),
      () => appendUniqueLines(excludePath, normalized),
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
    try {
      const parsed = JSON.parse(await readFile(this.projectIndexPath(), "utf-8")) as ProjectIndex;
      return { projects: Array.isArray(parsed.projects) ? parsed.projects : [] };
    } catch {
      return { projects: [] };
    }
  }

  private async upsertProject(project: CanvasProjectSummary): Promise<void> {
    const index = await this.readProjectIndex();
    const projects = [
      project,
      ...index.projects.filter(
        (candidate) =>
          candidate.id !== project.id &&
          normalizedRootKey(candidate.projectRoot) !== normalizedRootKey(project.projectRoot),
      ),
    ];
    await this.writeProjectIndex(projects);
  }

  private async writeProjectIndex(projects: CanvasProjectSummary[]): Promise<void> {
    await mkdir(this.projectsRoot, { recursive: true });
    await writeFile(
      this.projectIndexPath(),
      `${JSON.stringify({ projects }, undefined, 2)}\n`,
      "utf-8",
    );
  }

  private async discoverProjects(): Promise<CanvasProjectSummary[]> {
    let entries: Dirent[];
    try {
      entries = await readdir(this.projectsRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const projects = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          try {
            return await this.readProjectSummary(path.join(this.projectsRoot, entry.name));
          } catch {
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
    const document = await this.readWorkspaceDocument(resolvedRoot);
    const relocated = relocateWorkspace(document, resolvedRoot, {
      requireExternalTrust:
        normalizedRootKey(document.project.projectRoot) !== normalizedRootKey(resolvedRoot),
    });
    const project = relocated.project;
    return fallback && normalizedRootKey(fallback.projectRoot) === normalizedRootKey(resolvedRoot)
      ? { ...project, id: fallback.id }
      : project;
  }

  private async readWorkspaceDocument(projectRoot: string): Promise<WorkspaceDocument> {
    const resolvedRoot = path.resolve(projectRoot);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path.join(resolvedRoot, WORKSPACE_STATE_FILE), "utf-8"));
    } catch (error) {
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

async function ensureCloned(
  runGit: GitRunner,
  source: string,
  localRepoPath: string,
): Promise<void> {
  if (await exists(path.join(localRepoPath, ".git"))) return;
  await rm(localRepoPath, { recursive: true, force: true });
  await mkdir(path.dirname(localRepoPath), { recursive: true });
  await runGit(["clone", source, localRepoPath]);
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
      const [currentTarget, expectedTarget] = await Promise.all([
        realpath(mountPath),
        realpath(sourcePath),
      ]);
      if (sameFileSystemPath(currentTarget, expectedTarget)) return;
      throw new Error(
        `共享资源挂载点已映射到其他目录: ${mountPath} -> ${currentTarget}`,
      );
    }
    throw new Error(`共享资源挂载点已存在且不是映射: ${mountPath}`);
  }
  const type = process.platform === "win32" ? "junction" : "dir";
  await symlink(path.resolve(sourcePath), mountPath, type);
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
  const [currentTarget, expectedTarget] = await Promise.all([
    realpath(mountPath),
    realpath(sourcePath),
  ]);
  if (!sameFileSystemPath(currentTarget, expectedTarget)) {
    throw new Error(
      `共享资源挂载点已映射到其他目录: ${mountPath} -> ${currentTarget}`,
    );
  }
}

async function assertExistingLinkPointsTo(
  sourcePath: string,
  mountPath: string,
): Promise<void> {
  const mountStat = await lstatIfExists(mountPath);
  if (!mountStat?.isSymbolicLink()) {
    throw new Error(`共享资源挂载点缺失或不是映射: ${mountPath}`);
  }
  const [currentTarget, expectedTarget] = await Promise.all([
    realpath(mountPath),
    realpath(sourcePath),
  ]);
  if (!sameFileSystemPath(currentTarget, expectedTarget)) {
    throw new Error(`共享资源挂载点已映射到其他目录: ${mountPath} -> ${currentTarget}`);
  }
}

async function assertSameRealPath(
  expectedPath: string,
  actualPath: string,
  message: string,
): Promise<void> {
  const [expected, actual] = await Promise.all([
    realpath(expectedPath),
    realpath(actualPath),
  ]);
  if (!sameFileSystemPath(expected, actual)) throw new Error(message);
}

function sameFileSystemPath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

async function ensureFile(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  try {
    await writeFile(filePath, content, { encoding: "utf-8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
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

async function assertRegularFile(filePath: string, message: string): Promise<void> {
  const stat = await lstatIfExists(filePath);
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error(message);
}

async function assertOrdinaryDirectory(directoryPath: string, message: string): Promise<void> {
  const stat = await lstatIfExists(directoryPath);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error(message);
}

async function assertRegularFileIfExists(filePath: string, message: string): Promise<void> {
  const stat = await lstatIfExists(filePath);
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error(message);
}

async function readRegularFile(filePath: string): Promise<string> {
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const handle = await open(filePath, constants.O_RDONLY | noFollow);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`工作文档索引必须是普通文件: ${filePath}`);
    return await handle.readFile({ encoding: "utf-8" });
  } finally {
    await handle.close();
  }
}

async function writeRegularFile(filePath: string, content: string): Promise<void> {
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const handle = await open(filePath, constants.O_WRONLY | noFollow);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`工作文档索引必须是普通文件: ${filePath}`);
    await handle.truncate(0);
    await handle.writeFile(content, { encoding: "utf-8" });
  } finally {
    await handle.close();
  }
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
  await mkdir(path.dirname(filePath), { recursive: true });
  let content = "";
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    // ignore missing exclude file
  }
  const existing = new Set(content.split(/\r?\n/u).filter(Boolean));
  const next = lines.filter((line) => !existing.has(line));
  if (next.length === 0) return;
  const prefix = content && !content.endsWith("\n") ? "\n" : "";
  await writeFile(filePath, `${content}${prefix}${next.join("\n")}\n`, "utf-8");
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
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

function normalizeBranch(value: string): string {
  const branch = value.trim();
  if (!branch) throw new Error("branch 不能为空");
  if (
    /[\u0000-\u001f ~^:?*\\]/u.test(branch) ||
    branch.includes("..") ||
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
  const hash = createHash("sha256").update(path.resolve(root).toLowerCase()).digest("hex").slice(0, 12);
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
  const trusted = new Set(
    (options.trustedExternalResourcePaths ?? []).map((resourcePath) =>
      normalizedRootKey(path.resolve(resourcePath)),
    ),
  );
  const relocateInternal = (storedPath: string, label: string): string => {
    if (!isPathWithin(storedPath, oldRoot)) {
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
    if (isPathWithin(resource.sourcePath, oldRoot)) {
      sourcePath = relocateInternal(resource.sourcePath, "sharedResource.sourcePath");
      if (!isPathWithin(sourcePath, path.join(nextRoot, "shared"))) {
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
      if (options.requireExternalTrust && !trusted.has(normalizedRootKey(sourcePath))) {
        throw new Error(`外部共享资源需要重新授权: ${sourcePath}`);
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

function isPathWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`) && relative !== "..")
  );
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
    .update(path.resolve(defaultSourcePath).toLowerCase())
    .digest("hex")
    .slice(0, 12);
  return path.join(defaultProjectsRoot(), key);
}

function defaultProjectsRoot(): string {
  const localDataRoot =
    process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".local", "share");
  return path.join(localDataRoot, "agent_canvas", "projects");
}
