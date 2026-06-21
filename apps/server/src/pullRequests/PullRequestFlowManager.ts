import type {
  AgentEventEnvelope,
  AgentSnapshot,
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

type DeliverableRunner = {
  getStatus(): string;
  send(text: string): void;
  steer(text: string): Promise<void>;
};

export interface PullRequestAgentHost {
  list(): AgentSnapshot[];
  get(id: string): DeliverableRunner | undefined;
  historyOf(id: string): AgentEventEnvelope[];
  currentTurnIndex?(id: string): number;
}

export interface PullRequestFlowManagerOptions {
  host: PullRequestAgentHost;
  resolveChangedFiles?: ResolvePullRequestChangedFiles;
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

const DEFAULT_REVIEW_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_REVIEW_RETRY_LIMIT = 1;
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
  private readonly resolveChangedFiles?: ResolvePullRequestChangedFiles;
  private readonly now: () => number;
  private readonly reviewTimeoutMs: number;
  private readonly reviewRetryLimit: number;
  private readonly setTimer: (callback: () => void, delay: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;
  private readonly flows = new Map<string, PullRequestFlowSnapshot>();
  private readonly timers = new Map<string, unknown>();
  private readonly listeners = new Set<FlowListener>();
  private counter = 0;

  constructor(options: PullRequestFlowManagerOptions) {
    this.host = options.host;
    this.resolveChangedFiles = options.resolveChangedFiles;
    this.now = options.now ?? Date.now;
    this.reviewTimeoutMs = options.reviewTimeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS;
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

  get(id: string): PullRequestFlowSnapshot | undefined {
    return this.flows.get(id);
  }

  async create(input: CreatePullRequestFlowInput): Promise<PullRequestFlowSnapshot> {
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
    const fileChanges = await this.changedFilesFor({
      proposerAgentId: input.proposerAgentId,
      sourceBranch,
      targetBranch: input.targetBranch.trim(),
      sourceCwd: proposer.config.cwd,
      files: input.files,
    });
    if (fileChanges.length === 0) {
      throw new Error("PR flow requires a concrete changed file list");
    }
    const files = pathsFromFileChanges(fileChanges);

    const flow: PullRequestFlowSnapshot = {
      id: `pr_flow_${++this.counter}`,
      proposerAgentId: input.proposerAgentId,
      sourceTurnIndex: this.host.currentTurnIndex?.(input.proposerAgentId),
      sourceBranch,
      targetBranch: input.targetBranch.trim(),
      title: input.title?.trim() || undefined,
      summary: input.summary.trim(),
      files,
      fileChanges,
      status: "source_review_collecting",
      createdAt: this.now(),
      updatedAt: this.now(),
      currentStage: "source_preflight",
      reviewRequests: [],
    };
    this.flows.set(flow.id, flow);
    await this.startReviewStage(flow.id, "source_preflight");
    return this.requireFlow(flow.id);
  }

  async recordPrCreated(
    flowId: string,
    input: PullRequestCreatedInput,
    reportedByAgentId?: string,
  ): Promise<PullRequestFlowSnapshot> {
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
    this.save({
      ...flow,
      files,
      fileChanges,
      pr,
      status: "target_review_collecting",
      currentStage: "target_merge",
      updatedAt: this.now(),
    });
    await this.startReviewStage(flowId, "target_merge");
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
    const next = {
      ...flow,
      status: "cancelled" as const,
      currentStage: undefined,
      updatedAt: this.now(),
      closedAt: this.now(),
    };
    this.save(next);
    return next;
  }

  async handleAgentEvent(envelope: AgentEventEnvelope): Promise<void> {
    if (envelope.event.kind !== "result") return;
    await Promise.resolve();
    await this.captureReviewResult(envelope.agentId);
    await this.captureAgentPrEvent(envelope.agentId);
  }

  private async startReviewStage(
    flowId: string,
    stage: PullRequestReviewStage,
  ): Promise<void> {
    const flow = this.requireFlow(flowId);
    const reviewers = this.activeReviewersFor(flow, stage);
    const request: PullRequestReviewRequest = {
      id: `${flow.id}:${stage}:${flow.reviewRequests.length + 1}`,
      stage,
      requestedAgentIds: reviewers.map((agent) => agent.id),
      pendingAgentIds: reviewers.map((agent) => agent.id),
      retryCounts: Object.fromEntries(reviewers.map((agent) => [agent.id, 0])),
      responses: [],
      requestedAt: this.now(),
      deadlineAt: this.now() + this.reviewTimeoutMs,
    };
    this.save({
      ...flow,
      currentStage: stage,
      deadlineAt: request.deadlineAt,
      reviewRequests: [...flow.reviewRequests, request],
      updatedAt: this.now(),
    });
    this.resetTimer(flowId, request.deadlineAt);

    if (reviewers.length === 0) {
      await this.finishStageIfComplete(flowId);
      return;
    }

    for (const reviewer of reviewers) {
      try {
        await this.deliverToAgent(reviewer.id, reviewPrompt(this.requireFlow(flowId), stage));
      } catch (error) {
        this.recordSyntheticResponse(
          flowId,
          stage,
          reviewer.id,
          "blocked",
          `Failed to deliver review request: ${errorMessage(error)}`,
        );
      }
    }
    await this.finishStageIfComplete(flowId);
  }

  private async captureReviewResult(agentId: string): Promise<void> {
    const openRequests = this.listOpenRequestsFor(agentId);
    for (const { flow, request } of openRequests) {
      const rawText = assistantTextSince(this.host.historyOf(agentId), request.requestedAt);
      const parsed = parseReview(rawText, flow.id, request.stage);
      if (!parsed) {
        await this.handleInvalidReview(flow.id, request.stage, agentId);
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
      await this.finishStageIfComplete(flow.id);
    }
  }

  private async captureAgentPrEvent(agentId: string): Promise<void> {
    const possibleFlows = this.list().filter(
      (flow) =>
        flow.proposerAgentId === agentId &&
        (flow.status === "create_pr_authorized" || flow.status === "merge_authorized"),
    );
    for (const flow of possibleFlows) {
      const since =
        flow.status === "create_pr_authorized"
          ? flow.createAuthorization?.issuedAt ?? flow.updatedAt
          : flow.mergeAuthorization?.issuedAt ?? flow.updatedAt;
      const parsed = parseAgentPrEvent(assistantTextSince(this.host.historyOf(agentId), since));
      if (!parsed || parsed.flowId !== flow.id) continue;
      if (parsed.agentCanvasPrEvent === "pr_created") {
        await this.recordPrCreated(flow.id, parsed, agentId);
      } else if (parsed.agentCanvasPrEvent === "merged") {
        this.recordMerged(flow.id);
      }
    }
  }

  private async handleInvalidReview(
    flowId: string,
    stage: PullRequestReviewStage,
    agentId: string,
  ): Promise<void> {
    const flow = this.requireFlow(flowId);
    const request = currentRequest(flow, stage);
    if (!request || !request.pendingAgentIds.includes(agentId)) return;
    const retryCount = request.retryCounts[agentId] ?? 0;
    if (retryCount < this.reviewRetryLimit) {
      request.retryCounts[agentId] = retryCount + 1;
      this.saveRequest(flowId, request);
      await this.deliverToAgent(agentId, retryPrompt(flow, stage));
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
    await this.finishStageIfComplete(flowId);
  }

  private async finishStageIfComplete(flowId: string): Promise<void> {
    const flow = this.requireFlow(flowId);
    const request = currentRequest(flow, flow.currentStage);
    if (!request || request.pendingAgentIds.length > 0) return;
    this.closeTimer(flowId);
    const allApproved = request.responses.every((response) => response.decision === "approve");
    if (request.stage === "source_preflight") {
      if (!allApproved) {
        const next = this.failFlow(flow, "source_review_failed", reviewSummary(request.responses));
        await this.notifyProposer(next, sourceFailurePrompt(next, request.responses));
        return;
      }
      await this.authorizeCreatePr(flow, request.responses);
      return;
    }
    if (!allApproved) {
      const next = this.failFlow(flow, "target_review_failed", reviewSummary(request.responses));
      await this.notifyProposer(next, targetFailurePrompt(next, request.responses));
      return;
    }
    await this.authorizeMerge(flow, request.responses);
  }

  private async authorizeCreatePr(
    flow: PullRequestFlowSnapshot,
    responses: PullRequestReviewResponse[],
  ): Promise<void> {
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
    this.resetTimer(flow.id, authorization.expiresAt);
    await this.notifyProposer(next, createPrAuthorizationPrompt(next, responses));
  }

  private async authorizeMerge(
    flow: PullRequestFlowSnapshot,
    responses: PullRequestReviewResponse[],
  ): Promise<void> {
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
    this.resetTimer(flow.id, authorization.expiresAt);
    await this.notifyProposer(next, mergeAuthorizationPrompt(next, responses));
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

  private async notifyProposer(flow: PullRequestFlowSnapshot, text: string): Promise<void> {
    try {
      await this.deliverToAgent(flow.proposerAgentId, text);
    } catch (error) {
      if (!CLOSED_STATUSES.includes(flow.status)) {
        this.failFlow(flow, "blocked", `Failed to deliver proposer signal: ${errorMessage(error)}`);
      }
    }
  }

  private activeReviewersFor(
    flow: PullRequestFlowSnapshot,
    stage: PullRequestReviewStage,
  ): AgentSnapshot[] {
    const branch = stage === "source_preflight" ? flow.sourceBranch : flow.targetBranch;
    return this.host
      .list()
      .filter((agent) => agent.config.branch === branch && isActiveAgentStatus(agent.status));
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

  private async deliverToAgent(agentId: string, text: string): Promise<void> {
    const runner = this.host.get(agentId);
    if (!runner) throw new Error(`unknown agent: ${agentId}`);
    const status = runner.getStatus();
    if (status === "running") {
      await runner.steer(text);
      return;
    }
    if (status === "waiting_input") {
      runner.send(text);
      return;
    }
    throw new Error(`agent ${agentId} is not active (${status})`);
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
      const request = currentRequest(flow, flow.currentStage);
      if (request?.pendingAgentIds.includes(agentId)) result.push({ flow, request });
    }
    return result;
  }

  private resetTimer(flowId: string, deadlineAt: number): void {
    this.closeTimer(flowId);
    const delay = Math.max(0, deadlineAt - this.now());
    this.timers.set(
      flowId,
      this.setTimer(() => {
        const flow = this.flows.get(flowId);
        if (!flow || CLOSED_STATUSES.includes(flow.status)) return;
        this.save({
          ...flow,
          status: "timed_out",
          currentStage: undefined,
          updatedAt: this.now(),
          closedAt: this.now(),
          failureReason: "PR flow timed out before all required agent responses arrived.",
        });
        this.closeTimer(flowId);
      }, delay),
    );
  }

  private closeTimer(flowId: string): void {
    const timer = this.timers.get(flowId);
    if (timer !== undefined) this.clearTimer(timer);
    this.timers.delete(flowId);
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

function isActiveAgentStatus(status: string): boolean {
  return status === "running" || status === "waiting_input";
}

function currentRequest(
  flow: PullRequestFlowSnapshot,
  stage: PullRequestReviewStage | undefined,
): PullRequestReviewRequest | undefined {
  if (!stage) return undefined;
  return [...flow.reviewRequests].reverse().find((request) => request.stage === stage);
}

function assistantTextSince(history: AgentEventEnvelope[], at: number): string {
  return history
    .filter((entry) => entry.at >= at && entry.event.kind === "assistant_text")
    .map((entry) => (entry.event.kind === "assistant_text" ? entry.event.text : ""))
    .join("");
}

function parseReview(
  text: string,
  flowId: string,
  stage: PullRequestReviewStage,
): ParsedReview | undefined {
  for (const candidate of parseJsonObjects(text)) {
    if (!isRecord(candidate)) continue;
    if (candidate.agentCanvasPrReview !== true) continue;
    if (candidate.flowId !== flowId || candidate.stage !== stage) continue;
    if (!isReviewDecision(candidate.decision)) continue;
    if (typeof candidate.summary !== "string" || !candidate.summary.trim()) continue;
    return {
      agentCanvasPrReview: true,
      flowId,
      stage,
      decision: candidate.decision,
      summary: candidate.summary,
      risks: stringArray(candidate.risks),
      filesReviewed: stringArray(candidate.filesReviewed),
      requiredChanges: stringArray(candidate.requiredChanges),
    };
  }
  return undefined;
}

function parseAgentPrEvent(text: string): ParsedAgentEvent | undefined {
  for (const candidate of parseJsonObjects(text)) {
    if (!isRecord(candidate)) continue;
    if (candidate.agentCanvasPrEvent !== "pr_created" && candidate.agentCanvasPrEvent !== "merged") {
      continue;
    }
    if (typeof candidate.flowId !== "string") continue;
    return {
      agentCanvasPrEvent: candidate.agentCanvasPrEvent,
      flowId: candidate.flowId,
      prNumber: typeof candidate.prNumber === "number" ? candidate.prNumber : undefined,
      prUrl: typeof candidate.prUrl === "string" ? candidate.prUrl : undefined,
      title: typeof candidate.title === "string" ? candidate.title : undefined,
      summary: typeof candidate.summary === "string" ? candidate.summary : undefined,
      files: stringArray(candidate.files),
      fileChanges: fileChangeArray(candidate.fileChanges),
    };
  }
  return undefined;
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
