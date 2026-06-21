export type SharedResourceAccess = "readOnly" | "readWrite";

export interface CanvasProjectSummary {
  id: string;
  name: string;
  projectRoot: string;
  createdAt: number;
  openedAt?: number;
}

export interface CreateCanvasProjectInput {
  name: string;
}

export interface OpenCanvasProjectInput {
  id: string;
}

export interface GitHubConnection {
  id: string;
  remoteUrl: string;
  owner?: string;
  repo?: string;
  defaultBranch: string;
  localRepoPath: string;
  connectedAt: number;
}

export interface BranchWorkspace {
  id: string;
  repoId: string;
  branch: string;
  baseBranch?: string;
  worktreePath: string;
  scratchRoot: string;
  isDefault: boolean;
  createdAt: number;
}

export interface BranchOption {
  branch: string;
  branchWorkspaceId?: string;
  worktreePath?: string;
  hasWorkspace: boolean;
  isDefault: boolean;
}

export interface BranchDiffFile {
  status: string;
  path: string;
}

export interface BranchDiffSummary {
  fromBranch: string;
  toBranch: string;
  files: BranchDiffFile[];
}

export interface SharedResourceMount {
  id: string;
  repoId: string;
  name: string;
  sourcePath: string;
  mountPath: string;
  access: SharedResourceAccess;
  createdAt: number;
}

export interface WorkspaceProject {
  canvasProject?: CanvasProjectSummary;
  projectRoot: string;
  repo?: GitHubConnection;
  branches: BranchWorkspace[];
  sharedResources: SharedResourceMount[];
}

export interface ConnectGitHubInput {
  remoteUrl?: string;
  localPath?: string;
  defaultBranch?: string;
}

export interface CreateBranchWorkspaceInput {
  branch: string;
  baseBranch?: string;
}

export interface CreateSharedResourceInput {
  name: string;
  mountPath: string;
  access?: SharedResourceAccess;
  sourcePath?: string;
}

export interface AgentSharedResourceReference {
  name: string;
  mountPath: string;
  sourcePath: string;
  access: SharedResourceAccess;
}
