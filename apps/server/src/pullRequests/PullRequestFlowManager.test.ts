import { describe, expect, it, vi, afterEach } from "vitest";
import type {
  AgentEventEnvelope,
  AgentSnapshot,
  PullRequestFlowSnapshot,
} from "@agent-canvas/shared";
import {
  PullRequestFlowManager,
  type PullRequestAgentHost,
} from "./PullRequestFlowManager.js";

class FakeRunner {
  readonly sent: string[] = [];
  readonly steered: string[] = [];

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

  async steer(text: string): Promise<void> {
    this.steered.push(text);
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
  private readonly agents: Array<{ id: string; branch: string; runner: FakeRunner }> = [];
  seq = 0;

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
      config: { prompt: "", provider: "codex", branch },
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

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe("PullRequestFlowManager", () => {
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
    const state = original.exportState();
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
    const state = original.exportState();
    original.importState(undefined);
    now = 20;

    const restored = new PullRequestFlowManager({ host, now: () => now });
    const observed: PullRequestFlowSnapshot[] = [];
    restored.onFlow((next) => observed.push(next));
    restored.importState(state, { deferActivation: true });
    vi.advanceTimersByTime(100);

    expect(restored.get(flow.id)?.status).toBe("source_review_collecting");
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

  it("queues PR flows that target the same branch and starts them in order", async () => {
    let now = 6000;
    const host = new FakeHost();
    const proposerA = host.addAgent("agent_a", "feature/a", "waiting_input");
    const proposerB = host.addAgent("agent_b", "feature/b", "waiting_input");
    const targetReviewer = host.addAgent("agent_main", "main", "waiting_input");
    const manager = new PullRequestFlowManager({ host, now: () => now });

    let first = await manager.create({
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
    expect(second.status).toBe("queued");
    expect(proposerA.sent).toHaveLength(1);
    expect(proposerB.sent).toHaveLength(0);

    now += 1;
    proposerA.setStatus("waiting_input");
    host.assistant("agent_a", reviewJson(first, "source_preflight", "approve"), now);
    await manager.handleAgentEvent(host.result("agent_a", now));

    first = manager.get(first.id)!;
    expect(first.status).toBe("create_pr_authorized");

    now += 1;
    proposerA.setStatus("waiting_input");
    host.assistant(
      "agent_a",
      JSON.stringify({ agentCanvasPrEvent: "pr_created", flowId: first.id, prNumber: 1 }),
      now,
    );
    await manager.handleAgentEvent(host.result("agent_a", now));

    first = manager.get(first.id)!;
    expect(first.status).toBe("target_review_collecting");

    now += 1;
    targetReviewer.setStatus("waiting_input");
    host.assistant("agent_main", reviewJson(first, "target_merge", "approve"), now);
    await manager.handleAgentEvent(host.result("agent_main", now));

    first = manager.get(first.id)!;
    expect(first.status).toBe("merge_authorized");

    manager.recordMerged(first.id);
    await flush();

    const startedSecond = manager.get(second.id)!;
    expect(startedSecond.status).toBe("source_review_collecting");
    expect(proposerB.sent).toHaveLength(1);
    expect(proposerB.sent[0]).toContain(`flowId: ${second.id}`);
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
      host.addAgent("agent_b", "feature/b", "waiting_input");
      const manager = new PullRequestFlowManager({
        host,
        now: () => now,
        ensureBranchesReady: async ({ sourceBranch }) => {
          if (blockDrain && sourceBranch === "feature/b") {
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
    host.addAgent("agent_b", "feature/b", "waiting_input");
    const manager = new PullRequestFlowManager({
      host,
      now: () => now,
      ensureBranchesReady: async ({ sourceBranch }) => {
        if (blockDrain && sourceBranch === "feature/b") {
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
    host.addAgent("agent_b", "feature/b", "waiting_input");
    const manager = new PullRequestFlowManager({
      host,
      now: () => now,
      reviewTimeoutMs: 10,
      ensureBranchesReady: async ({ sourceBranch }) => {
        if (blockDrain && sourceBranch === "feature/b") {
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
    const proposerA = host.addAgent("agent_a", "feature/a", "waiting_input");
    const proposerB = host.addAgent("agent_b", "feature/b", "waiting_input");
    const targetReviewer = host.addAgent("agent_main", "main", "waiting_input");
    const manager = new PullRequestFlowManager({
      host,
      now: () => now,
      ensureBranchesReady: async ({ sourceBranch, targetBranch }) => {
        if (!ready && sourceBranch === "feature/b") {
          throw new Error(`source branch ${sourceBranch} must include origin/${targetBranch}`);
        }
      },
    });

    let first = await manager.create({
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
    expect(second.status).toBe("queued");

    now += 1;
    proposerA.setStatus("waiting_input");
    host.assistant("agent_a", reviewJson(first, "source_preflight", "approve"), now);
    await manager.handleAgentEvent(host.result("agent_a", now));

    first = manager.get(first.id)!;
    now += 1;
    proposerA.setStatus("waiting_input");
    host.assistant(
      "agent_a",
      JSON.stringify({ agentCanvasPrEvent: "pr_created", flowId: first.id, prNumber: 1 }),
      now,
    );
    await manager.handleAgentEvent(host.result("agent_a", now));

    first = manager.get(first.id)!;
    now += 1;
    targetReviewer.setStatus("waiting_input");
    host.assistant("agent_main", reviewJson(first, "target_merge", "approve"), now);
    await manager.handleAgentEvent(host.result("agent_main", now));

    ready = false;
    manager.recordMerged(first.id);
    await flush();

    const stillQueued = manager.get(second.id)!;
    expect(stillQueued.status).toBe("queued");
    expect(stillQueued.failureReason).toContain("waiting for branch sync");
    expect(proposerB.sent).toHaveLength(0);

    ready = true;
    proposerB.setStatus("waiting_input");
    const retried = await manager.retryQueued(second.id);

    expect(retried.status).toBe("source_review_collecting");
    expect(retried.failureReason).toBeUndefined();
    expect(proposerB.sent).toHaveLength(1);
    expect(proposerB.sent[0]).toContain(`flowId: ${second.id}`);
  });

  it("continues draining independent queued flows when an older queued flow still needs sync", async () => {
    let now = 6750;
    let staleReady = true;
    const host = new FakeHost();
    const activeProposer = host.addAgent("agent_active", "feature/c", "waiting_input");
    const staleProposer = host.addAgent("agent_stale", "feature/b", "waiting_input");
    const releaseReviewer = host.addAgent("agent_release", "release", "waiting_input");
    const manager = new PullRequestFlowManager({
      host,
      now: () => now,
      ensureBranchesReady: async ({ sourceBranch, targetBranch }) => {
        if (!staleReady && sourceBranch === "feature/b") {
          throw new Error(`source branch ${sourceBranch} must include origin/${targetBranch}`);
        }
      },
    });

    let active = await manager.create({
      proposerAgentId: "agent_active",
      targetBranch: "release",
      summary: "Active PR",
      files: ["src/active.ts"],
    });
    const staleQueued = await manager.create({
      proposerAgentId: "agent_stale",
      targetBranch: "release",
      summary: "Stale queued PR",
      files: ["src/stale.ts"],
    });

    expect(staleQueued.status).toBe("queued");

    now += 1;
    activeProposer.setStatus("waiting_input");
    host.assistant("agent_active", reviewJson(active, "source_preflight", "approve"), now);
    await manager.handleAgentEvent(host.result("agent_active", now));

    active = manager.get(active.id)!;
    const readyProposer = host.addAgent("agent_ready", "feature/c", "waiting_input");
    const readyQueued = await manager.create({
      proposerAgentId: "agent_ready",
      targetBranch: "main",
      summary: "Ready queued PR",
      files: ["src/ready.ts"],
    });
    expect(readyQueued.status).toBe("queued");

    now += 1;
    activeProposer.setStatus("waiting_input");
    host.assistant(
      "agent_active",
      JSON.stringify({ agentCanvasPrEvent: "pr_created", flowId: active.id, prNumber: 4 }),
      now,
    );
    await manager.handleAgentEvent(host.result("agent_active", now));

    active = manager.get(active.id)!;
    now += 1;
    releaseReviewer.setStatus("waiting_input");
    host.assistant("agent_release", reviewJson(active, "target_merge", "approve"), now);
    await manager.handleAgentEvent(host.result("agent_release", now));

    staleReady = false;
    manager.recordMerged(active.id);
    await flush();

    const stale = manager.get(staleQueued.id)!;
    const ready = manager.get(readyQueued.id)!;
    expect(stale.status).toBe("queued");
    expect(stale.failureReason).toContain("waiting for branch sync");
    expect(staleProposer.sent).toHaveLength(0);
    expect(ready.status).toBe("source_review_collecting");
    expect(readyProposer.sent).toHaveLength(1);
    expect(readyProposer.sent[0]).toContain(`flowId: ${readyQueued.id}`);
  });

  it("treats queued flows as branch reservations so later flows cannot skip them", async () => {
    let now = 7000;
    const host = new FakeHost();
    const activeProposer = host.addAgent("agent_active", "feature/a", "waiting_input");
    const queuedProposer = host.addAgent("agent_queued", "feature/b", "waiting_input");
    const laterProposer = host.addAgent("agent_later", "feature/b", "waiting_input");
    const mainReviewer = host.addAgent("agent_main", "main", "waiting_input");
    const releaseReviewer = host.addAgent("agent_release", "release", "waiting_input");
    const manager = new PullRequestFlowManager({ host, now: () => now });

    const active = await manager.create({
      proposerAgentId: "agent_active",
      targetBranch: "release",
      summary: "Active release PR",
      files: ["src/a.ts"],
    });
    const olderQueued = await manager.create({
      proposerAgentId: "agent_queued",
      targetBranch: "release",
      summary: "Older queued release PR",
      files: ["src/b.ts"],
    });
    const laterQueued = await manager.create({
      proposerAgentId: "agent_later",
      targetBranch: "main",
      summary: "Later main PR",
      files: ["src/c.ts"],
    });
    laterProposer.setStatus("idle");

    expect(active.status).toBe("source_review_collecting");
    expect(olderQueued.status).toBe("queued");
    expect(laterQueued.status).toBe("queued");
    expect(queuedProposer.sent).toHaveLength(0);
    expect(laterProposer.sent).toHaveLength(0);

    now += 1;
    activeProposer.setStatus("waiting_input");
    host.assistant("agent_active", reviewJson(active, "source_preflight", "approve"), now);
    await manager.handleAgentEvent(host.result("agent_active", now));

    now += 1;
    activeProposer.setStatus("waiting_input");
    host.assistant(
      "agent_active",
      JSON.stringify({ agentCanvasPrEvent: "pr_created", flowId: active.id, prNumber: 2 }),
      now,
    );
    await manager.handleAgentEvent(host.result("agent_active", now));

    now += 1;
    releaseReviewer.setStatus("waiting_input");
    host.assistant("agent_release", reviewJson(manager.get(active.id)!, "target_merge", "approve"), now);
    await manager.handleAgentEvent(host.result("agent_release", now));
    manager.recordMerged(active.id);
    await flush();

    expect(manager.get(olderQueued.id)?.status).toBe("source_review_collecting");
    expect(manager.get(laterQueued.id)?.status).toBe("queued");
    expect(queuedProposer.sent).toHaveLength(1);
    expect(laterProposer.sent).toHaveLength(0);

    now += 1;
    queuedProposer.setStatus("waiting_input");
    host.assistant("agent_queued", reviewJson(manager.get(olderQueued.id)!, "source_preflight", "approve"), now);
    await manager.handleAgentEvent(host.result("agent_queued", now));

    now += 1;
    queuedProposer.setStatus("waiting_input");
    host.assistant(
      "agent_queued",
      JSON.stringify({ agentCanvasPrEvent: "pr_created", flowId: olderQueued.id, prNumber: 3 }),
      now,
    );
    await manager.handleAgentEvent(host.result("agent_queued", now));
    expect(manager.get(olderQueued.id)?.status).toBe("target_review_collecting");

    now += 1;
    releaseReviewer.setStatus("waiting_input");
    host.assistant(
      "agent_release",
      reviewJson(manager.get(olderQueued.id)!, "target_merge", "approve"),
      now,
    );
    await manager.handleAgentEvent(host.result("agent_release", now));
    expect(manager.get(olderQueued.id)?.status).toBe("merge_authorized");
    laterProposer.setStatus("waiting_input");
    manager.recordMerged(olderQueued.id);
    await flush();

    expect(manager.get(laterQueued.id)?.status).toBe("source_review_collecting");
    expect(mainReviewer.sent).toHaveLength(0);
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
