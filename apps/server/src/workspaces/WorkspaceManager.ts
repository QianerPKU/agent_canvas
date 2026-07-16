import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  open,
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

interface WorkspaceState {
  repo?: GitHubConnection;
  branches: BranchWorkspace[];
  sharedResources: SharedResourceMount[];
}

interface ProjectIndex {
  projects: CanvasProjectSummary[];
}

interface WorkDocumentationContext {
  workspace: BranchWorkspace;
  projectRoot: string;
  repositoryKey: string;
}

const DEFAULT_REPO_ID = "repo_1";
const WORKSPACE_STATE_FILE = "workspace.json";
const PROJECT_INDEX_FILE = "index.json";

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

  async listCanvasProjects(): Promise<CanvasProjectSummary[]> {
    const index = await this.readProjectIndex();
    const projects = [...index.projects];
    if (
      this.currentProject &&
      !projects.some((project) => project.id === this.currentProject?.id)
    ) {
      projects.unshift(this.currentProject);
    }
    return projects.sort((a, b) => (b.openedAt ?? b.createdAt) - (a.openedAt ?? a.createdAt));
  }

  async createCanvasProject(input: CreateCanvasProjectInput): Promise<CanvasProjectSummary> {
    const name = normalizeName(input.name);
    const explicitRoot = normalizeOptionalProjectRoot(input.projectRoot);
    const id = explicitRoot
      ? projectIdFromExplicitRoot(explicitRoot)
      : `${safePathPart(name)}-${this.now().toString(36)}`;
    const projectRoot = explicitRoot ?? path.join(this.projectsRoot, id);
    const project: CanvasProjectSummary = {
      id,
      name,
      projectRoot,
      createdAt: this.now(),
      openedAt: this.now(),
    };
    await mkdir(projectRoot, { recursive: true });
    await this.upsertProject(project);
    await this.openProject(project);
    await this.saveState();
    return project;
  }

  async openCanvasProject(input: OpenCanvasProjectInput): Promise<WorkspaceProject> {
    const index = await this.readProjectIndex();
    const project = index.projects.find((candidate) => candidate.id === input.id);
    if (!project) throw new Error(`未知 canvas 项目: ${input.id}`);
    const opened = { ...project, openedAt: this.now() };
    await this.upsertProject(opened);
    await this.openProject(opened);
    return this.snapshot();
  }

  async project(): Promise<WorkspaceProject> {
    await this.ensureProjectOpen();
    await this.loadStateIfNeeded();
    return this.snapshot();
  }

  async connect(input: ConnectGitHubInput = {}): Promise<WorkspaceProject> {
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
    this.state = { repo, branches: [], sharedResources: [] };
    this.resetWorkDocumentationPreparation();
    this.branchCounter = 0;
    this.resourceCounter = 0;
    await this.createBranch({ branch: defaultBranch });
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
    const documentationContext =
      workspace && options.workDocumentationEnabled
        ? this.captureWorkDocumentationContext(workspace)
        : undefined;
    const cwd = workspace?.worktreePath ?? config?.cwd;
    if (!cwd) return undefined;
    const scratchDirectory = path.join(cwd, ".agent-tmp", agentId);
    await mkdir(scratchDirectory, { recursive: true });
    if (workspace) await this.ensureIgnored(workspace, [".agent-tmp/"]);
    if (documentationContext) {
      await this.queueWorkDocumentation(() =>
        this.ensureWorkDocumentation(documentationContext),
      );
    }
    return scratchDirectory;
  }

  async prepareWorkDocumentationForAllBranches(): Promise<void> {
    const projectGeneration = this.projectGeneration;
    await this.ensureProjectOpen();
    await this.loadStateIfNeeded();
    if (projectGeneration !== this.projectGeneration) {
      throw new Error("Canvas 项目已在工作文档初始化期间切换，请重试");
    }
    const contexts = this.state.branches.map((workspace) =>
      this.captureWorkDocumentationContext(workspace),
    );
    await this.queueWorkDocumentation(async () => {
      for (const context of contexts) {
        await this.ensureWorkDocumentation(context);
      }
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
    const documentation = options.workDocumentationEnabled
      ? this.workDocumentationPaths(this.captureWorkDocumentationContext(workspace))
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

  private async openProject(project: CanvasProjectSummary): Promise<void> {
    this.projectGeneration += 1;
    this.resetWorkDocumentationPreparation();
    this.currentProject = project;
    this.projectRoot = path.resolve(project.projectRoot);
    this.state = { branches: [], sharedResources: [] };
    this.stateLoaded = false;
    this.branchCounter = 0;
    this.resourceCounter = 0;
    await mkdir(this.projectRoot, { recursive: true });
    await this.loadStateIfNeeded();
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
    this.stateLoaded = true;
    const statePath = this.statePath();
    try {
      const parsed = JSON.parse(await readFile(statePath, "utf-8")) as WorkspaceState;
      this.state = {
        repo: parsed.repo,
        branches: Array.isArray(parsed.branches) ? parsed.branches : [],
        sharedResources: Array.isArray(parsed.sharedResources) ? parsed.sharedResources : [],
      };
      this.branchCounter = maxNumericSuffix(this.state.branches.map((branch) => branch.id));
      this.resourceCounter = maxNumericSuffix(
        this.state.sharedResources.map((resource) => resource.id),
      );
    } catch {
      this.state = { branches: [], sharedResources: [] };
      this.branchCounter = 0;
      this.resourceCounter = 0;
    }
  }

  private async saveState(): Promise<void> {
    const statePath = this.statePath();
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(
      statePath,
      `${JSON.stringify(this.state, undefined, 2)}\n`,
      "utf-8",
    );
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
  ): WorkDocumentationContext {
    return {
      workspace: { ...workspace },
      projectRoot: this.requireProjectRoot(),
      repositoryKey: this.workDocumentationRepositoryKey(workspace),
    };
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
    const preparationKey = [
      context.projectRoot,
      context.repositoryKey,
      context.workspace.worktreePath,
      context.workspace.branch,
    ].join("\u0000");
    if (this.preparedWorkDocumentation.has(preparationKey)) return;

    const { workspace } = context;
    const documentation = this.workDocumentationPaths(context);
    await this.preflightWorkDocumentation(context, documentation);
    await this.ensureIgnored(workspace, [
      WORK_DOCUMENTATION_PATHS.isolatedDirectory,
      WORK_DOCUMENTATION_PATHS.sharedMountDirectory,
    ]);

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

    const sharedIndex = await readRegularFile(documentation.sharedSourceIndex);
    const nextSharedIndex = ensureSharedBranchIndexEntry(
      sharedIndex,
      workspace.branch,
      documentation.branchDirectory,
    );
    if (nextSharedIndex !== sharedIndex) {
      await writeRegularFile(documentation.sharedSourceIndex, nextSharedIndex);
    }
    this.preparedWorkDocumentation.add(preparationKey);
  }

  private async preflightWorkDocumentation(
    context: WorkDocumentationContext,
    documentation: ReturnType<WorkspaceManager["workDocumentationPaths"]>,
  ): Promise<void> {
    const { workspace } = context;
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
      ...index.projects.filter((candidate) => candidate.id !== project.id),
    ];
    await mkdir(this.projectsRoot, { recursive: true });
    await writeFile(
      this.projectIndexPath(),
      `${JSON.stringify({ projects }, undefined, 2)}\n`,
      "utf-8",
    );
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

function normalizeRelativePath(value: string): string {
  const normalized = value.replace(/\\/gu, "/").trim().replace(/^\/+/u, "");
  if (!normalized || path.isAbsolute(normalized) || normalized.split("/").includes("..")) {
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
