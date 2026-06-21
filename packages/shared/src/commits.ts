export interface ReportAgentCommitInput {
  /** Git commit ref to record. Defaults to HEAD in the agent workspace. */
  commit?: string;
  /** Optional short summary from the agent; git subject is used when omitted. */
  summary?: string;
}

export interface CommitChangedFile {
  status: string;
  path: string;
  oldPath?: string;
  additions: number;
  deletions: number;
  diff: string;
}

export interface AgentCommitSnapshot {
  id: string;
  agentId: string;
  sourceTurnIndex: number;
  commitSha: string;
  shortSha: string;
  branch?: string;
  cwd?: string;
  authorName?: string;
  authorEmail?: string;
  authoredAt?: string;
  committedAt?: string;
  subject: string;
  body?: string;
  summary: string;
  files: CommitChangedFile[];
  createdAt: number;
}
