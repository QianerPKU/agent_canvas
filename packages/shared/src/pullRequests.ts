import type { AgentStatus } from "./events.js";

export type PullRequestReviewStage = "source_preflight" | "target_merge";

export type PullRequestReviewDecision =
  | "approve"
  | "reject"
  | "needs_changes"
  | "blocked";

export type PullRequestFlowStatus =
  | "queued"
  | "source_review_collecting"
  | "source_review_failed"
  | "create_pr_authorized"
  | "target_review_collecting"
  | "target_review_failed"
  | "merge_authorized"
  | "merged"
  | "timed_out"
  | "cancelled"
  | "blocked";

export interface CreatePullRequestFlowInput {
  proposerAgentId: string;
  targetBranch: string;
  sourceBranch?: string;
  title?: string;
  summary: string;
  files?: string[];
}

export interface PullRequestChangedFile {
  status: string;
  path: string;
}

export interface PullRequestCreatedInput {
  prNumber?: number;
  prUrl?: string;
  title?: string;
  summary?: string;
  files?: string[];
  fileChanges?: PullRequestChangedFile[];
}

export interface PullRequestReviewResponse {
  agentId: string;
  stage: PullRequestReviewStage;
  decision: PullRequestReviewDecision;
  summary: string;
  risks: string[];
  filesReviewed: string[];
  requiredChanges: string[];
  retryCount: number;
  receivedAt: number;
}

export interface PullRequestReviewRequest {
  id: string;
  stage: PullRequestReviewStage;
  requestedAgentIds: string[];
  pendingAgentIds: string[];
  retryCounts: Record<string, number>;
  responses: PullRequestReviewResponse[];
  requestedAt: number;
  requestedAfterSeqs?: Record<string, number>;
  deadlineAt: number;
}

export interface PullRequestCreatedInfo extends PullRequestCreatedInput {
  files: string[];
  fileChanges: PullRequestChangedFile[];
  reportedByAgentId?: string;
  createdAt: number;
}

export interface PullRequestAuthorization {
  agentId: string;
  issuedAt: number;
  expiresAt: number;
}

export interface PullRequestFlowSnapshot {
  id: string;
  proposerAgentId: string;
  sourceTurnIndex?: number;
  sourceBranch: string;
  targetBranch: string;
  title?: string;
  summary: string;
  files: string[];
  fileChanges: PullRequestChangedFile[];
  status: PullRequestFlowStatus;
  createdAt: number;
  updatedAt: number;
  closedAt?: number;
  failureReason?: string;
  currentStage?: PullRequestReviewStage;
  deadlineAt?: number;
  reviewRequests: PullRequestReviewRequest[];
  pr?: PullRequestCreatedInfo;
  createAuthorization?: PullRequestAuthorization;
  mergeAuthorization?: PullRequestAuthorization;
}

export interface PullRequestFlowAgentOption {
  id: string;
  branch?: string;
  status: AgentStatus;
}
