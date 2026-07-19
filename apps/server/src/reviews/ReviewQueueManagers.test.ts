import { describe, expect, it } from "vitest";
import type {
  AgentEventEnvelope,
  AgentSnapshot,
  AgentStartConfig,
  PullRequestFlowSnapshot,
  SyncFlowSnapshot,
} from "@agent-canvas/shared";
import {
  PullRequestFlowManager,
  type PullRequestAgentHost,
} from "../pullRequests/PullRequestFlowManager.js";
import {
  SyncFlowManager,
  type SyncFlowAgentHost,
} from "../sync/SyncFlowManager.js";
import { BranchReviewQueue } from "./BranchReviewQueue.js";

class FakeRunner {
  readonly sent: string[] = [];
  readonly steered: string[] = [];
  private nextSteerBlock?: Promise<void>;

  constructor(private status: string) {}

  getStatus(): string {
    return this.status;
  }

  setStatus(status: string): void {
    this.status = status;
  }

  blockNextSteerUntil(promise: Promise<void>): void {
    this.nextSteerBlock = promise;
  }

  send(text: string): void {
    this.sent.push(text);
    this.status = "running";
  }

  start(text: string): void {
    this.sent.push(text);
    this.status = "starting";
  }

  async steer(text: string): Promise<void> {
    this.steered.push(text);
    const block = this.nextSteerBlock;
    this.nextSteerBlock = undefined;
    if (block) await block;
  }

  async deliver(text: string): Promise<void> {
    if (this.status === "running") {
      await this.steer(text);
      return;
    }
    if (this.status === "waiting_input") {
      this.send(text);
      return;
    }
    throw new Error(`runner is not active (${this.status})`);
  }
}

class FakeHost implements PullRequestAgentHost, SyncFlowAgentHost {
  readonly runners = new Map<string, FakeRunner>();
  readonly histories = new Map<string, AgentEventEnvelope[]>();
  private readonly agents: Array<{ id: string; branch: string; runner: FakeRunner }> = [];
  private seq = 0;

  addAgent(id: string, branch: string, status: string): FakeRunner {
    const runner = new FakeRunner(status);
    this.runners.set(id, runner);
    this.histories.set(id, []);
    this.agents.push({ id, branch, runner });
    return runner;
  }

  list(): AgentSnapshot[] {
    return this.agents.map(({ id, branch, runner }) => ({
      id,
      provider: "codex",
      status: runner.getStatus() as AgentSnapshot["status"],
      config: {
        prompt: "",
        provider: "codex",
        branch,
        cwd: `C:\\repo\\${branch}`,
      },
      createdAt: 0,
      lastEventSeq: this.seq,
    }));
  }

  get(id: string): FakeRunner | undefined {
    return this.runners.get(id);
  }

  async startAgent(id: string, config: AgentStartConfig): Promise<void> {
    const runner = this.runners.get(id);
    if (!runner) throw new Error(`unknown agent: ${id}`);
    runner.start(config.prompt);
  }

  historyOf(id: string): AgentEventEnvelope[] {
    return this.histories.get(id) ?? [];
  }

  currentTurnIndex(id: string): number {
    return this.historyOf(id).filter((envelope) => envelope.event.kind === "result").length;
  }

  assistant(agentId: string, text: string, at: number): void {
    this.histories.get(agentId)?.push({
      agentId,
      seq: ++this.seq,
      at,
      event: { kind: "assistant_text", text },
    });
  }

  result(agentId: string, at: number): AgentEventEnvelope {
    const envelope: AgentEventEnvelope = {
      agentId,
      seq: ++this.seq,
      at,
      event: { kind: "result", subtype: "success", isError: false },
    };
    this.histories.get(agentId)?.push(envelope);
    this.runners.get(agentId)?.setStatus("waiting_input");
    return envelope;
  }
}

describe("shared branch review queue across flow managers", () => {
  it("starts one queued pull exactly once after an active PR source review approves", async () => {
    let now = 1000;
    const host = new FakeHost();
    const currentAgent = host.addAgent("agent_current", "feature/current", "waiting_input");
    const reviewQueue = new BranchReviewQueue();
    const prManager = new PullRequestFlowManager({ host, reviewQueue, now: () => now });
    const syncManager = new SyncFlowManager({ host, reviewQueue, now: () => now });

    const pr = await prManager.create({
      proposerAgentId: "agent_current",
      targetBranch: "main",
      summary: "Open the current branch PR",
      files: ["src/pr.ts"],
    });
    await waitUntil(() => prManager.get(pr.id)?.status === "source_review_collecting");
    const collectingPr = prManager.get(pr.id)!;
    expect(collectingPr.status).toBe("source_review_collecting");

    const deliveriesBeforePull = deliveries(currentAgent);
    const pull = await syncManager.create({
      kind: "branch_pull",
      proposerAgentId: "agent_current",
      sourceBranch: "main",
      targetBranch: "feature/current",
      summary: "Pull main into the current branch",
      reason: "Bring in the shared changes",
      files: ["src/pull.ts"],
    });

    expect(pull.status).toBe("queued");
    expect(pull.reviewRequest).toBeUndefined();
    expect(currentAgent.sent).toEqual(deliveriesBeforePull.sent);
    expect(currentAgent.steered).toEqual(deliveriesBeforePull.steered);

    now += 1;
    host.assistant("agent_current", prReviewJson(pr), now);
    const result = host.result("agent_current", now);
    await dispatchResult(prManager, syncManager, result);
    await waitUntil(() => syncManager.get(pull.id)?.status === "review_collecting");

    expect(prManager.get(pr.id)?.status).toBe("create_pr_authorized");
    expect(syncManager.get(pull.id)?.status).toBe("review_collecting");
    expect(syncManager.get(pull.id)?.reviewRequest).toBeDefined();
    expect(matchingDeliveries(currentAgent, "Agent Canvas sync review request", pull.id)).toHaveLength(
      1,
    );

    now += 1;
    host.assistant(
      "agent_current",
      JSON.stringify({ agentCanvasPrEvent: "pr_created", flowId: pr.id, prNumber: 9 }),
      now,
    );
    await dispatchResult(prManager, syncManager, host.result("agent_current", now));

    expect(syncManager.get(pull.id)?.reviewRequest?.retryCounts.agent_current).toBe(0);
    expect(
      allDeliveries(currentAgent).filter((text) =>
        text.includes("previous sync review response was not valid JSON"),
      ),
    ).toHaveLength(0);
  });

  it("starts a queued PR source review after the sync review reaches apply authorization", async () => {
    let now = 2000;
    const host = new FakeHost();
    const currentAgent = host.addAgent("agent_current", "feature/current", "waiting_input");
    const reviewQueue = new BranchReviewQueue();
    const prManager = new PullRequestFlowManager({ host, reviewQueue, now: () => now });
    const syncManager = new SyncFlowManager({ host, reviewQueue, now: () => now });

    const pull = await syncManager.create({
      kind: "branch_pull",
      proposerAgentId: "agent_current",
      sourceBranch: "main",
      targetBranch: "feature/current",
      summary: "Pull main first",
      reason: "Review the incoming branch before the PR",
      files: ["src/pull-first.ts"],
    });
    await waitUntil(() => syncManager.get(pull.id)?.status === "review_collecting");
    const collectingPull = syncManager.get(pull.id)!;
    expect(collectingPull.status).toBe("review_collecting");

    const deliveriesBeforePr = deliveries(currentAgent);
    const pr = await prManager.create({
      proposerAgentId: "agent_current",
      targetBranch: "main",
      summary: "Open the current branch PR second",
      files: ["src/pr-second.ts"],
    });

    expect(pr.status).toBe("queued");
    expect(pr.reviewRequests).toHaveLength(0);
    expect(currentAgent.sent).toEqual(deliveriesBeforePr.sent);
    expect(currentAgent.steered).toEqual(deliveriesBeforePr.steered);

    now += 1;
    host.assistant("agent_current", syncReviewJson(pull), now);
    const result = host.result("agent_current", now);
    await dispatchResult(prManager, syncManager, result);
    await waitUntil(() => prManager.get(pr.id)?.status === "source_review_collecting");

    expect(syncManager.get(pull.id)?.status).toBe("apply_authorized");
    expect(prManager.get(pr.id)?.status).toBe("source_review_collecting");
    expect(prManager.get(pr.id)?.reviewRequests).toHaveLength(1);
    expect(matchingDeliveries(currentAgent, "Agent Canvas PR review request", pr.id)).toHaveLength(
      1,
    );

    now += 1;
    host.assistant(
      "agent_current",
      JSON.stringify({ agentCanvasSyncEvent: "applied", flowId: pull.id }),
      now,
    );
    await dispatchResult(prManager, syncManager, host.result("agent_current", now));

    expect(prManager.get(pr.id)?.reviewRequests[0]?.retryCounts.agent_current).toBe(0);
    expect(
      allDeliveries(currentAgent).filter((text) =>
        text.includes("previous PR review response was not valid JSON"),
      ),
    ).toHaveLength(0);
  });

  it("does not treat a valid PR review result as an invalid retry for a queued sync", async () => {
    let now = 3000;
    const host = new FakeHost();
    const currentAgent = host.addAgent("agent_current", "feature/current", "waiting_input");
    const reviewQueue = new BranchReviewQueue();
    const prManager = new PullRequestFlowManager({ host, reviewQueue, now: () => now });
    const syncManager = new SyncFlowManager({
      host,
      reviewQueue,
      now: () => now,
      reviewRetryLimit: 1,
    });

    const pr = await prManager.create({
      proposerAgentId: "agent_current",
      targetBranch: "main",
      summary: "Review the PR before the pull",
      files: ["src/pr-review.ts"],
    });
    await waitUntil(() => prManager.get(pr.id)?.status === "source_review_collecting");
    const pull = await syncManager.create({
      kind: "branch_pull",
      proposerAgentId: "agent_current",
      sourceBranch: "main",
      targetBranch: "feature/current",
      summary: "Pull after the PR review",
      reason: "Exercise cross-manager result routing",
      files: ["src/pull-review.ts"],
    });
    expect(pull.status).toBe("queued");

    now += 1;
    host.assistant("agent_current", prReviewJson(pr), now);
    const result = host.result("agent_current", now);
    await dispatchResult(prManager, syncManager, result);
    await waitUntil(() => syncManager.get(pull.id)?.status === "review_collecting");

    const syncRequest = syncManager.get(pull.id)?.reviewRequest;
    expect(syncRequest?.retryCounts.agent_current).toBe(0);
    expect(
      allDeliveries(currentAgent).filter((text) =>
        text.includes("previous sync review response was not valid JSON"),
      ),
    ).toHaveLength(0);
    expect(matchingDeliveries(currentAgent, "Agent Canvas sync review request", pull.id)).toHaveLength(
      1,
    );
  });

  it("serializes a pull with an active PR target review on the same branch", async () => {
    let now = 4000;
    const host = new FakeHost();
    host.addAgent("agent_source", "feature/a", "waiting_input");
    const targetAgent = host.addAgent("agent_main", "main", "waiting_input");
    const reviewQueue = new BranchReviewQueue();
    const prManager = new PullRequestFlowManager({ host, reviewQueue, now: () => now });
    const syncManager = new SyncFlowManager({ host, reviewQueue, now: () => now });

    const pr = await prManager.create({
      proposerAgentId: "agent_source",
      targetBranch: "main",
      summary: "Review target before pulling into main",
      files: ["src/pr-target.ts"],
    });
    await waitUntil(() => prManager.get(pr.id)?.status === "source_review_collecting");
    now += 1;
    host.assistant("agent_source", prReviewJson(pr), now);
    await dispatchResult(prManager, syncManager, host.result("agent_source", now));
    await waitUntil(() => prManager.get(pr.id)?.status === "create_pr_authorized");
    await prManager.recordPrCreated(pr.id, { prNumber: 7 });
    await waitUntil(() => prManager.get(pr.id)?.status === "target_review_collecting");

    expect(prManager.get(pr.id)?.status).toBe("target_review_collecting");
    const deliveriesBeforePull = deliveries(targetAgent);
    const pull = await syncManager.create({
      kind: "branch_pull",
      proposerAgentId: "agent_main",
      sourceBranch: "release",
      targetBranch: "main",
      summary: "Pull release into main",
      reason: "Exercise target-stage queue sharing",
      files: ["src/release.ts"],
    });

    expect(pull.status).toBe("queued");
    expect(targetAgent.sent).toEqual(deliveriesBeforePull.sent);
    expect(targetAgent.steered).toEqual(deliveriesBeforePull.steered);

    now += 1;
    host.assistant(
      "agent_main",
      prReviewJson(prManager.get(pr.id)!, "target_merge"),
      now,
    );
    await dispatchResult(prManager, syncManager, host.result("agent_main", now));
    await waitUntil(() => syncManager.get(pull.id)?.status === "review_collecting");

    expect(prManager.get(pr.id)?.status).toBe("merge_authorized");
    expect(matchingDeliveries(targetAgent, "Agent Canvas sync review request", pull.id)).toHaveLength(
      1,
    );
  });

  it("admits a PR target stage behind a pull already queued on the target branch", async () => {
    let now = 4500;
    const host = new FakeHost();
    host.addAgent("agent_source", "feature/a", "waiting_input");
    const targetAgent = host.addAgent("agent_main", "main", "waiting_input");
    const reviewQueue = new BranchReviewQueue();
    const prManager = new PullRequestFlowManager({ host, reviewQueue, now: () => now });
    const syncManager = new SyncFlowManager({ host, reviewQueue, now: () => now });

    const pr = await prManager.create({
      proposerAgentId: "agent_source",
      targetBranch: "main",
      summary: "Move from source review to a separately admitted target review",
      files: ["src/pr-target-after-sync.ts"],
    });
    await waitUntil(() => prManager.get(pr.id)?.status === "source_review_collecting");
    const sourceSequence = prManager.get(pr.id)!.reviewQueueSequence!;
    now += 1;
    host.assistant("agent_source", prReviewJson(pr), now);
    await dispatchResult(prManager, syncManager, host.result("agent_source", now));
    await waitUntil(() => prManager.get(pr.id)?.status === "create_pr_authorized");
    expect(prManager.get(pr.id)?.status).toBe("create_pr_authorized");

    const pull = await syncManager.create({
      kind: "branch_pull",
      proposerAgentId: "agent_main",
      sourceBranch: "release",
      targetBranch: "main",
      summary: "Occupy the target branch before the PR target stage is admitted",
      reason: "The PR target stage must receive a fresh later queue position",
      files: ["src/sync-before-pr-target.ts"],
    });
    await waitUntil(() => syncManager.get(pull.id)?.status === "review_collecting");
    const collectingPull = syncManager.get(pull.id)!;
    expect(collectingPull.status).toBe("review_collecting");

    const targetPr = await prManager.recordPrCreated(pr.id, { prNumber: 8 });
    expect(targetPr).toMatchObject({ status: "queued", currentStage: "target_merge" });
    expect(targetPr.reviewQueueSequence).toBeGreaterThan(sourceSequence);
    expect(targetPr.reviewQueueSequence).toBeGreaterThan(collectingPull.reviewQueueSequence!);
    expect(
      matchingDeliveries(targetAgent, "Agent Canvas PR review request", targetPr.id),
    ).toHaveLength(0);

    now += 1;
    host.assistant("agent_main", syncReviewJson(pull), now);
    await dispatchResult(prManager, syncManager, host.result("agent_main", now));
    await waitUntil(() => prManager.get(pr.id)?.status === "target_review_collecting");

    expect(
      matchingDeliveries(targetAgent, "Agent Canvas PR review request", targetPr.id),
    ).toHaveLength(1);
    prManager.cancel(pr.id);
    syncManager.cancel(pull.id);
  });

  it("requeues restored deliveries in persisted FIFO order independent of import order", async () => {
    let now = 1000;
    const host = new FakeHost();
    host.addAgent("agent_current", "feature/current", "waiting_input");
    const originalPr = new PullRequestFlowManager({ host, now: () => now });
    const originalSync = new SyncFlowManager({ host, now: () => now });

    const pr = await originalPr.create({
      proposerAgentId: "agent_current",
      targetBranch: "main",
      summary: "Persisted PR review",
      files: ["src/pr.ts"],
    });
    await waitUntil(() => originalPr.get(pr.id)?.status === "source_review_collecting");
    now = 2000;
    const pull = await originalSync.create({
      kind: "branch_pull",
      proposerAgentId: "agent_current",
      sourceBranch: "main",
      targetBranch: "feature/current",
      summary: "Persisted pull review",
      reason: "Migrate a legacy conflicting state",
      files: ["src/pull.ts"],
    });
    await waitUntil(() => originalSync.get(pull.id)?.status === "review_collecting");
    const prState = originalPr.exportState();
    const syncState = originalSync.exportState();
    const oldPrRequest = prState[0]?.reviewRequests[0];
    const oldSyncRequest = syncState[0]?.reviewRequest;
    expect(oldPrRequest?.requestedAt).toBe(1000);
    expect(oldSyncRequest?.requestedAt).toBe(2000);
    originalPr.cancel(pr.id);
    originalSync.cancel(pull.id);
    now = 3000;

    const reviewQueue = new BranchReviewQueue();
    const restoredPr = new PullRequestFlowManager({ host, reviewQueue, now: () => now });
    const restoredSync = new SyncFlowManager({ host, reviewQueue, now: () => now });
    reviewQueue.clear();
    restoredPr.importState(prState);
    restoredSync.importState(syncState);
    await waitUntil(() => restoredPr.get(pr.id)?.status === "source_review_collecting");

    expect(restoredPr.get(pr.id)?.status).toBe("source_review_collecting");
    expect(restoredPr.get(pr.id)?.reviewRequests).toHaveLength(2);
    expect(restoredPr.get(pr.id)?.reviewRequests[0]).toEqual(oldPrRequest);
    expect(restoredPr.get(pr.id)?.reviewRequests[1]?.requestedAt).toBe(3000);
    expect(restoredSync.get(pull.id)?.status).toBe("queued");
    expect(restoredSync.get(pull.id)?.reviewRequest).toEqual(oldSyncRequest);

    host.assistant("agent_current", syncReviewJson(pull), now + 1);
    await dispatchResult(restoredPr, restoredSync, host.result("agent_current", now + 1));

    expect(restoredSync.get(pull.id)?.status).toBe("queued");
    expect(restoredSync.get(pull.id)?.reviewRequest).toEqual(oldSyncRequest);

    const reverseQueue = new BranchReviewQueue();
    const reversePr = new PullRequestFlowManager({
      host,
      reviewQueue: reverseQueue,
      now: () => now,
    });
    const reverseSync = new SyncFlowManager({
      host,
      reviewQueue: reverseQueue,
      now: () => now,
    });
    reverseSync.importState(syncState);
    reversePr.importState(prState);
    await waitUntil(() => reversePr.get(pr.id)?.status === "source_review_collecting");

    expect(reversePr.get(pr.id)?.status).toBe("source_review_collecting");
    expect(reversePr.get(pr.id)?.reviewRequests).toHaveLength(2);
    expect(reversePr.get(pr.id)?.reviewRequests[0]).toEqual(oldPrRequest);
    expect(reverseSync.get(pull.id)?.status).toBe("queued");
    expect(reverseSync.get(pull.id)?.reviewRequest).toEqual(oldSyncRequest);

    host.assistant("agent_current", syncReviewJson(pull), now + 2);
    await dispatchResult(reversePr, reverseSync, host.result("agent_current", now + 2));

    expect(reverseSync.get(pull.id)?.status).toBe("queued");
    expect(reverseSync.get(pull.id)?.reviewRequest).toEqual(oldSyncRequest);
  });

  it("preserves sync-before-PR total order across reload when timestamps are identical", async () => {
    const now = 1000;
    const originalHost = new FakeHost();
    originalHost.addAgent("agent_current", "feature/current", "waiting_input");
    const originalQueue = new BranchReviewQueue();
    const originalPr = new PullRequestFlowManager({
      host: originalHost,
      reviewQueue: originalQueue,
      now: () => now,
    });
    const originalSync = new SyncFlowManager({
      host: originalHost,
      reviewQueue: originalQueue,
      now: () => now,
    });

    const sync = await originalSync.create({
      kind: "branch_pull",
      proposerAgentId: "agent_current",
      sourceBranch: "main",
      targetBranch: "feature/current",
      summary: "Persist the first equal-time review",
      reason: "Prove the shared sequence survives reload",
      files: ["src/sync-first.ts"],
    });
    await waitUntil(() => originalSync.get(sync.id)?.status === "review_collecting");
    const pr = await originalPr.create({
      proposerAgentId: "agent_current",
      targetBranch: "main",
      summary: "Persist the second equal-time review",
      files: ["src/pr-second.ts"],
    });
    await waitUntil(() => !originalPr.hasPendingOperations());
    const collectingSync = originalSync.get(sync.id)!;
    const queuedPr = originalPr.get(pr.id)!;

    expect(sync.createdAt).toBe(pr.createdAt);
    expect(sync.reviewQueueSequence).toBeLessThan(pr.reviewQueueSequence!);
    expect(collectingSync.status).toBe("review_collecting");
    expect(queuedPr.status).toBe("queued");
    const syncState = originalSync.exportState();
    const prState = originalPr.exportState();
    originalSync.cancel(sync.id);
    originalPr.cancel(pr.id);

    const restoredHost = new FakeHost();
    const restoredRunner = restoredHost.addAgent(
      "agent_current",
      "feature/current",
      "waiting_input",
    );
    const restoredQueue = new BranchReviewQueue();
    const restoredPr = new PullRequestFlowManager({
      host: restoredHost,
      reviewQueue: restoredQueue,
      now: () => now,
    });
    const restoredSync = new SyncFlowManager({
      host: restoredHost,
      reviewQueue: restoredQueue,
      now: () => now,
    });

    // Restore the later PR owner first: its import order must not overtake the earlier sync job.
    restoredPr.importState(prState, { deferActivation: true });
    restoredSync.importState(syncState, { deferActivation: true });
    restoredPr.activateImportedState();
    restoredSync.activateImportedState();
    await waitUntil(() => restoredSync.get(sync.id)?.status === "review_collecting");

    expect(restoredPr.get(pr.id)?.status).toBe("queued");
    expect(
      matchingDeliveries(restoredRunner, "Agent Canvas sync review request", sync.id),
    ).toHaveLength(1);
    expect(
      matchingDeliveries(restoredRunner, "Agent Canvas PR review request", pr.id),
    ).toHaveLength(0);

    const restoredSyncFlow = restoredSync.get(sync.id);
    if (!restoredSyncFlow) throw new Error("expected the restored sync flow");
    restoredHost.assistant("agent_current", syncReviewJson(restoredSyncFlow), now + 1);
    await dispatchResult(
      restoredPr,
      restoredSync,
      restoredHost.result("agent_current", now + 1),
    );
    await waitUntil(() => restoredPr.get(pr.id)?.status === "source_review_collecting");

    expect(
      matchingDeliveries(restoredRunner, "Agent Canvas PR review request", pr.id),
    ).toHaveLength(1);
  });

  it("migrates sequence-less cross-manager snapshots by stable admission time", async () => {
    let now = 1000;
    const originalHost = new FakeHost();
    originalHost.addAgent("agent_current", "feature/current", "waiting_input");
    const originalQueue = new BranchReviewQueue();
    const originalPr = new PullRequestFlowManager({
      host: originalHost,
      reviewQueue: originalQueue,
      now: () => now,
    });
    const originalSync = new SyncFlowManager({
      host: originalHost,
      reviewQueue: originalQueue,
      now: () => now,
    });

    const olderSync = await originalSync.create({
      kind: "branch_pull",
      proposerAgentId: "agent_current",
      sourceBranch: "main",
      targetBranch: "feature/current",
      summary: "Legacy sync admitted first",
      reason: "Its sequence was not persisted by the old snapshot format",
      files: ["src/legacy-sync.ts"],
    });
    await waitUntil(() => originalSync.get(olderSync.id)?.status === "review_collecting");
    now = 2000;
    const youngerPr = await originalPr.create({
      proposerAgentId: "agent_current",
      targetBranch: "main",
      summary: "Legacy PR admitted second",
      files: ["src/legacy-pr.ts"],
    });
    await waitUntil(() => !originalPr.hasPendingOperations());
    expect(originalSync.get(olderSync.id)?.status).toBe("review_collecting");
    expect(originalPr.get(youngerPr.id)?.status).toBe("queued");

    const syncState = originalSync.exportState().map(({ reviewQueueSequence: _, ...flow }) => flow);
    const prState = originalPr.exportState().map(({ reviewQueueSequence: _, ...flow }) => flow);
    originalSync.cancel(olderSync.id);
    originalPr.cancel(youngerPr.id);

    const restoredHost = new FakeHost();
    const restoredRunner = restoredHost.addAgent(
      "agent_current",
      "feature/current",
      "waiting_input",
    );
    const restoredQueue = new BranchReviewQueue();
    const restoredPr = new PullRequestFlowManager({
      host: restoredHost,
      reviewQueue: restoredQueue,
      now: () => now,
    });
    const restoredSync = new SyncFlowManager({
      host: restoredHost,
      reviewQueue: restoredQueue,
      now: () => now,
    });

    // Production restores PR first. Legacy migration must not turn import order into FIFO order.
    restoredPr.importState(prState as PullRequestFlowSnapshot[], { deferActivation: true });
    restoredSync.importState(syncState as SyncFlowSnapshot[], { deferActivation: true });
    restoredPr.activateImportedState();
    restoredSync.activateImportedState();
    await waitUntil(() => restoredSync.get(olderSync.id)?.status === "review_collecting");

    expect(restoredSync.get(olderSync.id)?.reviewQueueSequence).toBe(1);
    expect(restoredPr.get(youngerPr.id)?.reviewQueueSequence).toBe(2);
    expect(restoredPr.get(youngerPr.id)?.status).toBe("queued");
    expect(
      matchingDeliveries(restoredRunner, "Agent Canvas sync review request", olderSync.id),
    ).toHaveLength(1);
    expect(
      matchingDeliveries(restoredRunner, "Agent Canvas PR review request", youngerPr.id),
    ).toHaveLength(0);

    restoredSync.cancel(olderSync.id);
    restoredPr.cancel(youngerPr.id);
  });

  it("migrates equal-time legacy pr_flow_9 before pr_flow_10 by numeric order", async () => {
    const now = 1000;
    const host = new FakeHost();
    const reviewer = host.addAgent("agent_current", "feature/current", "waiting_input");
    const reviewQueue = new BranchReviewQueue();
    const manager = new PullRequestFlowManager({ host, reviewQueue, now: () => now });
    const flow9: PullRequestFlowSnapshot = {
      id: "pr_flow_9",
      proposerAgentId: "agent_current",
      sourceBranch: "feature/current",
      targetBranch: "main",
      summary: "Legacy PR nine",
      files: ["src/legacy-9.ts"],
      fileChanges: [{ status: "specified", path: "src/legacy-9.ts" }],
      status: "queued",
      createdAt: now,
      updatedAt: now,
      currentStage: "source_preflight",
      reviewRequests: [],
    };
    const flow10: PullRequestFlowSnapshot = {
      ...flow9,
      id: "pr_flow_10",
      summary: "Legacy PR ten",
      files: ["src/legacy-10.ts"],
      fileChanges: [{ status: "specified", path: "src/legacy-10.ts" }],
    };

    // Reverse persisted array order so only numeric flow order can recover the original FIFO.
    manager.importState([flow10, flow9], { deferActivation: true });
    manager.activateImportedState();
    await waitUntil(() => manager.get(flow9.id)?.status === "source_review_collecting");

    expect(manager.get(flow9.id)?.reviewQueueSequence).toBe(1);
    expect(manager.get(flow10.id)?.reviewQueueSequence).toBe(2);
    expect(manager.get(flow10.id)?.status).toBe("queued");
    expect(
      matchingDeliveries(reviewer, "Agent Canvas PR review request", flow9.id),
    ).toHaveLength(1);
    expect(
      matchingDeliveries(reviewer, "Agent Canvas PR review request", flow10.id),
    ).toHaveLength(0);

    manager.cancel(flow9.id);
    await waitUntil(() => manager.get(flow10.id)?.status === "source_review_collecting");
    expect(
      matchingDeliveries(reviewer, "Agent Canvas PR review request", flow10.id),
    ).toHaveLength(1);
    manager.cancel(flow10.id);
  });

  it("keeps an older deferred stage first after it starts late and the managers reload", async () => {
    let now = 1000;
    const branch = "feature/shared";
    const originalHost = new FakeHost();
    originalHost.addAgent("agent_control", "control", "waiting_input");
    const originalQueue = new BranchReviewQueue();
    const originalPr = new PullRequestFlowManager({
      host: originalHost,
      reviewQueue: originalQueue,
      now: () => now,
    });
    const originalSync = new SyncFlowManager({
      host: originalHost,
      reviewQueue: originalQueue,
      now: () => now,
    });

    const olderSync = await originalSync.create({
      kind: "branch_pull",
      proposerAgentId: "agent_control",
      sourceBranch: "main",
      targetBranch: branch,
      summary: "Older review waits for a branch reviewer",
      reason: "Its original admission must survive a later activation",
      files: ["src/older-sync.ts"],
    });
    await waitUntil(
      () => originalSync.get(olderSync.id)?.failureReason?.includes("waiting for an active reviewer") === true,
    );
    expect(originalSync.get(olderSync.id)?.status).toBe("queued");
    expect(originalSync.get(olderSync.id)?.reviewRequest).toBeUndefined();

    now = 2000;
    const youngerPr = await originalPr.create({
      proposerAgentId: "agent_control",
      sourceBranch: branch,
      targetBranch: "main",
      summary: "Younger PR waits behind the older sync review",
      files: ["src/younger-pr.ts"],
    });
    await waitUntil(() => !originalPr.hasPendingOperations());
    expect(olderSync.createdAt).toBe(1000);
    expect(youngerPr.createdAt).toBe(2000);
    expect(originalPr.get(youngerPr.id)?.status).toBe("queued");
    expect(olderSync.reviewQueueSequence).toBeLessThan(youngerPr.reviewQueueSequence!);

    now = 3000;
    const originalReviewer = originalHost.addAgent("agent_shared", branch, "waiting_input");
    await originalQueue.retryBranch(branch);
    await waitUntil(() => originalSync.get(olderSync.id)?.status === "review_collecting");
    expect(originalSync.get(olderSync.id)?.status).toBe("review_collecting");
    expect(originalSync.get(olderSync.id)?.reviewRequest?.requestedAt).toBe(3000);
    expect(originalSync.get(olderSync.id)?.reviewRequest?.requestedAt).toBeGreaterThan(
      youngerPr.createdAt,
    );
    expect(originalPr.get(youngerPr.id)?.status).toBe("queued");
    expect(
      matchingDeliveries(originalReviewer, "Agent Canvas sync review request", olderSync.id),
    ).toHaveLength(1);
    expect(
      matchingDeliveries(originalReviewer, "Agent Canvas PR review request", youngerPr.id),
    ).toHaveLength(0);

    const syncState = originalSync.exportState();
    const prState = originalPr.exportState();
    originalSync.cancel(olderSync.id);
    originalPr.cancel(youngerPr.id);

    const restoredHost = new FakeHost();
    restoredHost.addAgent("agent_control", "control", "waiting_input");
    const restoredReviewer = restoredHost.addAgent("agent_shared", branch, "waiting_input");
    const restoredQueue = new BranchReviewQueue();
    const restoredPr = new PullRequestFlowManager({
      host: restoredHost,
      reviewQueue: restoredQueue,
      now: () => now,
    });
    const restoredSync = new SyncFlowManager({
      host: restoredHost,
      reviewQueue: restoredQueue,
      now: () => now,
    });

    // Restore the younger owner first; the persisted stage sequence must still keep it second.
    restoredPr.importState(prState, { deferActivation: true });
    restoredSync.importState(syncState, { deferActivation: true });
    restoredPr.activateImportedState();
    restoredSync.activateImportedState();
    await waitUntil(() => restoredSync.get(olderSync.id)?.status === "review_collecting");

    expect(restoredSync.get(olderSync.id)?.reviewQueueSequence).toBe(
      olderSync.reviewQueueSequence,
    );
    expect(restoredPr.get(youngerPr.id)?.reviewQueueSequence).toBe(
      youngerPr.reviewQueueSequence,
    );
    expect(restoredPr.get(youngerPr.id)?.status).toBe("queued");
    expect(
      matchingDeliveries(restoredReviewer, "Agent Canvas sync review request", olderSync.id),
    ).toHaveLength(1);
    expect(
      matchingDeliveries(restoredReviewer, "Agent Canvas PR review request", youngerPr.id),
    ).toHaveLength(0);

    restoredSync.cancel(olderSync.id);
    await waitUntil(() => restoredPr.get(youngerPr.id)?.status === "source_review_collecting");
    expect(
      matchingDeliveries(restoredReviewer, "Agent Canvas PR review request", youngerPr.id),
    ).toHaveLength(1);
  });

  it("releases a completed review before a proposer notification finishes", async () => {
    let now = 5000;
    const host = new FakeHost();
    const proposer = host.addAgent("agent_proposer", "feature/shared", "waiting_input");
    const reviewer = host.addAgent("agent_reviewer", "feature/shared", "waiting_input");
    const reviewQueue = new BranchReviewQueue();
    const manager = new PullRequestFlowManager({ host, reviewQueue, now: () => now });

    const first = await manager.create({
      proposerAgentId: "agent_proposer",
      targetBranch: "main",
      summary: "Review with a slow authorization notification",
      files: ["src/first.ts"],
    });
    await waitUntil(() => manager.get(first.id)?.status === "source_review_collecting");
    const second = await manager.create({
      proposerAgentId: "agent_proposer",
      targetBranch: "release",
      summary: "Review that must not wait for notification I/O",
      files: ["src/second.ts"],
    });
    await waitUntil(() => !manager.hasPendingOperations());
    expect(manager.get(second.id)?.status).toBe("queued");

    now += 1;
    host.assistant("agent_proposer", prReviewJson(first), now);
    await manager.handleAgentEvent(host.result("agent_proposer", now));

    let releaseNotification!: () => void;
    const notificationBlock = new Promise<void>((resolve) => {
      releaseNotification = resolve;
    });
    proposer.setStatus("running");
    proposer.blockNextSteerUntil(notificationBlock);
    now += 1;
    host.assistant("agent_reviewer", prReviewJson(first), now);
    const finishing = manager.handleAgentEvent(host.result("agent_reviewer", now));

    await waitUntil(() => manager.get(second.id)?.status === "source_review_collecting");
    expect(manager.get(first.id)?.status).toBe("create_pr_authorized");
    expect(reviewer.sent.some((text) => text.includes(`flowId: ${second.id}`))).toBe(true);

    releaseNotification();
    await finishing;
  });
});

async function dispatchResult(
  prManager: PullRequestFlowManager,
  syncManager: SyncFlowManager,
  envelope: AgentEventEnvelope,
): Promise<void> {
  await Promise.all([
    prManager.handleAgentEvent(envelope),
    syncManager.handleAgentEvent(envelope),
  ]);
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("timed out waiting for the queued branch review to start");
}

function deliveries(runner: FakeRunner): { sent: string[]; steered: string[] } {
  return { sent: [...runner.sent], steered: [...runner.steered] };
}

function allDeliveries(runner: FakeRunner): string[] {
  return [...runner.sent, ...runner.steered];
}

function matchingDeliveries(runner: FakeRunner, marker: string, flowId: string): string[] {
  return allDeliveries(runner).filter(
    (text) => text.includes(marker) && text.includes(`flowId: ${flowId}`),
  );
}

function prReviewJson(
  flow: PullRequestFlowSnapshot,
  stage: "source_preflight" | "target_merge" = "source_preflight",
): string {
  return JSON.stringify({
    agentCanvasPrReview: true,
    flowId: flow.id,
    stage,
    decision: "approve",
    summary: `approve ${stage}`,
    risks: [],
    filesReviewed: flow.files,
    requiredChanges: [],
  });
}

function syncReviewJson(flow: SyncFlowSnapshot): string {
  return JSON.stringify({
    agentCanvasSyncReview: true,
    flowId: flow.id,
    decision: "approve",
    summary: "approve sync",
    risks: [],
    filesReviewed: flow.files,
    requiredChanges: [],
  });
}
