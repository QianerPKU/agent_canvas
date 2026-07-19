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
  deliver(text: string): Promise<void>;
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

  importState(
    flows: PullRequestFlowSnapshot[] | undefined,
    options: { deferActivation?: boolean } = {},
  ): void {
    this.stateGeneration += 1;
    for (const flowId of this.timers.keys()) this.closeTimer(flowId);
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
    await this.reviewQueue.enqueue(this.reviewJob(flow, "source_preflight", "queued"));
    this.assertCurrentGeneration(generation);
    return this.requireFlow(flow.id);
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
    await this.reviewQueue.enqueue(this.reviewJob(queued, "target_merge", "queued"));
    this.assertCurrentGeneration(generation);
    return this.requireFlow(flowId);
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
    await this.reviewQueue.retry(reviewJobId(flow.id, flow.currentStage));
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
        await this.trackPendingOperation(async () =>
          await this.activateQueuedReviewStage(flow.id, stage, generation),
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
              reviewPrompt(this.requireFlow(flowId), stage),
              { startIfIdle: true },
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
      const reviewText = assistantTextForResult(
        this.host.historyOf(agentId),
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
          await this.deliverToAgent(agentId, retryPrompt(flow, stage), {
            startIfIdle: true,
          }),
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
    const request = currentRequest(flow, flow.currentStage);
    if (!request || request.pendingAgentIds.length > 0) return;
    if (!hasCompleteReviewerCoverage(request)) return;
    this.closeTimer(flowId);
    const allApproved = request.responses.every((response) => response.decision === "approve");
    if (request.stage === "source_preflight") {
      if (!allApproved) {
        const next = this.failFlow(flow, "source_review_failed", reviewSummary(request.responses));
        this.reviewQueue.complete(reviewJobId(flowId, request.stage));
        await this.notifyProposer(next, sourceFailurePrompt(next, request.responses), generation);
        return;
      }
      this.reviewQueue.complete(reviewJobId(flowId, request.stage));
      await this.authorizeCreatePr(flow, request.responses, generation);
      return;
    }
    if (!allApproved) {
      const next = this.failFlow(flow, "target_review_failed", reviewSummary(request.responses));
      this.reviewQueue.complete(reviewJobId(flowId, request.stage));
      await this.notifyProposer(next, targetFailurePrompt(next, request.responses), generation);
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
    this.save(next);
    this.resetTimer(flow.id, authorization.expiresAt, generation);
    await this.notifyProposer(next, createPrAuthorizationPrompt(next, responses), generation);
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
    this.save(next);
    this.resetTimer(flow.id, authorization.expiresAt, generation);
    await this.notifyProposer(next, mergeAuthorizationPrompt(next, responses), generation);
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
      await this.deliverToAgent(flow.proposerAgentId, text);
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

  private async trackPendingOperation<T>(operation: () => Promise<T>): Promise<T> {
    const token = Symbol("pr-review-operation");
    this.pendingOperations.add(token);
    try {
      return await operation();
    } finally {
      this.pendingOperations.delete(token);
    }
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
    options: { startIfIdle?: boolean } = {},
  ): Promise<void> {
    const runner = this.host.get(agentId);
    if (!runner) throw new Error(`unknown agent: ${agentId}`);
    if (options.startIfIdle && runner.getStatus() === "idle") {
      await this.host.startAgent(agentId, { prompt: text });
      return;
    }
    await runner.deliver(text);
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
    this.flows.set(flow.id, flow);
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

function pathsFromFileChanges(files: PullRequestChangedFile[]): string[] {
  return uniqueStrings(files.map((file) => file.path));
}

function uniqueStrings(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

function reviewPrompt(flow: PullRequestFlowSnapshot, stage: PullRequestReviewStage): string {
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
    "Review the current state. You may inspect the repository as needed.",
    reviewImpactInstruction(stage),
    "Return exactly one JSON object matching this schema, with no extra prose:",
    reviewSchema(flow.id, stage),
  ]
    .filter(Boolean)
    .join("\n");
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

function retryPrompt(flow: PullRequestFlowSnapshot, stage: PullRequestReviewStage): string {
  return [
    "Your previous PR review response was not valid JSON for Agent Canvas.",
    "Return exactly one JSON object matching this schema, with no extra prose:",
    reviewSchema(flow.id, stage),
  ].join("\n");
}

function reviewSchema(flowId: string, stage: PullRequestReviewStage): string {
  return JSON.stringify(
    {
      agentCanvasPrReview: true,
      flowId,
      stage,
      decision: "approve | reject | needs_changes | blocked",
      summary: "short review summary",
      risks: ["risk or empty array"],
      filesReviewed: ["path or empty array"],
      requiredChanges: ["required change or empty array"],
    },
    null,
    2,
  );
}

function createPrAuthorizationPrompt(
  flow: PullRequestFlowSnapshot,
  responses: PullRequestReviewResponse[],
): string {
  return [
    "Agent Canvas PR authorization granted.",
    "You are authorized to prepare and create the PR for this flow.",
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
    "You have full freedom to choose the git/GitHub commands, update the source branch, and resolve conflicts before opening the PR.",
    "Do not merge the PR yet. After the PR exists, report exactly one JSON object:",
    JSON.stringify(
      {
        agentCanvasPrEvent: "pr_created",
        flowId: flow.id,
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
    "",
    "Source review summary:",
    reviewSummary(responses),
  ].join("\n");
}

function mergeAuthorizationPrompt(
  flow: PullRequestFlowSnapshot,
  responses: PullRequestReviewResponse[],
): string {
  return [
    "Agent Canvas merge authorization granted.",
    "You are authorized to merge the PR for this flow.",
    `flowId: ${flow.id}`,
    `sourceBranch: ${flow.sourceBranch}`,
    `targetBranch: ${flow.targetBranch}`,
    `PR: ${flow.pr?.prUrl ?? flow.pr?.prNumber ?? "(not provided)"}`,
    "",
    "You have full freedom to choose the git/GitHub commands and handle merge-time details.",
    "After the merge is complete, report exactly one JSON object:",
    JSON.stringify({ agentCanvasPrEvent: "merged", flowId: flow.id }, null, 2),
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
    `flowId: ${flow.id}`,
    reviewSummary(responses),
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
