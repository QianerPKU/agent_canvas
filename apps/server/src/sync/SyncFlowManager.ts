import { randomUUID } from "node:crypto";
import type {
  AgentEventEnvelope,
  AgentSnapshot,
  BranchPullStrategy,
  CreateSyncFlowInput,
  SyncFlowAppliedInfo,
  SyncFlowAppliedInput,
  SyncFlowChangedFile,
  SyncFlowReviewDecision,
  SyncFlowReviewRequest,
  SyncFlowReviewResponse,
  SyncFlowSnapshot,
} from "@agent-canvas/shared";
import {
  BranchReviewQueue,
  type BranchReviewJob,
  type BranchReviewStartResult,
} from "../reviews/BranchReviewQueue.js";
import {
  redactFlowCapabilities,
  redactFlowCapabilityText,
} from "../flowCapabilityRedaction.js";
import { DEFAULT_BRANCH_REVIEW_TIMEOUT_MS } from "../reviews/reviewDefaults.js";

type DeliverableRunner = {
  deliver(
    text: string,
    options?: { automationKey?: string; replaceQueued?: boolean },
  ): Promise<void>;
};

export interface SyncFlowAgentHost {
  list(): AgentSnapshot[];
  get(id: string): DeliverableRunner | undefined;
  historyOf(id: string): AgentEventEnvelope[];
  currentTurnIndex?(id: string): number;
}

export interface ResolveSyncChangedFilesContext {
  kind: CreateSyncFlowInput["kind"];
  proposerAgentId: string;
  targetBranch: string;
  sourceBranch?: string;
  commitSha?: string;
  targetCwd?: string;
}

export interface ResolveSyncChangedFiles {
  (context: ResolveSyncChangedFilesContext): Promise<SyncFlowChangedFile[] | undefined>;
}

export interface SyncFlowManagerOptions {
  host: SyncFlowAgentHost;
  reviewQueue?: BranchReviewQueue;
  resolveChangedFiles?: ResolveSyncChangedFiles;
  now?: () => number;
  reviewTimeoutMs?: number;
  reviewRetryLimit?: number;
  setTimer?: (callback: () => void, delay: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

type FlowListener = (flow: SyncFlowSnapshot) => void;

interface ParsedReview {
  agentCanvasSyncReview: true;
  flowId: string;
  decision: SyncFlowReviewDecision;
  summary: string;
  risks?: string[];
  filesReviewed?: string[];
  requiredChanges?: string[];
}

interface ParsedAgentEvent {
  agentCanvasSyncEvent: "applied";
  flowId: string;
  summary?: string;
  commitSha?: string;
  files?: string[];
  fileChanges?: SyncFlowChangedFile[];
}

export interface SyncFlowReviewSubmission {
  agentId: string;
  reviewToken: string;
  decision: SyncFlowReviewDecision;
  summary: string;
  risks?: string[];
  filesReviewed?: string[];
  requiredChanges?: string[];
}

export interface SyncFlowAppliedSubmission extends SyncFlowAppliedInput {
  callbackToken: string;
}

interface NormalizedSyncFlowReview {
  agentId: string;
  reviewToken: string;
  decision: SyncFlowReviewDecision;
  summary: string;
  risks: string[];
  filesReviewed: string[];
  requiredChanges: string[];
}

interface ReviewCapability {
  token: string;
  flowId: string;
  requestId: string;
  agentId: string;
  accepted?: NormalizedSyncFlowReview;
}

interface NormalizedAppliedSubmission {
  summary: string;
  commitSha?: string;
  files: string[];
  fileChanges: SyncFlowChangedFile[];
}

interface ApplyCapability {
  token: string;
  flowId: string;
  agentId: string;
  action: "applied";
  accepted?: NormalizedAppliedSubmission;
}

const DEFAULT_REVIEW_RETRY_LIMIT = 1;
const REVIEW_QUEUE_OWNER = "sync";
const CAPABILITY_TOKEN_PREFIX = "agent_canvas_cap_";
const CLOSED_STATUSES: SyncFlowSnapshot["status"][] = [
  "review_failed",
  "applied",
  "timed_out",
  "cancelled",
  "blocked",
];

export class SyncFlowManager {
  private readonly host: SyncFlowAgentHost;
  private readonly reviewQueue: BranchReviewQueue;
  private readonly resolveChangedFiles?: ResolveSyncChangedFiles;
  private readonly now: () => number;
  private readonly reviewTimeoutMs: number;
  private readonly reviewRetryLimit: number;
  private readonly setTimer: (callback: () => void, delay: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;
  private readonly flows = new Map<string, SyncFlowSnapshot>();
  private readonly timers = new Map<string, unknown>();
  private readonly listeners = new Set<FlowListener>();
  private readonly pendingOperations = new Set<symbol>();
  private readonly pendingOperationsByFlow = new Map<string, Set<Promise<unknown>>>();
  private readonly reviewCapabilities = new Map<string, ReviewCapability>();
  private readonly applyCapabilities = new Map<string, ApplyCapability>();
  private readonly issuedCapabilityTokens = new Set<string>();
  private readonly successfulClosureReleases = new Map<string, Set<string>>();
  private readonly pendingClosureReleases = new Map<
    string,
    { agentId: string; promise: Promise<void> }
  >();
  private readonly closureReleaseVersions = new Map<string, number>();
  private counter = 0;
  private importedStateActivated = true;
  private stateGeneration = 0;

  constructor(options: SyncFlowManagerOptions) {
    this.host = options.host;
    this.reviewQueue = options.reviewQueue ?? new BranchReviewQueue();
    this.resolveChangedFiles = options.resolveChangedFiles;
    this.now = options.now ?? Date.now;
    this.reviewTimeoutMs = options.reviewTimeoutMs ?? DEFAULT_BRANCH_REVIEW_TIMEOUT_MS;
    this.reviewRetryLimit = options.reviewRetryLimit ?? DEFAULT_REVIEW_RETRY_LIMIT;
    this.setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
    this.clearTimer =
      options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  }

  onFlow(listener: FlowListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(): SyncFlowSnapshot[] {
    return [...this.flows.values()];
  }

  exportState(): SyncFlowSnapshot[] {
    return redactFlowCapabilities(this.list());
  }

  hasOpenFlows(): boolean {
    return this.list().some((flow) => !CLOSED_STATUSES.includes(flow.status));
  }

  hasPendingOperations(): boolean {
    return this.pendingOperations.size > 0;
  }

  importState(
    flows: SyncFlowSnapshot[] | undefined,
    options: { deferActivation?: boolean } = {},
  ): void {
    this.stateGeneration += 1;
    this.pendingOperationsByFlow.clear();
    for (const flowId of this.timers.keys()) this.closeTimer(flowId);
    this.clearAllCapabilities();
    this.successfulClosureReleases.clear();
    this.pendingClosureReleases.clear();
    this.closureReleaseVersions.clear();
    // Retire live reservations immediately. An in-flight lease keeps its branch occupied until
    // delivery settles, while deferred activation prevents restored prompts from being sent
    // before the rest of the project state is authoritative.
    this.reviewQueue.replaceOwner(REVIEW_QUEUE_OWNER, []);
    this.flows.clear();
    for (const importedFlow of flows ?? []) {
      const flow = redactFlowCapabilities(importedFlow);
      const participantAgentIds = uniqueStrings([
        ...(flow.participantAgentIds ?? []),
        ...(flow.reviewRequest?.requestedAgentIds ?? []),
      ]);
      const restoredBase: SyncFlowSnapshot = {
        ...flow,
        participantAgentIds: participantAgentIds.length > 0 ? participantAgentIds : undefined,
      };
      let restored =
        restoredBase.status === "review_collecting"
          ? {
              ...restoredBase,
              status: "queued" as const,
              deadlineAt: undefined,
              failureReason:
                "Review was requeued because its previous delivery cannot survive reload.",
            }
          : restoredBase;
      if (restored.status === "queued") {
        if (restored.reviewQueueSequence !== undefined) {
          this.reviewQueue.observeSequence(restored.reviewQueueSequence);
        }
      }
      this.flows.set(flow.id, restored);
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
      if (flow.status !== "queued") return [];
      return [this.reviewJob(flow, "queued")];
    });
    this.reviewQueue.replaceOwner(REVIEW_QUEUE_OWNER, reviewJobs);
    for (const flow of [...this.flows.values()]) {
      if (CLOSED_STATUSES.includes(flow.status)) continue;
      if (flow.deadlineAt !== undefined && flow.deadlineAt <= this.now()) {
        this.timeoutFlow(flow.id, generation);
        continue;
      }
      if (flow.deadlineAt !== undefined) this.resetTimer(flow.id, flow.deadlineAt, generation);
      if (flow.status === "apply_authorized") {
        void this.trackPendingOperation(
          async () => await this.restoreApplyAuthorization(flow.id, generation),
          flow.id,
        );
      }
    }
  }

  getReviewQueue(): BranchReviewQueue {
    return this.reviewQueue;
  }

  get(id: string): SyncFlowSnapshot | undefined {
    return this.flows.get(id);
  }

  async retryClosureReleasesForAgent(agentId: string): Promise<void> {
    const normalizedAgentId = agentId.trim();
    if (!normalizedAgentId) return;
    const epoch = this.stateGeneration;
    const closedFlows = this.list().filter(
      (flow) =>
        CLOSED_STATUSES.includes(flow.status) &&
        closureRecipientAgentIds(flow).includes(normalizedAgentId),
    );
    await Promise.all(
      closedFlows.map(
        async (flow) =>
          await this.releaseClosureToAgent(
            flow,
            normalizedAgentId,
            epoch,
            reviewFreezeReleasePrompt(flow),
          ),
      ),
    );
  }

  forgetClosureReleasesForAgent(agentId: string): void {
    const normalizedAgentId = agentId.trim();
    if (!normalizedAgentId) return;
    this.successfulClosureReleases.delete(normalizedAgentId);
    this.closureReleaseVersions.set(
      normalizedAgentId,
      (this.closureReleaseVersions.get(normalizedAgentId) ?? 0) + 1,
    );
    for (const [key, pending] of this.pendingClosureReleases) {
      if (pending.agentId === normalizedAgentId) this.pendingClosureReleases.delete(key);
    }
  }

  async create(input: CreateSyncFlowInput): Promise<SyncFlowSnapshot> {
    input = redactFlowCapabilities(input);
    const epoch = this.stateGeneration;
    if (!input?.proposerAgentId) throw new Error("missing proposerAgentId");
    if (!input.summary?.trim()) throw new Error("missing summary");
    if (!input.reason?.trim()) throw new Error("missing reason");
    const proposer = this.host.list().find((agent) => agent.id === input.proposerAgentId);
    if (!proposer) throw new Error(`unknown proposer agent: ${input.proposerAgentId}`);
    if (!isActiveAgentStatus(proposer.status)) {
      throw new Error("proposer agent must be running or waiting_input");
    }
    const targetBranch = redactFlowCapabilityText(
      input.targetBranch?.trim() || proposer.config.branch || "",
    );
    if (!targetBranch) throw new Error("missing targetBranch");
    if (input.kind === "cherry_pick" && !input.commitSha.trim()) {
      throw new Error("missing commitSha");
    }
    if (input.kind === "branch_pull" && !input.sourceBranch.trim()) {
      throw new Error("missing sourceBranch");
    }

    const sourceBranch =
      input.kind === "branch_pull" || input.sourceBranch?.trim()
        ? input.sourceBranch?.trim()
        : undefined;
    const commitSha = input.kind === "cherry_pick" ? input.commitSha.trim() : undefined;
    const fileChanges = await this.changedFilesFor({
      kind: input.kind,
      proposerAgentId: input.proposerAgentId,
      targetBranch,
      sourceBranch,
      commitSha,
      targetCwd: proposer.config.cwd,
      files: input.files,
    });
    this.assertCurrentEpoch(epoch);
    if (fileChanges.length === 0) {
      throw new Error("sync flow requires a concrete changed file list");
    }

    const createdAt = this.now();
    const flow: SyncFlowSnapshot = {
      id: `sync_flow_${++this.counter}`,
      kind: input.kind,
      proposerAgentId: input.proposerAgentId,
      sourceTurnIndex: this.host.currentTurnIndex?.(input.proposerAgentId),
      targetBranch,
      sourceBranch,
      commitSha,
      strategy: input.kind === "branch_pull" ? input.strategy ?? "merge" : undefined,
      title: input.title?.trim() || undefined,
      summary: input.summary.trim(),
      reason: input.reason.trim(),
      files: pathsFromFileChanges(fileChanges),
      fileChanges,
      status: "queued",
      createdAt,
      updatedAt: createdAt,
      reviewQueueSequence: this.reviewQueue.reserveSequence(),
    };
    this.save(flow);
    this.startBackgroundOperation(flow.id, async () => {
      await this.reviewQueue.enqueue(this.reviewJob(flow, "queued"));
      this.assertCurrentEpoch(epoch);
    });
    return this.requireFlow(flow.id);
  }

  recordApplied(
    flowId: string,
    input: SyncFlowAppliedInput = {},
    reportedByAgentId?: string,
  ): SyncFlowSnapshot {
    const next = this.recordAppliedState(flowId, input, reportedByAgentId);
    const epoch = this.stateGeneration;
    this.releaseReviewersInBackground(next, epoch);
    return next;
  }

  async submitApplied(
    flowId: string,
    input: SyncFlowAppliedSubmission,
  ): Promise<SyncFlowSnapshot> {
    const epoch = this.stateGeneration;
    const flow = this.requireFlow(flowId);
    const callbackToken = normalizeCallbackToken(input?.callbackToken);
    const capability = this.requireApplyCapability(flow.id, flow.proposerAgentId);
    if (capability.token !== callbackToken) {
      throw new Error("invalid or expired sync applied callbackToken");
    }
    const submission = normalizeAppliedSubmission(flow, canonicalAppliedInput(input));
    if (capability.accepted) {
      if (sameAppliedSubmission(capability.accepted, submission)) return flow;
      throw new Error("sync applied callback already submitted with different data");
    }
    if (flow.status !== "apply_authorized") {
      throw new Error("sync flow can only be marked applied after authorization");
    }

    capability.accepted = submission;
    let next: SyncFlowSnapshot;
    try {
      next = this.recordAppliedState(flowId, submission, flow.proposerAgentId);
    } catch (error) {
      capability.accepted = undefined;
      throw error;
    }
    this.releaseReviewersInBackground(next, epoch);
    return next;
  }

  async submitReview(
    flowId: string,
    input: SyncFlowReviewSubmission,
  ): Promise<SyncFlowSnapshot> {
    const epoch = this.stateGeneration;
    const flow = this.requireFlow(flowId);
    const submission = normalizeReviewSubmission(input);
    const request = flow.reviewRequest;
    const capability = this.requireReviewCapability(
      flow.id,
      request?.id,
      submission.agentId,
    );
    if (capability.token !== submission.reviewToken) {
      throw new Error("invalid or expired sync reviewToken");
    }
    if (capability.accepted) {
      if (sameNormalizedReviewSubmission(capability.accepted, submission)) return flow;
      throw new Error(`agent ${submission.agentId} already submitted a different review`);
    }
    if (!request || !request.requestedAgentIds.includes(submission.agentId)) {
      throw new Error(`agent ${submission.agentId} was not requested to review sync flow ${flowId}`);
    }
    if (flow.status !== "review_collecting") {
      throw new Error("sync flow is not collecting reviews");
    }
    if (!request.pendingAgentIds.includes(submission.agentId)) {
      throw new Error(`agent ${submission.agentId} is not pending for sync flow ${flowId}`);
    }

    this.recordReviewResponse(flowId, {
      agentId: submission.agentId,
      decision: submission.decision,
      summary: submission.summary,
      risks: submission.risks,
      filesReviewed: submission.filesReviewed,
      requiredChanges: submission.requiredChanges,
      retryCount: request.retryCounts[submission.agentId] ?? 0,
      receivedAt: this.now(),
    });
    capability.accepted = submission;
    this.startBackgroundOperation(
      flowId,
      async () => await this.finishReviewIfComplete(flowId, epoch),
    );
    this.assertCurrentEpoch(epoch);
    return this.requireFlow(flowId);
  }

  cancel(flowId: string): SyncFlowSnapshot {
    const flow = this.requireFlow(flowId);
    this.closeTimer(flowId);
    const next = {
      ...flow,
      status: "cancelled" as const,
      updatedAt: this.now(),
      closedAt: this.now(),
    };
    this.save(next);
    if (flow.status === "queued" || flow.status === "review_collecting") {
      this.reviewQueue.complete(reviewJobId(flow.id));
    }
    const epoch = this.stateGeneration;
    this.releaseReviewersInBackground(next, epoch);
    return next;
  }

  async handleAgentEvent(envelope: AgentEventEnvelope): Promise<void> {
    if (envelope.event.kind !== "result") return;
    const epoch = this.stateGeneration;
    await Promise.resolve();
    if (epoch !== this.stateGeneration) return;
    await this.captureReviewResult(envelope, epoch);
    if (epoch !== this.stateGeneration) return;
    await this.captureAgentSyncEvent(envelope, epoch);
  }

  private reviewJob(
    flow: SyncFlowSnapshot,
    state: BranchReviewJob["state"],
  ): BranchReviewJob {
    const epoch = this.stateGeneration;
    return {
      id: reviewJobId(flow.id),
      owner: REVIEW_QUEUE_OWNER,
      branch: flow.targetBranch,
      order: flow.createdAt,
      sequence: flow.reviewQueueSequence,
      onSequenceAssigned: (sequence) => {
        const current = this.flows.get(flow.id);
        if (!current || (current.status !== "queued" && current.status !== "review_collecting")) {
          return;
        }
        if (current.reviewQueueSequence === sequence) return;
        this.flows.set(flow.id, { ...current, reviewQueueSequence: sequence });
      },
      state,
      start: async () =>
        await this.trackPendingOperation(
          async () => await this.activateQueuedReview(flow.id, epoch),
          flow.id,
        ),
    };
  }

  private async activateQueuedReview(
    flowId: string,
    epoch: number,
  ): Promise<BranchReviewStartResult> {
    if (epoch !== this.stateGeneration) return "started";
    const flow = this.requireFlow(flowId);
    if (flow.status !== "queued") return "started";
    const reviewers = this.activeReviewersFor(flow);
    if (reviewers.length === 0) {
      this.save({
        ...flow,
        failureReason: `Queued sync review is waiting for an active reviewer on branch ${flow.targetBranch}.`,
        updatedAt: this.now(),
      });
      return "deferred";
    }
    this.save({
      ...flow,
      status: "review_collecting",
      failureReason: undefined,
      updatedAt: this.now(),
    });
    await this.startReview(flowId, reviewers, epoch);
    return "started";
  }

  private async startReview(
    flowId: string,
    reviewers: AgentSnapshot[],
    epoch: number,
  ): Promise<void> {
    if (epoch !== this.stateGeneration) return;
    const flow = this.requireFlow(flowId);
    const request: SyncFlowReviewRequest = {
      id: nextReviewRequestId(flow),
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
        this.issueReviewCapability(flow.id, request.id, reviewer.id),
      ]),
    );
    this.save({
      ...flow,
      participantAgentIds: uniqueStrings([
        ...(flow.participantAgentIds ?? []),
        ...request.requestedAgentIds,
      ]),
      reviewRequest: request,
      deadlineAt: request.deadlineAt,
      updatedAt: this.now(),
    });
    this.resetTimer(flowId, request.deadlineAt);

    for (const reviewer of reviewers) {
      try {
        const delivery = await this.reviewQueue.runWhileReserved(
          reviewJobId(flowId),
          async () =>
            await this.deliverToAgent(
              reviewer.id,
              reviewPrompt(
                this.requireFlow(flowId),
                reviewer.id,
                reviewTokens.get(reviewer.id)!,
              ),
              syncFlowDeliveryOptions(flowId),
            ),
        );
        if (delivery.status === "invalidated") return;
      } catch (error) {
        if (!this.isCurrentReview(flowId, request.id, epoch)) return;
        this.recordSyntheticResponse(
          flowId,
          reviewer.id,
          "blocked",
          `Failed to deliver sync review request: ${errorMessage(error)}`,
        );
      }
      if (!this.isCurrentReview(flowId, request.id, epoch)) return;
    }
    if (!this.isCurrentReview(flowId, request.id, epoch)) return;
    await this.finishReviewIfComplete(flowId, epoch);
  }

  private async captureReviewResult(envelope: AgentEventEnvelope, epoch: number): Promise<void> {
    const agentId = envelope.agentId;
    const openFlows = this.listOpenReviewFlowsFor(agentId);
    for (const flow of openFlows) {
      const request = flow.reviewRequest!;
      const capability = this.reviewCapabilities.get(
        reviewCapabilityKey(flow.id, request.id, agentId),
      );
      const history = this.host.historyOf(agentId);
      if (
        capability &&
        hasUndeliveredQueuedReviewPrompt(
          history,
          envelope.seq,
          request.requestedAt,
          request.requestedAfterSeqs?.[agentId],
          flow.id,
          agentId,
          capability.token,
        )
      ) {
        continue;
      }
      const rawText = assistantTextForResult(
        history,
        envelope.seq,
        request.requestedAt,
        request.requestedAfterSeqs?.[agentId],
      );
      const parsed = parseReview(rawText, flow.id);
      if (!parsed) {
        if (hasRecognizedAgentCanvasOutput(rawText)) continue;
        await this.handleInvalidReview(flow.id, agentId, epoch);
        if (epoch !== this.stateGeneration) return;
        continue;
      }
      this.recordReviewResponse(flow.id, {
        agentId,
        decision: parsed.decision,
        summary: parsed.summary,
        risks: parsed.risks ?? [],
        filesReviewed: parsed.filesReviewed ?? [],
        requiredChanges: parsed.requiredChanges ?? [],
        retryCount: request.retryCounts[agentId] ?? 0,
        receivedAt: this.now(),
      });
      await this.finishReviewIfComplete(flow.id, epoch);
      if (epoch !== this.stateGeneration) return;
    }
  }

  private async captureAgentSyncEvent(envelope: AgentEventEnvelope, epoch: number): Promise<void> {
    const agentId = envelope.agentId;
    const possibleFlows = this.list().filter(
      (flow) => flow.proposerAgentId === agentId && flow.status === "apply_authorized",
    );
    for (const flow of possibleFlows) {
      const since = flow.applyAuthorization?.issuedAt ?? flow.updatedAt;
      const parsed = parseAgentSyncEvent(
        assistantTextForResult(this.host.historyOf(agentId), envelope.seq, since),
      );
      if (!parsed || parsed.flowId !== flow.id) continue;
      const next = this.recordAppliedState(flow.id, parsed, agentId);
      await this.releaseReviewers(next, epoch);
      if (epoch !== this.stateGeneration) return;
    }
  }

  private async handleInvalidReview(
    flowId: string,
    agentId: string,
    epoch: number,
  ): Promise<void> {
    if (epoch !== this.stateGeneration) return;
    const flow = this.requireFlow(flowId);
    const request = flow.reviewRequest;
    if (!request || !request.pendingAgentIds.includes(agentId)) return;
    const retryCount = request.retryCounts[agentId] ?? 0;
    if (retryCount < this.reviewRetryLimit) {
      request.retryCounts[agentId] = retryCount + 1;
      this.save({
        ...flow,
        reviewRequest: { ...request },
        updatedAt: this.now(),
      });
      const reviewToken = this.requireReviewCapability(
        flow.id,
        request.id,
        agentId,
      ).token;
      const delivery = await this.reviewQueue.runWhileReserved(
        reviewJobId(flowId),
        async () =>
          await this.deliverToAgent(
            agentId,
            retryPrompt(flow, agentId, reviewToken),
            syncFlowDeliveryOptions(flowId),
          ),
      );
      if (delivery.status === "invalidated") return;
      return;
    }
    this.recordReviewResponse(flowId, {
      agentId,
      decision: "blocked",
      summary: "Review response did not match the required JSON schema after retry.",
      risks: [],
      filesReviewed: [],
      requiredChanges: ["Return the required JSON schema exactly."],
      retryCount,
      receivedAt: this.now(),
    });
    if (epoch !== this.stateGeneration) return;
    await this.finishReviewIfComplete(flowId, epoch);
  }

  private async finishReviewIfComplete(flowId: string, epoch: number): Promise<void> {
    if (epoch !== this.stateGeneration) return;
    const flow = this.requireFlow(flowId);
    if (flow.status !== "review_collecting") return;
    const request = flow.reviewRequest;
    if (!request || request.pendingAgentIds.length > 0) return;
    if (!hasCompleteReviewerCoverage(request)) return;
    this.closeTimer(flowId);
    const allApproved = request.responses.every((response) => response.decision === "approve");
    if (!allApproved) {
      const next = this.failFlow(flow, "review_failed", reviewSummary(request.responses));
      this.reviewQueue.complete(reviewJobId(flowId));
      await this.releaseReviewers(next, epoch, reviewFailurePrompt(next, request.responses));
      return;
    }
    const next = this.authorizeApply(flow);
    this.reviewQueue.complete(reviewJobId(flowId));
    const callbackToken = this.issueApplyCapability(
      next.id,
      next.proposerAgentId,
    );
    await this.notifyProposer(
      next,
      applyAuthorizationPrompt(next, request.responses, callbackToken),
      epoch,
    );
  }

  private authorizeApply(flow: SyncFlowSnapshot): SyncFlowSnapshot {
    const authorization = {
      agentId: flow.proposerAgentId,
      issuedAt: this.now(),
      expiresAt: this.now() + this.reviewTimeoutMs,
    };
    const next = {
      ...flow,
      status: "apply_authorized" as const,
      deadlineAt: authorization.expiresAt,
      applyAuthorization: authorization,
      updatedAt: this.now(),
    };
    this.save(next);
    this.resetTimer(flow.id, authorization.expiresAt);
    return next;
  }

  private recordAppliedState(
    flowId: string,
    input: SyncFlowAppliedInput,
    reportedByAgentId?: string,
  ): SyncFlowSnapshot {
    const flow = this.requireFlow(flowId);
    if (flow.status !== "apply_authorized") {
      throw new Error("sync flow can only be marked applied after authorization");
    }
    this.closeTimer(flowId);
    const canonicalInput = canonicalAppliedInput(input);
    const fileChanges = updatedFileChangesForApplied(flow, canonicalInput);
    const applied: SyncFlowAppliedInfo = {
      summary: canonicalInput.summary?.trim() || flow.summary,
      commitSha: canonicalInput.commitSha?.trim() || undefined,
      files: pathsFromFileChanges(fileChanges),
      fileChanges,
      reportedByAgentId,
      appliedAt: this.now(),
    };
    const next = {
      ...flow,
      files: applied.files,
      fileChanges,
      applied,
      status: "applied" as const,
      updatedAt: this.now(),
      closedAt: this.now(),
    };
    this.save(next);
    return next;
  }

  private failFlow(
    flow: SyncFlowSnapshot,
    status: "review_failed" | "blocked",
    reason: string,
  ): SyncFlowSnapshot {
    this.closeTimer(flow.id);
    const next = {
      ...flow,
      status,
      updatedAt: this.now(),
      closedAt: this.now(),
      failureReason: reason,
    };
    this.save(next);
    return next;
  }

  private async notifyProposer(
    flow: SyncFlowSnapshot,
    text: string,
    epoch: number,
  ): Promise<void> {
    if (!this.isCurrentGeneration(epoch)) return;
    try {
      await this.deliverToAgent(
        flow.proposerAgentId,
        text,
        syncFlowDeliveryOptions(flow.id),
      );
    } catch (error) {
      if (
        this.isCurrentGeneration(epoch) &&
        this.flows.get(flow.id) === flow &&
        !CLOSED_STATUSES.includes(flow.status)
      ) {
        const blocked = this.failFlow(
          flow,
          "blocked",
          `Failed to deliver proposer signal: ${errorMessage(error)}`,
        );
        await this.releaseReviewers(blocked, epoch);
      }
    }
  }

  private async restoreApplyAuthorization(flowId: string, epoch: number): Promise<void> {
    if (!this.isCurrentGeneration(epoch)) return;
    const flow = this.flows.get(flowId);
    if (!flow || flow.status !== "apply_authorized") return;
    const callbackToken = this.issueApplyCapability(flow.id, flow.proposerAgentId);
    const responses = flow.reviewRequest?.responses ?? [];
    try {
      await this.deliverToAgent(
        flow.proposerAgentId,
        applyAuthorizationPrompt(flow, responses, callbackToken),
        syncFlowDeliveryOptions(flow.id),
      );
    } catch {
      // Reissuing a restored authorization is best effort. The legacy trusted completion path
      // remains available, and delivery failure must not close an otherwise valid restored flow.
    }
  }

  private issueReviewCapability(
    flowId: string,
    requestId: string,
    agentId: string,
  ): string {
    const key = reviewCapabilityKey(flowId, requestId, agentId);
    const existing = this.reviewCapabilities.get(key);
    if (existing) return existing.token;
    const token = this.issueCapabilityToken();
    this.reviewCapabilities.set(key, { token, flowId, requestId, agentId });
    return token;
  }

  private requireReviewCapability(
    flowId: string,
    requestId: string | undefined,
    agentId: string,
  ): ReviewCapability {
    if (!requestId) throw new Error("invalid or expired sync reviewToken");
    const capability = this.reviewCapabilities.get(
      reviewCapabilityKey(flowId, requestId, agentId),
    );
    if (!capability) throw new Error("invalid or expired sync reviewToken");
    return capability;
  }

  private issueApplyCapability(flowId: string, agentId: string): string {
    const key = applyCapabilityKey(flowId, agentId);
    const existing = this.applyCapabilities.get(key);
    if (existing) return existing.token;
    const token = this.issueCapabilityToken();
    this.applyCapabilities.set(key, {
      token,
      flowId,
      agentId,
      action: "applied",
    });
    return token;
  }

  private requireApplyCapability(flowId: string, agentId: string): ApplyCapability {
    const capability = this.applyCapabilities.get(applyCapabilityKey(flowId, agentId));
    if (!capability) throw new Error("invalid or expired sync applied callbackToken");
    return capability;
  }

  private issueCapabilityToken(): string {
    let token = `${CAPABILITY_TOKEN_PREFIX}${randomUUID()}`;
    while (this.issuedCapabilityTokens.has(token)) {
      token = `${CAPABILITY_TOKEN_PREFIX}${randomUUID()}`;
    }
    this.issuedCapabilityTokens.add(token);
    return token;
  }

  private clearAllCapabilities(): void {
    this.reviewCapabilities.clear();
    this.applyCapabilities.clear();
    this.issuedCapabilityTokens.clear();
  }

  private clearReviewCapabilitiesForFlow(flowId: string): void {
    for (const [key, capability] of this.reviewCapabilities) {
      if (capability.flowId !== flowId) continue;
      this.reviewCapabilities.delete(key);
      this.issuedCapabilityTokens.delete(capability.token);
    }
  }

  private clearUnacceptedApplyCapabilitiesForFlow(flowId: string): void {
    for (const [key, capability] of this.applyCapabilities) {
      if (capability.flowId !== flowId || capability.accepted) continue;
      this.applyCapabilities.delete(key);
      this.issuedCapabilityTokens.delete(capability.token);
    }
  }

  private async releaseReviewers(
    flow: SyncFlowSnapshot,
    epoch: number,
    text = reviewFreezeReleasePrompt(flow),
  ): Promise<void> {
    if (!this.isCurrentGeneration(epoch)) return;
    await Promise.all(
      closureRecipientAgentIds(flow).map(
        async (reviewerId) =>
          await this.releaseClosureToAgent(flow, reviewerId, epoch, text),
      ),
    );
  }

  private async releaseClosureToAgent(
    flow: SyncFlowSnapshot,
    agentId: string,
    epoch: number,
    text: string,
  ): Promise<void> {
    if (!this.isCurrentGeneration(epoch)) return;
    if (this.successfulClosureReleases.get(agentId)?.has(flow.id)) return;
    const key = closureReleaseKey(flow.id, agentId);
    const existing = this.pendingClosureReleases.get(key);
    if (existing) {
      await existing.promise;
      return;
    }

    const agentVersion = this.closureReleaseVersions.get(agentId) ?? 0;
    let promise!: Promise<void>;
    promise = (async () => {
      try {
        await this.deliverToAgent(
          agentId,
          text,
          syncFlowDeliveryOptions(flow.id, true),
        );
        if (
          this.isCurrentGeneration(epoch) &&
          (this.closureReleaseVersions.get(agentId) ?? 0) === agentVersion
        ) {
          const released = this.successfulClosureReleases.get(agentId) ?? new Set<string>();
          released.add(flow.id);
          this.successfulClosureReleases.set(agentId, released);
        }
      } catch {
        // Failed releases remain eligible for retry when the agent becomes available again.
      } finally {
        if (this.pendingClosureReleases.get(key)?.promise === promise) {
          this.pendingClosureReleases.delete(key);
        }
      }
    })();
    this.pendingClosureReleases.set(key, { agentId, promise });
    await promise;
  }

  private releaseReviewersInBackground(
    flow: SyncFlowSnapshot,
    epoch: number,
    text = reviewFreezeReleasePrompt(flow),
  ): void {
    const blockers = [...(this.pendingOperationsByFlow.get(flow.id) ?? [])];
    this.startBackgroundOperation(flow.id, async () => {
      await Promise.allSettled(blockers);
      await this.releaseReviewers(flow, epoch, text);
    });
  }

  private activeReviewersFor(flow: SyncFlowSnapshot): AgentSnapshot[] {
    return this.host
      .list()
      .filter((agent) => agent.config.branch === flow.targetBranch && isActiveAgentStatus(agent.status));
  }

  private async changedFilesFor(
    input: ResolveSyncChangedFilesContext & { files?: string[] },
  ): Promise<SyncFlowChangedFile[]> {
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
    options?: { automationKey?: string; replaceQueued?: boolean },
  ): Promise<void> {
    const runner = this.host.get(agentId);
    if (!runner) throw new Error(`unknown agent: ${agentId}`);
    await runner.deliver(text, options);
  }

  private recordSyntheticResponse(
    flowId: string,
    agentId: string,
    decision: SyncFlowReviewDecision,
    summary: string,
  ): void {
    const flow = this.requireFlow(flowId);
    const request = flow.reviewRequest;
    this.recordReviewResponse(flowId, {
      agentId,
      decision,
      summary,
      risks: [],
      filesReviewed: [],
      requiredChanges: [summary],
      retryCount: request?.retryCounts[agentId] ?? 0,
      receivedAt: this.now(),
    });
  }

  private recordReviewResponse(flowId: string, response: SyncFlowReviewResponse): void {
    const flow = this.requireFlow(flowId);
    const request = flow.reviewRequest;
    if (!request || !request.pendingAgentIds.includes(response.agentId)) return;
    const nextRequest = {
      ...request,
      pendingAgentIds: request.pendingAgentIds.filter((id) => id !== response.agentId),
      responses: [...request.responses, response],
    };
    this.save({
      ...flow,
      reviewRequest: nextRequest,
      updatedAt: this.now(),
    });
  }

  private listOpenReviewFlowsFor(agentId: string): SyncFlowSnapshot[] {
    return this.list().filter(
      (flow) =>
        flow.status === "review_collecting" &&
        flow.reviewRequest?.pendingAgentIds.includes(agentId),
    );
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
    const token = Symbol("sync-timeout");
    this.pendingOperations.add(token);
    try {
      const flow = this.flows.get(flowId);
      if (!flow || CLOSED_STATUSES.includes(flow.status)) return;
      if (flow.deadlineAt !== undefined && flow.deadlineAt > this.now()) {
        this.resetTimer(flowId, flow.deadlineAt, generation);
        return;
      }
      const next = {
        ...flow,
        status: "timed_out",
        updatedAt: this.now(),
        closedAt: this.now(),
        failureReason: "Sync flow timed out before the required agent responses arrived.",
      } as SyncFlowSnapshot;
      this.save(next);
      this.closeTimer(flowId);
      if (flow.status === "queued" || flow.status === "review_collecting") {
        this.reviewQueue.complete(reviewJobId(flowId));
      }
      this.releaseReviewersInBackground(next, generation);
    } finally {
      this.pendingOperations.delete(token);
    }
  }

  private isCurrentGeneration(generation: number): boolean {
    return generation === this.stateGeneration;
  }

  private closeTimer(flowId: string): void {
    const timer = this.timers.get(flowId);
    if (timer !== undefined) this.clearTimer(timer);
    this.timers.delete(flowId);
  }

  private isCurrentReview(flowId: string, requestId: string, epoch: number): boolean {
    if (epoch !== this.stateGeneration) return false;
    const flow = this.flows.get(flowId);
    return (
      flow?.status === "review_collecting" &&
      flow.reviewRequest?.id === requestId
    );
  }

  private assertCurrentEpoch(epoch: number): void {
    if (epoch !== this.stateGeneration) {
      throw new Error("Sync flow state changed while the operation was in progress");
    }
  }

  private async trackPendingOperation<T>(
    operation: () => Promise<T>,
    flowId?: string,
  ): Promise<T> {
    const token = Symbol("sync-review-operation");
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
      // Flow operations update their own blocked/deferred state. Keep the callback non-blocking
      // while hasPendingOperations() prevents project replacement during the background work.
    });
  }

  private requireFlow(id: string): SyncFlowSnapshot {
    const flow = this.flows.get(id);
    if (!flow) throw new Error(`unknown sync flow: ${id}`);
    return flow;
  }

  private save(flow: SyncFlowSnapshot): void {
    const canonical = redactFlowCapabilities(flow);
    Object.assign(flow, canonical);
    const previous = this.flows.get(flow.id);
    this.flows.set(flow.id, flow);
    if (
      CLOSED_STATUSES.includes(flow.status) &&
      (!previous || !CLOSED_STATUSES.includes(previous.status))
    ) {
      this.clearReviewCapabilitiesForFlow(flow.id);
      this.clearUnacceptedApplyCapabilitiesForFlow(flow.id);
    }
    for (const listener of this.listeners) {
      try {
        listener(flow);
      } catch {
        // A broken subscriber must not interrupt sync flow bookkeeping.
      }
    }
  }
}

function reviewJobId(flowId: string): string {
  return `${REVIEW_QUEUE_OWNER}:${flowId}:review`;
}

function syncFlowDeliveryOptions(
  flowId: string,
  replaceQueued = false,
): { automationKey: string; replaceQueued?: boolean } {
  return replaceQueued
    ? { automationKey: `sync-flow:${flowId}`, replaceQueued: true }
    : { automationKey: `sync-flow:${flowId}` };
}

function closureRecipientAgentIds(flow: SyncFlowSnapshot): string[] {
  return uniqueStrings([
    flow.proposerAgentId,
    ...(flow.participantAgentIds ?? []),
    ...(flow.reviewRequest?.requestedAgentIds ?? []),
  ]);
}

function closureReleaseKey(flowId: string, agentId: string): string {
  return JSON.stringify([flowId, agentId]);
}

function reviewCapabilityKey(flowId: string, requestId: string, agentId: string): string {
  return JSON.stringify([flowId, requestId, agentId]);
}

function applyCapabilityKey(flowId: string, agentId: string): string {
  return JSON.stringify([flowId, "applied", agentId]);
}

function nextReviewRequestId(flow: SyncFlowSnapshot): string {
  const prefix = `${flow.id}:review:`;
  const previousSuffix = flow.reviewRequest?.id.startsWith(prefix)
    ? Number(flow.reviewRequest.id.slice(prefix.length))
    : 0;
  const nextSuffix = Number.isSafeInteger(previousSuffix) && previousSuffix > 0
    ? previousSuffix + 1
    : flow.reviewRequest
      ? 2
      : 1;
  return `${prefix}${nextSuffix}`;
}

function isActiveAgentStatus(status: string): boolean {
  return status === "running" || status === "waiting_input";
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
  agentId: string,
  reviewToken: string,
): boolean {
  const queuedTexts = new Set<string>();
  for (const entry of history) {
    if (
      entry.seq <= (requestedAfterSeq ?? 0) ||
      entry.seq >= resultSeq ||
      entry.at < requestedAt ||
      entry.event.kind !== "user_input" ||
      !isReviewPromptFor(entry.event.text, flowId, agentId, reviewToken)
    ) {
      continue;
    }
    if (entry.event.mode === "queued") {
      queuedTexts.add(entry.event.text);
    } else {
      queuedTexts.delete(entry.event.text);
    }
  }

  return queuedTexts.size > 0;
}

function isReviewPromptFor(
  text: string,
  flowId: string,
  agentId: string,
  reviewToken: string,
): boolean {
  return (
    text.includes(`/api/sync-flows/${flowId}/reviews`) &&
    text.includes(`"agentId": "${agentId}"`) &&
    text.includes(`"reviewToken": "${reviewToken}"`)
  );
}

function hasCompleteReviewerCoverage(request: SyncFlowReviewRequest): boolean {
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

function parseReview(text: string, flowId: string): ParsedReview | undefined {
  for (const candidate of parseJsonObjects(text)) {
    if (!isRecord(candidate)) continue;
    if (candidate.agentCanvasSyncReview !== true) continue;
    if (candidate.flowId !== flowId) continue;
    if (!isReviewDecision(candidate.decision)) continue;
    if (typeof candidate.summary !== "string" || !candidate.summary.trim()) continue;
    return {
      agentCanvasSyncReview: true,
      flowId,
      decision: candidate.decision,
      summary: candidate.summary,
      risks: stringArray(candidate.risks),
      filesReviewed: stringArray(candidate.filesReviewed),
      requiredChanges: stringArray(candidate.requiredChanges),
    };
  }
  return undefined;
}

function parseAgentSyncEvent(text: string): ParsedAgentEvent | undefined {
  for (const candidate of parseJsonObjects(text)) {
    if (!isRecord(candidate)) continue;
    if (candidate.agentCanvasSyncEvent !== "applied") continue;
    if (typeof candidate.flowId !== "string") continue;
    return {
      agentCanvasSyncEvent: "applied",
      flowId: candidate.flowId,
      summary: typeof candidate.summary === "string" ? candidate.summary : undefined,
      commitSha: typeof candidate.commitSha === "string" ? candidate.commitSha : undefined,
      files: stringArray(candidate.files),
      fileChanges: fileChangeArray(candidate.fileChanges),
    };
  }
  return undefined;
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

function isReviewDecision(value: unknown): value is SyncFlowReviewDecision {
  return (
    value === "approve" ||
    value === "reject" ||
    value === "needs_changes" ||
    value === "blocked"
  );
}

function normalizeReviewSubmission(input: SyncFlowReviewSubmission): NormalizedSyncFlowReview {
  const candidate = input as Partial<SyncFlowReviewSubmission> | undefined;
  const agentId =
    typeof candidate?.agentId === "string"
      ? redactFlowCapabilityText(candidate.agentId).trim()
      : "";
  if (!agentId) throw new Error("missing review agentId");
  const reviewToken =
    typeof candidate?.reviewToken === "string" ? candidate.reviewToken.trim() : "";
  if (!reviewToken) throw new Error("missing sync reviewToken");
  if (!isReviewDecision(candidate?.decision)) throw new Error("invalid sync review decision");
  const summary =
    typeof candidate?.summary === "string"
      ? redactFlowCapabilityText(candidate.summary).trim()
      : "";
  if (!summary) throw new Error("missing sync review summary");
  return {
    agentId,
    reviewToken,
    decision: candidate.decision,
    summary,
    risks: reviewStringArray(candidate.risks, "risks"),
    filesReviewed: reviewStringArray(candidate.filesReviewed, "filesReviewed"),
    requiredChanges: reviewStringArray(candidate.requiredChanges, "requiredChanges"),
  };
}

function reviewStringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`invalid sync review ${field}`);
  }
  return uniqueStrings(value.map((item) => redactFlowCapabilityText(item)));
}

function sameNormalizedReviewSubmission(
  recorded: NormalizedSyncFlowReview,
  submission: NormalizedSyncFlowReview,
): boolean {
  return (
    recorded.agentId === submission.agentId &&
    recorded.reviewToken === submission.reviewToken &&
    recorded.decision === submission.decision &&
    recorded.summary === submission.summary &&
    sameStringArray(recorded.risks, submission.risks) &&
    sameStringArray(recorded.filesReviewed, submission.filesReviewed) &&
    sameStringArray(recorded.requiredChanges, submission.requiredChanges)
  );
}

function normalizeCallbackToken(value: unknown): string {
  const token = typeof value === "string" ? value.trim() : "";
  if (!token) throw new Error("missing sync applied callbackToken");
  return token;
}

function canonicalAppliedInput(input: SyncFlowAppliedInput): SyncFlowAppliedInput {
  return redactFlowCapabilities({
    summary: input.summary,
    commitSha: input.commitSha,
    files: input.files,
    fileChanges: input.fileChanges,
  });
}

function normalizeAppliedSubmission(
  flow: SyncFlowSnapshot,
  input: SyncFlowAppliedInput,
): NormalizedAppliedSubmission {
  const fileChanges = updatedFileChangesForApplied(flow, input);
  return {
    summary: input.summary?.trim() || flow.summary,
    commitSha: input.commitSha?.trim() || undefined,
    files: pathsFromFileChanges(fileChanges),
    fileChanges,
  };
}

function sameAppliedSubmission(
  left: NormalizedAppliedSubmission,
  right: NormalizedAppliedSubmission,
): boolean {
  return (
    left.summary === right.summary &&
    left.commitSha === right.commitSha &&
    sameStringArray(left.files, right.files) &&
    sameFileChanges(left.fileChanges, right.fileChanges)
  );
}

function sameFileChanges(
  left: SyncFlowChangedFile[],
  right: SyncFlowChangedFile[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (value, index) =>
        value.status === right[index]?.status && value.path === right[index]?.path,
    )
  );
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(value.filter((item): item is string => typeof item === "string"));
}

function fileChangeArray(value: unknown): SyncFlowChangedFile[] {
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
  files: SyncFlowChangedFile[] | undefined,
): SyncFlowChangedFile[] {
  const seen = new Set<string>();
  const result: SyncFlowChangedFile[] = [];
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
  resolved: SyncFlowChangedFile[],
): SyncFlowChangedFile[] {
  const byPath = new Map(resolved.map((file) => [file.path, file]));
  return files.map((path) => byPath.get(path) ?? { status: "specified", path });
}

function updatedFileChangesForApplied(
  flow: SyncFlowSnapshot,
  input: SyncFlowAppliedInput,
): SyncFlowChangedFile[] {
  const reportedChanges = normalizeFileChanges(input.fileChanges);
  if (reportedChanges.length > 0) return reportedChanges;
  const reportedFiles = uniqueStrings(input.files ?? []);
  if (reportedFiles.length > 0) return fileChangesForExplicitFiles(reportedFiles, flow.fileChanges);
  return flow.fileChanges;
}

function pathsFromFileChanges(files: SyncFlowChangedFile[]): string[] {
  return uniqueStrings(files.map((file) => file.path));
}

function uniqueStrings(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

function reviewPrompt(
  flow: SyncFlowSnapshot,
  reviewerAgentId: string,
  reviewToken: string,
): string {
  const safeFlow = redactFlowCapabilities(flow);
  const safeReviewerAgentId = redactFlowCapabilityText(reviewerAgentId);
  const proposerRule = reviewerAgentId === flow.proposerAgentId
    ? "If all reviewers approve, only a later explicit apply-authorization message grants you a limited write exception for this sync."
    : "A review approval does not grant you permission to modify the workspace or Git state for this sync.";
  return [
    `Agent Canvas sync review request (${kindLabel(safeFlow.kind)}).`,
    `flowId: ${safeFlow.id}`,
    `targetBranch: ${safeFlow.targetBranch}`,
    safeFlow.sourceBranch ? `sourceBranch: ${safeFlow.sourceBranch}` : undefined,
    safeFlow.commitSha ? `commitSha: ${safeFlow.commitSha}` : undefined,
    safeFlow.strategy ? `strategy: ${safeFlow.strategy}` : undefined,
    `title: ${safeFlow.title ?? "(untitled)"}`,
    `summary: ${safeFlow.summary}`,
    `reason: ${safeFlow.reason}`,
    "files:",
    formatFiles(safeFlow.files),
    "changedFiles:",
    formatFileChanges(safeFlow.fileChanges),
    "Review the current state. You may inspect the repository as needed.",
    "Your primary review goal is to decide whether this sync is acceptable for your own current work on the target branch.",
    safeFlow.kind === "cherry_pick"
      ? "Check whether cherry-picking this single commit would interfere with the part you are currently working on, unfinished experiments, pending validation, or local conflicts."
      : "Check whether pulling/merging this source branch would interfere with the part you are currently working on, unfinished experiments, pending validation, or local conflicts.",
    "If the sync would disrupt your current work or should wait, reject or request changes and explain the impact in summary, risks, and requiredChanges.",
    "From receiving this review request until Agent Canvas sends a closure/release notice for this flow, keep the entire workspace, Git state, and PR state read-only. You may continue read-only inspection and analysis, but do not edit files, fetch, commit, push, create a PR, or perform any sync operation.",
    "Submitting this review callback does not release that freeze; remain read-only while the flow is still waiting or apply-authorized.",
    proposerRule,
    "Submit the decision with an actual HTTP request to the Agent Canvas API base from the built-in workspace rules (set decision to exactly one of approve, reject, needs_changes, or blocked):",
    `POST /api/sync-flows/${safeFlow.id}/reviews`,
    "JSON body:",
    reviewSubmissionBody(safeReviewerAgentId, reviewToken),
    "This POST is an intermediate tool call. Do not end your reply or print the JSON as a final answer merely to submit the review.",
  ]
    .filter(Boolean)
    .join("\n");
}

function retryPrompt(
  flow: SyncFlowSnapshot,
  reviewerAgentId: string,
  reviewToken: string,
): string {
  const safeFlow = redactFlowCapabilities(flow);
  const safeReviewerAgentId = redactFlowCapabilityText(reviewerAgentId);
  return [
    "Your previous sync review response was not registered by Agent Canvas.",
    "Keep the entire workspace, Git state, and PR state read-only before and after this corrected callback. The freeze lasts until Agent Canvas sends a closure/release notice for this flow.",
    "Submit the corrected decision with an actual HTTP request (set decision to exactly one of approve, reject, needs_changes, or blocked):",
    `POST /api/sync-flows/${safeFlow.id}/reviews`,
    "JSON body:",
    reviewSubmissionBody(safeReviewerAgentId, reviewToken),
    "This POST is an intermediate tool call. Do not end your reply or print the JSON as a final answer merely to submit the review.",
  ].join("\n");
}

function reviewSubmissionBody(reviewerAgentId: string, reviewToken: string): string {
  return JSON.stringify(
    {
      agentId: redactFlowCapabilityText(reviewerAgentId),
      reviewToken,
      decision: "approve",
      summary: "short review summary focused on impact to your current work",
      risks: ["risk or empty array"],
      filesReviewed: ["path or empty array"],
      requiredChanges: ["required change or empty array"],
    },
    null,
    2,
  );
}

function applyAuthorizationPrompt(
  flow: SyncFlowSnapshot,
  responses: SyncFlowReviewResponse[],
  callbackToken: string,
): string {
  const safeFlow = redactFlowCapabilities(flow);
  const safeResponses = redactFlowCapabilities(responses);
  const actionText =
    safeFlow.kind === "cherry_pick"
      ? [
          "You are authorized to cherry-pick the requested commit into your current target branch.",
          `commitSha: ${safeFlow.commitSha}`,
          safeFlow.sourceBranch ? `sourceBranch: ${safeFlow.sourceBranch}` : undefined,
          "You may fetch the source branch/commit, run git cherry-pick, resolve conflicts, run tests, commit the result, and push the updated target branch as needed.",
        ]
      : [
          "You are authorized to pull/merge the requested source branch into your current target branch.",
          `sourceBranch: ${safeFlow.sourceBranch}`,
          `strategy: ${safeFlow.strategy ?? "merge"}`,
          "You may fetch, merge/rebase/pull according to the strategy, resolve conflicts, run tests, commit the result, and push the updated target branch as needed.",
        ];
  return [
    "Agent Canvas sync authorization granted.",
    `flowId: ${safeFlow.id}`,
    `targetBranch: ${safeFlow.targetBranch}`,
    ...actionText.filter(Boolean),
    `summary: ${safeFlow.summary}`,
    `reason: ${safeFlow.reason}`,
    "files:",
    formatFiles(safeFlow.files),
    "changedFiles:",
    formatFileChanges(safeFlow.fileChanges),
    "",
    "All participants remain under this flow's read-only freeze until Agent Canvas sends a closure/release notice.",
    "This authorization grants only the proposer a limited write exception for the changes required by this sync flow. Keep unrelated workspace, Git, PR, and external state unchanged until the flow is recorded as applied.",
    "After the sync is complete, record it with an actual HTTP request to the Agent Canvas API base from the built-in workspace rules:",
    `POST /api/sync-flows/${safeFlow.id}/applied`,
    "JSON body:",
    JSON.stringify(
      {
        callbackToken,
        summary: safeFlow.summary,
        commitSha: "resulting commit sha if applicable",
        files: safeFlow.files,
        fileChanges: safeFlow.fileChanges,
      },
      null,
      2,
    ),
    "This POST is an intermediate tool call. After it succeeds, continue the remaining user task and end the reply only when the overall task is complete. Do not emit the legacy completion JSON as the final answer.",
    "",
    "Review summary:",
    reviewSummary(safeResponses),
  ].join("\n");
}

function reviewFailurePrompt(
  flow: SyncFlowSnapshot,
  responses: SyncFlowReviewResponse[],
): string {
  const safeFlow = redactFlowCapabilities(flow);
  const safeResponses = redactFlowCapabilities(responses);
  return [
    "Agent Canvas sync review failed. Do not apply this sync flow.",
    "This flow is closed. The workspace/Git/PR read-only freeze imposed by this sync flow is now released.",
    "This releases only the flow named below; continue to obey any freeze imposed by another active PR or sync flow.",
    `flowId: ${safeFlow.id}`,
    reviewSummary(safeResponses),
  ].join("\n");
}

function reviewFreezeReleasePrompt(flow: SyncFlowSnapshot): string {
  const safeFlow = redactFlowCapabilities(flow);
  return [
    "Agent Canvas sync flow closure/release notice.",
    `flowId: ${safeFlow.id}`,
    `status: ${safeFlow.status}`,
    "The workspace/Git/PR read-only freeze imposed by this sync flow is now released.",
    "This releases only this flow; if another PR or sync flow is still active, continue to obey that flow's freeze and authorization limits.",
    safeFlow.status === "applied"
      ? "The authorized sync was recorded as applied; continue the remaining user task."
      : "Do not perform this sync unless a new flow separately authorizes it.",
  ].join("\n");
}

function reviewSummary(responses: SyncFlowReviewResponse[]): string {
  const safeResponses = redactFlowCapabilities(responses);
  if (safeResponses.length === 0) return "No active reviewers were available.";
  return safeResponses
    .map(
      (response) =>
        `- ${response.agentId}: ${response.decision}; ${response.summary}` +
        (response.requiredChanges.length
          ? `; requiredChanges=${response.requiredChanges.join("; ")}`
          : ""),
    )
    .join("\n");
}

function kindLabel(kind: SyncFlowSnapshot["kind"]): string {
  return kind === "cherry_pick" ? "cherry-pick commit" : "pull branch";
}

function formatFiles(files: string[]): string {
  return files.map((file) => `- ${file}`).join("\n");
}

function formatFileChanges(files: SyncFlowChangedFile[]): string {
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
