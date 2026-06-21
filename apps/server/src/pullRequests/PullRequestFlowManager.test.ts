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
    expect(flow.fileChanges).toEqual([{ status: "specified", path: "src/a.ts" }]);
    expect(proposer.sent[0]).toContain("sourceBranch: feature/a");
    expect(proposer.sent[0]).toContain("changedFiles (git diff --name-status):");
    expect(proposer.sent[0]).toContain("- specified src/a.ts");
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
