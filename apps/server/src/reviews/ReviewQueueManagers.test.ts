import { describe, expect, it } from "vitest";
import type {
  AgentEventEnvelope,
  AgentSnapshot,
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

  async steer(text: string): Promise<void> {
    this.steered.push(text);
    const block = this.nextSteerBlock;
    this.nextSteerBlock = undefined;
    if (block) await block;
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
    expect(pr.status).toBe("source_review_collecting");

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
    expect(pull.status).toBe("review_collecting");

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
    now += 1;
    host.assistant("agent_source", prReviewJson(pr), now);
    await dispatchResult(prManager, syncManager, host.result("agent_source", now));
    await prManager.recordPrCreated(pr.id, { prNumber: 7 });

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

  it("demotes a conflicting restored review so snapshots match recovered queue ownership", async () => {
    const host = new FakeHost();
    host.addAgent("agent_current", "feature/current", "waiting_input");
    const originalPr = new PullRequestFlowManager({ host });
    const originalSync = new SyncFlowManager({ host });

    const pr = await originalPr.create({
      proposerAgentId: "agent_current",
      targetBranch: "main",
      summary: "Persisted PR review",
      files: ["src/pr.ts"],
    });
    const pull = await originalSync.create({
      kind: "branch_pull",
      proposerAgentId: "agent_current",
      sourceBranch: "main",
      targetBranch: "feature/current",
      summary: "Persisted pull review",
      reason: "Migrate a legacy conflicting state",
      files: ["src/pull.ts"],
    });
    const prState = originalPr.exportState();
    const syncState = originalSync.exportState();
    originalPr.cancel(pr.id);
    originalSync.cancel(pull.id);

    const reviewQueue = new BranchReviewQueue();
    const restoredPr = new PullRequestFlowManager({ host, reviewQueue });
    const restoredSync = new SyncFlowManager({ host, reviewQueue });
    reviewQueue.clear();
    restoredPr.importState(prState);
    restoredSync.importState(syncState);
    await Promise.resolve();

    expect(restoredPr.get(pr.id)?.status).toBe("source_review_collecting");
    expect(restoredSync.get(pull.id)?.status).toBe("queued");
    expect(restoredSync.get(pull.id)?.reviewRequest).toBeUndefined();

    const reverseQueue = new BranchReviewQueue();
    const reversePr = new PullRequestFlowManager({ host, reviewQueue: reverseQueue });
    const reverseSync = new SyncFlowManager({ host, reviewQueue: reverseQueue });
    reverseSync.importState(syncState);
    reversePr.importState(prState);
    await Promise.resolve();

    expect(reverseSync.get(pull.id)?.status).toBe("review_collecting");
    expect(reversePr.get(pr.id)?.status).toBe("queued");
    expect(reversePr.get(pr.id)?.reviewRequests[0]?.pendingAgentIds).toContain("agent_current");

    host.assistant("agent_current", prReviewJson(pr), 1);
    await dispatchResult(reversePr, reverseSync, host.result("agent_current", 1));

    expect(reversePr.get(pr.id)?.status).toBe("queued");
    expect(reversePr.get(pr.id)?.reviewRequests[0]?.responses).toEqual([]);
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
    const second = await manager.create({
      proposerAgentId: "agent_proposer",
      targetBranch: "release",
      summary: "Review that must not wait for notification I/O",
      files: ["src/second.ts"],
    });
    expect(second.status).toBe("queued");

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
