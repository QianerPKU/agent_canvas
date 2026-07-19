import { describe, expect, it, vi, afterEach } from "vitest";
import type {
  AgentEventEnvelope,
  AgentSnapshot,
  AgentStartConfig,
  PullRequestFlowSnapshot,
} from "@agent-canvas/shared";
import {
  PullRequestFlowManager,
  type PullRequestAgentHost,
} from "./PullRequestFlowManager.js";

class FakeRunner {
  readonly sent: string[] = [];
  readonly started: string[] = [];
  readonly steered: string[] = [];
  activeSteers = 0;
  maxConcurrentSteers = 0;
  private nextSteerBlock?: Promise<void>;

  constructor(private status: string) {}

  getStatus(): string {
    return this.status;
  }

  setStatus(status: string): void {
    this.status = status;
  }

  send(text: string): void {
    this.sent.push(text);
    this.status = "running";
  }

  start(text: string): void {
    this.started.push(text);
    this.sent.push(text);
    this.status = "starting";
  }

  blockNextSteerUntil(block: Promise<void>): void {
    this.nextSteerBlock = block;
  }

  async steer(text: string): Promise<void> {
    this.steered.push(text);
    const block = this.nextSteerBlock;
    this.nextSteerBlock = undefined;
    this.activeSteers += 1;
    this.maxConcurrentSteers = Math.max(this.maxConcurrentSteers, this.activeSteers);
    try {
      await block;
    } finally {
      this.activeSteers -= 1;
    }
  }

  async deliver(text: string): Promise<void> {
    if (this.status === "running") return await this.steer(text);
    if (this.status === "waiting_input") {
      this.send(text);
      return;
    }
    throw new Error(`agent is not active (${this.status})`);
  }
}

class FakeHost implements PullRequestAgentHost {
  readonly runners = new Map<string, FakeRunner>();
  readonly histories = new Map<string, AgentEventEnvelope[]>();
  private readonly agents: Array<{
    id: string;
    branch: string;
    runner: FakeRunner;
    createdAt: number;
  }> = [];
  private createdAt = 0;
  seq = 0;

  addAgent(id: string, branch: string, status: string): FakeRunner {
    const runner = new FakeRunner(status);
    this.runners.set(id, runner);
    this.histories.set(id, []);
    this.agents.push({ id, branch, runner, createdAt: ++this.createdAt });
    return runner;
  }

  list(): AgentSnapshot[] {
    return this.agents.map(({ id, branch, runner, createdAt }) => ({
      id,
      provider: "codex",
      status: runner.getStatus() as AgentSnapshot["status"],
      config: { prompt: "", provider: "codex", branch },
      createdAt,
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

afterEach(() => {
  vi.useRealTimers();
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("condition was not reached");
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe("PullRequestFlowManager", () => {
  it("still rejects an idle proposer", async () => {
    const host = new FakeHost();
    host.addAgent("agent_1", "feature/a", "idle");
    const manager = new PullRequestFlowManager({ host });

    await expect(
      manager.create({
        proposerAgentId: "agent_1",
        targetBranch: "main",
        summary: "Idle proposer must start explicitly",
      }),
    ).rejects.toThrow("proposer agent must be running or waiting_input");
  });

  it("authorizes create and merge after source and target approvals", async () => {
    let now = 1000;
    const host = new FakeHost();
    const proposer = host.addAgent("agent_1", "feature/a", "waiting_input");
    const targetReviewer = host.addAgent("agent_2", "main", "waiting_input");
    const manager = new PullRequestFlowManager({ host, now: () => now });

    let flow = await manager.create({
      proposerAgentId: "agent_1",
      targetBranch: "main",
      title: "Add feature",
      summary: "Ship feature A",
      files: ["src/a.ts"],
    });

    expect(flow.status).toBe("source_review_collecting");
    expect(flow.sourceTurnIndex).toBe(0);
    expect(flow.fileChanges).toEqual([{ status: "specified", path: "src/a.ts" }]);
    expect(proposer.sent[0]).toContain("sourceBranch: feature/a");
    expect(proposer.sent[0]).toContain("changedFiles (git diff --name-status):");
    expect(proposer.sent[0]).toContain("- specified src/a.ts");
    expect(proposer.sent[0]).toContain("conflicts with the part you are currently working on");
    expect(proposer.sent[0]).toContain("should wait until your current work is finished");
    expect(proposer.sent[0]).toContain("\"stage\": \"source_preflight\"");

    now += 1;
    proposer.setStatus("waiting_input");
    host.assistant("agent_1", reviewJson(flow, "source_preflight", "approve"), now);
    await manager.handleAgentEvent(host.result("agent_1", now));

    flow = manager.get(flow.id)!;
    expect(flow.status).toBe("create_pr_authorized");
    expect(proposer.sent.at(-1)).toContain("authorized to prepare and create the PR");

    now += 1;
    proposer.setStatus("waiting_input");
    host.assistant(
      "agent_1",
      JSON.stringify({
        agentCanvasPrEvent: "pr_created",
        flowId: flow.id,
        prNumber: 12,
        prUrl: "https://github.com/acme/demo/pull/12",
      }),
      now,
    );
    await manager.handleAgentEvent(host.result("agent_1", now));

    flow = manager.get(flow.id)!;
    expect(flow.status).toBe("target_review_collecting");
    expect(targetReviewer.sent.at(-1)).toContain("\"stage\": \"target_merge\"");
    expect(targetReviewer.sent.at(-1)).toContain("- specified src/a.ts");
    expect(targetReviewer.sent.at(-1)).toContain("would interfere with the part you are currently working on");
    expect(targetReviewer.sent.at(-1)).toContain("unfinished experiments");

    now += 1;
    targetReviewer.setStatus("waiting_input");
    host.assistant("agent_2", reviewJson(flow, "target_merge", "approve"), now);
    await manager.handleAgentEvent(host.result("agent_2", now));

    flow = manager.get(flow.id)!;
    expect(flow.status).toBe("merge_authorized");
    expect(proposer.sent.at(-1)).toContain("authorized to merge the PR");
  });

  it("starts an idle target reviewer after a deferred target review is retried", async () => {
    let now = 1500;
    const host = new FakeHost();
    const proposer = host.addAgent("agent_1", "feature/a", "waiting_input");
    host.addAgent("agent_2", "main", "stopped");
    const manager = new PullRequestFlowManager({ host, now: () => now });

    let flow = await manager.create({
      proposerAgentId: "agent_1",
      targetBranch: "main",
      summary: "Target reviewer is offline",
      files: ["src/a.ts"],
    });

    now += 1;
    proposer.setStatus("waiting_input");
    host.assistant("agent_1", reviewJson(flow, "source_preflight", "approve"), now);
    await manager.handleAgentEvent(host.result("agent_1", now));
    flow = manager.get(flow.id)!;
    expect(flow.status).toBe("create_pr_authorized");

    flow = await manager.recordPrCreated(flow.id, { prNumber: 13 });

    expect(flow).toMatchObject({
      status: "queued",
      currentStage: "target_merge",
    });
    expect(flow.failureReason).toContain("waiting for an active reviewer on branch main");
    expect(flow.reviewRequests).toHaveLength(1);
    expect(flow.reviewRequests[0]?.stage).toBe("source_preflight");

    const idleReviewer = host.addAgent("agent_3", "main", "idle");
    const laterIdleReviewer = host.addAgent("agent_4", "main", "idle");
    await manager.getReviewQueue().retryBranch("main");

    flow = manager.get(flow.id)!;
    expect(flow).toMatchObject({
      status: "target_review_collecting",
      currentStage: "target_merge",
      failureReason: undefined,
    });
    expect(flow.reviewRequests.at(-1)?.requestedAgentIds).toEqual(["agent_3"]);
    expect(idleReviewer.getStatus()).toBe("starting");
    expect(idleReviewer.started.at(-1)).toContain('"stage": "target_merge"');
    expect(laterIdleReviewer.getStatus()).toBe("idle");
    expect(laterIdleReviewer.started).toEqual([]);
  });

  it("prefers active reviewers without starting idle reviewers on the same branch", async () => {
    let now = 1750;
    const host = new FakeHost();
    const proposer = host.addAgent("agent_1", "feature/a", "waiting_input");
    const activeReviewer = host.addAgent("agent_2", "main", "waiting_input");
    const idleReviewer = host.addAgent("agent_3", "main", "idle");
    const manager = new PullRequestFlowManager({ host, now: () => now });

    let flow = await manager.create({
      proposerAgentId: "agent_1",
      targetBranch: "main",
      summary: "Prefer the already active reviewer",
      files: ["src/a.ts"],
    });

    now += 1;
    proposer.setStatus("waiting_input");
    host.assistant("agent_1", reviewJson(flow, "source_preflight", "approve"), now);
    await manager.handleAgentEvent(host.result("agent_1", now));
    flow = await manager.recordPrCreated(flow.id, { prNumber: 14 });

    expect(flow.status).toBe("target_review_collecting");
    expect(flow.reviewRequests.at(-1)?.requestedAgentIds).toEqual(["agent_2"]);
    expect(activeReviewer.sent.at(-1)).toContain('"stage": "target_merge"');
    expect(idleReviewer.started).toEqual([]);
  });

  it("retries invalid review JSON and then blocks the flow", async () => {
    let now = 2000;
    const host = new FakeHost();
    const proposer = host.addAgent("agent_1", "feature/a", "waiting_input");
    const manager = new PullRequestFlowManager({
      host,
      now: () => now,
      reviewRetryLimit: 1,
    });

    const flow = await manager.create({
      proposerAgentId: "agent_1",
      targetBranch: "main",
      summary: "Needs review",
      files: ["src/retry.ts"],
    });

    now += 1;
    proposer.setStatus("waiting_input");
    host.assistant("agent_1", "not json", now);
    await manager.handleAgentEvent(host.result("agent_1", now));
    expect(proposer.sent.at(-1)).toContain("previous PR review response was not valid JSON");

    now += 1;
    proposer.setStatus("waiting_input");
    host.assistant("agent_1", "still not json", now);
    await manager.handleAgentEvent(host.result("agent_1", now));

    const next = manager.get(flow.id)!;
    expect(next.status).toBe("source_review_failed");
    expect(next.reviewRequests[0]!.responses[0]).toMatchObject({
      agentId: "agent_1",
      decision: "blocked",
    });
  });

  it("times out when reviewers do not all respond", async () => {
    vi.useFakeTimers();
    let now = 0;
    const host = new FakeHost();
    host.addAgent("agent_1", "feature/a", "waiting_input");
    const manager = new PullRequestFlowManager({
      host,
      now: () => now,
      reviewTimeoutMs: 10,
    });

    const flow = await manager.create({
      proposerAgentId: "agent_1",
      targetBranch: "main",
      summary: "Timeout flow",
      files: ["src/timeout.ts"],
    });
    now = 11;
    vi.advanceTimersByTime(11);

    expect(manager.get(flow.id)?.status).toBe("timed_out");
  });

  it("rebuilds future timers and immediately expires overdue flows on import", async () => {
    vi.useFakeTimers();
    let now = 0;
    const host = new FakeHost();
    host.addAgent("agent_1", "feature/a", "waiting_input");
    const original = new PullRequestFlowManager({
      host,
      now: () => now,
      reviewTimeoutMs: 10,
    });
    const flow = await original.create({
      proposerAgentId: "agent_1",
      targetBranch: "main",
      summary: "Persisted timeout flow",
      files: ["src/import-timeout.ts"],
    });
    const state = original.exportState().map((candidate) =>
      candidate.id === flow.id
        ? {
            ...candidate,
            status: "create_pr_authorized" as const,
            currentStage: undefined,
            deadlineAt: 10,
            createAuthorization: {
              agentId: candidate.proposerAgentId,
              issuedAt: 0,
              expiresAt: 10,
            },
          }
        : candidate,
    );
    original.importState(undefined);

    now = 5;
    const restored = new PullRequestFlowManager({ host, now: () => now });
    restored.importState(state);
    expect(restored.hasOpenFlows()).toBe(true);
    now = 11;
    vi.advanceTimersByTime(6);
    expect(restored.get(flow.id)?.status).toBe("timed_out");
    expect(restored.hasOpenFlows()).toBe(false);

    now = 20;
    const overdue = new PullRequestFlowManager({ host, now: () => now });
    overdue.importState(state);
    expect(overdue.get(flow.id)?.status).toBe("timed_out");
  });

  it("defers imported timeout activation until the caller publishes authoritative state", async () => {
    vi.useFakeTimers();
    let now = 0;
    const host = new FakeHost();
    host.addAgent("agent_1", "feature/a", "waiting_input");
    const original = new PullRequestFlowManager({
      host,
      now: () => now,
      reviewTimeoutMs: 10,
    });
    const flow = await original.create({
      proposerAgentId: "agent_1",
      targetBranch: "main",
      summary: "Deferred imported timeout",
      files: ["src/deferred-import.ts"],
    });
    const state = original.exportState().map((candidate) =>
      candidate.id === flow.id
        ? {
            ...candidate,
            status: "create_pr_authorized" as const,
            currentStage: undefined,
            deadlineAt: 10,
            createAuthorization: {
              agentId: candidate.proposerAgentId,
              issuedAt: 0,
              expiresAt: 10,
            },
          }
        : candidate,
    );
    original.importState(undefined);
    now = 20;

    const restored = new PullRequestFlowManager({ host, now: () => now });
    const observed: PullRequestFlowSnapshot[] = [];
    restored.onFlow((next) => observed.push(next));
    restored.importState(state, { deferActivation: true });
    vi.advanceTimersByTime(100);

    expect(restored.get(flow.id)?.status).toBe("create_pr_authorized");
    expect(observed).toEqual([]);
    expect(restored.hasPendingOperations()).toBe(false);

    restored.activateImportedState();
    expect(restored.get(flow.id)?.status).toBe("timed_out");
    expect(observed.map((next) => next.status)).toEqual(["timed_out"]);
    restored.activateImportedState();
    expect(observed).toHaveLength(1);
  });

  it("ignores a stale timeout callback after importing replacement state", async () => {
    let now = 0;
    const callbacks: Array<() => void> = [];
    const host = new FakeHost();
    host.addAgent("agent_1", "feature/a", "waiting_input");
    const manager = new PullRequestFlowManager({
      host,
      now: () => now,
      reviewTimeoutMs: 10,
      setTimer: (callback) => {
        callbacks.push(callback);
        return callback;
      },
      clearTimer: () => undefined,
    });
    await manager.create({
      proposerAgentId: "agent_1",
      targetBranch: "main",
      summary: "Stale callback",
      files: ["src/stale-timeout.ts"],
    });
    const staleCallback = callbacks[0]!;

    manager.importState(undefined);
    now = 11;
    staleCallback();

    expect(manager.list()).toEqual([]);
    expect(manager.hasPendingOperations()).toBe(false);
  });

  it("uses a two hour default timeout for PR reviews", async () => {
    let now = 5000;
    const host = new FakeHost();
    host.addAgent("agent_1", "feature/a", "waiting_input");
    const manager = new PullRequestFlowManager({ host, now: () => now });

    const flow = await manager.create({
      proposerAgentId: "agent_1",
      targetBranch: "main",
      summary: "Default timeout",
      files: ["src/default-timeout.ts"],
    });

    expect(flow.deadlineAt).toBe(now + 2 * 60 * 60 * 1000);
    expect(flow.reviewRequests[0]?.deadlineAt).toBe(now + 2 * 60 * 60 * 1000);
  });

  it("rejects PR flows when the source branch has not incorporated the target branch", async () => {
    const host = new FakeHost();
    host.addAgent("agent_1", "feature/a", "waiting_input");
    const manager = new PullRequestFlowManager({
      host,
      ensureBranchesReady: async () => {
        throw new Error("source branch feature/a must include origin/main");
      },
      resolveChangedFiles: async () => {
        throw new Error("changed files should not be resolved before branch readiness");
      },
    });

    await expect(
      manager.create({
        proposerAgentId: "agent_1",
        targetBranch: "main",
        summary: "Not synced",
        files: ["src/not-synced.ts"],
      }),
    ).rejects.toThrow("must include origin/main");
  });

  it("starts the next source review as soon as the previous source review finishes", async () => {
    let now = 6000;
    const host = new FakeHost();
    const proposer = host.addAgent("agent_1", "feature/shared", "waiting_input");
    const manager = new PullRequestFlowManager({ host, now: () => now });

    const first = await manager.create({
      proposerAgentId: "agent_1",
      targetBranch: "main",
      summary: "First PR",
      files: ["src/a.ts"],
    });
    const second = await manager.create({
      proposerAgentId: "agent_1",
      targetBranch: "release",
      summary: "Second PR",
      files: ["src/b.ts"],
    });

    expect(first.status).toBe("source_review_collecting");
    expect(second).toMatchObject({ status: "queued", currentStage: "source_preflight" });
    expect(second.reviewRequests).toHaveLength(0);
    expect(proposer.sent).toHaveLength(1);
    expect(proposer.steered).toHaveLength(0);

    now += 1;
    proposer.setStatus("waiting_input");
    host.assistant("agent_1", reviewJson(first, "source_preflight", "approve"), now);
    await manager.handleAgentEvent(host.result("agent_1", now));
    await flush();

    expect(manager.get(first.id)?.status).toBe("create_pr_authorized");
    expect(manager.get(second.id)?.status).toBe("source_review_collecting");
    expect(manager.get(second.id)?.reviewRequests).toHaveLength(1);
    expect(proposer.steered).toHaveLength(1);
    expect(proposer.steered[0]).toContain(`flowId: ${second.id}`);
  });

  it("keeps the branch reserved when a cancelled PR still has a blocked review delivery", async () => {
    const host = new FakeHost();
    const proposer = host.addAgent("agent_1", "feature/shared", "running");
    const blockedDelivery = deferred();
    proposer.blockNextSteerUntil(blockedDelivery.promise);
    const manager = new PullRequestFlowManager({ host });

    const firstCreate = manager.create({
      proposerAgentId: "agent_1",
      targetBranch: "main",
      summary: "Blocked first PR",
      files: ["src/first.ts"],
    });
    await waitUntil(() => proposer.steered.length === 1);
    const firstId = manager.list()[0]!.id;
    const second = await manager.create({
      proposerAgentId: "agent_1",
      targetBranch: "release",
      summary: "Queued second PR",
      files: ["src/second.ts"],
    });

    expect(second).toMatchObject({ status: "queued", currentStage: "source_preflight" });
    manager.cancel(firstId);
    await Promise.resolve();

    expect(manager.get(firstId)?.status).toBe("cancelled");
    expect(manager.get(second.id)?.status).toBe("queued");
    expect(proposer.steered).toHaveLength(1);
    expect(proposer.activeSteers).toBe(1);

    blockedDelivery.resolve();
    await firstCreate;
    await waitUntil(() => manager.get(second.id)?.status === "source_review_collecting");

    expect(proposer.steered).toHaveLength(2);
    expect(proposer.steered[1]).toContain(`flowId: ${second.id}`);
    expect(proposer.maxConcurrentSteers).toBe(1);
  });

  it("keeps the branch reserved when a timed out PR still has a blocked review delivery", async () => {
    vi.useFakeTimers();
    let now = 0;
    const host = new FakeHost();
    const proposer = host.addAgent("agent_1", "feature/shared", "running");
    const blockedDelivery = deferred();
    proposer.blockNextSteerUntil(blockedDelivery.promise);
    const manager = new PullRequestFlowManager({
      host,
      now: () => now,
      reviewTimeoutMs: 10,
    });

    const firstCreate = manager.create({
      proposerAgentId: "agent_1",
      targetBranch: "main",
      summary: "Blocked timeout PR",
      files: ["src/first.ts"],
    });
    await waitUntil(() => proposer.steered.length === 1);
    const firstId = manager.list()[0]!.id;
    const second = await manager.create({
      proposerAgentId: "agent_1",
      targetBranch: "release",
      summary: "Queued after timeout",
      files: ["src/second.ts"],
    });

    now = 11;
    vi.advanceTimersByTime(11);
    await Promise.resolve();

    expect(manager.get(firstId)?.status).toBe("timed_out");
    expect(manager.get(second.id)?.status).toBe("queued");
    expect(proposer.steered).toHaveLength(1);
    expect(proposer.activeSteers).toBe(1);

    blockedDelivery.resolve();
    await firstCreate;
    await waitUntil(() => manager.get(second.id)?.status === "source_review_collecting");

    expect(proposer.steered).toHaveLength(2);
    expect(proposer.steered[1]).toContain(`flowId: ${second.id}`);
    expect(proposer.maxConcurrentSteers).toBe(1);
  });

  it("runs source reviews on different branches in parallel and queues their target reviews", async () => {
    let now = 6250;
    const host = new FakeHost();
    const proposerA = host.addAgent("agent_a", "feature/a", "waiting_input");
    const proposerB = host.addAgent("agent_b", "feature/b", "waiting_input");
    const targetReviewer = host.addAgent("agent_main", "main", "waiting_input");
    const manager = new PullRequestFlowManager({ host, now: () => now });

    const first = await manager.create({
      proposerAgentId: "agent_a",
      targetBranch: "main",
      summary: "First PR",
      files: ["src/a.ts"],
    });
    const second = await manager.create({
      proposerAgentId: "agent_b",
      targetBranch: "main",
      summary: "Second PR",
      files: ["src/b.ts"],
    });

    expect(first.status).toBe("source_review_collecting");
    expect(second.status).toBe("source_review_collecting");

    now += 1;
    proposerA.setStatus("waiting_input");
    host.assistant("agent_a", reviewJson(first, "source_preflight", "approve"), now);
    await manager.handleAgentEvent(host.result("agent_a", now));
    now += 1;
    proposerB.setStatus("waiting_input");
    host.assistant("agent_b", reviewJson(second, "source_preflight", "approve"), now);
    await manager.handleAgentEvent(host.result("agent_b", now));

    await manager.recordPrCreated(first.id, { prNumber: 1 });
    await manager.recordPrCreated(second.id, { prNumber: 2 });

    expect(manager.get(first.id)?.status).toBe("target_review_collecting");
    expect(manager.get(second.id)).toMatchObject({ status: "queued", currentStage: "target_merge" });
    expect(targetReviewer.sent).toHaveLength(1);

    now += 1;
    targetReviewer.setStatus("waiting_input");
    host.assistant("agent_main", reviewJson(manager.get(first.id)!, "target_merge", "approve"), now);
    await manager.handleAgentEvent(host.result("agent_main", now));
    await flush();

    expect(manager.get(first.id)?.status).toBe("merge_authorized");
    expect(manager.get(second.id)?.status).toBe("target_review_collecting");
    expect(targetReviewer.sent).toHaveLength(2);
    expect(targetReviewer.sent[1]).toContain(`flowId: ${second.id}`);
  });

  it.each(["recordMerged", "cancel"] as const)(
    "cancels a queued drain started by %s when replacement state is imported",
    async (trigger) => {
      let now = 6100;
      let blockDrain = false;
      const drainStarted = deferred();
      const releaseDrain = deferred();
      const host = new FakeHost();
      host.addAgent("agent_a", "feature/a", "waiting_input");
      host.addAgent("agent_b", "feature/a", "waiting_input");
      const manager = new PullRequestFlowManager({
        host,
        now: () => now,
        ensureBranchesReady: async ({ sourceBranch }) => {
          if (blockDrain && sourceBranch === "feature/a") {
            drainStarted.resolve();
            await releaseDrain.promise;
          }
        },
      });
      const active = await manager.create({
        proposerAgentId: "agent_a",
        targetBranch: "main",
        summary: "Active flow",
        files: ["src/active.ts"],
      });
      await manager.create({
        proposerAgentId: "agent_b",
        targetBranch: "main",
        summary: "Queued flow",
        files: ["src/queued.ts"],
      });
      if (trigger === "recordMerged") {
        const expiresAt = now + 1000;
        manager.importState(
          manager.exportState().map((flow) =>
            flow.id === active.id
              ? {
                  ...flow,
                  status: "merge_authorized",
                  currentStage: undefined,
                  deadlineAt: expiresAt,
                  mergeAuthorization: {
                    agentId: flow.proposerAgentId,
                    issuedAt: now,
                    expiresAt,
                  },
                }
              : flow,
          ),
        );
      }

      blockDrain = true;
      if (trigger === "recordMerged") manager.recordMerged(active.id);
      else manager.cancel(active.id);
      await drainStarted.promise;
      expect(manager.hasPendingOperations()).toBe(true);

      manager.importState(undefined);
      releaseDrain.resolve();
      await flush();

      expect(manager.list()).toEqual([]);
      expect(manager.hasPendingOperations()).toBe(false);
    },
  );

  it("cancels a queued drain started by review failure when replacement state is imported", async () => {
    let now = 6200;
    let blockDrain = false;
    const drainStarted = deferred();
    const releaseDrain = deferred();
    const host = new FakeHost();
    const proposer = host.addAgent("agent_a", "feature/a", "waiting_input");
    const queuedProposer = host.addAgent("agent_b", "feature/a", "waiting_input");
    const manager = new PullRequestFlowManager({
      host,
      now: () => now,
      ensureBranchesReady: async ({ sourceBranch }) => {
        if (blockDrain && sourceBranch === "feature/a") {
          drainStarted.resolve();
          await releaseDrain.promise;
        }
      },
    });
    const active = await manager.create({
      proposerAgentId: "agent_a",
      targetBranch: "main",
      summary: "Rejected flow",
      files: ["src/rejected.ts"],
    });
    await manager.create({
      proposerAgentId: "agent_b",
      targetBranch: "main",
      summary: "Queued after rejection",
      files: ["src/queued.ts"],
    });

    blockDrain = true;
    now += 1;
    proposer.setStatus("waiting_input");
    host.assistant("agent_a", reviewJson(active, "source_preflight", "reject"), now);
    await manager.handleAgentEvent(host.result("agent_a", now));
    now += 1;
    queuedProposer.setStatus("waiting_input");
    host.assistant("agent_b", reviewJson(active, "source_preflight", "reject"), now);
    await manager.handleAgentEvent(host.result("agent_b", now));
    await drainStarted.promise;
    expect(manager.hasPendingOperations()).toBe(true);

    manager.importState(undefined);
    releaseDrain.resolve();
    await flush();

    expect(manager.list()).toEqual([]);
    expect(manager.hasPendingOperations()).toBe(false);
  });

  it("cancels a queued drain started by timeout when replacement state is imported", async () => {
    vi.useFakeTimers();
    let now = 0;
    let blockDrain = false;
    const drainStarted = deferred();
    const releaseDrain = deferred();
    const host = new FakeHost();
    host.addAgent("agent_a", "feature/a", "waiting_input");
    host.addAgent("agent_b", "feature/a", "waiting_input");
    const manager = new PullRequestFlowManager({
      host,
      now: () => now,
      reviewTimeoutMs: 10,
      ensureBranchesReady: async ({ sourceBranch }) => {
        if (blockDrain && sourceBranch === "feature/a") {
          drainStarted.resolve();
          await releaseDrain.promise;
        }
      },
    });
    await manager.create({
      proposerAgentId: "agent_a",
      targetBranch: "main",
      summary: "Timed active flow",
      files: ["src/timed.ts"],
    });
    await manager.create({
      proposerAgentId: "agent_b",
      targetBranch: "main",
      summary: "Queued after timeout",
      files: ["src/queued.ts"],
    });

    blockDrain = true;
    now = 11;
    vi.advanceTimersByTime(11);
    await drainStarted.promise;
    expect(manager.hasPendingOperations()).toBe(true);

    manager.importState(undefined);
    releaseDrain.resolve();
    await flushMicrotasks();

    expect(manager.list()).toEqual([]);
    expect(manager.hasPendingOperations()).toBe(false);
  });

  it("rechecks queued PR branch readiness before starting source review", async () => {
    let now = 6500;
    let ready = true;
    const host = new FakeHost();
    const proposer = host.addAgent("agent_1", "feature/shared", "waiting_input");
    const manager = new PullRequestFlowManager({
      host,
      now: () => now,
      ensureBranchesReady: async ({ sourceBranch, targetBranch }) => {
        if (!ready) {
          throw new Error(`source branch ${sourceBranch} must include origin/${targetBranch}`);
        }
      },
    });

    const first = await manager.create({
      proposerAgentId: "agent_1",
      targetBranch: "main",
      summary: "First PR",
      files: ["src/a.ts"],
    });
    const second = await manager.create({
      proposerAgentId: "agent_1",
      targetBranch: "release",
      summary: "Second PR",
      files: ["src/b.ts"],
    });
    expect(second.status).toBe("queued");

    ready = false;
    now += 1;
    proposer.setStatus("waiting_input");
    host.assistant("agent_1", reviewJson(first, "source_preflight", "approve"), now);
    await manager.handleAgentEvent(host.result("agent_1", now));
    await flush();

    expect(manager.get(second.id)).toMatchObject({
      status: "queued",
      currentStage: "source_preflight",
    });
    expect(manager.get(second.id)?.failureReason).toContain("waiting for branch sync");

    ready = true;
    proposer.setStatus("waiting_input");
    const retried = await manager.retryQueued(second.id);

    expect(retried.status).toBe("source_review_collecting");
    expect(retried.failureReason).toBeUndefined();
  });

  it("keeps FIFO order for multiple source reviews on the same branch", async () => {
    let now = 7000;
    const host = new FakeHost();
    const proposer = host.addAgent("agent_1", "feature/shared", "waiting_input");
    const manager = new PullRequestFlowManager({ host, now: () => now });

    const first = await manager.create({
      proposerAgentId: "agent_1",
      targetBranch: "main",
      summary: "First PR",
      files: ["src/a.ts"],
    });
    const second = await manager.create({
      proposerAgentId: "agent_1",
      targetBranch: "release",
      summary: "Second PR",
      files: ["src/b.ts"],
    });
    const third = await manager.create({
      proposerAgentId: "agent_1",
      targetBranch: "develop",
      summary: "Third PR",
      files: ["src/c.ts"],
    });

    expect(second.status).toBe("queued");
    expect(third.status).toBe("queued");

    now += 1;
    proposer.setStatus("waiting_input");
    host.assistant("agent_1", reviewJson(first, "source_preflight", "approve"), now);
    await manager.handleAgentEvent(host.result("agent_1", now));
    await flush();

    expect(manager.get(second.id)?.status).toBe("source_review_collecting");
    expect(manager.get(third.id)?.status).toBe("queued");

    now += 1;
    proposer.setStatus("waiting_input");
    host.assistant("agent_1", reviewJson(manager.get(second.id)!, "source_preflight", "approve"), now);
    await manager.handleAgentEvent(host.result("agent_1", now));
    await flush();

    expect(manager.get(third.id)?.status).toBe("source_review_collecting");
    expect(manager.get(third.id)?.reviewRequests).toHaveLength(1);
  });

  it("starts a restored queued review when its persisted predecessor is already closed", async () => {
    let now = 7500;
    const host = new FakeHost();
    const proposer = host.addAgent("agent_1", "feature/shared", "waiting_input");
    const manager = new PullRequestFlowManager({ host, now: () => now });

    const first = await manager.create({
      proposerAgentId: "agent_1",
      targetBranch: "main",
      summary: "Persisted predecessor",
      files: ["src/a.ts"],
    });
    const second = await manager.create({
      proposerAgentId: "agent_1",
      targetBranch: "release",
      summary: "Persisted queued review",
      files: ["src/b.ts"],
    });
    const restored = manager.exportState().map((flow) =>
      flow.id === first.id
        ? {
            ...flow,
            status: "cancelled" as const,
            currentStage: undefined,
            closedAt: now,
          }
        : flow,
    );

    proposer.sent.length = 0;
    proposer.steered.length = 0;
    proposer.setStatus("waiting_input");
    manager.importState(restored);
    await flush();

    expect(manager.get(second.id)?.status).toBe("source_review_collecting");
    expect(proposer.sent).toHaveLength(1);
    expect(proposer.sent[0]).toContain(`flowId: ${second.id}`);
  });

  it("requeues a restored collecting review without its old deadline and redelivers after retry", async () => {
    vi.useFakeTimers();
    let now = 8000;
    const host = new FakeHost();
    const proposer = host.addAgent("agent_1", "feature/a", "waiting_input");
    const original = new PullRequestFlowManager({
      host,
      now: () => now,
      reviewTimeoutMs: 10,
    });
    const flow = await original.create({
      proposerAgentId: "agent_1",
      targetBranch: "main",
      summary: "Restored timeout",
      files: ["src/timeout.ts"],
    });
    const persisted = original.exportState();
    original.cancel(flow.id);
    proposer.sent.length = 0;
    proposer.steered.length = 0;
    proposer.setStatus("stopped");

    const restored = new PullRequestFlowManager({
      host,
      now: () => now,
      reviewTimeoutMs: 10,
    });
    restored.importState(persisted);
    await waitUntil(() =>
      restored.get(flow.id)?.failureReason?.includes("active reviewer") === true &&
      restored
        .getReviewQueue()
        .stateOf(`pull_request:${flow.id}:source_preflight`) === "queued",
    );

    expect(restored.get(flow.id)).toMatchObject({
      status: "queued",
      currentStage: "source_preflight",
    });
    expect(restored.get(flow.id)?.deadlineAt).toBeUndefined();
    expect(restored.get(flow.id)?.reviewRequests).toHaveLength(1);
    expect(restored.get(flow.id)?.failureReason).toContain("active reviewer");

    now += 11;
    vi.advanceTimersByTime(11);

    expect(restored.get(flow.id)?.status).toBe("queued");
    expect(proposer.sent).toHaveLength(0);
    expect(proposer.steered).toHaveLength(0);

    proposer.setStatus("running");
    await restored.getReviewQueue().retryBranch("feature/a");

    const retried = restored.get(flow.id)!;
    expect(retried.status).toBe("source_review_collecting");
    expect(retried.deadlineAt).toBe(now + 10);
    expect(retried.reviewRequests).toHaveLength(2);
    expect(retried.reviewRequests[1]?.id).not.toBe(retried.reviewRequests[0]?.id);
    expect(retried.reviewRequests[1]?.requestedAgentIds).toEqual(["agent_1"]);
    expect(proposer.steered).toHaveLength(1);
    expect(proposer.steered[0]).toContain(`flowId: ${flow.id}`);

    vi.advanceTimersByTime(9);
    expect(restored.get(flow.id)?.status).toBe("source_review_collecting");
  });

  it("does not let an in-flight review start mutate a newly imported project", async () => {
    const host = new FakeHost();
    const proposer = host.addAgent("agent_1", "feature/shared", "waiting_input");
    let readinessChecks = 0;
    let releaseStaleCheck!: () => void;
    const staleCheck = new Promise<void>((resolve) => {
      releaseStaleCheck = resolve;
    });
    const manager = new PullRequestFlowManager({
      host,
      ensureBranchesReady: async () => {
        readinessChecks += 1;
        if (readinessChecks === 2) await staleCheck;
      },
    });

    const staleCreate = manager.create({
      proposerAgentId: "agent_1",
      targetBranch: "main",
      summary: "Old project review",
      files: ["src/old.ts"],
    });
    for (let attempt = 0; attempt < 10 && readinessChecks < 2; attempt += 1) {
      await Promise.resolve();
    }
    expect(readinessChecks).toBe(2);

    manager.importState([]);
    proposer.setStatus("waiting_input");
    const fresh = await manager.create({
      proposerAgentId: "agent_1",
      targetBranch: "release",
      summary: "New project review",
      files: ["src/new.ts"],
    });
    expect(fresh.id).toBe("pr_flow_1");
    expect(fresh.status).toBe("queued");

    releaseStaleCheck();
    await expect(staleCreate).rejects.toThrow("state changed");
    await waitUntil(() => manager.get(fresh.id)?.status === "source_review_collecting");
    expect(manager.get(fresh.id)?.summary).toBe("New project review");
    expect(manager.get(fresh.id)?.status).toBe("source_review_collecting");
  });

  it("keeps an imported same-branch review queued until stale delivery settles", async () => {
    const host = new FakeHost();
    const proposer = host.addAgent("agent_1", "feature/shared", "running");
    const staleDelivery = deferred();
    proposer.blockNextSteerUntil(staleDelivery.promise);
    const manager = new PullRequestFlowManager({ host });

    const staleCreate = manager.create({
      proposerAgentId: "agent_1",
      targetBranch: "main",
      summary: "Old project delivery",
      files: ["src/old.ts"],
    });
    await waitUntil(() => proposer.steered.length === 1);
    const staleFlow = manager.list()[0]!;
    const importedFlow: PullRequestFlowSnapshot = {
      ...staleFlow,
      id: "pr_flow_42",
      summary: "Imported project delivery",
      status: "queued",
      currentStage: "source_preflight",
      deadlineAt: undefined,
      failureReason: undefined,
      reviewRequests: [],
      createdAt: staleFlow.createdAt + 1,
      updatedAt: staleFlow.updatedAt + 1,
    };

    manager.importState([importedFlow]);
    await Promise.resolve();

    expect(manager.get(importedFlow.id)?.status).toBe("queued");
    expect(proposer.steered).toHaveLength(1);
    expect(proposer.activeSteers).toBe(1);

    staleDelivery.resolve();
    await expect(staleCreate).rejects.toThrow("state changed");
    await waitUntil(
      () => manager.get(importedFlow.id)?.status === "source_review_collecting",
    );

    expect(proposer.steered).toHaveLength(2);
    expect(proposer.steered[1]).toContain(`flowId: ${importedFlow.id}`);
    expect(proposer.maxConcurrentSteers).toBe(1);
  });

  it("resolves changed files when a flow is created without explicit files", async () => {
    let now = 3000;
    const host = new FakeHost();
    const proposer = host.addAgent("agent_1", "feature/a", "waiting_input");
    const manager = new PullRequestFlowManager({
      host,
      now: () => now,
      resolveChangedFiles: async ({ sourceBranch, targetBranch }) => {
        expect(sourceBranch).toBe("feature/a");
        expect(targetBranch).toBe("main");
        return [{ status: "M", path: "src/resolved.ts" }];
      },
    });

    const flow = await manager.create({
      proposerAgentId: "agent_1",
      targetBranch: "main",
      summary: "Resolved files",
    });

    expect(flow.files).toEqual(["src/resolved.ts"]);
    expect(flow.fileChanges).toEqual([{ status: "M", path: "src/resolved.ts" }]);
    expect(proposer.sent[0]).toContain("- M src/resolved.ts");
  });

  it("rejects PR flows when no changed files can be determined", async () => {
    const host = new FakeHost();
    host.addAgent("agent_1", "feature/a", "waiting_input");
    const manager = new PullRequestFlowManager({ host });

    await expect(
      manager.create({
        proposerAgentId: "agent_1",
        targetBranch: "main",
        summary: "No files",
      }),
    ).rejects.toThrow("concrete changed file list");
  });
});

function reviewJson(
  flow: PullRequestFlowSnapshot,
  stage: "source_preflight" | "target_merge",
  decision: "approve" | "reject" | "needs_changes" | "blocked",
): string {
  return JSON.stringify({
    agentCanvasPrReview: true,
    flowId: flow.id,
    stage,
    decision,
    summary: `${decision} ${stage}`,
    risks: [],
    filesReviewed: [],
    requiredChanges: [],
  });
}
