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
  type SubmitPullRequestReviewInput,
} from "./PullRequestFlowManager.js";

class FakeRunner {
  readonly sent: string[] = [];
  readonly started: string[] = [];
  readonly steered: string[] = [];
  readonly deliveries: Array<{
    text: string;
    options?: { automationKey?: string; replaceQueued?: boolean };
  }> = [];
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

  async deliver(
    text: string,
    options?: { automationKey?: string; replaceQueued?: boolean },
  ): Promise<void> {
    this.deliveries.push({ text, options: options ? { ...options } : undefined });
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

  addAgent(id: string, branch: string, status: string, createdAt?: number): FakeRunner {
    const runner = new FakeRunner(status);
    this.runners.set(id, runner);
    this.histories.set(id, []);
    const assignedCreatedAt = createdAt ?? this.createdAt + 1;
    this.createdAt = Math.max(this.createdAt, assignedCreatedAt);
    this.agents.push({ id, branch, runner, createdAt: assignedCreatedAt });
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

  userInput(
    agentId: string,
    text: string,
    at: number,
    mode?: "queued" | "steer",
  ): void {
    this.histories.get(agentId)?.push({
      agentId,
      seq: ++this.seq,
      at,
      event: { kind: "user_input", text, mode },
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

async function waitForFlow(
  manager: PullRequestFlowManager,
  flowId: string,
  predicate: (flow: PullRequestFlowSnapshot) => boolean,
): Promise<PullRequestFlowSnapshot> {
  await waitUntil(() => {
    const flow = manager.get(flowId);
    return flow !== undefined && predicate(flow);
  });
  return manager.get(flowId)!;
}

async function waitForDelivery(runner: FakeRunner, text: string): Promise<string> {
  await waitUntil(() => hasDelivery(runner, text));
  return findDelivery(runner, text);
}

function hasDelivery(runner: FakeRunner, text: string): boolean {
  return [...runner.sent, ...runner.steered].some((candidate) => candidate.includes(text));
}

function findDeliveryAttempt(runner: FakeRunner, text: string) {
  const delivery = runner.deliveries.find((candidate) => candidate.text.includes(text));
  if (!delivery) throw new Error(`missing delivery attempt containing ${text}`);
  return delivery;
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

    expect(flow.status).toBe("queued");
    flow = await waitForFlow(
      manager,
      flow.id,
      (candidate) => candidate.status === "source_review_collecting",
    );
    await waitForDelivery(proposer, `POST /api/pr-flows/${flow.id}/reviews`);
    expect(findDeliveryAttempt(proposer, `POST /api/pr-flows/${flow.id}/reviews`).options).toEqual(
      { automationKey: `pr-flow:${flow.id}` },
    );
    expect(flow.status).toBe("source_review_collecting");
    expect(flow.sourceTurnIndex).toBe(0);
    expect(flow.fileChanges).toEqual([{ status: "specified", path: "src/a.ts" }]);
    expect(proposer.sent[0]).toContain("sourceBranch: feature/a");
    expect(proposer.sent[0]).toContain("changedFiles (git diff --name-status):");
    expect(proposer.sent[0]).toContain("- specified src/a.ts");
    expect(proposer.sent[0]).toContain("conflicts with the part you are currently working on");
    expect(proposer.sent[0]).toContain("should wait until your current work is finished");
    expect(proposer.sent[0]).toContain("\"stage\": \"source_preflight\"");
    expect(proposer.sent[0]).toContain(`POST /api/pr-flows/${flow.id}/reviews`);
    expect(proposer.sent[0]).toContain("\"agentId\": \"agent_1\"");
    expect(proposer.sent[0]).toContain("intermediate tool call");
    expect(proposer.sent[0]).toContain("READ-ONLY FLOW FREEZE");
    expect(extractPromptToken(proposer.sent[0]!, "reviewToken")).toMatch(
      /^agent_canvas_cap_/u,
    );
    expect(proposer.sent[0]).toContain("continue the task you were doing in the same reply");
    expect(proposer.sent[0]).toContain("you are also this flow's proposer");
    expect(proposer.sent[0]).toContain("read-only freeze remains in force");

    now += 1;
    proposer.setStatus("waiting_input");
    host.assistant("agent_1", reviewJson(flow, "source_preflight", "approve"), now);
    await manager.handleAgentEvent(host.result("agent_1", now));

    flow = await waitForFlow(
      manager,
      flow.id,
      (candidate) => candidate.status === "create_pr_authorized",
    );
    await waitForDelivery(proposer, `/api/pr-flows/${flow.id}/pr-created`);
    expect(findDeliveryAttempt(proposer, `/api/pr-flows/${flow.id}/pr-created`).options).toEqual(
      { automationKey: `pr-flow:${flow.id}` },
    );
    expect(flow.status).toBe("create_pr_authorized");
    expect(proposer.sent.at(-1)).toContain(
      "authorized to create the PR for this flow from the reviewed source head",
    );
    expect(proposer.sent.at(-1)).toContain(`POST /api/pr-flows/${flow.id}/pr-created`);
    expect(proposer.sent.at(-1)).toContain("lifts the proposer freeze only to create this PR");
    expect(proposer.sent.at(-1)).toContain("exact reviewed and already-pushed source head");
    expect(proposer.sent.at(-1)).toContain("Do not edit files, create commits, push");
    expect(proposer.sent.at(-1)).toContain("become read-only again");
    expect(proposer.sent.at(-1)).toContain("continue the task you were doing in the same reply");
    expect(extractPromptToken(proposer.sent.at(-1)!, "completionToken")).toBeTruthy();

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

    flow = await waitForFlow(
      manager,
      flow.id,
      (candidate) => candidate.status === "target_review_collecting",
    );
    await waitForDelivery(targetReviewer, `POST /api/pr-flows/${flow.id}/reviews`);
    expect(
      findDeliveryAttempt(targetReviewer, `POST /api/pr-flows/${flow.id}/reviews`).options,
    ).toEqual({ automationKey: `pr-flow:${flow.id}` });
    expect(flow.status).toBe("target_review_collecting");
    expect(targetReviewer.sent.at(-1)).toContain("\"stage\": \"target_merge\"");
    expect(targetReviewer.sent.at(-1)).toContain("- specified src/a.ts");
    expect(targetReviewer.sent.at(-1)).toContain("would interfere with the part you are currently working on");
    expect(targetReviewer.sent.at(-1)).toContain("unfinished experiments");
    expect(targetReviewer.sent.at(-1)).toContain(`POST /api/pr-flows/${flow.id}/reviews`);
    expect(targetReviewer.sent.at(-1)).toContain("\"agentId\": \"agent_2\"");
    expect(targetReviewer.sent.at(-1)).toContain("read-only freeze remains in force");
    expect(extractPromptToken(targetReviewer.sent.at(-1)!, "reviewToken")).toBeTruthy();

    now += 1;
    targetReviewer.setStatus("waiting_input");
    host.assistant("agent_2", reviewJson(flow, "target_merge", "approve"), now);
    await manager.handleAgentEvent(host.result("agent_2", now));

    flow = await waitForFlow(
      manager,
      flow.id,
      (candidate) => candidate.status === "merge_authorized",
    );
    await waitForDelivery(proposer, `/api/pr-flows/${flow.id}/merged`);
    expect(findDeliveryAttempt(proposer, `/api/pr-flows/${flow.id}/merged`).options).toEqual({
      automationKey: `pr-flow:${flow.id}`,
    });
    expect(flow.status).toBe("merge_authorized");
    expect(proposer.sent.at(-1)).toContain("authorized to merge the PR");
    expect(proposer.sent.at(-1)).toContain(`POST /api/pr-flows/${flow.id}/merged`);
    expect(proposer.sent.at(-1)).toContain("only to merge this exact, already-reviewed PR");
    expect(proposer.sent.at(-1)).toContain("Do not edit files");
    expect(proposer.sent.at(-1)).toContain("create new source-branch or workspace commits");
    expect(proposer.sent.at(-1)).toContain("push, sync/rewrite branches");
    expect(proposer.sent.at(-1)).toContain("continue the task you were doing in the same reply");
    expect(extractPromptToken(proposer.sent.at(-1)!, "completionToken")).toBeTruthy();
  });

  it("accepts direct review callbacks without result events and deduplicates retries", async () => {
    let now = 1250;
    const host = new FakeHost();
    const proposer = host.addAgent("agent_1", "feature/a", "waiting_input");
    const targetReviewer = host.addAgent("agent_2", "main", "waiting_input");
    const manager = new PullRequestFlowManager({ host, now: () => now });

    let flow = await manager.create({
      proposerAgentId: "agent_1",
      targetBranch: "main",
      summary: "Submit review through REST",
      files: ["src/direct.ts"],
    });
    flow = await waitForFlow(
      manager,
      flow.id,
      (candidate) => candidate.status === "source_review_collecting",
    );
    await waitForDelivery(proposer, `POST /api/pr-flows/${flow.id}/reviews`);
    const sourceReviewToken = extractPromptToken(proposer.sent[0]!, "reviewToken");
    const submission: SubmitPullRequestReviewInput = {
      agentId: "agent_1",
      reviewToken: sourceReviewToken,
      stage: "source_preflight",
      decision: "approve",
      summary: "Source preflight is safe",
      risks: [],
      filesReviewed: ["src/direct.ts"],
      requiredChanges: [],
    };

    now += 1;
    proposer.setStatus("waiting_input");
    flow = await manager.submitReview(flow.id, submission);

    expect(flow.status).toBe("source_review_collecting");
    flow = await waitForFlow(
      manager,
      flow.id,
      (candidate) => candidate.status === "create_pr_authorized",
    );
    await waitForDelivery(proposer, `/api/pr-flows/${flow.id}/pr-created`);
    expect(flow.status).toBe("create_pr_authorized");
    expect(flow.reviewRequests[0]?.responses).toHaveLength(1);
    expect(flow.reviewRequests[0]?.responses[0]).toMatchObject({
      agentId: submission.agentId,
      stage: submission.stage,
      decision: submission.decision,
      summary: submission.summary,
    });
    expect(JSON.stringify(flow)).not.toContain(sourceReviewToken);
    expect(host.historyOf("agent_1")).toEqual([]);
    expect(host.seq).toBe(0);

    const deliveriesAfterApproval = proposer.sent.length + proposer.steered.length;
    const responseAfterApproval = flow.reviewRequests[0]?.responses[0];
    const duplicate = await manager.submitReview(flow.id, submission);

    expect(duplicate.status).toBe("create_pr_authorized");
    expect(duplicate.reviewRequests[0]?.responses).toEqual([responseAfterApproval]);
    expect(proposer.sent.length + proposer.steered.length).toBe(deliveriesAfterApproval);

    await expect(
      manager.submitReview(flow.id, {
        ...submission,
        summary: "Conflicting replacement review",
      }),
    ).rejects.toThrow("conflicting PR review submission");

    const createPrompt = findDelivery(proposer, `/api/pr-flows/${flow.id}/pr-created`);
    const createCompletionToken = extractPromptToken(createPrompt, "completionToken");
    expect(JSON.stringify(flow)).not.toContain(createCompletionToken);
    await expect(
      manager.submitPrCreated(flow.id, {
        agentId: "agent_2",
        completionToken: createCompletionToken,
        prNumber: 24,
      }),
    ).rejects.toThrow("invalid or expired PR pr_created completionToken");

    const prCreatedSubmission = {
      agentId: "agent_1",
      completionToken: createCompletionToken,
      prNumber: 24,
      prUrl: "https://github.com/acme/demo/pull/24",
    };
    flow = await manager.submitPrCreated(flow.id, prCreatedSubmission);
    expect(flow.status).toBe("queued");
    expect((await manager.submitPrCreated(flow.id, prCreatedSubmission)).id).toBe(flow.id);
    await expect(
      manager.submitPrCreated(flow.id, { ...prCreatedSubmission, prNumber: 25 }),
    ).rejects.toThrow("conflicting PR pr_created completion submission");
    flow = await waitForFlow(
      manager,
      flow.id,
      (candidate) => candidate.status === "target_review_collecting",
    );
    await waitForDelivery(targetReviewer, `POST /api/pr-flows/${flow.id}/reviews`);
    const targetReviewToken = extractPromptToken(
      targetReviewer.sent.at(-1)!,
      "reviewToken",
    );

    now += 1;
    targetReviewer.setStatus("waiting_input");
    flow = await manager.submitReview(flow.id, {
      agentId: "agent_2",
      reviewToken: targetReviewToken,
      stage: "target_merge",
      decision: "approve",
      summary: "Target merge is safe",
      filesReviewed: ["src/direct.ts"],
    });

    expect(flow.status).toBe("target_review_collecting");
    flow = await waitForFlow(
      manager,
      flow.id,
      (candidate) => candidate.status === "merge_authorized",
    );
    await waitForDelivery(proposer, `/api/pr-flows/${flow.id}/merged`);
    expect(flow.status).toBe("merge_authorized");
    expect(flow.reviewRequests[1]?.responses[0]).toMatchObject({
      agentId: "agent_2",
      stage: "target_merge",
      decision: "approve",
    });
    expect(host.historyOf("agent_2")).toEqual([]);
    expect(host.seq).toBe(0);

    const mergePrompt = findDelivery(proposer, `/api/pr-flows/${flow.id}/merged`);
    const mergeCompletionToken = extractPromptToken(mergePrompt, "completionToken");
    expect(mergeCompletionToken).not.toBe(createCompletionToken);
    expect(() =>
      manager.submitMerged(flow.id, {
        agentId: "agent_1",
        completionToken: createCompletionToken,
      }),
    ).toThrow("invalid or expired PR merged completionToken");

    targetReviewer.setStatus("stopped");
    flow = manager.submitMerged(flow.id, {
      agentId: "agent_1",
      completionToken: mergeCompletionToken,
    });
    expect(flow.status).toBe("merged");
    expect(
      manager.submitMerged(flow.id, {
        agentId: "agent_1",
        completionToken: mergeCompletionToken,
      }),
    ).toBe(flow);
    expect(await waitForDelivery(proposer, "PR flow closed")).toContain("status: merged");
    await expect(manager.submitReview(flow.id, submission)).rejects.toThrow(
      "invalid or expired PR reviewToken",
    );
  });

  it("binds direct review capabilities to request, stage, and reviewer", async () => {
    const host = new FakeHost();
    const reviewerOne = host.addAgent("agent_1", "feature/a", "waiting_input");
    const reviewerTwo = host.addAgent("agent_2", "feature/a", "waiting_input");
    host.addAgent("agent_3", "main", "waiting_input");
    const manager = new PullRequestFlowManager({ host });
    let flow = await manager.create({
      proposerAgentId: "agent_1",
      targetBranch: "main",
      summary: "Validate direct reviews",
      files: ["src/validate.ts"],
    });
    flow = await waitForFlow(
      manager,
      flow.id,
      (candidate) => candidate.status === "source_review_collecting",
    );
    await waitForDelivery(reviewerOne, `POST /api/pr-flows/${flow.id}/reviews`);
    await waitForDelivery(reviewerTwo, `POST /api/pr-flows/${flow.id}/reviews`);
    const tokenOne = extractPromptToken(reviewerOne.sent[0]!, "reviewToken");
    const tokenTwo = extractPromptToken(reviewerTwo.sent[0]!, "reviewToken");
    expect(tokenOne).not.toBe(tokenTwo);
    expect(JSON.stringify(manager.exportState())).not.toContain(tokenOne);
    expect(JSON.stringify(manager.exportState())).not.toContain(tokenTwo);

    await expect(
      manager.submitReview(flow.id, {
        agentId: "agent_1",
        reviewToken: tokenOne,
        stage: "target_merge",
        decision: "approve",
        summary: "Wrong stage",
      }),
    ).rejects.toThrow("invalid or expired PR reviewToken");

    await expect(
      manager.submitReview(flow.id, {
        agentId: "agent_2",
        reviewToken: tokenOne,
        stage: "source_preflight",
        decision: "approve",
        summary: "Forged reviewer",
      }),
    ).rejects.toThrow("invalid or expired PR reviewToken");

    await expect(
      manager.submitReview(flow.id, {
        agentId: "agent_3",
        reviewToken: tokenOne,
        stage: "source_preflight",
        decision: "approve",
        summary: "Unrequested reviewer",
      }),
    ).rejects.toThrow("invalid or expired PR reviewToken");

    await expect(
      manager.submitReview(flow.id, {
        agentId: "agent_1",
        reviewToken: tokenOne,
        stage: "source_preflight",
        decision: "invalid" as never,
        summary: "Invalid decision",
      }),
    ).rejects.toThrow("invalid PR review decision");

    await expect(
      manager.submitReview(flow.id, {
        agentId: "agent_1",
        reviewToken: tokenOne,
        stage: "source_preflight",
        decision: "approve",
        summary: "   ",
      }),
    ).rejects.toThrow("missing PR review summary");

    await expect(
      manager.submitReview(flow.id, {
        agentId: "agent_1",
        reviewToken: "",
        stage: "source_preflight",
        decision: "approve",
        summary: "Missing token",
      }),
    ).rejects.toThrow("missing PR reviewToken");

    expect(manager.get(flow.id)?.reviewRequests[0]?.pendingAgentIds).toEqual([
      "agent_1",
      "agent_2",
    ]);
  });

  it("returns from the final direct review while authorization delivery is blocked", async () => {
    const host = new FakeHost();
    const proposer = host.addAgent("agent_1", "feature/auth-background", "waiting_input");
    const manager = new PullRequestFlowManager({ host });
    let flow = await manager.create({
      proposerAgentId: "agent_1",
      targetBranch: "main",
      summary: "Authorize in background",
      files: ["src/auth-background.ts"],
    });
    flow = await waitForFlow(
      manager,
      flow.id,
      (candidate) => candidate.status === "source_review_collecting",
    );
    const reviewPrompt = await waitForDelivery(
      proposer,
      `POST /api/pr-flows/${flow.id}/reviews`,
    );
    await waitUntil(() => !manager.hasPendingOperations());

    const blockedAuthorization = deferred();
    proposer.blockNextSteerUntil(blockedAuthorization.promise);
    const returned = await manager.submitReview(flow.id, {
      agentId: "agent_1",
      reviewToken: extractPromptToken(reviewPrompt, "reviewToken"),
      stage: "source_preflight",
      decision: "approve",
      summary: "Approved while authorization delivery blocks",
    });

    expect(returned.status).toBe("source_review_collecting");
    expect(manager.hasPendingOperations()).toBe(true);
    await waitUntil(() => proposer.steered.length === 1);

    blockedAuthorization.resolve();
    await waitUntil(() => !manager.hasPendingOperations());
    flow = await waitForFlow(
      manager,
      flow.id,
      (candidate) => candidate.status === "create_pr_authorized",
    );
    expect(await waitForDelivery(proposer, `/api/pr-flows/${flow.id}/pr-created`)).toContain(
      "authorization granted",
    );
  });

  it("keeps a flow cancelled when its final direct review finishes in the background", async () => {
    const host = new FakeHost();
    const proposer = host.addAgent("agent_1", "feature/cancel-race", "waiting_input");
    const manager = new PullRequestFlowManager({ host });
    let flow = await manager.create({
      proposerAgentId: "agent_1",
      targetBranch: "main",
      summary: "Cancel while final review finishes",
      files: ["src/cancel-race.ts"],
    });
    flow = await waitForFlow(
      manager,
      flow.id,
      (candidate) => candidate.status === "source_review_collecting",
    );
    const reviewPrompt = await waitForDelivery(
      proposer,
      `POST /api/pr-flows/${flow.id}/reviews`,
    );
    await waitUntil(() => !manager.hasPendingOperations());

    const reviewResult = manager.submitReview(flow.id, {
      agentId: "agent_1",
      reviewToken: extractPromptToken(reviewPrompt, "reviewToken"),
      stage: "source_preflight",
      decision: "approve",
      summary: "Approved immediately before cancellation",
    });
    expect(manager.hasPendingOperations()).toBe(true);

    const cancelled = manager.cancel(flow.id);
    expect(cancelled.status).toBe("cancelled");
    expect((await reviewResult).status).toBe("source_review_collecting");

    await waitUntil(() => !manager.hasPendingOperations());
    expect(manager.get(flow.id)?.status).toBe("cancelled");
    expect(hasDelivery(proposer, `/api/pr-flows/${flow.id}/pr-created`)).toBe(false);
    expect(await waitForDelivery(proposer, "PR flow closed")).toContain(
      `flowId: ${flow.id}`,
    );
  });

  it("releases the queued proposer when a flow closes before any review request", async () => {
    const host = new FakeHost();
    host.addAgent("agent_1", "feature/a", "waiting_input");
    const queuedProposer = host.addAgent("agent_2", "feature/a", "waiting_input");
    const manager = new PullRequestFlowManager({ host });
    const active = await manager.create({
      proposerAgentId: "agent_1",
      targetBranch: "main",
      summary: "Hold source review slot",
      files: ["src/active.ts"],
    });
    await waitForFlow(
      manager,
      active.id,
      (candidate) => candidate.status === "source_review_collecting",
    );
    const queued = await manager.create({
      proposerAgentId: "agent_2",
      targetBranch: "main",
      summary: "Cancel before review starts",
      files: ["src/queued.ts"],
    });

    expect(queued.status).toBe("queued");
    expect(queued.reviewRequests).toEqual([]);
    const cancelled = manager.cancel(queued.id);

    expect(cancelled.status).toBe("cancelled");
    expect(manager.get(active.id)?.status).toBe("source_review_collecting");
    const release = await waitForDelivery(queuedProposer, "PR flow closed");
    expect(release).toContain(`flowId: ${queued.id}`);
    expect(release).toContain("other active PR or sync flow");
  });

  it("retries failed keyed closure releases, deduplicates success, and forgets delivery state", async () => {
    const host = new FakeHost();
    const proposer = host.addAgent("agent_1", "feature/release-retry", "waiting_input");
    const manager = new PullRequestFlowManager({ host });
    const created = await manager.create({
      proposerAgentId: "agent_1",
      targetBranch: "main",
      summary: "Retry the closure release",
      files: ["src/release-retry.ts"],
    });
    const flow = await waitForFlow(
      manager,
      created.id,
      (candidate) => candidate.status === "source_review_collecting",
    );
    await waitForDelivery(proposer, `POST /api/pr-flows/${flow.id}/reviews`);
    await waitUntil(() => !manager.hasPendingOperations());

    proposer.setStatus("stopped");
    manager.cancel(flow.id);
    await waitUntil(() => !manager.hasPendingOperations());

    const releaseText = `flowId: ${flow.id}`;
    const releaseAttempts = () =>
      proposer.deliveries.filter(
        (delivery) => delivery.text.includes("PR flow closed") && delivery.text.includes(releaseText),
      );
    expect(releaseAttempts()).toHaveLength(1);
    expect(releaseAttempts()[0]?.options).toEqual({
      automationKey: `pr-flow:${flow.id}`,
      replaceQueued: true,
    });
    expect(hasDelivery(proposer, "PR flow closed")).toBe(false);

    proposer.setStatus("waiting_input");
    await manager.retryClosureReleasesForAgent("agent_1");
    expect(releaseAttempts()).toHaveLength(2);
    expect(await waitForDelivery(proposer, "PR flow closed")).toContain(releaseText);

    await manager.retryClosureReleasesForAgent("agent_1");
    expect(releaseAttempts()).toHaveLength(2);

    manager.forgetClosureReleasesForAgent("agent_1");
    proposer.setStatus("waiting_input");
    await manager.retryClosureReleasesForAgent("agent_1");
    expect(releaseAttempts()).toHaveLength(3);
    expect(releaseAttempts()[2]?.options).toEqual({
      automationKey: `pr-flow:${flow.id}`,
      replaceQueued: true,
    });

    manager.importState(manager.exportState());
    proposer.setStatus("waiting_input");
    await manager.retryClosureReleasesForAgent("agent_1");
    expect(releaseAttempts()).toHaveLength(4);
  });

  it("reissues a private completion capability for restored authorization", async () => {
    let now = 1400;
    const host = new FakeHost();
    const proposer = host.addAgent("agent_1", "feature/a", "waiting_input");
    const manager = new PullRequestFlowManager({ host, now: () => now });
    let flow = await manager.create({
      proposerAgentId: "agent_1",
      targetBranch: "main",
      summary: "Restore create authorization",
      files: ["src/restore-auth.ts"],
    });
    flow = await waitForFlow(
      manager,
      flow.id,
      (candidate) => candidate.status === "source_review_collecting",
    );
    await waitForDelivery(proposer, `POST /api/pr-flows/${flow.id}/reviews`);

    now += 1;
    proposer.setStatus("waiting_input");
    host.assistant("agent_1", reviewJson(flow, "source_preflight", "approve"), now);
    await manager.handleAgentEvent(host.result("agent_1", now));
    flow = await waitForFlow(
      manager,
      flow.id,
      (candidate) => candidate.status === "create_pr_authorized",
    );
    const authorizationPath = `/api/pr-flows/${flow.id}/pr-created`;
    const oldPrompt = await waitForDelivery(proposer, authorizationPath);
    const oldToken = extractPromptToken(oldPrompt, "completionToken");
    const oldDeliveryCount = [...proposer.sent, ...proposer.steered].filter((text) =>
      text.includes(authorizationPath),
    ).length;
    const persisted = manager.exportState();

    proposer.setStatus("waiting_input");
    manager.importState(persisted, { deferActivation: true });
    expect(JSON.stringify(manager.exportState())).not.toContain(oldToken);
    manager.activateImportedState();
    await waitUntil(
      () =>
        [...proposer.sent, ...proposer.steered].filter((text) =>
          text.includes(authorizationPath),
        ).length > oldDeliveryCount,
    );

    const restoredPrompt = findDelivery(proposer, authorizationPath);
    const restoredToken = extractPromptToken(restoredPrompt, "completionToken");
    expect(restoredToken).not.toBe(oldToken);
    await expect(
      manager.submitPrCreated(flow.id, {
        agentId: "agent_1",
        completionToken: oldToken,
        prNumber: 31,
      }),
    ).rejects.toThrow("invalid or expired PR pr_created completionToken");

    const next = await manager.submitPrCreated(flow.id, {
      agentId: "agent_1",
      completionToken: restoredToken,
      prNumber: 31,
    });
    expect(next).toMatchObject({ status: "queued", currentStage: "target_merge" });
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
    flow = await waitForFlow(
      manager,
      flow.id,
      (candidate) => candidate.status === "source_review_collecting",
    );
    await waitForDelivery(proposer, `POST /api/pr-flows/${flow.id}/reviews`);

    now += 1;
    proposer.setStatus("waiting_input");
    host.assistant("agent_1", reviewJson(flow, "source_preflight", "approve"), now);
    await manager.handleAgentEvent(host.result("agent_1", now));
    flow = await waitForFlow(
      manager,
      flow.id,
      (candidate) => candidate.status === "create_pr_authorized",
    );
    expect(flow.status).toBe("create_pr_authorized");

    flow = await manager.recordPrCreated(flow.id, { prNumber: 13 });

    expect(flow).toMatchObject({
      status: "queued",
      currentStage: "target_merge",
    });
    flow = await waitForFlow(
      manager,
      flow.id,
      (candidate) => candidate.failureReason?.includes("waiting for an active reviewer") === true,
    );
    expect(flow.failureReason).toContain("waiting for an active reviewer on branch main");
    expect(flow.reviewRequests).toHaveLength(1);
    expect(flow.reviewRequests[0]?.stage).toBe("source_preflight");
    await waitUntil(() => !manager.hasPendingOperations());

    const idleReviewer = host.addAgent("agent_3", "main", "idle");
    const laterIdleReviewer = host.addAgent("agent_4", "main", "idle");
    await manager.getReviewQueue().retryBranch("main");

    flow = await waitForFlow(
      manager,
      flow.id,
      (candidate) => candidate.status === "target_review_collecting",
    );
    await waitUntil(() => idleReviewer.started.length > 0);
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

  it("uses natural agent id order to choose between equally old idle target reviewers", async () => {
    let now = 1650;
    const host = new FakeHost();
    const proposer = host.addAgent("agent_1", "feature/a", "waiting_input");
    const agent10 = host.addAgent("agent_10", "main", "idle", 100);
    const agent9 = host.addAgent("agent_9", "main", "idle", 100);
    const manager = new PullRequestFlowManager({ host, now: () => now });

    let flow = await manager.create({
      proposerAgentId: "agent_1",
      targetBranch: "main",
      summary: "Choose a stable idle target reviewer",
      files: ["src/a.ts"],
    });
    flow = await waitForFlow(
      manager,
      flow.id,
      (candidate) => candidate.status === "source_review_collecting",
    );
    await waitForDelivery(proposer, `POST /api/pr-flows/${flow.id}/reviews`);

    now += 1;
    proposer.setStatus("waiting_input");
    host.assistant("agent_1", reviewJson(flow, "source_preflight", "approve"), now);
    await manager.handleAgentEvent(host.result("agent_1", now));
    flow = await waitForFlow(
      manager,
      flow.id,
      (candidate) => candidate.status === "create_pr_authorized",
    );
    flow = await manager.recordPrCreated(flow.id, { prNumber: 15 });
    flow = await waitForFlow(
      manager,
      flow.id,
      (candidate) => candidate.status === "target_review_collecting",
    );
    await waitUntil(() => agent9.started.length > 0);

    expect(flow.status).toBe("target_review_collecting");
    expect(flow.reviewRequests.at(-1)?.requestedAgentIds).toEqual(["agent_9"]);
    expect(agent9.started.at(-1)).toContain('"stage": "target_merge"');
    expect(agent10.started).toEqual([]);
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
    flow = await waitForFlow(
      manager,
      flow.id,
      (candidate) => candidate.status === "source_review_collecting",
    );
    await waitForDelivery(proposer, `POST /api/pr-flows/${flow.id}/reviews`);

    now += 1;
    proposer.setStatus("waiting_input");
    host.assistant("agent_1", reviewJson(flow, "source_preflight", "approve"), now);
    await manager.handleAgentEvent(host.result("agent_1", now));
    flow = await waitForFlow(
      manager,
      flow.id,
      (candidate) => candidate.status === "create_pr_authorized",
    );
    flow = await manager.recordPrCreated(flow.id, { prNumber: 14 });
    flow = await waitForFlow(
      manager,
      flow.id,
      (candidate) => candidate.status === "target_review_collecting",
    );
    await waitForDelivery(activeReviewer, `POST /api/pr-flows/${flow.id}/reviews`);

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

    let flow = await manager.create({
      proposerAgentId: "agent_1",
      targetBranch: "main",
      summary: "Needs review",
      files: ["src/retry.ts"],
    });
    flow = await waitForFlow(
      manager,
      flow.id,
      (candidate) => candidate.status === "source_review_collecting",
    );
    await waitForDelivery(proposer, `POST /api/pr-flows/${flow.id}/reviews`);

    now += 1;
    proposer.setStatus("waiting_input");
    host.assistant("agent_1", "not json", now);
    await manager.handleAgentEvent(host.result("agent_1", now));
    const retryPrompt = await waitForDelivery(
      proposer,
      "previous PR review response was not valid JSON",
    );
    expect(retryPrompt).toContain(`POST /api/pr-flows/${flow.id}/reviews`);
    expect(retryPrompt).toContain("READ-ONLY FLOW FREEZE");
    expect(retryPrompt).toContain("do not end your reply");
    expect(extractPromptToken(retryPrompt, "reviewToken")).toBe(
      extractPromptToken(proposer.sent[0]!, "reviewToken"),
    );

    now += 1;
    proposer.setStatus("waiting_input");
    host.assistant("agent_1", "still not json", now);
    await manager.handleAgentEvent(host.result("agent_1", now));

    const next = await waitForFlow(
      manager,
      flow.id,
      (candidate) => candidate.status === "source_review_failed",
    );
    expect(next.status).toBe("source_review_failed");
    expect(next.reviewRequests[0]!.responses[0]).toMatchObject({
      agentId: "agent_1",
      decision: "blocked",
    });
    await waitUntil(() => !manager.hasPendingOperations());
    const failureRelease = proposer.deliveries.find(
      (delivery) =>
        delivery.text.includes("PR source preflight failed") &&
        delivery.text.includes(`flowId: ${flow.id}`),
    );
    expect(failureRelease?.text).toContain(
      "Review response did not match the required JSON schema after retry.",
    );
    expect(failureRelease?.text).toContain("another active PR or sync flow");
    expect(failureRelease?.options).toEqual({
      automationKey: `pr-flow:${flow.id}`,
      replaceQueued: true,
    });
  });

  it("ignores an old turn result while its review prompt is only queued", async () => {
    let now = 2500;
    const host = new FakeHost();
    const proposer = host.addAgent("agent_1", "feature/a", "waiting_input");
    const manager = new PullRequestFlowManager({
      host,
      now: () => now,
      reviewRetryLimit: 1,
    });
    let flow = await manager.create({
      proposerAgentId: "agent_1",
      targetBranch: "main",
      summary: "Queue review behind old turn",
      files: ["src/queued-review.ts"],
    });
    flow = await waitForFlow(
      manager,
      flow.id,
      (candidate) => candidate.status === "source_review_collecting",
    );
    const prompt = await waitForDelivery(
      proposer,
      `POST /api/pr-flows/${flow.id}/reviews`,
    );

    now += 1;
    host.userInput("agent_1", prompt, now, "queued");
    host.assistant("agent_1", "Finished the work that preceded the queued review.", now);
    await manager.handleAgentEvent(host.result("agent_1", now));

    flow = manager.get(flow.id)!;
    expect(flow.status).toBe("source_review_collecting");
    expect(flow.reviewRequests[0]?.pendingAgentIds).toEqual(["agent_1"]);
    expect(flow.reviewRequests[0]?.retryCounts.agent_1).toBe(0);
    expect(flow.reviewRequests[0]?.responses).toEqual([]);
    expect(proposer.sent).toHaveLength(1);

    now += 1;
    host.userInput("agent_1", prompt, now);
    host.assistant("agent_1", reviewJson(flow, "source_preflight", "approve"), now);
    await manager.handleAgentEvent(host.result("agent_1", now));

    flow = await waitForFlow(
      manager,
      flow.id,
      (candidate) => candidate.status === "create_pr_authorized",
    );
    expect(flow.reviewRequests[0]?.retryCounts.agent_1).toBe(0);
  });

  it("times out when reviewers do not all respond", async () => {
    vi.useFakeTimers();
    let now = 0;
    const host = new FakeHost();
    const proposer = host.addAgent("agent_1", "feature/a", "waiting_input");
    const manager = new PullRequestFlowManager({
      host,
      now: () => now,
      reviewTimeoutMs: 10,
    });

    let flow = await manager.create({
      proposerAgentId: "agent_1",
      targetBranch: "main",
      summary: "Timeout flow",
      files: ["src/timeout.ts"],
    });
    flow = await waitForFlow(
      manager,
      flow.id,
      (candidate) => candidate.status === "source_review_collecting",
    );
    await waitForDelivery(proposer, `POST /api/pr-flows/${flow.id}/reviews`);
    await waitUntil(() => !manager.hasPendingOperations());
    const reviewToken = extractPromptToken(proposer.sent[0]!, "reviewToken");
    now = 11;
    vi.advanceTimersByTime(11);

    expect(manager.get(flow.id)?.status).toBe("timed_out");
    expect(await waitForDelivery(proposer, "PR flow closed")).toContain("status: timed_out");
    await expect(
      manager.submitReview(flow.id, {
        agentId: "agent_1",
        reviewToken,
        stage: "source_preflight",
        decision: "approve",
        summary: "Too late",
      }),
    ).rejects.toThrow("invalid or expired PR reviewToken");
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
    await waitUntil(() => callbacks.length > 0);
    const staleCallback = callbacks[0]!;

    manager.importState(undefined);
    now = 11;
    staleCallback();
    await waitUntil(() => !manager.hasPendingOperations());

    expect(manager.list()).toEqual([]);
    expect(manager.hasPendingOperations()).toBe(false);
  });

  it("uses a two hour default timeout for PR reviews", async () => {
    let now = 5000;
    const host = new FakeHost();
    host.addAgent("agent_1", "feature/a", "waiting_input");
    const manager = new PullRequestFlowManager({ host, now: () => now });

    let flow = await manager.create({
      proposerAgentId: "agent_1",
      targetBranch: "main",
      summary: "Default timeout",
      files: ["src/default-timeout.ts"],
    });
    flow = await waitForFlow(
      manager,
      flow.id,
      (candidate) => candidate.deadlineAt !== undefined,
    );

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

    let first = await manager.create({
      proposerAgentId: "agent_1",
      targetBranch: "main",
      summary: "First PR",
      files: ["src/a.ts"],
    });
    first = await waitForFlow(
      manager,
      first.id,
      (candidate) => candidate.status === "source_review_collecting",
    );
    await waitForDelivery(proposer, `POST /api/pr-flows/${first.id}/reviews`);
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
    await waitForFlow(
      manager,
      first.id,
      (candidate) => candidate.status === "create_pr_authorized",
    );
    await waitForFlow(
      manager,
      second.id,
      (candidate) => candidate.status === "source_review_collecting",
    );
    await waitForDelivery(proposer, `flowId: ${second.id}`);

    expect(manager.get(first.id)?.status).toBe("create_pr_authorized");
    expect(manager.get(second.id)?.status).toBe("source_review_collecting");
    expect(manager.get(second.id)?.reviewRequests).toHaveLength(1);
    expect(proposer.steered).toHaveLength(1);
    expect(proposer.steered[0]).toContain(`flowId: ${second.id}`);
  });

  it("returns queued while a blocked review delivery continues in the background", async () => {
    const host = new FakeHost();
    const proposer = host.addAgent("agent_1", "feature/background", "running");
    const blockedDelivery = deferred();
    proposer.blockNextSteerUntil(blockedDelivery.promise);
    const manager = new PullRequestFlowManager({ host });

    const created = await manager.create({
      proposerAgentId: "agent_1",
      targetBranch: "main",
      summary: "Return before review delivery settles",
      files: ["src/background.ts"],
    });

    expect(created.status).toBe("queued");
    expect(manager.hasPendingOperations()).toBe(true);
    await waitUntil(() => proposer.steered.length === 1);
    expect(manager.get(created.id)?.status).toBe("source_review_collecting");

    blockedDelivery.resolve();
    await waitUntil(() => !manager.hasPendingOperations());
    expect(manager.get(created.id)?.status).toBe("source_review_collecting");
  });

  it("keeps the branch reserved when a cancelled PR still has a blocked review delivery", async () => {
    const host = new FakeHost();
    const proposer = host.addAgent("agent_1", "feature/shared", "running");
    const blockedDelivery = deferred();
    proposer.blockNextSteerUntil(blockedDelivery.promise);
    const manager = new PullRequestFlowManager({ host });

    let first = await manager.create({
      proposerAgentId: "agent_1",
      targetBranch: "main",
      summary: "Blocked first PR",
      files: ["src/first.ts"],
    });
    expect(first.status).toBe("queued");
    expect(manager.hasPendingOperations()).toBe(true);
    await waitUntil(() => proposer.steered.length === 1);
    const firstId = first.id;
    let second = await manager.create({
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
    await waitUntil(() => manager.get(second.id)?.status === "source_review_collecting");
    await waitForDelivery(proposer, "PR flow closed");
    await waitForDelivery(proposer, `flowId: ${second.id}`);

    expect(proposer.steered).toHaveLength(3);
    expect(findDelivery(proposer, `flowId: ${second.id}`)).toContain("PR review request");
    expect(findDelivery(proposer, "PR flow closed")).toContain(`flowId: ${firstId}`);
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

    let first = await manager.create({
      proposerAgentId: "agent_1",
      targetBranch: "main",
      summary: "Blocked timeout PR",
      files: ["src/first.ts"],
    });
    expect(first.status).toBe("queued");
    expect(manager.hasPendingOperations()).toBe(true);
    await waitUntil(() => proposer.steered.length === 1);
    const firstId = first.id;
    let second = await manager.create({
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
    await waitUntil(() => manager.get(second.id)?.status === "source_review_collecting");
    await waitForDelivery(proposer, "PR flow closed");
    await waitForDelivery(proposer, `flowId: ${second.id}`);

    expect(proposer.steered).toHaveLength(3);
    expect(findDelivery(proposer, `flowId: ${second.id}`)).toContain("PR review request");
    expect(findDelivery(proposer, "PR flow closed")).toContain(`flowId: ${firstId}`);
    expect(proposer.maxConcurrentSteers).toBe(1);
  });

  it("runs source reviews on different branches in parallel and queues their target reviews", async () => {
    let now = 6250;
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
    let second = await manager.create({
      proposerAgentId: "agent_b",
      targetBranch: "main",
      summary: "Second PR",
      files: ["src/b.ts"],
    });

    first = await waitForFlow(
      manager,
      first.id,
      (candidate) => candidate.status === "source_review_collecting",
    );
    second = await waitForFlow(
      manager,
      second.id,
      (candidate) => candidate.status === "source_review_collecting",
    );
    await waitForDelivery(proposerA, `POST /api/pr-flows/${first.id}/reviews`);
    await waitForDelivery(proposerB, `POST /api/pr-flows/${second.id}/reviews`);

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

    await waitForFlow(
      manager,
      first.id,
      (candidate) => candidate.status === "create_pr_authorized",
    );
    await waitForFlow(
      manager,
      second.id,
      (candidate) => candidate.status === "create_pr_authorized",
    );

    await manager.recordPrCreated(first.id, { prNumber: 1 });
    await manager.recordPrCreated(second.id, { prNumber: 2 });

    await waitForFlow(
      manager,
      first.id,
      (candidate) => candidate.status === "target_review_collecting",
    );
    await waitForDelivery(targetReviewer, `flowId: ${first.id}`);

    expect(manager.get(first.id)?.status).toBe("target_review_collecting");
    expect(manager.get(second.id)).toMatchObject({ status: "queued", currentStage: "target_merge" });
    expect(targetReviewer.sent).toHaveLength(1);

    now += 1;
    targetReviewer.setStatus("waiting_input");
    host.assistant("agent_main", reviewJson(manager.get(first.id)!, "target_merge", "approve"), now);
    await manager.handleAgentEvent(host.result("agent_main", now));
    await waitForFlow(
      manager,
      first.id,
      (candidate) => candidate.status === "merge_authorized",
    );
    await waitForFlow(
      manager,
      second.id,
      (candidate) => candidate.status === "target_review_collecting",
    );
    await waitForDelivery(targetReviewer, `flowId: ${second.id}`);

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
    const releaseRetryDelivery = deferred();
    proposer.setStatus("running");
    proposer.blockNextSteerUntil(releaseRetryDelivery.promise);
    const retried = await manager.retryQueued(second.id);

    expect(retried.status).toBe("queued");
    await waitUntil(() => manager.get(second.id)?.status === "source_review_collecting");
    expect(manager.hasPendingOperations()).toBe(true);
    releaseRetryDelivery.resolve();
    await flush();

    expect(manager.get(second.id)).toMatchObject({
      status: "source_review_collecting",
      failureReason: undefined,
    });
    expect(manager.hasPendingOperations()).toBe(false);
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
    await waitForFlow(
      original,
      flow.id,
      (candidate) => candidate.status === "source_review_collecting",
    );
    await waitForDelivery(proposer, `POST /api/pr-flows/${flow.id}/reviews`);
    const persisted = original.exportState();
    original.cancel(flow.id);
    await waitForDelivery(proposer, "PR flow closed");
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

    const stale = await staleCreate;
    expect(stale).toMatchObject({
      status: "queued",
      currentStage: "source_preflight",
      summary: "Old project review",
    });

    releaseStaleCheck();
    await waitUntil(() => !manager.hasPendingOperations());
    await waitUntil(() => manager.get(fresh.id)?.status === "source_review_collecting");
    await waitForDelivery(proposer, `flowId: ${fresh.id}`);
    expect(manager.list()).toHaveLength(1);
    expect(manager.get(fresh.id)?.summary).toBe("New project review");
    expect(manager.get(fresh.id)?.status).toBe("source_review_collecting");
    expect(manager.get(fresh.id)?.files).toEqual(["src/new.ts"]);
    expect(findDelivery(proposer, `flowId: ${fresh.id}`)).toContain("src/new.ts");
    expect(findDelivery(proposer, `flowId: ${fresh.id}`)).not.toContain("src/old.ts");
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
    const stale = await staleCreate;
    expect(stale).toMatchObject({
      status: "queued",
      currentStage: "source_preflight",
      summary: "Old project delivery",
    });
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
    await waitUntil(
      () => manager.get(importedFlow.id)?.status === "source_review_collecting",
    );
    await waitUntil(() => !manager.hasPendingOperations());

    expect(manager.get(stale.id)).toBeUndefined();
    expect(manager.list()).toHaveLength(1);
    expect(manager.get(importedFlow.id)?.summary).toBe("Imported project delivery");
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
    await waitForFlow(
      manager,
      flow.id,
      (candidate) => candidate.status === "source_review_collecting",
    );
    await waitForDelivery(proposer, `POST /api/pr-flows/${flow.id}/reviews`);
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

function extractPromptToken(
  prompt: string,
  field: "reviewToken" | "completionToken",
): string {
  const match = prompt.match(new RegExp(`"${field}"\\s*:\\s*"([^"]+)"`, "u"));
  if (!match?.[1]) throw new Error(`missing ${field} in prompt`);
  return match[1];
}

function findDelivery(runner: FakeRunner, text: string): string {
  const delivery = [...runner.sent, ...runner.steered]
    .reverse()
    .find((candidate) => candidate.includes(text));
  if (!delivery) throw new Error(`missing delivery containing ${text}`);
  return delivery;
}
