import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentEventEnvelope,
  AgentSnapshot,
  SyncFlowAppliedInput,
  SyncFlowSnapshot,
} from "@agent-canvas/shared";
import { SyncFlowManager, type SyncFlowAgentHost } from "./SyncFlowManager.js";

interface FakeDeliveryOptions {
  automationKey?: string;
  replaceQueued?: boolean;
}

class FakeRunner {
  readonly sent: string[] = [];
  readonly steered: string[] = [];
  readonly deliveryCalls: Array<{ text: string; options?: FakeDeliveryOptions }> = [];
  private nextSteerBlock?: Promise<void>;
  private deliveryError?: Error;

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

  failDelivery(message: string): void {
    this.deliveryError = new Error(message);
  }

  allowDelivery(): void {
    this.deliveryError = undefined;
  }

  async send(text: string): Promise<void> {
    if (this.deliveryError) throw this.deliveryError;
    this.sent.push(text);
    this.status = "running";
  }

  async steer(text: string): Promise<void> {
    if (this.deliveryError) throw this.deliveryError;
    this.steered.push(text);
    const block = this.nextSteerBlock;
    this.nextSteerBlock = undefined;
    if (block) await block;
  }

  async deliver(text: string, options?: FakeDeliveryOptions): Promise<void> {
    this.deliveryCalls.push({ text, options: options ? { ...options } : undefined });
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

const CAPABILITY_ECHO = "agent_canvas_cap_future-format-secret";

describe("SyncFlowManager", () => {
  it("settles direct send and steer validation failures in the background", async () => {
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

    expect(flow.status).toBe("queued");
    expect(manager.hasPendingOperations()).toBe(true);
    await waitForMicrotasks(() => manager.get(flow.id)?.status === "review_failed");
    await waitForMicrotasks(() => !manager.hasPendingOperations());
    expect(manager.get(flow.id)?.failureReason).toContain("Failed to deliver sync review request");
    expect(waiting.sent).toEqual([]);
    expect(running.steered).toEqual([]);
  });

  it("resolves create while blocked review delivery remains a pending background operation", async () => {
    const host = new FakeHost();
    const proposer = host.addAgent("agent_1", "feature/current", "running");
    const manager = new SyncFlowManager({ host });
    let releaseDelivery!: () => void;
    const deliveryBlock = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    proposer.blockNextSteerUntil(deliveryBlock);

    const flow = await manager.create({
      kind: "branch_pull",
      proposerAgentId: "agent_1",
      sourceBranch: "main",
      summary: "Return before review delivery settles",
      reason: "Keep callback latency independent of downstream agents",
      files: ["src/non-blocking-create.ts"],
    });

    expect(flow.status).toBe("queued");
    expect(manager.hasPendingOperations()).toBe(true);
    await waitForMicrotasks(() => proposer.steered.length === 1);
    releaseDelivery();
    await waitForMicrotasks(() => manager.get(flow.id)?.status === "review_collecting");
    await waitForMicrotasks(() => !manager.hasPendingOperations());
    expect(manager.get(flow.id)?.reviewRequest).toBeDefined();
  });

  it.each(["branch_pull", "cherry_pick"] as const)(
    "canonicalizes reserved-prefix echoes before %s resolution, snapshots, and review prompts",
    async (kind) => {
      const host = new FakeHost();
      const proposer = host.addAgent("agent_1", "feature/current", "waiting_input");
      const observed: SyncFlowSnapshot[] = [];
      const manager = new SyncFlowManager({ host });
      manager.onFlow((flow) => observed.push(flow));
      const common = {
        proposerAgentId: "agent_1",
        title: `title ${CAPABILITY_ECHO}`,
        summary: `summary ${CAPABILITY_ECHO}`,
        reason: `reason ${CAPABILITY_ECHO}`,
        files: [`src/${CAPABILITY_ECHO}`],
      };

      const flow = await manager.create(
        kind === "branch_pull"
          ? {
              ...common,
              kind,
              sourceBranch: `source-${CAPABILITY_ECHO}`,
            }
          : {
              ...common,
              kind,
              sourceBranch: `source-${CAPABILITY_ECHO}`,
              commitSha: `commit-${CAPABILITY_ECHO}`,
            },
      );
      await waitForMicrotasks(() => manager.get(flow.id)?.status === "review_collecting");
      await waitForMicrotasks(() => !manager.hasPendingOperations());

      const stored = manager.get(flow.id)!;
      const exported = manager.exportState();
      expect(exported[0]).not.toBe(stored);
      expect(exported[0]?.reviewRequest).not.toBe(stored.reviewRequest);
      expect(
        JSON.stringify({ flow, stored, listed: manager.list(), exported, observed }),
      ).not.toContain(CAPABILITY_ECHO);
      expect(JSON.stringify(exported)).toContain("[redacted]");
      expect(proposer.sent[0]).not.toContain(CAPABILITY_ECHO);
      expect(proposer.sent[0]).toContain("[redacted]");
      expect(tokenFromPrompt(proposer.sent[0]!, "reviewToken")).toMatch(
        /^agent_canvas_cap_/u,
      );
    },
  );

  it("canonicalizes the proposer branch fallback before changed-file resolution", async () => {
    const host = new FakeHost();
    host.addAgent("agent_1", `feature/${CAPABILITY_ECHO}`, "waiting_input");
    host.addAgent("agent_2", "feature/[redacted]", "waiting_input");
    const resolveChangedFiles = vi.fn(async (input) => {
      expect(input.targetBranch).toBe("feature/[redacted]");
      expect(
        JSON.stringify({
          targetBranch: input.targetBranch,
          sourceBranch: input.sourceBranch,
          files: input.files,
        }),
      ).not.toContain(CAPABILITY_ECHO);
      return [{ status: "M", path: "src/fallback.ts" }];
    });
    const manager = new SyncFlowManager({ host, resolveChangedFiles });

    const flow = await manager.create({
      kind: "branch_pull",
      proposerAgentId: "agent_1",
      sourceBranch: "main",
      summary: "Canonicalize the fallback branch",
      reason: "Do not expose agent configuration through the resolver",
      files: ["src/fallback.ts"],
    });
    await waitForMicrotasks(() => !manager.hasPendingOperations());

    expect(resolveChangedFiles).toHaveBeenCalledOnce();
    expect(flow.targetBranch).toBe("feature/[redacted]");
    expect(JSON.stringify(manager.exportState())).not.toContain(CAPABILITY_ECHO);
  });

  it("submits reviews through intermediate callbacks without waiting for a result event", async () => {
    const host = new FakeHost();
    const proposer = host.addAgent("agent_1", "feature/current", "waiting_input");
    const reviewer = host.addAgent("agent_2", "feature/current", "running");
    const manager = new SyncFlowManager({ host });

    const flow = await manager.create({
      kind: "branch_pull",
      proposerAgentId: "agent_1",
      sourceBranch: "main",
      summary: "Catch up without ending the current reply",
      reason: "Exercise direct review callbacks",
      files: ["src/callback.ts"],
    });
    await waitForMicrotasks(
      () => proposer.sent.length === 1 && reviewer.steered.length === 1,
    );
    await waitForMicrotasks(() => !manager.hasPendingOperations());
    const automationKey = `sync-flow:${flow.id}`;
    expect(proposer.deliveryCalls[0]?.options).toEqual({ automationKey });
    expect(reviewer.deliveryCalls[0]?.options).toEqual({ automationKey });

    expect(proposer.sent[0]).toContain(`POST /api/sync-flows/${flow.id}/reviews`);
    expect(proposer.sent[0]).toContain('"agentId": "agent_1"');
    const proposerReviewToken = tokenFromPrompt(proposer.sent[0]!, "reviewToken");
    const reviewerReviewToken = tokenFromPrompt(reviewer.steered[0]!, "reviewToken");
    expect(proposerReviewToken).not.toBe(reviewerReviewToken);
    expect(proposer.sent[0]).not.toContain(reviewerReviewToken);
    expect(reviewer.steered[0]).not.toContain(proposerReviewToken);
    expect(proposerReviewToken).toMatch(/^agent_canvas_cap_/u);
    expect(proposerReviewToken.length).toBeGreaterThanOrEqual(32);
    expect(proposer.sent[0]).toContain('"decision": "approve"');
    expect(proposer.sent[0]).not.toContain('"decision": "approve | reject');
    expect(proposer.sent[0]).toContain("keep the entire workspace, Git state, and PR state read-only");
    expect(proposer.sent[0]).toContain("intermediate tool call");
    expect(proposer.sent[0]).not.toContain("Return exactly one JSON object");
    expect(reviewer.steered[0]).toContain(
      "Submitting this review callback does not release that freeze",
    );
    expect(JSON.stringify(flow)).not.toContain(proposerReviewToken);
    expect(JSON.stringify(flow)).not.toContain(reviewerReviewToken);

    const firstResponse = await manager.submitReview(flow.id, {
      agentId: "agent_1",
      reviewToken: proposerReviewToken,
      decision: "approve",
      summary: "Proposer approves",
      risks: [],
      filesReviewed: ["src/callback.ts"],
      requiredChanges: [],
    });
    expect(firstResponse.status).toBe("review_collecting");
    expect(host.historyOf("agent_1")).toEqual([]);

    const submitted = await manager.submitReview(flow.id, {
      agentId: "agent_2",
      reviewToken: reviewerReviewToken,
      decision: "approve",
      summary: "Reviewer approves",
      risks: [" low risk ", "low risk"],
      filesReviewed: ["src/callback.ts"],
      requiredChanges: [],
    });

    expect(submitted.status).toBe("review_collecting");
    await waitForMicrotasks(() => manager.get(flow.id)?.status === "apply_authorized");
    await waitForMicrotasks(() => !manager.hasPendingOperations());
    const authorized = manager.get(flow.id)!;
    expect(authorized.reviewRequest?.responses).toHaveLength(2);
    expect(authorized.reviewRequest?.responses[1]?.risks).toEqual(["low risk"]);
    expect(proposer.getStatus()).toBe("running");
    expect(proposer.steered.at(-1)).toContain(`POST /api/sync-flows/${flow.id}/applied`);
    const appliedPrompt = proposer.steered.at(-1) ?? "";
    const callbackToken = tokenFromPrompt(appliedPrompt, "callbackToken");
    expect(
      proposer.deliveryCalls.find((call) => call.text.includes("sync authorization granted"))
        ?.options,
    ).toEqual({ automationKey });
    expect(proposer.steered.at(-1)).toContain(
      "only the proposer a limited write exception",
    );
    expect(proposer.steered.at(-1)).toContain(
      "All participants remain under this flow's read-only freeze",
    );
    expect(proposer.steered.at(-1)).toContain("push the updated target branch as needed");
    expect(proposer.steered.at(-1)).toContain("intermediate tool call");
    expect(proposer.steered.at(-1)).not.toContain("report exactly one JSON object");
    expect(host.historyOf("agent_2")).toEqual([]);

    const appliedSubmission = {
      callbackToken,
      summary: "Applied callback without ending the turn",
      commitSha: "abcdef123456",
      files: ["src/callback.ts"],
    };
    await expect(
      manager.submitApplied(flow.id, { ...appliedSubmission, callbackToken: "wrong-token" }),
    ).rejects.toThrow("invalid or expired sync applied callbackToken");
    expect(manager.get(flow.id)?.status).toBe("apply_authorized");

    const applied = await manager.submitApplied(flow.id, appliedSubmission);
    expect(applied.status).toBe("applied");
    expect(JSON.stringify(applied)).not.toContain(callbackToken);
    expect(await manager.submitApplied(flow.id, appliedSubmission)).toBe(applied);
    await expect(
      manager.submitApplied(flow.id, { ...appliedSubmission, summary: "conflicting retry" }),
    ).rejects.toThrow("already submitted with different data");
    await waitForMicrotasks(() => !manager.hasPendingOperations());
    expect(proposer.steered.at(-1)).toContain("closure/release notice");
    expect(reviewer.steered.at(-1)).toContain("closure/release notice");
    expect(reviewer.steered.at(-1)).toContain("releases only this flow");
    expect(
      proposer.deliveryCalls.find((call) =>
        call.text.startsWith("Agent Canvas sync flow closure/release notice."),
      )?.options,
    ).toEqual({ automationKey, replaceQueued: true });
    expect(
      reviewer.deliveryCalls.find((call) =>
        call.text.startsWith("Agent Canvas sync flow closure/release notice."),
      )?.options,
    ).toEqual({ automationKey, replaceQueued: true });
  });

  it("keeps the direct review capability private while canonicalizing echoed review fields", async () => {
    const host = new FakeHost();
    const proposer = host.addAgent("agent_1", "feature/current", "waiting_input");
    const manager = new SyncFlowManager({ host });
    const flow = await manager.create({
      kind: "branch_pull",
      proposerAgentId: "agent_1",
      sourceBranch: "main",
      summary: "Canonical direct review",
      reason: "Do not reflect private review capabilities",
      files: ["src/direct-review.ts"],
    });
    await waitForMicrotasks(() => manager.get(flow.id)?.status === "review_collecting");
    await waitForMicrotasks(() => !manager.hasPendingOperations());
    const reviewPrompt = proposer.sent[0]!;
    const reviewToken = tokenFromPrompt(reviewPrompt, "reviewToken");

    await manager.submitReview(flow.id, {
      agentId: "agent_1",
      reviewToken,
      decision: "approve",
      summary: `summary ${CAPABILITY_ECHO}`,
      risks: [`risk ${CAPABILITY_ECHO}`],
      filesReviewed: [`src/${CAPABILITY_ECHO}`],
      requiredChanges: [`change ${CAPABILITY_ECHO}`],
    });
    await waitForMicrotasks(() => manager.get(flow.id)?.status === "apply_authorized");
    await waitForMicrotasks(() => !manager.hasPendingOperations());

    const authorized = manager.get(flow.id)!;
    const authorizationPrompt = latestDeliveryContaining(proposer, "sync authorization granted");
    expect(reviewToken).toMatch(/^agent_canvas_cap_/u);
    expect(reviewPrompt).toContain(reviewToken);
    expect(JSON.stringify([authorized, manager.list(), manager.exportState()])).not.toContain(
      CAPABILITY_ECHO,
    );
    expect(authorizationPrompt).not.toContain(CAPABILITY_ECHO);
    expect(authorizationPrompt).toContain("[redacted]");
    expect(tokenFromPrompt(authorizationPrompt, "callbackToken")).toMatch(
      /^agent_canvas_cap_/u,
    );
  });

  it("resolves the final direct review while blocked authorization delivery stays pending", async () => {
    const host = new FakeHost();
    const proposer = host.addAgent("agent_1", "feature/current", "waiting_input");
    const manager = new SyncFlowManager({ host });
    const flow = await manager.create({
      kind: "branch_pull",
      proposerAgentId: "agent_1",
      sourceBranch: "main",
      summary: "Authorize without blocking the callback",
      reason: "Downstream proposer delivery may be slow",
      files: ["src/non-blocking-authorization.ts"],
    });
    await waitForMicrotasks(() => manager.get(flow.id)?.status === "review_collecting");
    await waitForMicrotasks(() => !manager.hasPendingOperations());
    const reviewToken = tokenFromPrompt(proposer.sent[0]!, "reviewToken");
    let releaseDelivery!: () => void;
    const deliveryBlock = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    proposer.blockNextSteerUntil(deliveryBlock);

    const submitted = await manager.submitReview(flow.id, {
      agentId: "agent_1",
      reviewToken,
      decision: "approve",
      summary: "safe to authorize",
    });

    expect(submitted.status).toBe("review_collecting");
    expect(manager.hasPendingOperations()).toBe(true);
    await waitForMicrotasks(() => proposer.steered.length === 1);
    releaseDelivery();
    await waitForMicrotasks(() => manager.get(flow.id)?.status === "apply_authorized");
    await waitForMicrotasks(() => !manager.hasPendingOperations());
    expect(proposer.steered[0]).toContain(`POST /api/sync-flows/${flow.id}/applied`);
  });

  it("validates direct reviews and makes only identical callback retries idempotent", async () => {
    const host = new FakeHost();
    host.addAgent("agent_1", "feature/current", "waiting_input");
    const manager = new SyncFlowManager({ host });
    const flow = await manager.create({
      kind: "cherry_pick",
      proposerAgentId: "agent_1",
      commitSha: "abcdef123456",
      summary: "Validate direct review callbacks",
      reason: "Reject malformed or conflicting callbacks",
      files: ["src/validation.ts"],
    });
    await waitForMicrotasks(
      () => host.runners.get("agent_1")?.sent.length === 1,
    );
    await waitForMicrotasks(() => !manager.hasPendingOperations());
    const reviewToken = tokenFromPrompt(
      host.runners.get("agent_1")?.sent.at(-1) ?? "",
      "reviewToken",
    );
    const review = {
      agentId: "agent_1",
      reviewToken,
      decision: "approve" as const,
      summary: "Safe to apply",
      risks: [],
      filesReviewed: ["src/validation.ts"],
      requiredChanges: [],
    };

    await expect(
      manager.submitReview(flow.id, { ...review, agentId: "agent_unknown" }),
    ).rejects.toThrow("invalid or expired sync reviewToken");
    await expect(
      manager.submitReview(flow.id, { ...review, reviewToken: "wrong-token" }),
    ).rejects.toThrow("invalid or expired sync reviewToken");
    expect(manager.get(flow.id)?.reviewRequest?.pendingAgentIds).toEqual(["agent_1"]);
    await expect(
      manager.submitReview(flow.id, { ...review, decision: "maybe" as never }),
    ).rejects.toThrow("invalid sync review decision");
    await expect(manager.submitReview(flow.id, { ...review, summary: "  " })).rejects.toThrow(
      "missing sync review summary",
    );
    await expect(
      manager.submitReview(flow.id, { ...review, risks: "not-an-array" as never }),
    ).rejects.toThrow("invalid sync review risks");

    const acceptedPromise = manager.submitReview(flow.id, review);
    const retryPromise = manager.submitReview(flow.id, review);
    const [authorized, retried] = await Promise.all([acceptedPromise, retryPromise]);
    expect(retried).toBe(authorized);
    expect(retried.reviewRequest?.responses).toHaveLength(1);
    await expect(
      manager.submitReview(flow.id, { ...review, summary: "Conflicting retry" }),
    ).rejects.toThrow("already submitted a different review");
    await waitForMicrotasks(() => manager.get(flow.id)?.status === "apply_authorized");
    await waitForMicrotasks(() => !manager.hasPendingOperations());

    const cancelled = await manager.create({
      kind: "branch_pull",
      proposerAgentId: "agent_1",
      sourceBranch: "release",
      summary: "Cancelled review",
      reason: "Exercise wrong-state validation",
      files: ["src/cancelled.ts"],
    });
    await waitForMicrotasks(() => manager.get(cancelled.id)?.status === "review_collecting");
    await waitForMicrotasks(() => !manager.hasPendingOperations());
    const cancelledToken = tokenFromPrompt(
      host.runners.get("agent_1")?.steered.at(-1) ?? "",
      "reviewToken",
    );
    manager.cancel(cancelled.id);
    await expect(
      manager.submitReview(cancelled.id, {
        ...review,
        reviewToken: cancelledToken,
        filesReviewed: ["src/cancelled.ts"],
      }),
    ).rejects.toThrow("invalid or expired sync reviewToken");
    await waitForMicrotasks(() => !manager.hasPendingOperations());
  });

  it("keeps result JSON review parsing as a compatibility fallback", async () => {
    let now = 1000;
    const host = new FakeHost();
    const proposer = host.addAgent("agent_1", "feature/current", "waiting_input");
    const manager = new SyncFlowManager({ host, now: () => now });
    const flow = await manager.create({
      kind: "branch_pull",
      proposerAgentId: "agent_1",
      sourceBranch: "main",
      summary: "Legacy review fallback",
      reason: "Existing sessions may still emit result JSON",
      files: ["src/legacy.ts"],
    });
    await waitForMicrotasks(() => manager.get(flow.id)?.status === "review_collecting");
    await waitForMicrotasks(() => !manager.hasPendingOperations());

    proposer.setStatus("waiting_input");
    now += 1;
    host.assistant("agent_1", reviewJson(flow, "approve"), now);
    await manager.handleAgentEvent(host.result("agent_1", now));

    expect(manager.get(flow.id)?.status).toBe("apply_authorized");
  });

  it("canonicalizes legacy review echoes before failure snapshots and release prompts", async () => {
    let now = 2000;
    const host = new FakeHost();
    const proposer = host.addAgent("agent_1", "feature/current", "waiting_input");
    const manager = new SyncFlowManager({ host, now: () => now });
    const flow = await manager.create({
      kind: "branch_pull",
      proposerAgentId: "agent_1",
      sourceBranch: "main",
      summary: "Canonical legacy review",
      reason: "Legacy result fields must pass through canonical state",
      files: ["src/legacy-review.ts"],
    });
    await waitForMicrotasks(() => manager.get(flow.id)?.status === "review_collecting");
    await waitForMicrotasks(() => !manager.hasPendingOperations());

    proposer.setStatus("waiting_input");
    now += 1;
    host.assistant(
      "agent_1",
      JSON.stringify({
        agentCanvasSyncReview: true,
        flowId: flow.id,
        decision: "reject",
        summary: `summary ${CAPABILITY_ECHO}`,
        risks: [`risk ${CAPABILITY_ECHO}`],
        filesReviewed: [`src/${CAPABILITY_ECHO}`],
        requiredChanges: [`change ${CAPABILITY_ECHO}`],
      }),
      now,
    );
    await manager.handleAgentEvent(host.result("agent_1", now));
    await waitForMicrotasks(() => manager.get(flow.id)?.status === "review_failed");
    await waitForMicrotasks(() => !manager.hasPendingOperations());

    const failed = manager.get(flow.id)!;
    const failurePrompt = latestDeliveryContaining(proposer, "sync review failed");
    expect(JSON.stringify([failed, manager.list(), manager.exportState()])).not.toContain(
      CAPABILITY_ECHO,
    );
    expect(failurePrompt).not.toContain(CAPABILITY_ECHO);
    expect(failurePrompt).toContain("[redacted]");
  });

  it("ignores an old result while the current review prompt exists only as queued input", async () => {
    let now = 1500;
    const host = new FakeHost();
    const proposer = host.addAgent("agent_1", "feature/current", "running");
    const manager = new SyncFlowManager({ host, now: () => now, reviewRetryLimit: 1 });
    const flow = await manager.create({
      kind: "branch_pull",
      proposerAgentId: "agent_1",
      sourceBranch: "main",
      summary: "Do not consume the pre-review result",
      reason: "The review prompt was queued for the next turn",
      files: ["src/queued-review.ts"],
    });
    await waitForMicrotasks(
      () => manager.get(flow.id)?.status === "review_collecting" && proposer.steered.length === 1,
    );
    await waitForMicrotasks(() => !manager.hasPendingOperations());
    const prompt = proposer.steered[0]!;

    now += 1;
    host.userInput("agent_1", prompt, now, "queued");
    host.assistant("agent_1", "ordinary answer from the turn that was already running", now);
    await manager.handleAgentEvent(host.result("agent_1", now));

    expect(manager.get(flow.id)?.status).toBe("review_collecting");
    expect(manager.get(flow.id)?.reviewRequest?.retryCounts.agent_1).toBe(0);
    expect(manager.get(flow.id)?.reviewRequest?.pendingAgentIds).toEqual(["agent_1"]);
    expect(proposer.steered).toHaveLength(1);

    now += 1;
    host.userInput("agent_1", prompt, now);
    host.assistant("agent_1", reviewJson(flow, "approve"), now);
    await manager.handleAgentEvent(host.result("agent_1", now));

    expect(manager.get(flow.id)?.status).toBe("apply_authorized");
  });

  it("redirects an invalid legacy review to the intermediate callback without lifting the freeze", async () => {
    let now = 1000;
    const host = new FakeHost();
    const proposer = host.addAgent("agent_1", "feature/current", "waiting_input");
    const manager = new SyncFlowManager({ host, now: () => now, reviewRetryLimit: 1 });
    const flow = await manager.create({
      kind: "branch_pull",
      proposerAgentId: "agent_1",
      sourceBranch: "main",
      summary: "Retry through callback",
      reason: "Do not ask for another final JSON response",
      files: ["src/retry-callback.ts"],
    });
    await waitForMicrotasks(() => manager.get(flow.id)?.status === "review_collecting");
    await waitForMicrotasks(() => !manager.hasPendingOperations());

    proposer.setStatus("waiting_input");
    now += 1;
    host.assistant("agent_1", "not a registered review", now);
    await manager.handleAgentEvent(host.result("agent_1", now));

    const retry = proposer.sent.at(-1) ?? "";
    expect(proposer.deliveryCalls.find((call) => call.text === retry)?.options).toEqual({
      automationKey: `sync-flow:${flow.id}`,
    });
    expect(retry).toContain(`POST /api/sync-flows/${flow.id}/reviews`);
    expect(retry).toContain('"agentId": "agent_1"');
    expect(tokenFromPrompt(retry, "reviewToken")).toBe(
      tokenFromPrompt(proposer.sent[0]!, "reviewToken"),
    );
    expect(retry).toContain("Keep the entire workspace, Git state, and PR state read-only");
    expect(retry).toContain("after this corrected callback");
    expect(retry).toContain("intermediate tool call");
    expect(retry).not.toContain("Return exactly one JSON object");
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

    expect(flow.status).toBe("queued");
    await waitForMicrotasks(() => manager.get(flow.id)?.status === "review_collecting");
    await waitForMicrotasks(() => !manager.hasPendingOperations());
    flow = manager.get(flow.id)!;

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

  it.each(["direct", "trusted", "legacy"] as const)(
    "canonicalizes %s applied completion fields before snapshots, export, and closure",
    async (completionPath) => {
      let now = 3000;
      const host = new FakeHost();
      const proposer = host.addAgent("agent_1", "feature/current", "waiting_input");
      const manager = new SyncFlowManager({ host, now: () => now });
      const flow = await manager.create({
        kind: "branch_pull",
        proposerAgentId: "agent_1",
        sourceBranch: "main",
        summary: `Canonical ${completionPath} completion`,
        reason: "Completion payloads must not reflect capabilities",
        files: ["src/applied.ts"],
      });
      await waitForMicrotasks(() => manager.get(flow.id)?.status === "review_collecting");
      await waitForMicrotasks(() => !manager.hasPendingOperations());
      const reviewToken = tokenFromPrompt(proposer.sent[0]!, "reviewToken");
      await manager.submitReview(flow.id, {
        agentId: "agent_1",
        reviewToken,
        decision: "approve",
        summary: "safe to apply",
      });
      await waitForMicrotasks(() => manager.get(flow.id)?.status === "apply_authorized");
      await waitForMicrotasks(() => !manager.hasPendingOperations());
      const authorizationPrompt = latestDeliveryContaining(
        proposer,
        "sync authorization granted",
      );
      const callbackToken = tokenFromPrompt(authorizationPrompt, "callbackToken");
      const payload: SyncFlowAppliedInput = {
        summary: `summary ${CAPABILITY_ECHO}`,
        commitSha: `commit-${CAPABILITY_ECHO}`,
        files: [`src/${CAPABILITY_ECHO}`],
        fileChanges: [{ status: `M-${CAPABILITY_ECHO}`, path: `src/${CAPABILITY_ECHO}` }],
      };

      let applied: SyncFlowSnapshot;
      if (completionPath === "direct") {
        applied = await manager.submitApplied(flow.id, { ...payload, callbackToken });
        expect(await manager.submitApplied(flow.id, { ...payload, callbackToken })).toBe(applied);
      } else if (completionPath === "trusted") {
        applied = manager.recordApplied(flow.id, payload);
      } else {
        proposer.setStatus("waiting_input");
        now += 1;
        host.assistant(
          "agent_1",
          JSON.stringify({
            agentCanvasSyncEvent: "applied",
            flowId: flow.id,
            ...payload,
          }),
          now,
        );
        await manager.handleAgentEvent(host.result("agent_1", now));
        applied = manager.get(flow.id)!;
      }
      await waitForMicrotasks(() => manager.get(flow.id)?.status === "applied");
      await waitForMicrotasks(() => !manager.hasPendingOperations());

      expect(applied).toBe(manager.get(flow.id));
      expect(JSON.stringify([applied, manager.list(), manager.exportState()])).not.toContain(
        CAPABILITY_ECHO,
      );
      expect(JSON.stringify(applied)).toContain("[redacted]");
      expect(latestDeliveryContaining(proposer, "closure/release notice")).not.toContain(
        CAPABILITY_ECHO,
      );
    },
  );

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
    await waitForMicrotasks(() => manager.get(flow.id)?.status === "review_collecting");
    await waitForMicrotasks(() => !manager.hasPendingOperations());
    const collecting = manager.get(flow.id)!;

    expect(collecting).toMatchObject({
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
    await waitForMicrotasks(() => manager.get(flow.id)?.status === "review_collecting");
    await waitForMicrotasks(() => !manager.hasPendingOperations());
    const reviewToken = tokenFromPrompt(proposer.sent[0]!, "reviewToken");

    now += 1;
    proposer.setStatus("waiting_input");
    host.assistant("agent_1", reviewJson(flow, "reject"), now);
    await manager.handleAgentEvent(host.result("agent_1", now));

    const next = manager.get(flow.id)!;
    expect(next.status).toBe("review_failed");
    expect(next.failureReason).toContain("agent_1: reject");
    expect(proposer.sent.at(-1)).toContain("Do not apply this sync flow");
    await expect(
      manager.submitReview(flow.id, {
        agentId: "agent_1",
        reviewToken,
        decision: "reject",
        summary: "reject sync",
        risks: [],
        filesReviewed: [],
        requiredChanges: [],
      }),
    ).rejects.toThrow("invalid or expired sync reviewToken");
  });

  it("keeps blocked closure final while best-effort releasing every reachable reviewer", async () => {
    const host = new FakeHost();
    const proposer = host.addAgent("agent_1", "feature/current", "waiting_input");
    const reviewer = host.addAgent("agent_2", "feature/current", "running");
    const manager = new SyncFlowManager({ host });
    const flow = await manager.create({
      kind: "branch_pull",
      proposerAgentId: "agent_1",
      sourceBranch: "main",
      summary: "Block when authorization cannot be delivered",
      reason: "Release other reviewers without reopening the flow",
      files: ["src/blocked-release.ts"],
    });
    await waitForMicrotasks(() => manager.get(flow.id)?.status === "review_collecting");
    await waitForMicrotasks(() => !manager.hasPendingOperations());
    const proposerToken = tokenFromPrompt(proposer.sent[0]!, "reviewToken");
    const reviewerToken = tokenFromPrompt(reviewer.steered[0]!, "reviewToken");

    await manager.submitReview(flow.id, {
      agentId: "agent_1",
      reviewToken: proposerToken,
      decision: "approve",
      summary: "proposer approved",
    });
    proposer.failDelivery("proposer can no longer receive authorization");
    const submitted = await manager.submitReview(flow.id, {
      agentId: "agent_2",
      reviewToken: reviewerToken,
      decision: "approve",
      summary: "reviewer approved",
    });

    expect(submitted.status).toBe("review_collecting");
    await waitForMicrotasks(() => manager.get(flow.id)?.status === "blocked");
    await waitForMicrotasks(() => !manager.hasPendingOperations());
    const blocked = manager.get(flow.id)!;
    expect(blocked.status).toBe("blocked");
    expect(blocked.failureReason).toContain("Failed to deliver proposer signal");
    expect(reviewer.steered.at(-1)).toContain("closure/release notice");
    expect(manager.get(flow.id)?.status).toBe("blocked");
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
    await waitForMicrotasks(
      () =>
        manager.get(first.id)?.status === "review_collecting" &&
        manager.get(second.id)?.status === "queued" &&
        proposer.sent.length === 1,
    );
    await waitForMicrotasks(() => !manager.hasPendingOperations());

    expect(first.status).toBe("queued");
    expect(second.status).toBe("queued");
    expect(second.reviewRequest).toBeUndefined();
    expect(proposer.sent).toHaveLength(1);
    expect(proposer.steered).toHaveLength(0);

    now += 1;
    proposer.setStatus("waiting_input");
    host.assistant("agent_1", reviewJson(first, "approve"), now);
    await manager.handleAgentEvent(host.result("agent_1", now));
    await waitForMicrotasks(
      () =>
        manager.get(first.id)?.status === "apply_authorized" &&
        manager.get(second.id)?.status === "review_collecting",
    );
    await waitForMicrotasks(() => !manager.hasPendingOperations());

    expect(manager.get(first.id)?.status).toBe("apply_authorized");
    expect(manager.get(second.id)?.status).toBe("review_collecting");
    expect(manager.get(second.id)?.reviewRequest).toBeDefined();
    expect(proposer.steered).toHaveLength(1);
    expect(proposer.steered[0]).toContain(`flowId: ${second.id}`);
  });

  it("keeps the next same-branch review queued until cancelled delivery settles", async () => {
    const host = new FakeHost();
    const proposer = host.addAgent("agent_1", "feature/current", "running");
    const manager = new SyncFlowManager({ host });

    let releaseDelivery!: () => void;
    const deliveryBlock = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    proposer.blockNextSteerUntil(deliveryBlock);

    const firstCreation = manager.create({
      kind: "branch_pull",
      proposerAgentId: "agent_1",
      sourceBranch: "main",
      summary: "Cancelled pull",
      reason: "Exercise queue cancellation",
      files: ["src/first.ts"],
    });
    await waitForMicrotasks(() => proposer.steered.length === 1);
    expect(manager.hasPendingOperations()).toBe(true);
    const first = manager.list()[0]!;
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

    expect(manager.get(first.id)?.status).toBe("cancelled");
    expect(manager.get(second.id)?.status).toBe("queued");
    expect(proposer.steered).toHaveLength(1);

    releaseDelivery();
    await firstCreation;
    await waitForMicrotasks(() => manager.get(second.id)?.status === "review_collecting");
    await waitForMicrotasks(() => !manager.hasPendingOperations());

    expect(manager.get(second.id)?.status).toBe("review_collecting");
    expect(manager.hasPendingOperations()).toBe(false);
    expect(proposer.steered).toHaveLength(3);
    expect(proposer.steered.some((text) => text.includes("closure/release notice"))).toBe(true);
    expect(proposer.steered.some((text) => text.includes(`flowId: ${second.id}`))).toBe(true);
  });

  it("keeps the next same-branch review queued until timed-out delivery settles", async () => {
    vi.useFakeTimers();
    let now = 0;
    const host = new FakeHost();
    const proposer = host.addAgent("agent_1", "feature/current", "running");
    const manager = new SyncFlowManager({
      host,
      now: () => now,
      reviewTimeoutMs: 10,
    });

    let releaseDelivery!: () => void;
    const deliveryBlock = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    proposer.blockNextSteerUntil(deliveryBlock);

    const firstCreation = manager.create({
      kind: "cherry_pick",
      proposerAgentId: "agent_1",
      commitSha: "abcdef123456",
      summary: "Timeout pick",
      reason: "Needs review",
      files: ["src/timeout.ts"],
    });
    await waitForMicrotasks(() => proposer.steered.length === 1);
    expect(manager.hasPendingOperations()).toBe(true);
    const first = manager.list()[0]!;
    const second = await manager.create({
      kind: "branch_pull",
      proposerAgentId: "agent_1",
      sourceBranch: "release",
      summary: "Pull after timeout",
      reason: "Must wait for the timed-out delivery to settle",
      files: ["src/after-timeout.ts"],
    });
    expect(second.status).toBe("queued");

    now = 11;
    vi.advanceTimersByTime(11);

    expect(manager.get(first.id)?.status).toBe("timed_out");
    expect(manager.get(second.id)?.status).toBe("queued");
    expect(proposer.steered).toHaveLength(1);

    releaseDelivery();
    await firstCreation;
    await waitForMicrotasks(() => manager.get(second.id)?.status === "review_collecting");
    await waitForMicrotasks(() => !manager.hasPendingOperations());

    expect(manager.get(second.id)?.status).toBe("review_collecting");
    expect(manager.hasPendingOperations()).toBe(false);
    expect(proposer.steered).toHaveLength(3);
    expect(proposer.steered.some((text) => text.includes("closure/release notice"))).toBe(true);
    expect(proposer.steered.some((text) => text.includes(`flowId: ${second.id}`))).toBe(true);
  });

  it.each(["timed_out", "cancelled", "applied"] as const)(
    "does not let a late proposer-delivery rejection overwrite %s state",
    async (terminalStatus) => {
      vi.useFakeTimers();
      let now = 0;
      const host = new FakeHost();
      const proposer = host.addAgent("agent_1", "feature/current", "running");
      const reviewer = host.addAgent("agent_2", "feature/current", "running");
      const manager = new SyncFlowManager({
        host,
        now: () => now,
        reviewTimeoutMs: 10,
      });

      const flow = await manager.create({
        kind: "branch_pull",
        proposerAgentId: "agent_1",
        sourceBranch: "main",
        summary: `Late rejection after ${terminalStatus}`,
        reason: "Exercise stale proposer-delivery rejection handling",
        files: ["src/late-delivery.ts"],
      });
      await waitForMicrotasks(
        () =>
          manager.get(flow.id)?.status === "review_collecting" &&
          proposer.steered.length === 1 &&
          reviewer.steered.length === 1,
      );
      await waitForMicrotasks(() => !manager.hasPendingOperations());

      now = 1;
      host.assistant("agent_1", reviewJson(flow, "approve"), now);
      await manager.handleAgentEvent(host.result("agent_1", now));
      proposer.setStatus("running");

      let rejectDelivery!: (reason: Error) => void;
      const blockedDelivery = new Promise<void>((_resolve, reject) => {
        rejectDelivery = reject;
      });
      proposer.blockNextSteerUntil(blockedDelivery);

      now = 2;
      host.assistant("agent_2", reviewJson(flow, "approve"), now);
      const finishReview = manager.handleAgentEvent(host.result("agent_2", now));
      await waitForMicrotasks(
        () => manager.get(flow.id)?.status === "apply_authorized" && proposer.steered.length === 2,
      );

      if (terminalStatus === "timed_out") {
        now = 13;
        vi.advanceTimersByTime(11);
      } else if (terminalStatus === "cancelled") {
        manager.cancel(flow.id);
      } else {
        manager.recordApplied(flow.id, { summary: "Sync applied before delivery settled" });
      }
      expect(manager.get(flow.id)?.status).toBe(terminalStatus);

      rejectDelivery(new Error("late proposer delivery failed"));
      await finishReview;
      await waitForMicrotasks(() => !manager.hasPendingOperations());

      expect(manager.get(flow.id)?.status).toBe(terminalStatus);
    },
  );

  it("keeps a review queued when its target branch has no active reviewers", async () => {
    const host = new FakeHost();
    const proposer = host.addAgent("agent_1", "feature/current", "waiting_input");
    const manager = new SyncFlowManager({ host });

    const flow = await manager.create({
      kind: "branch_pull",
      proposerAgentId: "agent_1",
      sourceBranch: "release",
      targetBranch: "main",
      summary: "Pull release into main",
      reason: "Wait for a main-branch reviewer",
      files: ["src/main.ts"],
    });
    await waitForMicrotasks(
      () => manager.get(flow.id)?.failureReason?.includes("waiting for an active reviewer") === true,
    );
    await waitForMicrotasks(() => !manager.hasPendingOperations());
    const queued = manager.get(flow.id)!;

    expect(queued.status).toBe("queued");
    expect(queued.reviewRequest).toBeUndefined();
    expect(queued.failureReason).toContain("waiting for an active reviewer on branch main");
    expect(proposer.sent).toEqual([]);
    expect(proposer.steered).toEqual([]);

    manager.cancel(flow.id);
    await waitForMicrotasks(() => proposer.sent.length === 1);
    expect(proposer.sent[0]).toContain("closure/release notice");
    expect(proposer.sent[0]).toContain(`flowId: ${flow.id}`);
    expect(proposer.sent[0]).toContain("releases only this flow");
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
    let flow = await original.create({
      kind: "cherry_pick",
      proposerAgentId: "agent_1",
      commitSha: "abcdef123456",
      summary: "Persisted timeout",
      reason: "Exercise import",
      files: ["src/import-timeout.ts"],
    });
    await waitForMicrotasks(() => original.get(flow.id)?.status === "review_collecting");
    await waitForMicrotasks(() => !original.hasPendingOperations());
    now = 1;
    host.runners.get("agent_1")?.setStatus("waiting_input");
    host.assistant("agent_1", reviewJson(flow, "approve"), now);
    await original.handleAgentEvent(host.result("agent_1", now));
    flow = original.get(flow.id)!;
    expect(flow.status).toBe("apply_authorized");
    const state = original.exportState();
    original.importState(undefined);

    now = 5;
    const restored = new SyncFlowManager({ host, now: () => now });
    restored.importState(state);
    await waitForMicrotasks(() => !restored.hasPendingOperations());
    expect(restored.hasOpenFlows()).toBe(true);
    now = 11;
    vi.advanceTimersByTime(6);
    expect(restored.get(flow.id)?.status).toBe("timed_out");
    expect(restored.hasOpenFlows()).toBe(false);

    now = 20;
    const overdue = new SyncFlowManager({ host, now: () => now });
    overdue.importState(state);
    expect(overdue.get(flow.id)?.status).toBe("timed_out");
    await waitForMicrotasks(() => !overdue.hasPendingOperations());
    expect(overdue.hasPendingOperations()).toBe(false);
  });

  it("deep-canonicalizes imported snapshots before export and restored authorization prompts", async () => {
    const now = 6000;
    const host = new FakeHost();
    const proposer = host.addAgent("agent_1", "feature/current", "waiting_input");
    const imported: SyncFlowSnapshot = {
      id: "sync_flow_91",
      kind: "branch_pull",
      proposerAgentId: "agent_1",
      targetBranch: "feature/current",
      sourceBranch: `source-${CAPABILITY_ECHO}`,
      title: `title ${CAPABILITY_ECHO}`,
      summary: `summary ${CAPABILITY_ECHO}`,
      reason: `reason ${CAPABILITY_ECHO}`,
      files: [`src/${CAPABILITY_ECHO}`],
      fileChanges: [{ status: `M-${CAPABILITY_ECHO}`, path: `src/${CAPABILITY_ECHO}` }],
      status: "apply_authorized",
      createdAt: now - 100,
      updatedAt: now - 50,
      deadlineAt: now + 1000,
      failureReason: `failure ${CAPABILITY_ECHO}`,
      participantAgentIds: ["agent_1"],
      reviewRequest: {
        id: "sync_flow_91:review:1",
        requestedAgentIds: ["agent_1"],
        pendingAgentIds: [],
        retryCounts: { agent_1: 0 },
        responses: [
          {
            agentId: "agent_1",
            decision: "approve",
            summary: `review ${CAPABILITY_ECHO}`,
            risks: [`risk ${CAPABILITY_ECHO}`],
            filesReviewed: [`src/${CAPABILITY_ECHO}`],
            requiredChanges: [`change ${CAPABILITY_ECHO}`],
            retryCount: 0,
            receivedAt: now - 75,
          },
        ],
        requestedAt: now - 90,
        deadlineAt: now + 1000,
      },
      applyAuthorization: {
        agentId: "agent_1",
        issuedAt: now - 50,
        expiresAt: now + 1000,
      },
      applied: {
        summary: `applied ${CAPABILITY_ECHO}`,
        commitSha: `commit-${CAPABILITY_ECHO}`,
        files: [`src/${CAPABILITY_ECHO}`],
        fileChanges: [{ status: `M-${CAPABILITY_ECHO}`, path: `src/${CAPABILITY_ECHO}` }],
        appliedAt: now - 25,
      },
    };
    const manager = new SyncFlowManager({ host, now: () => now });

    manager.importState([imported], { deferActivation: true });
    const stored = manager.get(imported.id)!;
    const exported = manager.exportState();
    expect(JSON.stringify(imported)).toContain(CAPABILITY_ECHO);
    expect(stored).not.toBe(imported);
    expect(exported[0]).not.toBe(stored);
    expect(exported[0]?.reviewRequest).not.toBe(stored.reviewRequest);
    expect(JSON.stringify([stored, manager.list(), exported])).not.toContain(CAPABILITY_ECHO);
    expect(JSON.stringify(exported)).toContain("[redacted]");

    manager.activateImportedState();
    await waitForMicrotasks(() => !manager.hasPendingOperations());
    const restoredPrompt = latestDeliveryContaining(proposer, "sync authorization granted");
    const callbackToken = tokenFromPrompt(restoredPrompt, "callbackToken");
    expect(restoredPrompt).not.toContain(CAPABILITY_ECHO);
    expect(restoredPrompt).toContain("[redacted]");
    expect(callbackToken).toMatch(/^agent_canvas_cap_/u);
    expect(JSON.stringify(manager.exportState())).not.toContain(callbackToken);
  });

  it("redacts deferred-import reference pollution at the restored prompt boundary while keeping the fresh callback usable", async () => {
    let now = 7000;
    const host = new FakeHost();
    const proposer = host.addAgent("agent_1", "feature/current", "waiting_input");
    const imported: SyncFlowSnapshot = {
      id: "sync_flow_92",
      kind: "branch_pull",
      proposerAgentId: "agent_1",
      targetBranch: "feature/current",
      sourceBranch: "main",
      summary: "safe imported summary",
      reason: "safe imported reason",
      files: ["src/restored.ts"],
      fileChanges: [{ status: "M", path: "src/restored.ts" }],
      status: "apply_authorized",
      createdAt: now - 100,
      updatedAt: now - 50,
      deadlineAt: now + 1000,
      participantAgentIds: ["agent_1"],
      reviewRequest: {
        id: "sync_flow_92:review:1",
        requestedAgentIds: ["agent_1"],
        pendingAgentIds: [],
        retryCounts: { agent_1: 0 },
        responses: [
          {
            agentId: "agent_1",
            decision: "approve",
            summary: "safe imported review",
            risks: [],
            filesReviewed: ["src/restored.ts"],
            requiredChanges: [],
            retryCount: 0,
            receivedAt: now - 75,
          },
        ],
        requestedAt: now - 90,
        deadlineAt: now + 1000,
      },
      applyAuthorization: {
        agentId: "agent_1",
        issuedAt: now - 50,
        expiresAt: now + 1000,
      },
    };
    const manager = new SyncFlowManager({ host, now: () => now });
    manager.importState([imported], { deferActivation: true });

    const getReference = manager.get(imported.id)!;
    getReference.summary = `get ${CAPABILITY_ECHO}`;
    getReference.files[0] = `src/get-${CAPABILITY_ECHO}`;
    getReference.reviewRequest!.responses[0]!.summary = `review ${CAPABILITY_ECHO}`;
    const listReference = manager.list()[0]!;
    listReference.reason = `list ${CAPABILITY_ECHO}`;
    listReference.sourceBranch = `source-${CAPABILITY_ECHO}`;
    listReference.fileChanges[0]!.path = `src/list-${CAPABILITY_ECHO}`;
    listReference.reviewRequest!.responses[0]!.requiredChanges = [
      `change ${CAPABILITY_ECHO}`,
    ];
    expect(JSON.stringify(manager.get(imported.id))).toContain(CAPABILITY_ECHO);

    manager.activateImportedState();
    await waitForMicrotasks(() => !manager.hasPendingOperations());
    const restoredPrompt = latestDeliveryContaining(proposer, "sync authorization granted");
    const callbackToken = tokenFromPrompt(restoredPrompt, "callbackToken");
    expect(restoredPrompt).not.toContain(CAPABILITY_ECHO);
    expect(restoredPrompt).toContain("[redacted]");
    expect(callbackToken).toMatch(/^agent_canvas_cap_/u);

    now += 1;
    const applied = await manager.submitApplied(imported.id, {
      callbackToken,
      summary: "safe restored completion",
      files: ["src/restored.ts"],
    });
    expect(applied.status).toBe("applied");
    expect(JSON.stringify(applied)).not.toContain(CAPABILITY_ECHO);
    await waitForMicrotasks(() => !manager.hasPendingOperations());
  });

  it("reissues a private apply callback token when imported authorization is activated", async () => {
    let now = 6000;
    const host = new FakeHost();
    const proposer = host.addAgent("agent_1", "feature/current", "waiting_input");
    const original = new SyncFlowManager({ host, now: () => now });
    const flow = await original.create({
      kind: "branch_pull",
      proposerAgentId: "agent_1",
      sourceBranch: "main",
      summary: "Restore secure apply callback",
      reason: "Capabilities are intentionally not persisted",
      files: ["src/restored-callback.ts"],
    });
    await waitForMicrotasks(() => original.get(flow.id)?.status === "review_collecting");
    await waitForMicrotasks(() => !original.hasPendingOperations());
    const reviewToken = tokenFromPrompt(proposer.sent[0]!, "reviewToken");
    const submitted = await original.submitReview(flow.id, {
      agentId: "agent_1",
      reviewToken,
      decision: "approve",
      summary: "Ready to restore",
      risks: [],
      filesReviewed: ["src/restored-callback.ts"],
      requiredChanges: [],
    });
    expect(submitted.status).toBe("review_collecting");
    await waitForMicrotasks(() => original.get(flow.id)?.status === "apply_authorized");
    await waitForMicrotasks(() => !original.hasPendingOperations());
    const authorized = original.get(flow.id)!;
    const oldCallbackToken = tokenFromPrompt(proposer.steered.at(-1) ?? "", "callbackToken");
    const state = original.exportState();
    expect(JSON.stringify(state)).not.toContain(reviewToken);
    expect(JSON.stringify(state)).not.toContain(oldCallbackToken);
    original.importState(undefined);

    proposer.setStatus("waiting_input");
    const restored = new SyncFlowManager({ host, now: () => now });
    restored.importState(state, { deferActivation: true });
    const sentBeforeActivation = proposer.sent.length;
    await expect(
      restored.submitApplied(authorized.id, {
        callbackToken: oldCallbackToken,
        summary: "old capability must not survive import",
      }),
    ).rejects.toThrow("invalid or expired sync applied callbackToken");
    expect(proposer.sent).toHaveLength(sentBeforeActivation);

    restored.activateImportedState();
    await waitForMicrotasks(() => !restored.hasPendingOperations());
    const restoredPrompt = proposer.sent.at(-1) ?? "";
    const newCallbackToken = tokenFromPrompt(restoredPrompt, "callbackToken");
    expect(newCallbackToken).not.toBe(oldCallbackToken);
    expect(restoredPrompt).toContain(`POST /api/sync-flows/${flow.id}/applied`);
    expect(JSON.stringify(restored.exportState())).not.toContain(newCallbackToken);

    now += 1;
    const applied = await restored.submitApplied(flow.id, {
      callbackToken: newCallbackToken,
      summary: "restored callback applied",
      files: ["src/restored-callback.ts"],
    });
    expect(applied.status).toBe("applied");
    await waitForMicrotasks(() => !restored.hasPendingOperations());
  });

  it("retains pre-reload reviewers as closure participants when the active reviewer set changes", async () => {
    const host = new FakeHost();
    const proposer = host.addAgent("agent_1", "feature/current", "waiting_input");
    const oldReviewer = host.addAgent("agent_old", "feature/current", "waiting_input");
    const original = new SyncFlowManager({ host });
    const flow = await original.create({
      kind: "branch_pull",
      proposerAgentId: "agent_1",
      sourceBranch: "main",
      summary: "Preserve reviewers across reload",
      reason: "Every agent that was frozen must eventually receive closure",
      files: ["src/reload-participants.ts"],
    });
    await waitForMicrotasks(() => original.get(flow.id)?.status === "review_collecting");
    await waitForMicrotasks(() => !original.hasPendingOperations());
    const legacyState = original.exportState().map(({ participantAgentIds: _, ...snapshot }) =>
      snapshot as SyncFlowSnapshot,
    );
    original.importState(undefined);

    oldReviewer.setStatus("stopped");
    proposer.setStatus("waiting_input");
    const newReviewer = host.addAgent("agent_new", "feature/current", "waiting_input");
    const restored = new SyncFlowManager({ host });
    restored.importState(legacyState);
    await waitForMicrotasks(() => restored.get(flow.id)?.status === "review_collecting");
    await waitForMicrotasks(() => !restored.hasPendingOperations());
    const collecting = restored.get(flow.id)!;

    expect(collecting.reviewRequest?.requestedAgentIds).toEqual(["agent_1", "agent_new"]);
    expect(collecting.participantAgentIds).toEqual(["agent_1", "agent_old", "agent_new"]);
    expect(newReviewer.sent.some((text) => text.includes("sync review request"))).toBe(true);

    oldReviewer.setStatus("waiting_input");
    restored.cancel(flow.id);
    await waitForMicrotasks(() => !restored.hasPendingOperations());
    const oldRelease = oldReviewer.deliveryCalls.find((call) =>
      call.text.startsWith("Agent Canvas sync flow closure/release notice."),
    );
    expect(oldRelease?.options).toEqual({
      automationKey: `sync-flow:${flow.id}`,
      replaceQueued: true,
    });
  });

  it("retries failed closure releases, deduplicates success, and supports forgetting", async () => {
    const host = new FakeHost();
    host.addAgent("agent_1", "feature/current", "waiting_input");
    const reviewer = host.addAgent("agent_2", "feature/current", "waiting_input");
    const manager = new SyncFlowManager({ host });
    const flow = await manager.create({
      kind: "branch_pull",
      proposerAgentId: "agent_1",
      sourceBranch: "main",
      summary: "Retry a missed closure notice",
      reason: "Stopped reviewers must not remain frozen forever",
      files: ["src/retry-release.ts"],
    });
    await waitForMicrotasks(() => manager.get(flow.id)?.status === "review_collecting");
    await waitForMicrotasks(() => !manager.hasPendingOperations());
    const closureCalls = (): number =>
      reviewer.deliveryCalls.filter((call) =>
        call.text.startsWith("Agent Canvas sync flow closure/release notice."),
      ).length;

    reviewer.failDelivery("reviewer stopped before closure");
    manager.cancel(flow.id);
    await waitForMicrotasks(() => !manager.hasPendingOperations());
    expect(closureCalls()).toBe(1);

    reviewer.allowDelivery();
    reviewer.setStatus("waiting_input");
    await manager.retryClosureReleasesForAgent("agent_2");
    expect(closureCalls()).toBe(2);
    expect(reviewer.deliveryCalls.at(-1)?.options).toEqual({
      automationKey: `sync-flow:${flow.id}`,
      replaceQueued: true,
    });

    await manager.retryClosureReleasesForAgent("agent_2");
    expect(closureCalls()).toBe(2);

    manager.forgetClosureReleasesForAgent("agent_2");
    await manager.retryClosureReleasesForAgent("agent_2");
    expect(closureCalls()).toBe(3);
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
    let flow = await original.create({
      kind: "cherry_pick",
      proposerAgentId: "agent_1",
      commitSha: "abcdef123456",
      summary: "Deferred imported timeout",
      reason: "Publish workspace first",
      files: ["src/deferred-import.ts"],
    });
    await waitForMicrotasks(() => original.get(flow.id)?.status === "review_collecting");
    await waitForMicrotasks(() => !original.hasPendingOperations());
    now = 1;
    host.runners.get("agent_1")?.setStatus("waiting_input");
    host.assistant("agent_1", reviewJson(flow, "approve"), now);
    await original.handleAgentEvent(host.result("agent_1", now));
    flow = original.get(flow.id)!;
    expect(flow.status).toBe("apply_authorized");
    const state = original.exportState();
    original.importState(undefined);
    now = 20;

    const restored = new SyncFlowManager({ host, now: () => now });
    const observed: SyncFlowSnapshot[] = [];
    restored.onFlow((next) => observed.push(next));
    restored.importState(state, { deferActivation: true });
    vi.advanceTimersByTime(100);

    expect(restored.get(flow.id)?.status).toBe("apply_authorized");
    expect(observed).toEqual([]);
    restored.activateImportedState();
    expect(restored.get(flow.id)?.status).toBe("timed_out");
    expect(observed.map((next) => next.status)).toEqual(["timed_out"]);
    restored.activateImportedState();
    expect(observed).toHaveLength(1);
    await waitForMicrotasks(() => !restored.hasPendingOperations());
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
    const flow = await manager.create({
      kind: "cherry_pick",
      proposerAgentId: "agent_1",
      commitSha: "abcdef123456",
      summary: "Stale callback",
      reason: "Exercise generation guard",
      files: ["src/stale-timeout.ts"],
    });
    await waitForMicrotasks(
      () => manager.get(flow.id)?.status === "review_collecting" && callbacks.length === 1,
    );
    await waitForMicrotasks(() => !manager.hasPendingOperations());
    const staleCallback = callbacks[0]!;

    manager.importState(undefined);
    now = 11;
    staleCallback();

    expect(manager.list()).toEqual([]);
    expect(manager.hasPendingOperations()).toBe(false);
  });

  it("uses the same two hour default timeout as PR reviews", async () => {
    const now = 5000;
    const host = new FakeHost();
    host.addAgent("agent_1", "feature/current", "waiting_input");
    const manager = new SyncFlowManager({ host, now: () => now });

    const flow = await manager.create({
      kind: "branch_pull",
      proposerAgentId: "agent_1",
      sourceBranch: "main",
      summary: "Default timeout",
      reason: "Match the PR review deadline",
      files: ["src/default-timeout.ts"],
    });
    await waitForMicrotasks(() => manager.get(flow.id)?.status === "review_collecting");
    await waitForMicrotasks(() => !manager.hasPendingOperations());
    const collecting = manager.get(flow.id)!;

    expect(collecting.deadlineAt).toBe(now + 2 * 60 * 60 * 1000);
    expect(collecting.reviewRequest?.deadlineAt).toBe(now + 2 * 60 * 60 * 1000);
  });
});

async function waitForMicrotasks(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("timed out waiting for async sync review work");
}

function latestDeliveryContaining(runner: FakeRunner, marker: string): string {
  const delivery = [...runner.deliveryCalls]
    .reverse()
    .find((candidate) => candidate.text.includes(marker));
  if (!delivery) throw new Error(`missing delivery containing ${marker}`);
  return delivery.text;
}

function tokenFromPrompt(prompt: string, field: "reviewToken" | "callbackToken"): string {
  const match = prompt.match(new RegExp(`"${field}"\\s*:\\s*"([^"]+)"`, "u"));
  if (!match?.[1]) throw new Error(`missing ${field} in prompt`);
  return match[1];
}

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
