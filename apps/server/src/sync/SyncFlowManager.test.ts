import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEventEnvelope, AgentSnapshot, SyncFlowSnapshot } from "@agent-canvas/shared";
import { SyncFlowManager, type SyncFlowAgentHost } from "./SyncFlowManager.js";

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

  it("queues reviews for the same current branch and starts the next after authorization", async () => {
    let now = 3500;
    const host = new FakeHost();
    const proposer = host.addAgent("agent_1", "feature/current", "waiting_input");
    const manager = new SyncFlowManager({ host, now: () => now });

    const first = await manager.create({
      kind: "branch_pull",
      proposerAgentId: "agent_1",
      sourceBranch: "main",
      summary: "First pull",
      reason: "Need the first update",
      files: ["src/first.ts"],
    });
    const second = await manager.create({
      kind: "branch_pull",
      proposerAgentId: "agent_1",
      sourceBranch: "release",
      summary: "Second pull",
      reason: "Need the second update",
      files: ["src/second.ts"],
    });

    expect(first.status).toBe("review_collecting");
    expect(second.status).toBe("queued");
    expect(second.reviewRequest).toBeUndefined();
    expect(proposer.sent).toHaveLength(1);
    expect(proposer.steered).toHaveLength(0);

    now += 1;
    proposer.setStatus("waiting_input");
    host.assistant("agent_1", reviewJson(first, "approve"), now);
    await manager.handleAgentEvent(host.result("agent_1", now));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(manager.get(first.id)?.status).toBe("apply_authorized");
    expect(manager.get(second.id)?.status).toBe("review_collecting");
    expect(manager.get(second.id)?.reviewRequest).toBeDefined();
    expect(proposer.steered).toHaveLength(1);
    expect(proposer.steered[0]).toContain(`flowId: ${second.id}`);
  });

  it("releases the branch queue when an active sync review is cancelled", async () => {
    const host = new FakeHost();
    host.addAgent("agent_1", "feature/current", "waiting_input");
    const manager = new SyncFlowManager({ host });

    const first = await manager.create({
      kind: "branch_pull",
      proposerAgentId: "agent_1",
      sourceBranch: "main",
      summary: "Cancelled pull",
      reason: "Exercise queue cancellation",
      files: ["src/first.ts"],
    });
    const second = await manager.create({
      kind: "branch_pull",
      proposerAgentId: "agent_1",
      sourceBranch: "release",
      summary: "Pull after cancellation",
      reason: "Must start after the branch slot is released",
      files: ["src/second.ts"],
    });
    expect(second.status).toBe("queued");

    manager.cancel(first.id);
    await Promise.resolve();
    await Promise.resolve();

    expect(manager.get(first.id)?.status).toBe("cancelled");
    expect(manager.get(second.id)?.status).toBe("review_collecting");
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
