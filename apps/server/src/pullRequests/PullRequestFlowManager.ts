import { randomUUID } from "node:crypto";
import type {
  AgentEventEnvelope,
  AgentSnapshot,
  AgentStartConfig,
  PullRequestChangedFile,
  PullRequestCreatedInput,
  PullRequestCreatedInfo,
  PullRequestFlowSnapshot,
  PullRequestFlowStatus,
  PullRequestReviewDecision,
  PullRequestReviewRequest,
  PullRequestReviewResponse,
  PullRequestReviewStage,
  CreatePullRequestFlowInput,
} from "@agent-canvas/shared";
import {
  BranchReviewQueue,
  type BranchReviewJob,
  type BranchReviewStartResult,
} from "../reviews/BranchReviewQueue.js";
import { DEFAULT_BRANCH_REVIEW_TIMEOUT_MS } from "../reviews/reviewDefaults.js";

type DeliverableRunner = {
  getStatus(): string;
  deliver(
    text: string,
    options?: { automationKey?: string; replaceQueued?: boolean },
  ): Promise<void>;
};

export interface PullRequestAgentHost {
  list(): AgentSnapshot[];
  get(id: string): DeliverableRunner | undefined;
  startAgent(id: string, config: AgentStartConfig): Promise<void>;
  historyOf(id: string): AgentEventEnvelope[];
  currentTurnIndex?(id: string): number;
}

export interface PullRequestFlowManagerOptions {
  host: PullRequestAgentHost;
  reviewQueue?: BranchReviewQueue;
  resolveChangedFiles?: ResolvePullRequestChangedFiles;
  ensureBranchesReady?: EnsurePullRequestBranchesReady;
  now?: () => number;
  reviewTimeoutMs?: number;
  reviewRetryLimit?: number;
  setTimer?: (callback: () => void, delay: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

type FlowListener = (flow: PullRequestFlowSnapshot) => void;

export interface ResolvePullRequestChangedFilesContext {
  proposerAgentId: string;
  sourceBranch: string;
  targetBranch: string;
  sourceCwd?: string;
}

export interface ResolvePullRequestChangedFiles {
  (context: ResolvePullRequestChangedFilesContext): Promise<PullRequestChangedFile[] | undefined>;
}

export interface EnsurePullRequestBranchesReady {
  (context: ResolvePullRequestChangedFilesContext): Promise<void>;
}

export interface SubmitPullRequestReviewInput {
  agentId: string;
  reviewToken: string;
  stage: PullRequestReviewStage;
  decision: PullRequestReviewDecision;
  summary: string;
  risks?: string[];
  filesReviewed?: string[];
  requiredChanges?: string[];
}

export interface SubmitPullRequestCreatedInput extends PullRequestCreatedInput {
  agentId: string;
  completionToken: string;
}

export interface SubmitPullRequestMergedInput {
  agentId: string;
  completionToken: string;
}

interface ParsedReview {
  agentCanvasPrReview: true;
  flowId: string;
  stage: PullRequestReviewStage;
  decision: PullRequestReviewDecision;
  summary: string;
  risks?: string[];
  filesReviewed?: string[];
  requiredChanges?: string[];
}

interface NormalizedPullRequestReview {
  agentId: string;
  reviewToken: string;
  stage: PullRequestReviewStage;
  decision: PullRequestReviewDecision;
  summary: string;
  risks: string[];
  filesReviewed: string[];
  requiredChanges: string[];
}

interface ReviewCapability {
  token: string;
  flowId: string;
  requestId: string;
  stage: PullRequestReviewStage;
  agentId: string;
}

type PullRequestCompletionAction = "pr_created" | "merged";

interface CompletionCapability {
  token: string;
  flowId: string;
  action: PullRequestCompletionAction;
  agentId: string;
}

interface AcceptedCompletionCallback extends CompletionCapability {
  payloadFingerprint: string;
}

interface ParsedAgentEvent {
  agentCanvasPrEvent: "pr_created" | "merged";
  flowId: string;
  prNumber?: number;
  prUrl?: string;
  title?: string;
  summary?: string;
  files?: string[];
  fileChanges?: PullRequestChangedFile[];
}

const DEFAULT_REVIEW_RETRY_LIMIT = 1;
const REVIEW_QUEUE_OWNER = "pull_request";
const CAPABILITY_TOKEN_PREFIX = "agent_canvas_cap_";
const CLOSED_STATUSES: PullRequestFlowStatus[] = [
  "source_review_failed",
  "target_review_failed",
  "merged",
  "timed_out",
  "cancelled",
  "blocked",
];
export class PullRequestFlowManager {
  private readonly host: PullRequestAgentHost;
  private readonly reviewQueue: BranchReviewQueue;
  private readonly resolveChangedFiles?: ResolvePullRequestChangedFiles;
  private readonly ensureBranchesReady?: EnsurePullRequestBranchesReady;
  private readonly now: () => number;
  private readonly reviewTimeoutMs: number;
  private readonly reviewRetryLimit: number;
  private readonly setTimer: (callback: () => void, delay: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;
  private readonly flows = new Map<string, PullRequestFlowSnapshot>();
  private readonly timers = new Map<string, unknown>();
  private readonly listeners = new Set<FlowListener>();
  private readonly pendingOperations = new Set<symbol>();
  private readonly pendingOperationsByFlow = new Map<string, Set<Promise<unknown>>>();
  private readonly reviewCapabilities = new Map<string, ReviewCapability>();
  private readonly completionCapabilities = new Map<string, CompletionCapability>();
  private readonly acceptedCompletionCallbacks = new Map<string, AcceptedCompletionCallback>();
  private readonly issuedCapabilityTokens = new Set<string>();
  private readonly closureReleaseDeliveries = new Map<string, Promise<boolean>>();
  private counter = 0;
  private importedStateActivated = true;
  private stateGeneration = 0;

  constructor(options: PullRequestFlowManagerOptions) {
    this.host = options.host;
    this.reviewQueue = options.reviewQueue ?? new BranchReviewQueue();
    this.resolveChangedFiles = options.resolveChangedFiles;
    this.ensureBranchesReady = options.ensureBranchesReady;
    this.now = options.now ?? Date.now;
    this.reviewTimeoutMs = options.reviewTimeoutMs ?? DEFAULT_BRANCH_REVIEW_TIMEOUT_MS;
    this.reviewRetryLimit = options.reviewRetryLimit ?? DEFAULT_REVIEW_RETRY_LIMIT;
    this.setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  }

  onFlow(listener: FlowListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(): PullRequestFlowSnapshot[] {
    return [...this.flows.values()];
  }

  exportState(): PullRequestFlowSnapshot[] {
    return this.list();
  }

  hasOpenFlows(): boolean {
    return this.list().some((flow) => !CLOSED_STATUSES.includes(flow.status));
  }

  hasPendingOperations(): boolean {
    return this.pendingOperations.size > 0;
  }

  async retryClosureReleasesForAgent(agentId: string): Promise<void> {
    const normalizedAgentId = agentId.trim();
    if (!normalizedAgentId) return;
    const generation = this.stateGeneration;
    const closedParticipantFlows = this.list().filter(
      (flow) =>
        CLOSED_STATUSES.includes(flow.status) &&
        closureReleaseAgentIds(flow).includes(normalizedAgentId),
    );
    await Promise.all(
      closedParticipantFlows.map(async (flow) => {
        const blockers = [...(this.pendingOperationsByFlow.get(flow.id) ?? [])];
        await this.trackPendingOperation(async () => {
          await Promise.allSettled(blockers);
          await this.deliverReviewerReleases(
            flow.id,
            generation,
            [normalizedAgentId],
            reviewFreezeReleasePrompt(flow),
          );
        }, flow.id);
      }),
    );
  }

  forgetClosureReleasesForAgent(agentId: string): void {
    const normalizedAgentId = agentId.trim();
    if (!normalizedAgentId) return;
    for (const flow of this.flows.values()) {
      if (!closureReleaseAgentIds(flow).includes(normalizedAgentId)) continue;
      this.closureReleaseDeliveries.delete(
        closureReleaseDeliveryKey(flow.id, normalizedAgentId),
      );
    }
  }

  importState(
    flows: PullRequestFlowSnapshot[] | undefined,
    options: { deferActivation?: boolean } = {},
  ): void {
    this.stateGeneration += 1;
    this.pendingOperationsByFlow.clear();
    this.closureReleaseDeliveries.clear();
    for (const flowId of this.timers.keys()) this.closeTimer(flowId);
    this.clearAllCapabilities();
    // Retire old-project deliveries immediately. Replacement jobs are installed only after the
    // caller has restored the rest of the project state and explicitly activates this import.
    this.reviewQueue.replaceOwner(REVIEW_QUEUE_OWNER, []);
    this.flows.clear();
    for (const flow of flows ?? []) {
      const collectingStage: PullRequestReviewStage | undefined =
        flow.status === "source_review_collecting"
          ? "source_preflight"
          : flow.status === "target_review_collecting"
            ? "target_merge"
            : undefined;
      let restored = collectingStage
        ? {
            ...flow,
            status: "queued" as const,
            currentStage: collectingStage,
            deadlineAt: undefined,
            failureReason: "Review was requeued because its previous delivery cannot survive reload.",
          }
        : flow.status === "queued" && !flow.currentStage
          ? { ...flow, currentStage: "source_preflight" as const }
          : flow;
      const restoredStage = queuedOrCollectingStage(restored);
      if (restoredStage && restored.reviewQueueSequence !== undefined) {
        this.reviewQueue.observeSequence(restored.reviewQueueSequence);
      }
      this.flows.set(restored.id, restored);
    }
    this.counter = maxNumericSuffix([...this.flows.keys()]);
    this.importedStateActivated = false;
    if (!options.deferActivation) this.activateImportedState();
  }

  activateImportedState(): void {
    if (this.importedStateActivated) return;
    this.importedStateActivated = true;
    const generation = this.stateGeneration;
    const reviewJobs = this.list().flatMap((flow) => {
      const stage = queuedOrCollectingStage(flow);
      if (!stage) return [];
      return [this.reviewJob(flow, stage, "queued")];
    });
    this.reviewQueue.replaceOwner(REVIEW_QUEUE_OWNER, reviewJobs);
    for (const flow of this.flows.values()) {
      if (!CLOSED_STATUSES.includes(flow.status) && flow.deadlineAt !== undefined) {
        if (flow.deadlineAt <= this.now()) {
          this.timeoutFlow(flow.id, generation);
        } else {
          this.resetTimer(flow.id, flow.deadlineAt, generation);
        }
      }
      const current = this.flows.get(flow.id);
      if (
        current &&
        !CLOSED_STATUSES.includes(current.status) &&
        current.deadlineAt !== undefined &&
        current.deadlineAt > this.now()
      ) {
        this.redeliverRestoredAuthorization(current, generation);
      }
    }
  }

  getReviewQueue(): BranchReviewQueue {
    return this.reviewQueue;
  }

  get(id: string): PullRequestFlowSnapshot | undefined {
    return this.flows.get(id);
  }

  async create(input: CreatePullRequestFlowInput): Promise<PullRequestFlowSnapshot> {
    const generation = this.stateGeneration;
    if (!input.proposerAgentId) throw new Error("missing proposerAgentId");
    if (!input.targetBranch) throw new Error("missing targetBranch");
    if (!input.summary.trim()) throw new Error("missing summary");
    const proposer = this.host.list().find((agent) => agent.id === input.proposerAgentId);
    if (!proposer) throw new Error(`unknown proposer agent: ${input.proposerAgentId}`);
    if (!isActiveAgentStatus(proposer.status)) {
      throw new Error("proposer agent must be running or waiting_input");
    }
    const sourceBranch = input.sourceBranch?.trim() || proposer.config.branch;
    if (!sourceBranch) throw new Error("missing sourceBranch");
    const targetBranch = input.targetBranch.trim();
    await this.ensureBranchesReady?.({
      proposerAgentId: input.proposerAgentId,
      sourceBranch,
      targetBranch,
      sourceCwd: proposer.config.cwd,
    });
    this.assertCurrentGeneration(generation);
    const fileChanges = await this.changedFilesFor({
      proposerAgentId: input.proposerAgentId,
      sourceBranch,
      targetBranch,
      sourceCwd: proposer.config.cwd,
      files: input.files,
    });
    this.assertCurrentGeneration(generation);
    if (fileChanges.length === 0) {
      throw new Error("PR flow requires a concrete changed file list");
    }
    const files = pathsFromFileChanges(fileChanges);

    const createdAt = this.now();
    const flow: PullRequestFlowSnapshot = {
      id: `pr_flow_${++this.counter}`,
      proposerAgentId: input.proposerAgentId,
      sourceTurnIndex: this.host.currentTurnIndex?.(input.proposerAgentId),
      sourceBranch,
      targetBranch,
      title: input.title?.trim() || undefined,
      summary: input.summary.trim(),
      files,
      fileChanges,
      status: "queued",
      createdAt,
      updatedAt: createdAt,
      reviewQueueSequence: this.reviewQueue.reserveSequence(),
      currentStage: "source_preflight",
      reviewRequests: [],
    };
    this.flows.set(flow.id, flow);
    this.save(flow);
    this.startBackgroundOperation(flow.id, async () => {
      await this.reviewQueue.enqueue(this.reviewJob(flow, "source_preflight", "queued"));
      this.assertCurrentGeneration(generation);
    });
    return this.requireFlow(flow.id);
  }

  async submitPrCreated(
    flowId: string,
    input: SubmitPullRequestCreatedInput,
  ): Promise<PullRequestFlowSnapshot> {
    const flow = this.requireFlow(flowId);
    const callback = normalizeCompletionSubmission(input);
    const payloadFingerprint = prCreatedPayloadFingerprint(input);
    const accepted = this.acceptedCompletionCallback(
      flow,
      "pr_created",
      callback.agentId,
      callback.completionToken,
      payloadFingerprint,
    );
    if (accepted) return flow;
    this.assertCompletionCapability(
      flow,
      "pr_created",
      callback.agentId,
      callback.completionToken,
    );
    const receipt = this.rememberCompletionCallback(
      flow,
      "pr_created",
      callback.agentId,
      callback.completionToken,
      payloadFingerprint,
    );
    try {
      return await this.recordPrCreated(flowId, input, callback.agentId);
    } catch (error) {
      this.forgetCompletionCallback(receipt);
      throw error;
    }
  }

  async recordPrCreated(
    flowId: string,
    input: PullRequestCreatedInput,
    reportedByAgentId?: string,
  ): Promise<PullRequestFlowSnapshot> {
    const generation = this.stateGeneration;
    const flow = this.requireFlow(flowId);
    if (flow.status !== "create_pr_authorized") {
      throw new Error("PR can only be recorded after create_pr authorization");
    }
    const fileChanges = updatedFileChangesForPr(flow, input);
    const files = pathsFromFileChanges(fileChanges);
    const pr: PullRequestCreatedInfo = {
      prNumber: input.prNumber,
      prUrl: input.prUrl?.trim() || undefined,
      title: input.title?.trim() || flow.title,
      summary: input.summary?.trim() || flow.summary,
      files,
      fileChanges,
      reportedByAgentId,
      createdAt: this.now(),
    };
    this.closeTimer(flowId);
    const queuedAt = this.now();
    const queued: PullRequestFlowSnapshot = {
      ...flow,
      files,
      fileChanges,
      pr,
      status: "queued" as const,
      currentStage: "target_merge",
      deadlineAt: undefined,
      failureReason: undefined,
      updatedAt: queuedAt,
      reviewQueueSequence: this.reviewQueue.reserveSequence(),
    };
    this.save(queued);
    this.startBackgroundOperation(flowId, async () => {
      await this.reviewQueue.enqueue(this.reviewJob(queued, "target_merge", "queued"));
      this.assertCurrentGeneration(generation);
    });
    return this.requireFlow(flowId);
  }

  submitMerged(
    flowId: string,
    input: SubmitPullRequestMergedInput,
  ): PullRequestFlowSnapshot {
    const flow = this.requireFlow(flowId);
    const callback = normalizeCompletionSubmission(input);
    const payloadFingerprint = "{}";
    const accepted = this.acceptedCompletionCallback(
      flow,
      "merged",
      callback.agentId,
      callback.completionToken,
      payloadFingerprint,
    );
    if (accepted) return flow;
    this.assertCompletionCapability(
      flow,
      "merged",
      callback.agentId,
      callback.completionToken,
    );
    const receipt = this.rememberCompletionCallback(
      flow,
      "merged",
      callback.agentId,
      callback.completionToken,
      payloadFingerprint,
    );
    try {
      return this.recordMerged(flowId);
    } catch (error) {
      this.forgetCompletionCallback(receipt);
      throw error;
    }
  }

  recordMerged(flowId: string): PullRequestFlowSnapshot {
    const flow = this.requireFlow(flowId);
    if (flow.status !== "merge_authorized") {
      throw new Error("merge can only be recorded after merge authorization");
    }
    this.closeTimer(flowId);
    const next = {
      ...flow,
      status: "merged" as const,
      currentStage: undefined,
      updatedAt: this.now(),
      closedAt: this.now(),
    };
    this.save(next);
    return next;
  }

  cancel(flowId: string): PullRequestFlowSnapshot {
    const flow = this.requireFlow(flowId);
    this.closeTimer(flowId);
    const stage = flow.currentStage;
    const next = {
      ...flow,
      status: "cancelled" as const,
      currentStage: undefined,
      updatedAt: this.now(),
      closedAt: this.now(),
    };
    this.save(next);
    if (stage) this.reviewQueue.complete(reviewJobId(flow.id, stage));
    return next;
  }

  async retryQueued(flowId: string): Promise<PullRequestFlowSnapshot> {
    const generation = this.stateGeneration;
    const flow = this.requireFlow(flowId);
    if (flow.status !== "queued") {
      throw new Error("only queued PR flows can be retried");
    }
    if (!flow.currentStage) throw new Error("queued PR flow is missing its review stage");
    const jobId = reviewJobId(flow.id, flow.currentStage);
    this.startBackgroundOperation(flow.id, async () => {
      await this.reviewQueue.retry(jobId);
      this.assertCurrentGeneration(generation);
    });
    this.assertCurrentGeneration(generation);
    return this.requireFlow(flowId);
  }

  async submitReview(
    flowId: string,
    input: SubmitPullRequestReviewInput,
  ): Promise<PullRequestFlowSnapshot> {
    const generation = this.stateGeneration;
    const flow = this.requireFlow(flowId);
    const submission = normalizeReviewSubmission(input);
    const request = currentRequest(flow, submission.stage);
    this.assertReviewCapability(flow, request, submission);
    const existing = request?.responses.find(
      (response) => response.agentId === submission.agentId,
    );

    if (existing) {
      if (sameReviewSubmission(existing, submission)) return flow;
      throw new Error(
        `conflicting PR review submission for ${submission.agentId} on ${submission.stage}`,
      );
    }

    const expectedStatus =
      submission.stage === "source_preflight"
        ? "source_review_collecting"
        : "target_review_collecting";
    if (flow.status !== expectedStatus || flow.currentStage !== submission.stage) {
      throw new Error(
        `PR flow ${flowId} is not collecting ${submission.stage} reviews`,
      );
    }
    if (!request) {
      throw new Error(`PR flow ${flowId} has no ${submission.stage} review request`);
    }
    if (!request.requestedAgentIds.includes(submission.agentId)) {
      throw new Error(
        `agent ${submission.agentId} was not requested to review PR flow ${flowId}`,
      );
    }
    if (!request.pendingAgentIds.includes(submission.agentId)) {
      throw new Error(
        `agent ${submission.agentId} does not have a pending review for PR flow ${flowId}`,
      );
    }

    this.recordReviewResponse(flowId, submission.stage, {
      agentId: submission.agentId,
      stage: submission.stage,
      decision: submission.decision,
      summary: submission.summary,
      risks: submission.risks,
      filesReviewed: submission.filesReviewed,
      requiredChanges: submission.requiredChanges,
      retryCount: request.retryCounts[submission.agentId] ?? 0,
      receivedAt: this.now(),
    });
    this.startBackgroundOperation(
      flowId,
      async () => await this.finishStageIfComplete(flowId, generation),
    );
    this.assertCurrentGeneration(generation);
    return this.requireFlow(flowId);
  }

  async handleAgentEvent(envelope: AgentEventEnvelope): Promise<void> {
    if (envelope.event.kind !== "result") return;
    const generation = this.stateGeneration;
    await Promise.resolve();
    if (!this.isCurrentGeneration(generation)) return;
    await this.captureReviewResult(envelope, generation);
    if (!this.isCurrentGeneration(generation)) return;
    await this.captureAgentPrEvent(envelope, generation);
  }

  private reviewJob(
    flow: PullRequestFlowSnapshot,
    stage: PullRequestReviewStage,
    state: BranchReviewJob["state"],
  ): BranchReviewJob {
    const generation = this.stateGeneration;
    return {
      id: reviewJobId(flow.id, stage),
      owner: REVIEW_QUEUE_OWNER,
      branch: stage === "source_preflight" ? flow.sourceBranch : flow.targetBranch,
      order: reviewJobOrder(flow, stage),
      sequence: flow.reviewQueueSequence,
      onSequenceAssigned: (sequence) => {
        const current = this.flows.get(flow.id);
        if (!current || queuedOrCollectingStage(current) !== stage) return;
        if (current.reviewQueueSequence === sequence) return;
        this.flows.set(flow.id, { ...current, reviewQueueSequence: sequence });
      },
      state,
      start: async () =>
        await this.trackPendingOperation(
          async () => await this.activateQueuedReviewStage(flow.id, stage, generation),
          flow.id,
        ),
    };
  }

  private async activateQueuedReviewStage(
    flowId: string,
    stage: PullRequestReviewStage,
    generation: number,
  ): Promise<BranchReviewStartResult> {
    if (!this.isCurrentGeneration(generation)) return "started";
    let flow = this.requireFlow(flowId);
    if (flow.status !== "queued" || flow.currentStage !== stage) return "started";
    if (stage === "source_preflight") {
      try {
        const proposer = this.host.list().find((agent) => agent.id === flow.proposerAgentId);
        await this.ensureBranchesReady?.({
          proposerAgentId: flow.proposerAgentId,
          sourceBranch: flow.sourceBranch,
          targetBranch: flow.targetBranch,
          sourceCwd: proposer?.config.cwd,
        });
      } catch (error) {
        if (!this.isCurrentGeneration(generation)) return "started";
        flow = this.requireFlow(flowId);
        if (flow.status === "queued" && flow.currentStage === stage) {
          this.save({
            ...flow,
            failureReason: `Queued PR review is waiting for branch sync: ${errorMessage(error)}`,
            updatedAt: this.now(),
          });
        }
        return "deferred";
      }
    }
    if (!this.isCurrentGeneration(generation)) return "started";
    flow = this.requireFlow(flowId);
    if (flow.status !== "queued" || flow.currentStage !== stage) return "started";
    const reviewers = this.reviewersFor(flow, stage);
    if (reviewers.length === 0) {
      const branch = stage === "source_preflight" ? flow.sourceBranch : flow.targetBranch;
      this.save({
        ...flow,
        failureReason: `Queued PR review is waiting for an active reviewer on branch ${branch}.`,
        updatedAt: this.now(),
      });
      return "deferred";
    }
    this.save({
      ...flow,
      status:
        stage === "source_preflight"
          ? "source_review_collecting"
          : "target_review_collecting",
      failureReason: undefined,
      updatedAt: this.now(),
    });
    await this.startReviewStage(flowId, stage, reviewers, generation);
    return "started";
  }

  private async startReviewStage(
    flowId: string,
    stage: PullRequestReviewStage,
    reviewers: AgentSnapshot[],
    generation: number,
  ): Promise<void> {
    if (!this.isCurrentGeneration(generation)) return;
    const flow = this.requireFlow(flowId);
    const request: PullRequestReviewRequest = {
      id: `${flow.id}:${stage}:${flow.reviewRequests.length + 1}`,
      stage,
      requestedAgentIds: reviewers.map((agent) => agent.id),
      pendingAgentIds: reviewers.map((agent) => agent.id),
      retryCounts: Object.fromEntries(reviewers.map((agent) => [agent.id, 0])),
      responses: [],
      requestedAt: this.now(),
      requestedAfterSeqs: Object.fromEntries(
        reviewers.map((agent) => [agent.id, lastHistorySeq(this.host.historyOf(agent.id))]),
      ),
      deadlineAt: this.now() + this.reviewTimeoutMs,
    };
    const reviewTokens = new Map(
      reviewers.map((reviewer) => [
        reviewer.id,
        this.issueReviewCapability(flow.id, request.id, stage, reviewer.id),
      ]),
    );
    this.save({
      ...flow,
      currentStage: stage,
      deadlineAt: request.deadlineAt,
      reviewRequests: [...flow.reviewRequests, request],
      updatedAt: this.now(),
    });
    this.resetTimer(flowId, request.deadlineAt, generation);

    for (const reviewer of reviewers) {
      if (!this.isCurrentGeneration(generation)) return;
      try {
        const delivery = await this.reviewQueue.runWhileReserved(
          reviewJobId(flowId, stage),
          async () =>
            await this.deliverToAgent(
              reviewer.id,
              reviewPrompt(
                this.requireFlow(flowId),
                stage,
                reviewer.id,
                reviewTokens.get(reviewer.id)!,
              ),
              {
                automationKey: prFlowAutomationKey(flow.id),
                startIfIdle: true,
              },
            ),
        );
        if (delivery.status === "invalidated") return;
      } catch (error) {
        if (!this.isCurrentReview(flowId, stage, request.id, generation)) return;
        this.recordSyntheticResponse(
          flowId,
          stage,
          reviewer.id,
          "blocked",
          `Failed to deliver review request: ${errorMessage(error)}`,
        );
      }
      if (!this.isCurrentReview(flowId, stage, request.id, generation)) return;
    }
    if (!this.isCurrentReview(flowId, stage, request.id, generation)) return;
    await this.finishStageIfComplete(flowId, generation);
  }

  private async captureReviewResult(
    envelope: AgentEventEnvelope,
    generation: number,
  ): Promise<void> {
    const agentId = envelope.agentId;
    const openRequests = this.listOpenRequestsFor(agentId);
    if (openRequests.length === 0) return;
    for (const { flow, request } of openRequests) {
      const history = this.host.historyOf(agentId);
      if (
        hasUndeliveredQueuedReviewPrompt(
          history,
          envelope.seq,
          request.requestedAt,
          request.requestedAfterSeqs?.[agentId],
          flow.id,
          request.stage,
        )
      ) {
        continue;
      }
      const reviewText = assistantTextForResult(
        history,
        envelope.seq,
        request.requestedAt,
        request.requestedAfterSeqs?.[agentId],
      );
      const parsedReviews = parseReviews(
        reviewText,
      );
      const parsed = parsedReviews.find(
        (review) => review.flowId === flow.id && review.stage === request.stage,
      );
      if (!parsed) {
        if (parsedReviews.length > 0 || hasRecognizedAgentCanvasOutput(reviewText)) continue;
        await this.handleInvalidReview(flow.id, request.stage, agentId, generation);
        if (!this.isCurrentGeneration(generation)) return;
        continue;
      }
      this.recordReviewResponse(flow.id, request.stage, {
        agentId,
        stage: request.stage,
        decision: parsed.decision,
        summary: parsed.summary,
        risks: parsed.risks ?? [],
        filesReviewed: parsed.filesReviewed ?? [],
        requiredChanges: parsed.requiredChanges ?? [],
        retryCount: request.retryCounts[agentId] ?? 0,
        receivedAt: this.now(),
      });
      await this.finishStageIfComplete(flow.id, generation);
      if (!this.isCurrentGeneration(generation)) return;
    }
  }

  private async captureAgentPrEvent(
    envelope: AgentEventEnvelope,
    generation: number,
  ): Promise<void> {
    const agentId = envelope.agentId;
    const possibleFlows = this.list().filter(
      (flow) =>
        flow.proposerAgentId === agentId &&
        (flow.status === "create_pr_authorized" || flow.status === "merge_authorized"),
    );
    if (possibleFlows.length === 0) return;
    const since = Math.min(
      ...possibleFlows.map((flow) =>
        flow.status === "create_pr_authorized"
          ? flow.createAuthorization?.issuedAt ?? flow.updatedAt
          : flow.mergeAuthorization?.issuedAt ?? flow.updatedAt,
      ),
    );
    const parsedEvents = parseAgentPrEvents(
      assistantTextForResult(this.host.historyOf(agentId), envelope.seq, since),
    );
    for (const flow of possibleFlows) {
      const parsed = parsedEvents.find((event) => event.flowId === flow.id);
      if (!parsed) continue;
      if (parsed.agentCanvasPrEvent === "pr_created") {
        await this.recordPrCreated(flow.id, parsed, agentId);
        if (!this.isCurrentGeneration(generation)) return;
      } else if (parsed.agentCanvasPrEvent === "merged") {
        this.recordMerged(flow.id);
      }
    }
  }

  private async handleInvalidReview(
    flowId: string,
    stage: PullRequestReviewStage,
    agentId: string,
    generation: number,
  ): Promise<void> {
    if (!this.isCurrentGeneration(generation)) return;
    const flow = this.requireFlow(flowId);
    const request = currentRequest(flow, stage);
    if (!request || !request.pendingAgentIds.includes(agentId)) return;
    const retryCount = request.retryCounts[agentId] ?? 0;
    if (retryCount < this.reviewRetryLimit) {
      request.retryCounts[agentId] = retryCount + 1;
      this.saveRequest(flowId, request);
      const delivery = await this.reviewQueue.runWhileReserved(
        reviewJobId(flowId, stage),
        async () =>
          await this.deliverToAgent(
            agentId,
            retryPrompt(
              flow,
              stage,
              agentId,
              this.requireReviewCapability(flow.id, request.id, stage, agentId).token,
            ),
            {
              automationKey: prFlowAutomationKey(flow.id),
              startIfIdle: true,
            },
          ),
      );
      if (delivery.status === "invalidated") return;
      return;
    }
    this.recordReviewResponse(flowId, stage, {
      agentId,
      stage,
      decision: "blocked",
      summary: "Review response did not match the required JSON schema after retry.",
      risks: [],
      filesReviewed: [],
      requiredChanges: ["Return the required JSON schema exactly."],
      retryCount,
      receivedAt: this.now(),
    });
    if (!this.isCurrentGeneration(generation)) return;
    await this.finishStageIfComplete(flowId, generation);
  }

  private async finishStageIfComplete(
    flowId: string,
    generation = this.stateGeneration,
  ): Promise<void> {
    if (!this.isCurrentGeneration(generation)) return;
    const flow = this.requireFlow(flowId);
    if (
      flow.status !== "source_review_collecting" &&
      flow.status !== "target_review_collecting"
    ) {
      return;
    }
    const request = currentRequest(flow, flow.currentStage);
    if (!request || request.pendingAgentIds.length > 0) return;
    if (!hasCompleteReviewerCoverage(request)) return;
    this.closeTimer(flowId);
    const allApproved = request.responses.every((response) => response.decision === "approve");
    if (request.stage === "source_preflight") {
      if (!allApproved) {
        this.failFlow(flow, "source_review_failed", reviewSummary(request.responses));
        this.reviewQueue.complete(reviewJobId(flowId, request.stage));
        return;
      }
      this.reviewQueue.complete(reviewJobId(flowId, request.stage));
      await this.authorizeCreatePr(flow, request.responses, generation);
      return;
    }
    if (!allApproved) {
      this.failFlow(flow, "target_review_failed", reviewSummary(request.responses));
      this.reviewQueue.complete(reviewJobId(flowId, request.stage));
      return;
    }
    this.reviewQueue.complete(reviewJobId(flowId, request.stage));
    await this.authorizeMerge(flow, request.responses, generation);
  }

  private async authorizeCreatePr(
    flow: PullRequestFlowSnapshot,
    responses: PullRequestReviewResponse[],
    generation = this.stateGeneration,
  ): Promise<void> {
    if (!this.isCurrentGeneration(generation)) return;
    const authorization = {
      agentId: flow.proposerAgentId,
      issuedAt: this.now(),
      expiresAt: this.now() + this.reviewTimeoutMs,
    };
    const next = {
      ...flow,
      status: "create_pr_authorized" as const,
      currentStage: undefined,
      deadlineAt: authorization.expiresAt,
      createAuthorization: authorization,
      updatedAt: this.now(),
    };
    const completionToken = this.issueCompletionCapability(
      flow.id,
      "pr_created",
      flow.proposerAgentId,
    );
    this.save(next);
    this.resetTimer(flow.id, authorization.expiresAt, generation);
    await this.notifyProposer(
      next,
      createPrAuthorizationPrompt(next, responses, completionToken),
      generation,
    );
  }

  private async authorizeMerge(
    flow: PullRequestFlowSnapshot,
    responses: PullRequestReviewResponse[],
    generation = this.stateGeneration,
  ): Promise<void> {
    if (!this.isCurrentGeneration(generation)) return;
    const authorization = {
      agentId: flow.proposerAgentId,
      issuedAt: this.now(),
      expiresAt: this.now() + this.reviewTimeoutMs,
    };
    const next = {
      ...flow,
      status: "merge_authorized" as const,
      currentStage: undefined,
      deadlineAt: authorization.expiresAt,
      mergeAuthorization: authorization,
      updatedAt: this.now(),
    };
    const completionToken = this.issueCompletionCapability(
      flow.id,
      "merged",
      flow.proposerAgentId,
    );
    this.save(next);
    this.resetTimer(flow.id, authorization.expiresAt, generation);
    await this.notifyProposer(
      next,
      mergeAuthorizationPrompt(next, responses, completionToken),
      generation,
    );
  }

  private failFlow(
    flow: PullRequestFlowSnapshot,
    status: "source_review_failed" | "target_review_failed" | "blocked",
    reason: string,
  ): PullRequestFlowSnapshot {
    this.closeTimer(flow.id);
    const next = {
      ...flow,
      status,
      currentStage: undefined,
      updatedAt: this.now(),
      closedAt: this.now(),
      failureReason: reason,
    };
    this.save(next);
    return next;
  }

  private async notifyProposer(
    flow: PullRequestFlowSnapshot,
    text: string,
    generation = this.stateGeneration,
  ): Promise<void> {
    if (!this.isCurrentGeneration(generation)) return;
    try {
      await this.deliverToAgent(flow.proposerAgentId, text, {
        automationKey: prFlowAutomationKey(flow.id),
      });
    } catch (error) {
      if (
        this.isCurrentGeneration(generation) &&
        this.flows.get(flow.id) === flow &&
        !CLOSED_STATUSES.includes(flow.status)
      ) {
        this.failFlow(flow, "blocked", `Failed to deliver proposer signal: ${errorMessage(error)}`);
      }
    }
  }

  private reviewersFor(
    flow: PullRequestFlowSnapshot,
    stage: PullRequestReviewStage,
  ): AgentSnapshot[] {
    const branch = stage === "source_preflight" ? flow.sourceBranch : flow.targetBranch;
    const branchAgents = this.host.list().filter((agent) => agent.config.branch === branch);
    const activeReviewers = branchAgents.filter((agent) => isActiveAgentStatus(agent.status));
    if (activeReviewers.length > 0) return activeReviewers;
    const idleReviewers = branchAgents
      .filter((agent) => agent.status === "idle")
      .sort(compareAgentCreationOrder);
    return idleReviewers.slice(0, 1);
  }

  private async trackPendingOperation<T>(
    operation: () => Promise<T>,
    flowId?: string,
  ): Promise<T> {
    const token = Symbol("pr-review-operation");
    this.pendingOperations.add(token);
    const pending = Promise.resolve().then(operation);
    const flowOperations = flowId
      ? (this.pendingOperationsByFlow.get(flowId) ?? new Set<Promise<unknown>>())
      : undefined;
    if (flowId && flowOperations) {
      flowOperations.add(pending);
      this.pendingOperationsByFlow.set(flowId, flowOperations);
    }
    try {
      return await pending;
    } finally {
      this.pendingOperations.delete(token);
      if (flowId && flowOperations) {
        flowOperations.delete(pending);
        if (
          flowOperations.size === 0 &&
          this.pendingOperationsByFlow.get(flowId) === flowOperations
        ) {
          this.pendingOperationsByFlow.delete(flowId);
        }
      }
    }
  }

  private startBackgroundOperation(flowId: string, operation: () => Promise<void>): void {
    void this.trackPendingOperation(operation, flowId).catch(() => {
      // Flow operations update their own blocked/deferred state. The pending-operation guard
      // keeps project switches serialized without making the originating HTTP callback wait.
    });
  }

  private async changedFilesFor(
    input: ResolvePullRequestChangedFilesContext & { files?: string[] },
  ): Promise<PullRequestChangedFile[]> {
    const explicitFiles = uniqueStrings(input.files ?? []);
    const resolved = this.resolveChangedFiles
      ? normalizeFileChanges(await this.resolveChangedFiles(input))
      : [];
    if (explicitFiles.length > 0) {
      return fileChangesForExplicitFiles(explicitFiles, resolved);
    }
    return resolved;
  }

  private async deliverToAgent(
    agentId: string,
    text: string,
    options: {
      automationKey?: string;
      replaceQueued?: boolean;
      startIfIdle?: boolean;
    } = {},
  ): Promise<void> {
    const runner = this.host.get(agentId);
    if (!runner) throw new Error(`unknown agent: ${agentId}`);
    if (options.startIfIdle && runner.getStatus() === "idle") {
      await this.host.startAgent(agentId, { prompt: text });
      return;
    }
    await runner.deliver(text, {
      ...(options.automationKey !== undefined
        ? { automationKey: options.automationKey }
        : {}),
      ...(options.replaceQueued !== undefined
        ? { replaceQueued: options.replaceQueued }
        : {}),
    });
  }

  private issueReviewCapability(
    flowId: string,
    requestId: string,
    stage: PullRequestReviewStage,
    agentId: string,
  ): string {
    const key = reviewCapabilityKey(flowId, requestId, stage, agentId);
    const existing = this.reviewCapabilities.get(key);
    if (existing) return existing.token;
    const token = this.issueCapabilityToken();
    this.reviewCapabilities.set(key, { token, flowId, requestId, stage, agentId });
    return token;
  }

  private requireReviewCapability(
    flowId: string,
    requestId: string,
    stage: PullRequestReviewStage,
    agentId: string,
  ): ReviewCapability {
    const capability = this.reviewCapabilities.get(
      reviewCapabilityKey(flowId, requestId, stage, agentId),
    );
    if (!capability) throw new Error("invalid or expired PR reviewToken");
    return capability;
  }

  private assertReviewCapability(
    flow: PullRequestFlowSnapshot,
    request: PullRequestReviewRequest | undefined,
    submission: NormalizedPullRequestReview,
  ): void {
    if (!request) throw new Error("invalid or expired PR reviewToken");
    const capability = this.reviewCapabilities.get(
      reviewCapabilityKey(flow.id, request.id, submission.stage, submission.agentId),
    );
    if (!capability || capability.token !== submission.reviewToken) {
      throw new Error("invalid or expired PR reviewToken");
    }
  }

  private redeliverRestoredAuthorization(
    flow: PullRequestFlowSnapshot,
    generation: number,
  ): void {
    if (flow.status !== "create_pr_authorized" && flow.status !== "merge_authorized") return;
    const action: PullRequestCompletionAction =
      flow.status === "create_pr_authorized" ? "pr_created" : "merged";
    const stage: PullRequestReviewStage =
      action === "pr_created" ? "source_preflight" : "target_merge";
    const completionToken = this.issueCompletionCapability(
      flow.id,
      action,
      flow.proposerAgentId,
    );
    const responses = currentRequest(flow, stage)?.responses ?? [];
    const prompt =
      action === "pr_created"
        ? createPrAuthorizationPrompt(flow, responses, completionToken)
        : mergeAuthorizationPrompt(flow, responses, completionToken);
    void this.trackPendingOperation(async () => {
      if (
        !this.isCurrentGeneration(generation) ||
        this.flows.get(flow.id)?.status !== flow.status
      ) {
        return;
      }
      try {
        await this.deliverToAgent(flow.proposerAgentId, prompt, {
          automationKey: prFlowAutomationKey(flow.id),
        });
      } catch {
        // Restoration redelivery is best effort and must not revoke persisted authorization.
      }
    }, flow.id);
  }

  private issueCompletionCapability(
    flowId: string,
    action: PullRequestCompletionAction,
    agentId: string,
  ): string {
    const key = completionCapabilityKey(flowId, action, agentId);
    const existing = this.completionCapabilities.get(key);
    if (existing) return existing.token;
    const token = this.issueCapabilityToken();
    this.completionCapabilities.set(key, { token, flowId, action, agentId });
    return token;
  }

  private assertCompletionCapability(
    flow: PullRequestFlowSnapshot,
    action: PullRequestCompletionAction,
    agentId: string,
    token: string,
  ): void {
    const capability = this.completionCapabilities.get(
      completionCapabilityKey(flow.id, action, agentId),
    );
    if (
      flow.proposerAgentId !== agentId ||
      !capability ||
      capability.token !== token
    ) {
      throw new Error(`invalid or expired PR ${action} completionToken`);
    }
  }

  private acceptedCompletionCallback(
    flow: PullRequestFlowSnapshot,
    action: PullRequestCompletionAction,
    agentId: string,
    token: string,
    payloadFingerprint: string,
  ): boolean {
    const accepted = this.acceptedCompletionCallbacks.get(
      completionCapabilityKey(flow.id, action, agentId),
    );
    if (!accepted) return false;
    if (flow.proposerAgentId !== agentId || accepted.token !== token) {
      throw new Error(`invalid or expired PR ${action} completionToken`);
    }
    if (accepted.payloadFingerprint !== payloadFingerprint) {
      throw new Error(`conflicting PR ${action} completion submission`);
    }
    return true;
  }

  private rememberCompletionCallback(
    flow: PullRequestFlowSnapshot,
    action: PullRequestCompletionAction,
    agentId: string,
    token: string,
    payloadFingerprint: string,
  ): AcceptedCompletionCallback {
    const accepted = { token, flowId: flow.id, action, agentId, payloadFingerprint };
    this.acceptedCompletionCallbacks.set(
      completionCapabilityKey(flow.id, action, agentId),
      accepted,
    );
    return accepted;
  }

  private forgetCompletionCallback(accepted: AcceptedCompletionCallback): void {
    const key = completionCapabilityKey(
      accepted.flowId,
      accepted.action,
      accepted.agentId,
    );
    if (this.acceptedCompletionCallbacks.get(key) === accepted) {
      this.acceptedCompletionCallbacks.delete(key);
    }
  }

  private issueCapabilityToken(): string {
    let token = `${CAPABILITY_TOKEN_PREFIX}${randomUUID()}`;
    while (this.issuedCapabilityTokens.has(token)) {
      token = `${CAPABILITY_TOKEN_PREFIX}${randomUUID()}`;
    }
    this.issuedCapabilityTokens.add(token);
    return token;
  }

  private clearCapabilitiesForFlow(flowId: string): void {
    for (const [key, capability] of this.reviewCapabilities) {
      if (capability.flowId !== flowId) continue;
      this.reviewCapabilities.delete(key);
      if (!this.isAcceptedCapabilityToken(capability.token)) {
        this.issuedCapabilityTokens.delete(capability.token);
      }
    }
    for (const [key, capability] of this.completionCapabilities) {
      if (capability.flowId !== flowId) continue;
      this.completionCapabilities.delete(key);
      if (!this.isAcceptedCapabilityToken(capability.token)) {
        this.issuedCapabilityTokens.delete(capability.token);
      }
    }
  }

  private isAcceptedCapabilityToken(token: string): boolean {
    return [...this.acceptedCompletionCallbacks.values()].some(
      (accepted) => accepted.token === token,
    );
  }

  private clearAllCapabilities(): void {
    this.reviewCapabilities.clear();
    this.completionCapabilities.clear();
    this.acceptedCompletionCallbacks.clear();
    this.issuedCapabilityTokens.clear();
  }

  private releaseReviewers(flow: PullRequestFlowSnapshot): void {
    const generation = this.stateGeneration;
    const reviewerIds = closureReleaseAgentIds(flow);
    const prompt = reviewFreezeReleasePrompt(flow);
    const blockers = [...(this.pendingOperationsByFlow.get(flow.id) ?? [])];
    this.startBackgroundOperation(
      flow.id,
      async () => {
        await Promise.allSettled(blockers);
        await this.deliverReviewerReleases(flow.id, generation, reviewerIds, prompt);
      },
    );
  }

  private async deliverReviewerReleases(
    flowId: string,
    generation: number,
    reviewerIds: string[],
    prompt: string,
  ): Promise<void> {
    const flow = this.flows.get(flowId);
    if (
      !this.isCurrentGeneration(generation) ||
      !flow ||
      !CLOSED_STATUSES.includes(flow.status)
    ) {
      return;
    }
    await Promise.all(
      reviewerIds.map(async (reviewerId) => {
        await this.deliverReviewerRelease(flowId, generation, reviewerId, prompt);
      }),
    );
  }

  private async deliverReviewerRelease(
    flowId: string,
    generation: number,
    reviewerId: string,
    prompt: string,
  ): Promise<void> {
    const flow = this.flows.get(flowId);
    if (
      !this.isCurrentGeneration(generation) ||
      !flow ||
      !CLOSED_STATUSES.includes(flow.status)
    ) {
      return;
    }
    const deliveryKey = closureReleaseDeliveryKey(flowId, reviewerId);
    const existing = this.closureReleaseDeliveries.get(deliveryKey);
    if (existing) {
      await existing;
      return;
    }
    const delivery = (async (): Promise<boolean> => {
      try {
        await this.deliverToAgent(reviewerId, prompt, {
          automationKey: prFlowAutomationKey(flowId),
          replaceQueued: true,
        });
      } catch {
        // Releasing a freeze is best effort; a failed attempt remains eligible for retry.
        return false;
      }
      const current = this.flows.get(flowId);
      return (
        this.isCurrentGeneration(generation) &&
        current !== undefined &&
        CLOSED_STATUSES.includes(current.status)
      );
    })();
    this.closureReleaseDeliveries.set(deliveryKey, delivery);
    const delivered = await delivery;
    if (!delivered && this.closureReleaseDeliveries.get(deliveryKey) === delivery) {
      this.closureReleaseDeliveries.delete(deliveryKey);
    }
  }

  private recordSyntheticResponse(
    flowId: string,
    stage: PullRequestReviewStage,
    agentId: string,
    decision: PullRequestReviewDecision,
    summary: string,
  ): void {
    const flow = this.requireFlow(flowId);
    const request = currentRequest(flow, stage);
    this.recordReviewResponse(flowId, stage, {
      agentId,
      stage,
      decision,
      summary,
      risks: [],
      filesReviewed: [],
      requiredChanges: [summary],
      retryCount: request?.retryCounts[agentId] ?? 0,
      receivedAt: this.now(),
    });
  }

  private recordReviewResponse(
    flowId: string,
    stage: PullRequestReviewStage,
    response: PullRequestReviewResponse,
  ): void {
    const flow = this.requireFlow(flowId);
    const request = currentRequest(flow, stage);
    if (!request || !request.pendingAgentIds.includes(response.agentId)) return;
    const nextRequest = {
      ...request,
      pendingAgentIds: request.pendingAgentIds.filter((id) => id !== response.agentId),
      responses: [...request.responses, response],
    };
    this.saveRequest(flowId, nextRequest);
  }

  private saveRequest(flowId: string, request: PullRequestReviewRequest): void {
    const flow = this.requireFlow(flowId);
    this.save({
      ...flow,
      updatedAt: this.now(),
      reviewRequests: flow.reviewRequests.map((candidate) =>
        candidate.id === request.id ? { ...request } : candidate,
      ),
    });
  }

  private listOpenRequestsFor(
    agentId: string,
  ): Array<{ flow: PullRequestFlowSnapshot; request: PullRequestReviewRequest }> {
    const result: Array<{ flow: PullRequestFlowSnapshot; request: PullRequestReviewRequest }> = [];
    for (const flow of this.flows.values()) {
      const collectingStage =
        flow.status === "source_review_collecting"
          ? "source_preflight"
          : flow.status === "target_review_collecting"
            ? "target_merge"
            : undefined;
      if (!collectingStage || flow.currentStage !== collectingStage) continue;
      const request = currentRequest(flow, collectingStage);
      if (request?.pendingAgentIds.includes(agentId)) result.push({ flow, request });
    }
    return result;
  }

  private resetTimer(
    flowId: string,
    deadlineAt: number,
    generation = this.stateGeneration,
  ): void {
    this.closeTimer(flowId);
    const delay = Math.max(0, deadlineAt - this.now());
    this.timers.set(
      flowId,
      this.setTimer(() => {
        this.timeoutFlow(flowId, generation);
      }, delay),
    );
  }

  private timeoutFlow(flowId: string, generation: number): void {
    if (!this.isCurrentGeneration(generation)) return;
    const flow = this.flows.get(flowId);
    if (!flow || CLOSED_STATUSES.includes(flow.status)) return;
    if (flow.deadlineAt !== undefined && flow.deadlineAt > this.now()) {
      this.resetTimer(flowId, flow.deadlineAt, generation);
      return;
    }
    const stage = flow.currentStage;
    const next = {
      ...flow,
      status: "timed_out",
      currentStage: undefined,
      updatedAt: this.now(),
      closedAt: this.now(),
      failureReason: "PR flow timed out before all required agent responses arrived.",
    } as PullRequestFlowSnapshot;
    this.save(next);
    this.closeTimer(flowId);
    if (stage) this.reviewQueue.complete(reviewJobId(flowId, stage));
  }

  private isCurrentGeneration(generation: number): boolean {
    return generation === this.stateGeneration;
  }

  private closeTimer(flowId: string): void {
    const timer = this.timers.get(flowId);
    if (timer !== undefined) this.clearTimer(timer);
    this.timers.delete(flowId);
  }

  private isCurrentReview(
    flowId: string,
    stage: PullRequestReviewStage,
    requestId: string,
    generation: number,
  ): boolean {
    if (!this.isCurrentGeneration(generation)) return false;
    const flow = this.flows.get(flowId);
    if (!flow || flow.currentStage !== stage) return false;
    const expectedStatus =
      stage === "source_preflight" ? "source_review_collecting" : "target_review_collecting";
    return flow.status === expectedStatus && currentRequest(flow, stage)?.id === requestId;
  }

  private assertCurrentGeneration(generation: number): void {
    if (!this.isCurrentGeneration(generation)) {
      throw new Error("PR flow state changed while the operation was in progress");
    }
  }

  private requireFlow(id: string): PullRequestFlowSnapshot {
    const flow = this.flows.get(id);
    if (!flow) throw new Error(`unknown PR flow: ${id}`);
    return flow;
  }

  private save(flow: PullRequestFlowSnapshot): void {
    const previous = this.flows.get(flow.id);
    this.flows.set(flow.id, flow);
    const becameClosed =
      CLOSED_STATUSES.includes(flow.status) &&
      (!previous || !CLOSED_STATUSES.includes(previous.status));
    if (becameClosed) {
      this.clearCapabilitiesForFlow(flow.id);
      this.releaseReviewers(flow);
    }
    for (const listener of this.listeners) {
      try {
        listener(flow);
      } catch {
        // A broken UI subscriber must not interrupt PR flow bookkeeping.
      }
    }
  }
}

function queuedOrCollectingStage(
  flow: PullRequestFlowSnapshot,
): PullRequestReviewStage | undefined {
  if (flow.status === "source_review_collecting") return "source_preflight";
  if (flow.status === "target_review_collecting") return "target_merge";
  return flow.status === "queued" ? flow.currentStage : undefined;
}

function reviewJobId(flowId: string, stage: PullRequestReviewStage): string {
  return `${REVIEW_QUEUE_OWNER}:${flowId}:${stage}`;
}

function prFlowAutomationKey(flowId: string): string {
  return `pr-flow:${flowId}`;
}

function closureReleaseAgentIds(flow: PullRequestFlowSnapshot): string[] {
  return uniqueStrings([
    flow.proposerAgentId,
    ...flow.reviewRequests.flatMap((request) => request.requestedAgentIds),
  ]);
}

function closureReleaseDeliveryKey(flowId: string, agentId: string): string {
  return JSON.stringify([flowId, agentId]);
}

function reviewCapabilityKey(
  flowId: string,
  requestId: string,
  stage: PullRequestReviewStage,
  agentId: string,
): string {
  return JSON.stringify([flowId, requestId, stage, agentId]);
}

function completionCapabilityKey(
  flowId: string,
  action: PullRequestCompletionAction,
  agentId: string,
): string {
  return JSON.stringify([flowId, action, agentId]);
}

function reviewJobOrder(flow: PullRequestFlowSnapshot, stage: PullRequestReviewStage): number {
  if (stage === "target_merge") return flow.pr?.createdAt ?? flow.createdAt;
  return flow.createdAt;
}

function isActiveAgentStatus(status: string): boolean {
  return status === "running" || status === "waiting_input";
}

function compareAgentCreationOrder(left: AgentSnapshot, right: AgentSnapshot): number {
  if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
  return compareNaturalIds(left.id, right.id);
}

function compareNaturalIds(left: string, right: string): number {
  const leftParts = /^(.*?)(\d+)$/u.exec(left);
  const rightParts = /^(.*?)(\d+)$/u.exec(right);
  if (leftParts && rightParts && leftParts[1] === rightParts[1]) {
    const numeric = compareDecimalStrings(leftParts[2]!, rightParts[2]!);
    if (numeric !== 0) return numeric;
  }
  return compareStrings(left, right);
}

function compareDecimalStrings(left: string, right: string): number {
  const normalizedLeft = left.replace(/^0+(?=\d)/u, "");
  const normalizedRight = right.replace(/^0+(?=\d)/u, "");
  return (
    normalizedLeft.length - normalizedRight.length ||
    compareStrings(normalizedLeft, normalizedRight) ||
    compareStrings(left, right)
  );
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function currentRequest(
  flow: PullRequestFlowSnapshot,
  stage: PullRequestReviewStage | undefined,
): PullRequestReviewRequest | undefined {
  if (!stage) return undefined;
  return [...flow.reviewRequests].reverse().find((request) => request.stage === stage);
}

function hasCompleteReviewerCoverage(request: PullRequestReviewRequest): boolean {
  const requested = new Set(request.requestedAgentIds);
  const responded = new Set(request.responses.map((response) => response.agentId));
  return (
    request.requestedAgentIds.length > 0 &&
    requested.size === request.requestedAgentIds.length &&
    request.pendingAgentIds.length === 0 &&
    request.responses.length === request.requestedAgentIds.length &&
    responded.size === request.responses.length &&
    request.requestedAgentIds.every((agentId) => responded.has(agentId))
  );
}

function lastHistorySeq(history: AgentEventEnvelope[]): number {
  return history.reduce((max, entry) => Math.max(max, entry.seq), 0);
}

function hasUndeliveredQueuedReviewPrompt(
  history: AgentEventEnvelope[],
  resultSeq: number,
  requestedAt: number,
  requestedAfterSeq: number | undefined,
  flowId: string,
  stage: PullRequestReviewStage,
): boolean {
  let queuedText: string | undefined;
  for (const entry of history) {
    if (
      entry.seq <= (requestedAfterSeq ?? 0) ||
      entry.seq >= resultSeq ||
      entry.at < requestedAt ||
      entry.event.kind !== "user_input" ||
      !isReviewPromptFor(entry.event.text, flowId, stage)
    ) {
      continue;
    }
    if (entry.event.mode === "queued") {
      queuedText = entry.event.text;
      continue;
    }
    if (queuedText === entry.event.text) queuedText = undefined;
  }
  return queuedText !== undefined;
}

function isReviewPromptFor(
  text: string,
  flowId: string,
  stage: PullRequestReviewStage,
): boolean {
  return (
    text.includes(`/api/pr-flows/${flowId}/reviews`) &&
    text.includes(`"stage": "${stage}"`)
  );
}

function assistantTextForResult(
  history: AgentEventEnvelope[],
  resultSeq: number,
  requestedAt: number,
  requestedAfterSeq?: number,
): string {
  const previousResultSeq = history.reduce(
    (max, entry) =>
      entry.seq < resultSeq && entry.event.kind === "result" ? Math.max(max, entry.seq) : max,
    0,
  );
  const afterSeq = Math.max(previousResultSeq, requestedAfterSeq ?? 0);
  return history
    .filter(
      (entry) =>
        entry.seq > afterSeq &&
        entry.seq < resultSeq &&
        entry.at >= requestedAt &&
        entry.event.kind === "assistant_text",
    )
    .map((entry) => (entry.event.kind === "assistant_text" ? entry.event.text : ""))
    .join("");
}

function parseReviews(text: string): ParsedReview[] {
  const reviews: ParsedReview[] = [];
  for (const candidate of parseJsonObjects(text)) {
    if (!isRecord(candidate)) continue;
    if (candidate.agentCanvasPrReview !== true) continue;
    if (typeof candidate.flowId !== "string") continue;
    if (candidate.stage !== "source_preflight" && candidate.stage !== "target_merge") continue;
    if (!isReviewDecision(candidate.decision)) continue;
    if (typeof candidate.summary !== "string" || !candidate.summary.trim()) continue;
    reviews.push({
      agentCanvasPrReview: true,
      flowId: candidate.flowId,
      stage: candidate.stage,
      decision: candidate.decision,
      summary: candidate.summary,
      risks: stringArray(candidate.risks),
      filesReviewed: stringArray(candidate.filesReviewed),
      requiredChanges: stringArray(candidate.requiredChanges),
    });
  }
  return reviews;
}

function parseAgentPrEvents(text: string): ParsedAgentEvent[] {
  const events: ParsedAgentEvent[] = [];
  for (const candidate of parseJsonObjects(text)) {
    if (!isRecord(candidate)) continue;
    if (candidate.agentCanvasPrEvent !== "pr_created" && candidate.agentCanvasPrEvent !== "merged") {
      continue;
    }
    if (typeof candidate.flowId !== "string") continue;
    events.push({
      agentCanvasPrEvent: candidate.agentCanvasPrEvent,
      flowId: candidate.flowId,
      prNumber: typeof candidate.prNumber === "number" ? candidate.prNumber : undefined,
      prUrl: typeof candidate.prUrl === "string" ? candidate.prUrl : undefined,
      title: typeof candidate.title === "string" ? candidate.title : undefined,
      summary: typeof candidate.summary === "string" ? candidate.summary : undefined,
      files: stringArray(candidate.files),
      fileChanges: fileChangeArray(candidate.fileChanges),
    });
  }
  return events;
}

function hasRecognizedAgentCanvasOutput(text: string): boolean {
  return parseJsonObjects(text).some((candidate) => {
    if (!isRecord(candidate) || typeof candidate.flowId !== "string") return false;
    if (candidate.agentCanvasPrEvent === "pr_created" || candidate.agentCanvasPrEvent === "merged") {
      return true;
    }
    if (candidate.agentCanvasSyncEvent === "applied") return true;
    if (
      candidate.agentCanvasPrReview === true &&
      (candidate.stage === "source_preflight" || candidate.stage === "target_merge") &&
      isReviewDecision(candidate.decision) &&
      typeof candidate.summary === "string" &&
      candidate.summary.trim()
    ) {
      return true;
    }
    return (
      candidate.agentCanvasSyncReview === true &&
      isReviewDecision(candidate.decision) &&
      typeof candidate.summary === "string" &&
      Boolean(candidate.summary.trim())
    );
  });
}

function parseJsonObjects(text: string): unknown[] {
  const blocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1] ?? "");
  const candidates = [...blocks, ...balancedJsonCandidates(text)];
  const parsed: unknown[] = [];
  for (const candidate of candidates) {
    try {
      parsed.push(JSON.parse(candidate));
    } catch {
      // Try the next candidate.
    }
  }
  return parsed;
}

function balancedJsonCandidates(text: string): string[] {
  const result: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
      continue;
    }
    if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        result.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isReviewDecision(value: unknown): value is PullRequestReviewDecision {
  return (
    value === "approve" ||
    value === "reject" ||
    value === "needs_changes" ||
    value === "blocked"
  );
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(value.filter((item): item is string => typeof item === "string"));
}

function fileChangeArray(value: unknown): PullRequestChangedFile[] {
  if (!Array.isArray(value)) return [];
  return normalizeFileChanges(
    value
      .filter(isRecord)
      .map((item) => ({
        status: typeof item.status === "string" ? item.status : "",
        path: typeof item.path === "string" ? item.path : "",
      })),
  );
}

function normalizeFileChanges(
  files: PullRequestChangedFile[] | undefined,
): PullRequestChangedFile[] {
  const seen = new Set<string>();
  const result: PullRequestChangedFile[] = [];
  for (const file of files ?? []) {
    const path = file.path.trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    result.push({ status: file.status.trim() || "?", path });
  }
  return result;
}

function fileChangesForExplicitFiles(
  files: string[],
  resolved: PullRequestChangedFile[],
): PullRequestChangedFile[] {
  const byPath = new Map(resolved.map((file) => [file.path, file]));
  return files.map((path) => byPath.get(path) ?? { status: "specified", path });
}

function updatedFileChangesForPr(
  flow: PullRequestFlowSnapshot,
  input: PullRequestCreatedInput,
): PullRequestChangedFile[] {
  const reportedChanges = normalizeFileChanges(input.fileChanges);
  if (reportedChanges.length > 0) return reportedChanges;
  const reportedFiles = uniqueStrings(input.files ?? []);
  if (reportedFiles.length > 0) return fileChangesForExplicitFiles(reportedFiles, flow.fileChanges);
  return flow.fileChanges;
}

function prCreatedPayloadFingerprint(input: SubmitPullRequestCreatedInput): string {
  return JSON.stringify({
    prNumber: input.prNumber,
    prUrl: input.prUrl?.trim() || undefined,
    title: input.title?.trim() || undefined,
    summary: input.summary?.trim() || undefined,
    files: input.files === undefined ? undefined : uniqueStrings(input.files),
    fileChanges:
      input.fileChanges === undefined ? undefined : normalizeFileChanges(input.fileChanges),
  });
}

function pathsFromFileChanges(files: PullRequestChangedFile[]): string[] {
  return uniqueStrings(files.map((file) => file.path));
}

function uniqueStrings(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

function normalizeReviewSubmission(
  input: SubmitPullRequestReviewInput,
): NormalizedPullRequestReview {
  if (!isRecord(input)) throw new Error("missing PR review submission");
  if (typeof input.agentId !== "string" || !input.agentId.trim()) {
    throw new Error("missing PR review agentId");
  }
  if (typeof input.reviewToken !== "string" || !input.reviewToken.trim()) {
    throw new Error("missing PR reviewToken");
  }
  if (input.stage !== "source_preflight" && input.stage !== "target_merge") {
    throw new Error("invalid PR review stage");
  }
  if (!isReviewDecision(input.decision)) {
    throw new Error("invalid PR review decision");
  }
  if (typeof input.summary !== "string" || !input.summary.trim()) {
    throw new Error("missing PR review summary");
  }
  return {
    agentId: input.agentId.trim(),
    reviewToken: input.reviewToken.trim(),
    stage: input.stage,
    decision: input.decision,
    summary: input.summary.trim(),
    risks: normalizeReviewStringArray(input.risks, "risks"),
    filesReviewed: normalizeReviewStringArray(input.filesReviewed, "filesReviewed"),
    requiredChanges: normalizeReviewStringArray(input.requiredChanges, "requiredChanges"),
  };
}

function normalizeCompletionSubmission(
  input: SubmitPullRequestCreatedInput | SubmitPullRequestMergedInput,
): { agentId: string; completionToken: string } {
  if (!isRecord(input)) throw new Error("missing PR completion submission");
  if (typeof input.agentId !== "string" || !input.agentId.trim()) {
    throw new Error("missing PR completion agentId");
  }
  if (typeof input.completionToken !== "string" || !input.completionToken.trim()) {
    throw new Error("missing PR completionToken");
  }
  return {
    agentId: input.agentId.trim(),
    completionToken: input.completionToken.trim(),
  };
}

function normalizeReviewStringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`PR review ${field} must be an array of strings`);
  }
  return uniqueStrings(value);
}

function sameReviewSubmission(
  existing: PullRequestReviewResponse,
  submission: NormalizedPullRequestReview,
): boolean {
  return (
    existing.agentId === submission.agentId &&
    existing.stage === submission.stage &&
    existing.decision === submission.decision &&
    existing.summary === submission.summary &&
    sameStrings(existing.risks, submission.risks) &&
    sameStrings(existing.filesReviewed, submission.filesReviewed) &&
    sameStrings(existing.requiredChanges, submission.requiredChanges)
  );
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function reviewPrompt(
  flow: PullRequestFlowSnapshot,
  stage: PullRequestReviewStage,
  reviewerAgentId: string,
  reviewToken: string,
): string {
  const files = formatFiles(flow.files);
  const fileChanges = formatFileChanges(flow.fileChanges);
  const label = stage === "source_preflight" ? "source branch preflight" : "target branch merge";
  const prInfo =
    stage === "target_merge" && flow.pr
      ? `\nPR: ${flow.pr.prUrl ?? flow.pr.prNumber ?? "(not provided)"}`
      : "";
  return [
    `Agent Canvas PR review request (${label}).`,
    `flowId: ${flow.id}`,
    `sourceBranch: ${flow.sourceBranch}`,
    `targetBranch: ${flow.targetBranch}`,
    `title: ${flow.title ?? "(untitled)"}`,
    `summary: ${flow.summary}`,
    "files:",
    files,
    "changedFiles (git diff --name-status):",
    fileChanges,
    prInfo,
    "Review the current state using read-only inspection only.",
    reviewImpactInstruction(stage),
    "",
    reviewReadOnlyInstruction(),
    `When the review is ready, call POST /api/pr-flows/${flow.id}/reviews as an intermediate tool call with this JSON body (set decision to exactly one of approve, reject, needs_changes, or blocked):`,
    JSON.stringify(
      {
        agentId: reviewerAgentId,
        reviewToken,
        stage,
        decision: "approve",
        summary: "short review summary",
        risks: ["risk or empty array"],
        filesReviewed: ["path or empty array"],
        requiredChanges: ["required change or empty array"],
      },
      null,
      2,
    ),
    "Do not print or return the callback JSON as assistant text. The callback is an intermediate tool call, not the end of your reply.",
    "Wait for the HTTP response, then continue the task you were doing in the same reply.",
    "After the review callback succeeds, this flow's read-only freeze remains in force until Agent Canvas reports that the flow merged, failed, was cancelled, timed out, or became blocked.",
    reviewerAgentId === flow.proposerAgentId
      ? "Because you are also this flow's proposer, only an explicit create or merge authorization grants the limited mutation exception described in that authorization."
      : "Wait for an explicit flow-closed release before making any workspace, Git, remote branch, or PR mutation.",
  ]
    .filter(Boolean)
    .join("\n");
}

function reviewReadOnlyInstruction(): string {
  return [
    "READ-ONLY FLOW FREEZE: from receipt of this request until Agent Canvas explicitly reports that this flow is closed, do not edit or write files and do not run any command or action that mutates the workspace, Git state, a remote branch, or a PR.",
    "Prohibited operations include commit, checkout/switch, reset, rebase, merge, cherry-pick, pull, push, and PR creation/update/merge. Read-only status, diff, log, show, and file inspection are allowed; the review callback itself is allowed.",
  ].join("\n");
}

function reviewImpactInstruction(stage: PullRequestReviewStage): string {
  if (stage === "source_preflight") {
    return [
      "Your primary review goal is to decide whether this PR is acceptable for your own current work.",
      "As an agent working on the source branch, check whether the PR portion conflicts with the part you are currently working on, and whether the PR should wait until your current work is finished.",
      "If your current work is incomplete and may affect this PR, reject or request changes and explain the impact in summary, risks, and requiredChanges.",
    ].join("\n");
  }
  return [
    "Your primary review goal is to decide whether this PR is acceptable for your own current work.",
    "As an agent working on the target branch, check whether merging this PR would interfere with the part you are currently working on, including unfinished experiments, pending validation, or local conflicts.",
    "If the PR would disrupt your current work or should wait until your experiment/validation is complete, reject or request changes and explain the impact in summary, risks, and requiredChanges.",
  ].join("\n");
}

function retryPrompt(
  flow: PullRequestFlowSnapshot,
  stage: PullRequestReviewStage,
  reviewerAgentId: string,
  reviewToken: string,
): string {
  return [
    "Your previous PR review response was not valid JSON for Agent Canvas.",
    reviewReadOnlyInstruction(),
    `Submit the review by calling POST /api/pr-flows/${flow.id}/reviews as an intermediate tool call with this JSON body (set decision to exactly one of approve, reject, needs_changes, or blocked):`,
    JSON.stringify(
      {
        agentId: reviewerAgentId,
        reviewToken,
        stage,
        decision: "approve",
        summary: "short review summary",
        risks: [],
        filesReviewed: [],
        requiredChanges: [],
      },
      null,
      2,
    ),
    "Do not print or return the callback JSON as assistant text, and do not end your reply after submitting it.",
    "Wait for the HTTP response, then continue the task you were doing in the same reply.",
    "The flow's read-only freeze remains in force after the callback until Agent Canvas sends an explicit flow-closed release.",
    reviewerAgentId === flow.proposerAgentId
      ? "Only an explicit create or merge authorization grants the limited mutation exception described in that authorization."
      : "Continue read-only work while waiting for the flow-closed release.",
  ].join("\n");
}

function createPrAuthorizationPrompt(
  flow: PullRequestFlowSnapshot,
  responses: PullRequestReviewResponse[],
  completionToken: string,
): string {
  return [
    "Agent Canvas PR authorization granted.",
    "You are authorized to create the PR for this flow from the reviewed source head.",
    `flowId: ${flow.id}`,
    `sourceBranch: ${flow.sourceBranch}`,
    `targetBranch: ${flow.targetBranch}`,
    `title: ${flow.title ?? "(choose a suitable title)"}`,
    `summary: ${flow.summary}`,
    "files:",
    formatFiles(flow.files),
    "changedFiles (git diff --name-status):",
    formatFileChanges(flow.fileChanges),
    "",
    "This authorization lifts the proposer freeze only to create this PR from the exact reviewed and already-pushed source head. Unrelated workspace, Git, remote branch, and PR mutations remain prohibited.",
    "Do not edit files, create commits, push, or sync/rewrite the source branch at this stage. If the PR cannot be created from the reviewed head, report the blocker instead of changing it. Do not merge the PR yet.",
    `After the PR exists, call POST /api/pr-flows/${flow.id}/pr-created as an intermediate tool call with this JSON body:`,
    JSON.stringify(
      {
        agentId: flow.proposerAgentId,
        completionToken,
        prNumber: 0,
        prUrl: "https://github.com/OWNER/REPO/pull/0",
        title: flow.title ?? "",
        summary: flow.summary,
        files: flow.files,
        fileChanges: flow.fileChanges,
      },
      null,
      2,
    ),
    "Do not print or return the callback JSON as assistant text, and do not end your reply after submitting it.",
    "Wait for the HTTP response, then continue the task you were doing in the same reply.",
    "As soon as the pr-created callback succeeds, the entire workspace, Git state, remote branch, and PR state become read-only again until Agent Canvas grants merge authorization or reports failure for this flow.",
    "",
    "Source review summary:",
    reviewSummary(responses),
  ].join("\n");
}

function mergeAuthorizationPrompt(
  flow: PullRequestFlowSnapshot,
  responses: PullRequestReviewResponse[],
  completionToken: string,
): string {
  return [
    "Agent Canvas merge authorization granted.",
    "You are authorized to merge the PR for this flow.",
    `flowId: ${flow.id}`,
    `sourceBranch: ${flow.sourceBranch}`,
    `targetBranch: ${flow.targetBranch}`,
    `PR: ${flow.pr?.prUrl ?? flow.pr?.prNumber ?? "(not provided)"}`,
    "",
    "This authorization lifts the proposer freeze only to merge this exact, already-reviewed PR. Unrelated workspace, Git, remote branch, and PR mutations remain prohibited.",
    "Do not edit files, create new source-branch or workspace commits, push, sync/rewrite branches, or update the PR contents. The authorized merge itself may update this PR and create its target-branch merge commit. If the reviewed PR cannot be merged as-is, report the blocker instead of changing it.",
    `After the merge is complete, call POST /api/pr-flows/${flow.id}/merged as an intermediate tool call with this JSON body:`,
    JSON.stringify(
      { agentId: flow.proposerAgentId, completionToken },
      null,
      2,
    ),
    "Do not print or return callback JSON as assistant text, and do not end your reply after submitting it.",
    "Wait for the HTTP response, then continue the task you were doing in the same reply. A successful merged callback closes this flow and releases its freeze.",
    "",
    "Target review summary:",
    reviewSummary(responses),
  ].join("\n");
}

function sourceFailurePrompt(
  flow: PullRequestFlowSnapshot,
  responses: PullRequestReviewResponse[],
): string {
  return [
    "Agent Canvas PR source preflight failed. Do not create the PR for this flow.",
    "The workspace/Git/PR freeze imposed by this flow is now released.",
    "This releases only this flow; continue to obey every freeze imposed by another active PR or sync flow.",
    `flowId: ${flow.id}`,
    reviewSummary(responses),
  ].join("\n");
}

function targetFailurePrompt(
  flow: PullRequestFlowSnapshot,
  responses: PullRequestReviewResponse[],
): string {
  return [
    "Agent Canvas target branch review failed. Do not merge the PR for this flow.",
    "The workspace/Git/PR freeze imposed by this flow is now released.",
    "This releases only this flow; continue to obey every freeze imposed by another active PR or sync flow.",
    `flowId: ${flow.id}`,
    reviewSummary(responses),
  ].join("\n");
}

function reviewFreezeReleasePrompt(flow: PullRequestFlowSnapshot): string {
  if (flow.status === "source_review_failed") {
    const request = [...flow.reviewRequests]
      .reverse()
      .find((candidate) => candidate.stage === "source_preflight");
    return sourceFailurePrompt(flow, request?.responses ?? []);
  }
  if (flow.status === "target_review_failed") {
    const request = [...flow.reviewRequests]
      .reverse()
      .find((candidate) => candidate.stage === "target_merge");
    return targetFailurePrompt(flow, request?.responses ?? []);
  }
  return [
    "Agent Canvas PR flow closed. The read-only workspace/Git/PR freeze imposed by this flow is now released.",
    `flowId: ${flow.id}`,
    `status: ${flow.status}`,
    "This releases only the freeze imposed by this flow. If any other active PR or sync flow still imposes a freeze, you must continue to obey it.",
    "Resume your prior task subject to every other active flow and normal workspace policy.",
  ].join("\n");
}

function reviewSummary(responses: PullRequestReviewResponse[]): string {
  if (responses.length === 0) return "No active reviewers were available.";
  return responses
    .map(
      (response) =>
        `- ${response.agentId}: ${response.decision}; ${response.summary}` +
        (response.requiredChanges.length
          ? `; requiredChanges=${response.requiredChanges.join("; ")}`
          : ""),
    )
    .join("\n");
}

function formatFiles(files: string[]): string {
  return files.map((file) => `- ${file}`).join("\n");
}

function formatFileChanges(files: PullRequestChangedFile[]): string {
  return files.map((file) => `- ${file.status} ${file.path}`).join("\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function maxNumericSuffix(ids: string[]): number {
  let max = 0;
  for (const id of ids) {
    const match = id.match(/_(\d+)$/u);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max;
}
