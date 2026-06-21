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
  BranchWorkspace,
  ConnectGitHubInput,
  CreateBranchWorkspaceInput,
  CreateSharedResourceInput,
  GitHubConnection,
  SharedResourceMount,
  WorkspaceProject,
} from "@agent-canvas/shared";
import type { AgentStartConfig } from "@agent-canvas/shared";

export interface WorkspaceManagerOptions {
  defaultSourcePath: string;
  projectRoot?: string;
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

const DEFAULT_REPO_ID = "repo_1";

export class WorkspaceManager {
  private readonly defaultSourcePath: string;
  private readonly projectRoot: string;
  private readonly now: () => number;
  private readonly runGit: GitRunner;
  private state: WorkspaceState = { branches: [], sharedResources: [] };
  private initialized = false;
  private initPromise?: Promise<void>;
  private branchCounter = 0;
  private resourceCounter = 0;

  constructor(options: WorkspaceManagerOptions) {
    this.defaultSourcePath = path.resolve(options.defaultSourcePath);
    this.projectRoot = path.resolve(
      options.projectRoot ?? defaultProjectRoot(this.defaultSourcePath),
    );
    this.now = options.now ?? Date.now;
    this.runGit = options.runGit ?? defaultRunGit;
  }

  root(): string {
    return this.projectRoot;
  }

  async project(): Promise<WorkspaceProject> {
    await this.ensureInitialized();
    return this.snapshot();
  }

  async connect(input: ConnectGitHubInput = {}): Promise<WorkspaceProject> {
    await mkdir(this.projectRoot, { recursive: true });
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
    this.state.repo = repo;
    if (this.state.branches.length === 0) {
      await this.createBranch({ branch: defaultBranch });
    } else {
      await this.applyAllSharedResources();
    }
    this.initialized = true;
    return this.snapshot();
  }

  async listBranches(): Promise<BranchWorkspace[]> {
    await this.ensureInitialized();
    return [...this.state.branches];
  }

  async createBranch(input: CreateBranchWorkspaceInput): Promise<BranchWorkspace> {
    await this.ensureInitializedForBranchCreation();
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
      await this.runGit(["worktree", "add", "-B", branch, worktreePath, baseBranch], {
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
    return workspace;
  }

  async createSharedResource(input: CreateSharedResourceInput): Promise<SharedResourceMount> {
    await this.ensureInitialized();
    const repo = this.requireRepo();
    const name = normalizeName(input.name);
    const mountPath = normalizeRelativePath(input.mountPath);
    const id = `shared_${++this.resourceCounter}`;
    const sourcePath = path.resolve(
      input.sourcePath?.trim() || path.join(this.projectRoot, "shared", repo.id, safePathPart(name)),
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
    return resource;
  }

  branchOf(id: string | undefined): BranchWorkspace | undefined {
    return id ? this.state.branches.find((branch) => branch.id === id) : undefined;
  }

  defaultBranch(): BranchWorkspace | undefined {
    return this.state.branches.find((branch) => branch.isDefault) ?? this.state.branches[0];
  }

  async prepareAgentWorkspace(
    agentId: string,
    config: Pick<AgentStartConfig, "cwd" | "branchWorkspaceId"> | undefined,
  ): Promise<string | undefined> {
    if (!config?.branchWorkspaceId) {
      if (!config?.cwd) return undefined;
      const scratchDirectory = path.join(config.cwd, ".agent-tmp", agentId);
      await mkdir(scratchDirectory, { recursive: true });
      return scratchDirectory;
    }
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
      (settings.branchWorkspaceId ? undefined : this.defaultBranch());
    if (!workspace) return settings;
    return {
      ...settings,
      branchWorkspaceId: workspace.id,
      branch: workspace.branch,
      cwd: workspace.worktreePath,
    };
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    if (!this.initPromise) {
      this.initPromise = this.connect({
        localPath: this.defaultSourcePath,
      }).then(() => undefined);
    }
    await this.initPromise;
  }

  private async ensureInitializedForBranchCreation(): Promise<void> {
    if (this.state.repo) return;
    await this.ensureInitialized();
  }

  private snapshot(): WorkspaceProject {
    return {
      projectRoot: this.projectRoot,
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
    return path.join(this.projectRoot, "repos", repoId, "repo");
  }

  private branchWorktreePath(repoId: string, branch: string): string {
    return path.join(this.projectRoot, "worktrees", repoId, safePathPart(branch));
  }

  private async applyAllSharedResources(): Promise<void> {
    for (const workspace of this.state.branches) await this.applySharedResources(workspace);
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
  if (!name) throw new Error("共享资源名称不能为空");
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

function defaultProjectRoot(defaultSourcePath: string): string {
  const localDataRoot =
    process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".local", "share");
  const key = createHash("sha256")
    .update(path.resolve(defaultSourcePath).toLowerCase())
    .digest("hex")
    .slice(0, 12);
  return path.join(localDataRoot, "agent_canvas", "projects", key);
}
