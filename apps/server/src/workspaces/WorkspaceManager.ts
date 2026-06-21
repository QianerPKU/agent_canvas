import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  readFile,
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

interface WorkspaceState {
  repo?: GitHubConnection;
  branches: BranchWorkspace[];
  sharedResources: SharedResourceMount[];
}

interface ProjectIndex {
  projects: CanvasProjectSummary[];
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
    const id = `${safePathPart(name)}-${this.now().toString(36)}`;
    const projectRoot = path.join(this.projectsRoot, id);
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
    await this.ensureProjectOpen();
    await this.loadStateIfNeeded();
    const repo = this.state.repo;
    if (!repo || !fromBranch || !toBranch || fromBranch === toBranch) return undefined;
    try {
      const output = await this.runGit(["diff", "--name-status", fromBranch, toBranch], {
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
  ): Promise<string | undefined> {
    const workspace = this.branchOf(config?.branchWorkspaceId);
    const cwd = workspace?.worktreePath ?? config?.cwd;
    if (!cwd) return undefined;
    const scratchDirectory = path.join(cwd, ".agent-tmp", agentId);
    await mkdir(scratchDirectory, { recursive: true });
    if (workspace) await this.ensureIgnored(workspace, [".agent-tmp/"]);
    return scratchDirectory;
  }

  accessForAgent(
    config: Pick<AgentStartConfig, "branchWorkspaceId"> | undefined,
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
    return {
      readableFiles: [],
      readableDirectories: resources.map((resource) => resource.sourcePath),
      writableFiles: [],
      writableDirectories: resources
        .filter((resource) => resource.access === "readWrite")
        .map((resource) => resource.sourcePath),
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
    await appendUniqueLines(excludePath, normalized);
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
  if (await exists(mountPath)) {
    const stat = await lstat(mountPath);
    if (stat.isSymbolicLink()) return;
    throw new Error(`共享资源挂载点已存在且不是映射: ${mountPath}`);
  }
  const type = process.platform === "win32" ? "junction" : "dir";
  await symlink(path.resolve(sourcePath), mountPath, type);
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

function normalizeRelativePath(value: string): string {
  const normalized = value.replace(/\\/gu, "/").trim().replace(/^\/+/u, "");
  if (!normalized || path.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw new Error("共享资源挂载路径必须是工作区内的相对路径");
  }
  return normalized;
}

function normalizeIgnorePattern(value: string): string {
  const normalized = value.replace(/\\/gu, "/").replace(/^\/+/u, "");
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
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
