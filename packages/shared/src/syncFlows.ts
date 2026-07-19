import type { AgentStatus } from "./events.js";

export type SyncFlowKind = "cherry_pick" | "branch_pull";

export type SyncFlowStatus =
  | "queued"
  | "review_collecting"
  | "review_failed"
  | "apply_authorized"
  | "applied"
  | "timed_out"
  | "cancelled"
  | "blocked";

export type SyncFlowReviewDecision =
  | "approve"
  | "reject"
  | "needs_changes"
  | "blocked";

export type BranchPullStrategy = "merge" | "rebase" | "pull";

export interface SyncFlowChangedFile {
  status: string;
  path: string;
}

export interface CreateCherryPickFlowInput {
  kind: "cherry_pick";
  proposerAgentId: string;
  targetBranch?: string;
  sourceBranch?: string;
  commitSha: string;
  title?: string;
  summary: string;
  reason: string;
  files?: string[];
}

export interface CreateBranchPullFlowInput {
  kind: "branch_pull";
  proposerAgentId: string;
  targetBranch?: string;
  sourceBranch: string;
  strategy?: BranchPullStrategy;
  title?: string;
  summary: string;
  reason: string;
  files?: string[];
}

export type CreateSyncFlowInput = CreateCherryPickFlowInput | CreateBranchPullFlowInput;

export interface SyncFlowReviewResponse {
  agentId: string;
  decision: SyncFlowReviewDecision;
  summary: string;
  risks: string[];
  filesReviewed: string[];
  requiredChanges: string[];
  retryCount: number;
  receivedAt: number;
}

export interface SyncFlowReviewRequest {
  id: string;
  requestedAgentIds: string[];
  pendingAgentIds: string[];
  retryCounts: Record<string, number>;
  responses: SyncFlowReviewResponse[];
  requestedAt: number;
  requestedAfterSeqs?: Record<string, number>;
  deadlineAt: number;
}

export interface SyncFlowAuthorization {
  agentId: string;
  issuedAt: number;
  expiresAt: number;
}

export interface SyncFlowAppliedInput {
  summary?: string;
  commitSha?: string;
  files?: string[];
  fileChanges?: SyncFlowChangedFile[];
}

export interface SyncFlowAppliedInfo extends SyncFlowAppliedInput {
  files: string[];
  fileChanges: SyncFlowChangedFile[];
  reportedByAgentId?: string;
  appliedAt: number;
}

export interface SyncFlowSnapshot {
  id: string;
  kind: SyncFlowKind;
  proposerAgentId: string;
  sourceTurnIndex?: number;
  targetBranch: string;
  sourceBranch?: string;
  commitSha?: string;
  strategy?: BranchPullStrategy;
  title?: string;
  summary: string;
  reason: string;
  files: string[];
  fileChanges: SyncFlowChangedFile[];
  status: SyncFlowStatus;
  createdAt: number;
  updatedAt: number;
  /** Persistent FIFO position for the flow's current branch-review queue job. */
  reviewQueueSequence?: number;
  closedAt?: number;
  failureReason?: string;
  deadlineAt?: number;
  /** All agents that have participated in a review request for this flow. */
  participantAgentIds?: string[];
  reviewRequest?: SyncFlowReviewRequest;
  applyAuthorization?: SyncFlowAuthorization;
  applied?: SyncFlowAppliedInfo;
}

export interface SyncFlowAgentOption {
  id: string;
  branch?: string;
  status: AgentStatus;
}
