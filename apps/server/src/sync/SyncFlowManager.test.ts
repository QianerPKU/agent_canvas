import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEventEnvelope, AgentSnapshot, SyncFlowSnapshot } from "@agent-canvas/shared";
import { SyncFlowManager, type SyncFlowAgentHost } from "./SyncFlowManager.js";

class FakeRunner {
  readonly sent: string[] = [];
  readonly steered: string[] = [];
  private deliveryError?: Error;

  constructor(private status: string) {}

  getStatus(): string {
    return this.status;
  }

  setStatus(status: string): void {
    this.status = status;
  }

  failDelivery(message: string): void {
    this.deliveryError = new Error(message);
  }

  async send(text: string): Promise<void> {
    if (this.deliveryError) throw this.deliveryError;
    this.sent.push(text);
    this.status = "running";
  }

  async steer(text: string): Promise<void> {
    if (this.deliveryError) throw this.deliveryError;
    this.steered.push(text);
  }

  async deliver(text: string): Promise<void> {
    if (this.status === "running") return await this.steer(text);
    if (this.status === "waiting_input") return await this.send(text);
    throw new Error(`agent is not active (${this.status})`);
  }
}

class FakeHost implements SyncFlowAgentHost {
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
      config: { prompt: "", provider: "codex", branch, cwd: `C:\\repo\\${branch}` },
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

describe("SyncFlowManager", () => {
  it("awaits direct send and steer validation failures before completing review delivery", async () => {
    const host = new FakeHost();
    const waiting = host.addAgent("agent_waiting", "feature/current", "waiting_input");
    const running = host.addAgent("agent_running", "feature/current", "running");
    waiting.failDelivery("documentation mount was replaced");
    running.failDelivery("documentation mount was replaced");
    const manager = new SyncFlowManager({ host });

    const flow = await manager.create({
      kind: "branch_pull",
      proposerAgentId: "agent_waiting",
      sourceBranch: "main",
      targetBranch: "feature/current",
      summary: "Catch up with main",
      reason: "Need shared fixes",
      files: ["src/example.ts"],
    });

    expect(flow.status).toBe("review_failed");
    expect(flow.failureReason).toContain("Failed to deliver sync review request");
    expect(waiting.sent).toEqual([]);
    expect(running.steered).toEqual([]);
  });

  it("authorizes and records an applied cherry-pick after current-branch approvals", async () => {
    let now = 1000;
    const host = new FakeHost();
    const proposer = host.addAgent("agent_1", "feature/current", "waiting_input");
    const reviewer = host.addAgent("agent_2", "feature/current", "running");
    const manager = new SyncFlowManager({ host, now: () => now });

    let flow = await manager.create({
      kind: "cherry_pick",
      proposerAgentId: "agent_1",
      sourceBranch: "main",
      commitSha: "abcdef123456",
      summary: "Apply focused fix",
      reason: "Current branch needs this exact commit",
      files: ["src/fix.ts"],
    });

    expect(flow.status).toBe("review_collecting");
    expect(flow.targetBranch).toBe("feature/current");
    expect(flow.sourceTurnIndex).toBe(0);
    expect(flow.fileChanges).toEqual([{ status: "specified", path: "src/fix.ts" }]);
    expect(proposer.sent[0]).toContain("cherry-pick commit");
    expect(proposer.sent[0]).toContain("commitSha: abcdef123456");
    expect(reviewer.steered[0]).toContain("Check whether cherry-picking this single commit");

    now += 1;
    proposer.setStatus("waiting_input");
    host.assistant("agent_1", reviewJson(flow, "approve"), now);
    await manager.handleAgentEvent(host.result("agent_1", now));

    now += 1;
    reviewer.setStatus("waiting_input");
    host.assistant("agent_2", reviewJson(flow, "approve"), now);
    await manager.handleAgentEvent(host.result("agent_2", now));

    flow = manager.get(flow.id)!;
    expect(flow.status).toBe("apply_authorized");
    expect(proposer.sent.at(-1)).toContain("authorized to cherry-pick");

    now += 1;
    proposer.setStatus("waiting_input");
    host.assistant(
      "agent_1",
      JSON.stringify({
        agentCanvasSyncEvent: "applied",
        flowId: flow.id,
        summary: "Cherry-pick applied",
        commitSha: "fedcba654321",
        files: ["src/fix.ts"],
      }),
      now,
    );
    await manager.handleAgentEvent(host.result("agent_1", now));

    flow = manager.get(flow.id)!;
    expect(flow.status).toBe("applied");
    expect(flow.applied).toMatchObject({
      summary: "Cherry-pick applied",
      commitSha: "fedcba654321",
      reportedByAgentId: "agent_1",
    });
  });

  it("resolves changed files for a branch pull flow", async () => {
    let now = 2000;
    const host = new FakeHost();
    const proposer = host.addAgent("agent_1", "feature/current", "waiting_input");
    const manager = new SyncFlowManager({
      host,
      now: () => now,
      resolveChangedFiles: async (context) => {
        expect(context).toMatchObject({
          kind: "branch_pull",
          proposerAgentId: "agent_1",
          sourceBranch: "main",
          targetBranch: "feature/current",
        });
        return [{ status: "M", path: "src/main.ts" }];
      },
    });

    const flow = await manager.create({
      kind: "branch_pull",
      proposerAgentId: "agent_1",
      sourceBranch: "main",
      strategy: "rebase",
      summary: "Catch up with main",
      reason: "Need shared fixes from main",
    });

    expect(flow).toMatchObject({
      status: "review_collecting",
      strategy: "rebase",
      files: ["src/main.ts"],
      fileChanges: [{ status: "M", path: "src/main.ts" }],
    });
    expect(proposer.sent[0]).toContain("pull branch");
    expect(proposer.sent[0]).toContain("strategy: rebase");
  });

  it("closes a flow when any current-branch reviewer rejects it", async () => {
    let now = 3000;
    const host = new FakeHost();
    const proposer = host.addAgent("agent_1", "feature/current", "waiting_input");
    const manager = new SyncFlowManager({ host, now: () => now });

    const flow = await manager.create({
      kind: "branch_pull",
      proposerAgentId: "agent_1",
      sourceBranch: "main",
      summary: "Merge main",
      reason: "Need latest changes",
      files: ["src/main.ts"],
    });

    now += 1;
    proposer.setStatus("waiting_input");
    host.assistant("agent_1", reviewJson(flow, "reject"), now);
    await manager.handleAgentEvent(host.result("agent_1", now));

    const next = manager.get(flow.id)!;
    expect(next.status).toBe("review_failed");
    expect(next.failureReason).toContain("agent_1: reject");
    expect(proposer.sent.at(-1)).toContain("Do not apply this sync flow");
  });

  it("times out when reviewers do not all respond", async () => {
    vi.useFakeTimers();
    let now = 0;
    const host = new FakeHost();
    host.addAgent("agent_1", "feature/current", "waiting_input");
    const manager = new SyncFlowManager({
      host,
      now: () => now,
      reviewTimeoutMs: 10,
    });

    const flow = await manager.create({
      kind: "cherry_pick",
      proposerAgentId: "agent_1",
      commitSha: "abcdef123456",
      summary: "Timeout pick",
      reason: "Needs review",
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
    host.addAgent("agent_1", "feature/current", "waiting_input");
    const original = new SyncFlowManager({
      host,
      now: () => now,
      reviewTimeoutMs: 10,
    });
    const flow = await original.create({
      kind: "cherry_pick",
      proposerAgentId: "agent_1",
      commitSha: "abcdef123456",
      summary: "Persisted timeout",
      reason: "Exercise import",
      files: ["src/import-timeout.ts"],
    });
    const state = original.exportState();
    original.importState(undefined);

    now = 5;
    const restored = new SyncFlowManager({ host, now: () => now });
    restored.importState(state);
    expect(restored.hasOpenFlows()).toBe(true);
    now = 11;
    vi.advanceTimersByTime(6);
    expect(restored.get(flow.id)?.status).toBe("timed_out");
    expect(restored.hasOpenFlows()).toBe(false);

    now = 20;
    const overdue = new SyncFlowManager({ host, now: () => now });
    overdue.importState(state);
    expect(overdue.get(flow.id)?.status).toBe("timed_out");
    expect(overdue.hasPendingOperations()).toBe(false);
  });

  it("defers imported timeout activation until the caller publishes authoritative state", async () => {
    vi.useFakeTimers();
    let now = 0;
    const host = new FakeHost();
    host.addAgent("agent_1", "feature/current", "waiting_input");
    const original = new SyncFlowManager({
      host,
      now: () => now,
      reviewTimeoutMs: 10,
    });
    const flow = await original.create({
      kind: "cherry_pick",
      proposerAgentId: "agent_1",
      commitSha: "abcdef123456",
      summary: "Deferred imported timeout",
      reason: "Publish workspace first",
      files: ["src/deferred-import.ts"],
    });
    const state = original.exportState();
    original.importState(undefined);
    now = 20;

    const restored = new SyncFlowManager({ host, now: () => now });
    const observed: SyncFlowSnapshot[] = [];
    restored.onFlow((next) => observed.push(next));
    restored.importState(state, { deferActivation: true });
    vi.advanceTimersByTime(100);

    expect(restored.get(flow.id)?.status).toBe("review_collecting");
    expect(observed).toEqual([]);
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
    host.addAgent("agent_1", "feature/current", "waiting_input");
    const manager = new SyncFlowManager({
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
      kind: "cherry_pick",
      proposerAgentId: "agent_1",
      commitSha: "abcdef123456",
      summary: "Stale callback",
      reason: "Exercise generation guard",
      files: ["src/stale-timeout.ts"],
    });
    const staleCallback = callbacks[0]!;

    manager.importState(undefined);
    now = 11;
    staleCallback();

    expect(manager.list()).toEqual([]);
    expect(manager.hasPendingOperations()).toBe(false);
  });
});

function reviewJson(
  flow: SyncFlowSnapshot,
  decision: "approve" | "reject" | "needs_changes" | "blocked",
): string {
  return JSON.stringify({
    agentCanvasSyncReview: true,
    flowId: flow.id,
    decision,
    summary: `${decision} sync`,
    risks: [],
    filesReviewed: [],
    requiredChanges: [],
  });
}
