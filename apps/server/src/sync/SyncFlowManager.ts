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

type DeliverableRunner = {
  deliver(text: string): Promise<void>;
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

const DEFAULT_REVIEW_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_REVIEW_RETRY_LIMIT = 1;
const REVIEW_QUEUE_OWNER = "sync";
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
  private counter = 0;
  private importedStateActivated = true;
  private stateGeneration = 0;

  constructor(options: SyncFlowManagerOptions) {
    this.host = options.host;
    this.reviewQueue = options.reviewQueue ?? new BranchReviewQueue();
    this.resolveChangedFiles = options.resolveChangedFiles;
    this.now = options.now ?? Date.now;
    this.reviewTimeoutMs = options.reviewTimeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS;
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
    return this.list();
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
    for (const flowId of this.timers.keys()) this.closeTimer(flowId);
    // Retire live reservations immediately. An in-flight lease keeps its branch occupied until
    // delivery settles, while deferred activation prevents restored prompts from being sent
    // before the rest of the project state is authoritative.
    this.reviewQueue.replaceOwner(REVIEW_QUEUE_OWNER, []);
    this.flows.clear();
    for (const flow of flows ?? []) {
      let restored =
        flow.status === "review_collecting"
          ? {
              ...flow,
              status: "queued" as const,
              deadlineAt: undefined,
              failureReason:
                "Review was requeued because its previous delivery cannot survive reload.",
            }
          : flow;
      if (restored.status === "queued") {
        if (restored.reviewQueueSequence === undefined) {
          restored = {
            ...restored,
            reviewQueueSequence: this.reviewQueue.reserveLegacySequence(restored.createdAt),
          };
        } else {
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
      if (CLOSED_STATUSES.includes(flow.status) || flow.deadlineAt === undefined) continue;
      if (flow.deadlineAt <= this.now()) {
        this.timeoutFlow(flow.id, generation);
      } else {
        this.resetTimer(flow.id, flow.deadlineAt, generation);
      }
    }
  }

  getReviewQueue(): BranchReviewQueue {
    return this.reviewQueue;
  }

  get(id: string): SyncFlowSnapshot | undefined {
    return this.flows.get(id);
  }

  async create(input: CreateSyncFlowInput): Promise<SyncFlowSnapshot> {
    const epoch = this.stateGeneration;
    if (!input?.proposerAgentId) throw new Error("missing proposerAgentId");
    if (!input.summary?.trim()) throw new Error("missing summary");
    if (!input.reason?.trim()) throw new Error("missing reason");
    const proposer = this.host.list().find((agent) => agent.id === input.proposerAgentId);
    if (!proposer) throw new Error(`unknown proposer agent: ${input.proposerAgentId}`);
    if (!isActiveAgentStatus(proposer.status)) {
      throw new Error("proposer agent must be running or waiting_input");
    }
    const targetBranch = input.targetBranch?.trim() || proposer.config.branch;
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
    this.flows.set(flow.id, flow);
    this.save(flow);
    await this.reviewQueue.enqueue(this.reviewJob(flow, "queued"));
    this.assertCurrentEpoch(epoch);
    return this.requireFlow(flow.id);
  }

  recordApplied(
    flowId: string,
    input: SyncFlowAppliedInput = {},
    reportedByAgentId?: string,
  ): SyncFlowSnapshot {
    const flow = this.requireFlow(flowId);
    if (flow.status !== "apply_authorized") {
      throw new Error("sync flow can only be marked applied after authorization");
    }
    this.closeTimer(flowId);
    const fileChanges = updatedFileChangesForApplied(flow, input);
    const applied: SyncFlowAppliedInfo = {
      summary: input.summary?.trim() || flow.summary,
      commitSha: input.commitSha?.trim() || undefined,
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
      state,
      start: async () =>
        await this.trackPendingOperation(
          async () => await this.activateQueuedReview(flow.id, epoch),
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
    this.save({
      ...flow,
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
            await this.deliverToAgent(reviewer.id, reviewPrompt(this.requireFlow(flowId))),
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
      const rawText = assistantTextForResult(
        this.host.historyOf(agentId),
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
      this.recordApplied(flow.id, parsed, agentId);
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
      const delivery = await this.reviewQueue.runWhileReserved(
        reviewJobId(flowId),
        async () => await this.deliverToAgent(agentId, retryPrompt(flow)),
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
      await this.notifyProposer(next, reviewFailurePrompt(next, request.responses), epoch);
      return;
    }
    const next = this.authorizeApply(flow);
    this.reviewQueue.complete(reviewJobId(flowId));
    await this.notifyProposer(next, applyAuthorizationPrompt(next, request.responses), epoch);
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
      await this.deliverToAgent(flow.proposerAgentId, text);
    } catch (error) {
      if (
        this.isCurrentGeneration(epoch) &&
        this.flows.get(flow.id) === flow &&
        !CLOSED_STATUSES.includes(flow.status)
      ) {
        this.failFlow(flow, "blocked", `Failed to deliver proposer signal: ${errorMessage(error)}`);
      }
    }
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

  private async deliverToAgent(agentId: string, text: string): Promise<void> {
    const runner = this.host.get(agentId);
    if (!runner) throw new Error(`unknown agent: ${agentId}`);
    await runner.deliver(text);
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
      this.save({
        ...flow,
        status: "timed_out",
        updatedAt: this.now(),
        closedAt: this.now(),
        failureReason: "Sync flow timed out before the required agent responses arrived.",
      });
      this.closeTimer(flowId);
      if (flow.status === "queued" || flow.status === "review_collecting") {
        this.reviewQueue.complete(reviewJobId(flowId));
      }
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

  private async trackPendingOperation<T>(operation: () => Promise<T>): Promise<T> {
    const token = Symbol("sync-review-operation");
    this.pendingOperations.add(token);
    try {
      return await operation();
    } finally {
      this.pendingOperations.delete(token);
    }
  }

  private requireFlow(id: string): SyncFlowSnapshot {
    const flow = this.flows.get(id);
    if (!flow) throw new Error(`unknown sync flow: ${id}`);
    return flow;
  }

  private save(flow: SyncFlowSnapshot): void {
    this.flows.set(flow.id, flow);
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

function reviewPrompt(flow: SyncFlowSnapshot): string {
  return [
    `Agent Canvas sync review request (${kindLabel(flow.kind)}).`,
    `flowId: ${flow.id}`,
    `targetBranch: ${flow.targetBranch}`,
    flow.sourceBranch ? `sourceBranch: ${flow.sourceBranch}` : undefined,
    flow.commitSha ? `commitSha: ${flow.commitSha}` : undefined,
    flow.strategy ? `strategy: ${flow.strategy}` : undefined,
    `title: ${flow.title ?? "(untitled)"}`,
    `summary: ${flow.summary}`,
    `reason: ${flow.reason}`,
    "files:",
    formatFiles(flow.files),
    "changedFiles:",
    formatFileChanges(flow.fileChanges),
    "Review the current state. You may inspect the repository as needed.",
    "Your primary review goal is to decide whether this sync is acceptable for your own current work on the target branch.",
    flow.kind === "cherry_pick"
      ? "Check whether cherry-picking this single commit would interfere with the part you are currently working on, unfinished experiments, pending validation, or local conflicts."
      : "Check whether pulling/merging this source branch would interfere with the part you are currently working on, unfinished experiments, pending validation, or local conflicts.",
    "If the sync would disrupt your current work or should wait, reject or request changes and explain the impact in summary, risks, and requiredChanges.",
    "Return exactly one JSON object matching this schema, with no extra prose:",
    reviewSchema(flow.id),
  ]
    .filter(Boolean)
    .join("\n");
}

function retryPrompt(flow: SyncFlowSnapshot): string {
  return [
    "Your previous sync review response was not valid JSON for Agent Canvas.",
    "Return exactly one JSON object matching this schema, with no extra prose:",
    reviewSchema(flow.id),
  ].join("\n");
}

function reviewSchema(flowId: string): string {
  return JSON.stringify(
    {
      agentCanvasSyncReview: true,
      flowId,
      decision: "approve | reject | needs_changes | blocked",
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
): string {
  const actionText =
    flow.kind === "cherry_pick"
      ? [
          "You are authorized to cherry-pick the requested commit into your current target branch.",
          `commitSha: ${flow.commitSha}`,
          flow.sourceBranch ? `sourceBranch: ${flow.sourceBranch}` : undefined,
          "You may fetch the source branch/commit, run git cherry-pick, resolve conflicts, run tests, and commit the result as needed.",
        ]
      : [
          "You are authorized to pull/merge the requested source branch into your current target branch.",
          `sourceBranch: ${flow.sourceBranch}`,
          `strategy: ${flow.strategy ?? "merge"}`,
          "You may fetch, merge/rebase/pull according to the strategy, resolve conflicts, run tests, and commit the result as needed.",
        ];
  return [
    "Agent Canvas sync authorization granted.",
    `flowId: ${flow.id}`,
    `targetBranch: ${flow.targetBranch}`,
    ...actionText.filter(Boolean),
    `summary: ${flow.summary}`,
    `reason: ${flow.reason}`,
    "files:",
    formatFiles(flow.files),
    "changedFiles:",
    formatFileChanges(flow.fileChanges),
    "",
    "After the sync is complete, report exactly one JSON object:",
    JSON.stringify(
      {
        agentCanvasSyncEvent: "applied",
        flowId: flow.id,
        summary: flow.summary,
        commitSha: "resulting commit sha if applicable",
        files: flow.files,
        fileChanges: flow.fileChanges,
      },
      null,
      2,
    ),
    "",
    "Review summary:",
    reviewSummary(responses),
  ].join("\n");
}

function reviewFailurePrompt(
  flow: SyncFlowSnapshot,
  responses: SyncFlowReviewResponse[],
): string {
  return [
    "Agent Canvas sync review failed. Do not apply this sync flow.",
    `flowId: ${flow.id}`,
    reviewSummary(responses),
  ].join("\n");
}

function reviewSummary(responses: SyncFlowReviewResponse[]): string {
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
