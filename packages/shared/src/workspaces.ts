export type SharedResourceAccess = "readOnly" | "readWrite";

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
