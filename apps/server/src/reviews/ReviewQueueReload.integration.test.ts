import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AgentEventEnvelope,
  AgentSnapshot,
  AgentStartConfig,
  PersistedPromptState,
} from "@agent-canvas/shared";
import { AgentManager } from "../AgentManager.js";
import { FileManager } from "../files/FileManager.js";
import { PromptManager } from "../prompts/PromptManager.js";
import { PullRequestFlowManager } from "../pullRequests/PullRequestFlowManager.js";
import { createServer } from "../server.js";
import type {
  QueryFn,
  QueryHandle,
  QueryOptions,
  SdkMessage,
  SdkUserInput,
} from "../sdk/types.js";
import { SyncFlowManager, type SyncFlowAgentHost } from "../sync/SyncFlowManager.js";
import { AsyncMessageQueue } from "../util/AsyncMessageQueue.js";
import { WorkspaceManager, type GitRunner } from "../workspaces/WorkspaceManager.js";
import { BranchReviewQueue } from "./BranchReviewQueue.js";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("branch review queue project reload", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    const failures: unknown[] = [];
    for (const dispose of cleanup.splice(0).reverse()) {
      try {
        await dispose();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, "reload test cleanup failed");
  });

  it("requeues a collecting review across a real project reload and resumes it after its reviewer restarts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-review-reload-"));
    cleanup.push(() => removeTempRoot(root));
    const firstQuery = makeQueryHub();
    const firstManager = new AgentManager({
      query: firstQuery.query,
      codexQuery: firstQuery.query,
      defaultCwd: root,
    });
    const firstHarness = await createHarness(root, firstManager);
    cleanup.push(firstHarness.dispose);

    const projectA = await request(firstHarness.port, "POST", "/api/canvas-projects", {
      name: "review-reload-a",
      projectRoot: path.join(root, "review-reload-a"),
    });
    expect(projectA.status).toBe(201);

    const reviewer = firstManager.create({
      provider: "codex",
      branch: "feature/reload-review",
      cwd: root,
    });
    void firstManager
      .startAgent(reviewer.id, {
        provider: "codex",
        branch: "feature/reload-review",
        cwd: root,
        prompt: "start reviewer",
      })
      .catch(() => undefined);
    await waitUntil(() => firstQuery.sessions.length === 1);
    const firstSession = firstQuery.sessions.at(-1);
    if (!firstSession) throw new Error("expected the reviewer's first query session");
    firstSession.output.push(systemInit(reviewer.id, root));
    await waitUntil(() => reviewer.getStatus() === "running");

    const created = await firstHarness.syncFlowManager.create({
      kind: "branch_pull",
      proposerAgentId: reviewer.id,
      sourceBranch: "main",
      targetBranch: "feature/reload-review",
      strategy: "merge",
      summary: "Reload a pending review",
      reason: "Exercise project state restoration",
      files: ["src/reload.ts"],
    });
    await waitUntil(() => firstSession.steered.length === 1);
    expect(created.status).toBe("review_collecting");
    const firstReviewRequestId = created.reviewRequest?.id;
    expect(firstReviewRequestId).toBeTruthy();

    const statePath = path.join(projectA.json.project.projectRoot, "canvas-state.json");
    await firstHarness.flushCanvasState();
    await waitUntilAsync(async () => {
      try {
        const persisted = JSON.parse(await readFile(statePath, "utf-8"));
        return persisted.syncFlows?.[0]?.status === "review_collecting";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    });
    await firstHarness.close();

    const restartedQuery = makeQueryHub();
    const restartedManager = new AgentManager({
      query: restartedQuery.query,
      codexQuery: restartedQuery.query,
      defaultCwd: root,
    });
    const restartedHarness = await createHarness(root, restartedManager);
    cleanup.push(restartedHarness.dispose);

    const reopened = await request(restartedHarness.port, "POST", "/api/canvas-projects/open", {
      id: projectA.json.project.id,
    });
    expect(reopened.status).toBe(200);
    await waitUntil(() => restartedHarness.syncFlowManager.get(created.id)?.status === "queued");

    const restoredReviewer = restartedManager.get(reviewer.id);
    if (!restoredReviewer) throw new Error("expected the reviewer to be restored");
    expect(restoredReviewer.getStatus()).toBe("stopped");
    expect(restartedHarness.syncFlowManager.get(created.id)?.status).toBe("queued");
    expect(
      restartedHarness.syncFlowManager.get(created.id)?.applyAuthorization,
    ).toBeUndefined();
    expect(
      restartedHarness.syncFlowManager.get(created.id)?.reviewRequest?.responses,
    ).toEqual([]);
    expect(restartedQuery.sessions).toEqual([]);

    void restartedManager
      .startAgent(reviewer.id, { prompt: "restart restored reviewer" })
      .catch(() => undefined);
    await waitUntil(() => restartedQuery.sessions.length === 1);
    const restartedSession = restartedQuery.sessions.at(-1);
    if (!restartedSession) {
      throw new Error("expected a fresh query session for the restored reviewer");
    }
    restartedSession.output.push(systemInit(reviewer.id, root));

    await waitUntil(
      () => restartedHarness.syncFlowManager.get(created.id)?.status === "review_collecting",
    );
    await waitUntil(() => restartedSession.steered.length === 1);
    const resumed = restartedHarness.syncFlowManager.get(created.id);
    expect(resumed?.reviewRequest).toMatchObject({
      requestedAgentIds: [reviewer.id],
      pendingAgentIds: [reviewer.id],
      responses: [],
    });
    expect(resumed?.reviewRequest?.id).not.toBe(firstReviewRequestId);
    expect(inputText(restartedSession.steered[0])).toContain(`flowId: ${created.id}`);
  }, 15_000);

  it("activates restored queues on the first mutation of an auto-open project before admitting a new same-branch review", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-review-auto-open-"));
    cleanup.push(() => removeTempRoot(root));
    const branch = "feature/auto-open-review";
    const projectRoot = path.join(root, "auto-open-project");
    const now = 1000;

    const firstHost = new FakeReviewHost(branch);
    const firstQueue = new BranchReviewQueue();
    const firstPrManager = new PullRequestFlowManager({
      host: firstHost,
      reviewQueue: firstQueue,
      now: () => now,
    });
    const firstSyncManager = new SyncFlowManager({
      host: firstHost,
      reviewQueue: firstQueue,
      now: () => now,
    });
    const firstManager = new AgentManager({ query: emptyQuery, defaultCwd: root });
    const firstHarness = await createHarness(root, firstManager, {
      reviewQueue: firstQueue,
      pullRequestFlowManager: firstPrManager,
      syncFlowManager: firstSyncManager,
    });
    cleanup.push(firstHarness.dispose);

    const project = await request(firstHarness.port, "POST", "/api/canvas-projects", {
      name: "auto-open-review",
      projectRoot,
    });
    expect(project.status).toBe(201);

    const restoredSync = await firstSyncManager.create({
      kind: "branch_pull",
      proposerAgentId: firstHost.agentId,
      sourceBranch: "main",
      targetBranch: branch,
      strategy: "merge",
      summary: "Persisted auto-open sync",
      reason: "This restored review must retain the first branch reservation",
      files: ["src/restored-sync.ts"],
    });
    const restoredPr = await firstPrManager.create({
      proposerAgentId: firstHost.agentId,
      targetBranch: "main",
      title: "Persisted auto-open PR",
      summary: "This equal-time review must remain second in the shared FIFO",
      files: ["src/restored-pr.ts"],
    });
    expect(restoredSync.createdAt).toBe(restoredPr.createdAt);
    expect(restoredSync.reviewQueueSequence).toBeLessThan(restoredPr.reviewQueueSequence!);
    expect(restoredSync.status).toBe("review_collecting");
    expect(restoredPr.status).toBe("queued");

    const statePath = path.join(projectRoot, "canvas-state.json");
    await firstHarness.flushCanvasState();
    await waitUntilAsync(async () => {
      try {
        const persisted = JSON.parse(await readFile(statePath, "utf-8"));
        return (
          persisted.prFlows?.[0]?.id === restoredPr.id &&
          persisted.prFlows?.[0]?.reviewQueueSequence === restoredPr.reviewQueueSequence &&
          persisted.syncFlows?.[0]?.id === restoredSync.id &&
          persisted.syncFlows?.[0]?.reviewQueueSequence === restoredSync.reviewQueueSequence
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    });
    await firstHarness.close();

    const restartedHost = new FakeReviewHost(branch);
    const restartedQueue = new BranchReviewQueue();
    const restartedPrManager = new PullRequestFlowManager({
      host: restartedHost,
      reviewQueue: restartedQueue,
      now: () => now,
    });
    const restartedSyncManager = new SyncFlowManager({
      host: restartedHost,
      reviewQueue: restartedQueue,
      now: () => now,
    });
    const restartedManager = new AgentManager({ query: emptyQuery, defaultCwd: root });
    const restartedHarness = await createHarness(root, restartedManager, {
      workspaceProjectRoot: projectRoot,
      reviewQueue: restartedQueue,
      pullRequestFlowManager: restartedPrManager,
      syncFlowManager: restartedSyncManager,
    });
    cleanup.push(restartedHarness.dispose);

    // The WorkspaceManager already considers this project open. A read establishes request
    // revision headers but deliberately does not go through the explicit /canvas-projects/open
    // restoration path.
    const workspace = await request(restartedHarness.port, "GET", "/api/workspace");
    expect(workspace.status).toBe(200);
    expect(workspace.json.projectRoot).toBe(projectRoot);
    expect(restartedPrManager.list()).toEqual([]);
    expect(restartedSyncManager.list()).toEqual([]);

    const fresh = await request(restartedHarness.port, "POST", "/api/sync-flows", {
      kind: "branch_pull",
      proposerAgentId: restartedHost.agentId,
      sourceBranch: "release",
      targetBranch: branch,
      strategy: "merge",
      summary: "Fresh review after auto-open reload",
      reason: "It must not overtake either restored branch review",
      files: ["src/fresh-sync.ts"],
    });
    expect(fresh.status, JSON.stringify(fresh.json)).toBe(201);
    expect(fresh.json.flow.status).toBe("queued");

    await waitUntil(
      () => restartedSyncManager.get(restoredSync.id)?.status === "review_collecting",
    );
    expect(restartedSyncManager.get(restoredSync.id)?.reviewQueueSequence).toBe(
      restoredSync.reviewQueueSequence,
    );
    expect(restartedPrManager.get(restoredPr.id)?.reviewQueueSequence).toBe(
      restoredPr.reviewQueueSequence,
    );
    expect(restartedPrManager.get(restoredPr.id)?.status).toBe("queued");
    expect(restartedSyncManager.get(fresh.json.flow.id)?.status).toBe("queued");
    expect(restartedHost.runner.sent).toHaveLength(1);
    expect(restartedHost.runner.sent[0]).toContain(`flowId: ${restoredSync.id}`);

    restartedSyncManager.cancel(restoredSync.id);
    await waitUntil(
      () => restartedPrManager.get(restoredPr.id)?.status === "source_review_collecting",
    );
    expect(restartedSyncManager.get(fresh.json.flow.id)?.status).toBe("queued");
    expect(restartedHost.runner.sent).toHaveLength(2);
    expect(restartedHost.runner.sent[1]).toContain(`flowId: ${restoredPr.id}`);

    restartedPrManager.cancel(restoredPr.id);
    await waitUntil(
      () => restartedSyncManager.get(fresh.json.flow.id)?.status === "review_collecting",
    );
    expect(restartedHost.runner.sent).toHaveLength(3);
    expect(restartedHost.runner.sent[2]).toContain(`flowId: ${fresh.json.flow.id}`);
  }, 15_000);

  it("waits for prompt and layout restoration before rebuilding or persisting PR and sync queues", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-review-barrier-"));
    cleanup.push(() => removeTempRoot(root));
    const firstPromptManager = new PromptManager({
      workspaceRoot: root,
      promptRoot: path.join(root, "prompts"),
    });
    const firstHost = new FakeReviewHost("feature/restore-barrier");
    const firstReviewQueue = new BranchReviewQueue();
    const firstPullRequestFlowManager = new PullRequestFlowManager({
      host: firstHost,
      reviewQueue: firstReviewQueue,
    });
    const firstSyncFlowManager = new SyncFlowManager({
      host: firstHost,
      reviewQueue: firstReviewQueue,
    });
    const firstManager = new AgentManager({ query: emptyQuery, defaultCwd: root });
    const firstHarness = await createHarness(root, firstManager, {
      promptManager: firstPromptManager,
      reviewQueue: firstReviewQueue,
      pullRequestFlowManager: firstPullRequestFlowManager,
      syncFlowManager: firstSyncFlowManager,
    });
    cleanup.push(firstHarness.dispose);

    const projectA = await request(firstHarness.port, "POST", "/api/canvas-projects", {
      name: "restore-barrier-a",
      projectRoot: path.join(root, "restore-barrier-a"),
    });
    expect(projectA.status).toBe(201);
    const restoredAgent = firstManager.create({
      provider: "codex",
      branch: "feature/restored-agent",
      cwd: root,
    });
    const prompt = await request(firstHarness.port, "POST", "/api/prompts", {
      name: "restore-order",
      content: "prompts restore before review delivery",
      kind: "normal",
    });
    expect(prompt.status).toBe(201);
    const layout = await request(firstHarness.port, "PATCH", "/api/canvas-layout", {
      canvasProjectId: projectA.json.project.id,
      nodes: [
        {
          id: "restore-order-node",
          type: "prompt",
          position: { x: 321, y: 654 },
          width: 280,
          height: 180,
        },
      ],
    });
    expect(layout.status, JSON.stringify(layout.json)).toBe(200);

    const prFlow = await firstPullRequestFlowManager.create({
      proposerAgentId: firstHost.agentId,
      targetBranch: "main",
      title: "Restore queue ordering",
      summary: "Persist a collecting PR review",
      files: ["src/pr.ts"],
    });
    expect(prFlow.status).toBe("source_review_collecting");
    const oldPrRequestId = prFlow.reviewRequests.at(-1)?.id;
    expect(oldPrRequestId).toBeTruthy();
    const syncFlow = await firstSyncFlowManager.create({
      kind: "branch_pull",
      proposerAgentId: firstHost.agentId,
      sourceBranch: "main",
      targetBranch: "feature/restore-barrier",
      strategy: "merge",
      summary: "Persist a queued sync review",
      reason: "Share the branch review queue",
      files: ["src/sync.ts"],
    });
    expect(syncFlow.status).toBe("queued");

    firstHost.runner.setStatus("waiting_input");
    const statePath = path.join(projectA.json.project.projectRoot, "canvas-state.json");
    await firstHarness.flushCanvasState();
    await waitUntilAsync(async () => {
      const persisted = JSON.parse(await readFile(statePath, "utf-8"));
      return (
        persisted.prFlows?.[0]?.id === prFlow.id &&
        persisted.syncFlows?.[0]?.id === syncFlow.id &&
        persisted.layout?.nodes?.[0]?.id === "restore-order-node"
      );
    });
    await firstHarness.close();
    const stateBeforeOpen = await readFile(statePath, "utf-8");
    expect(JSON.parse(stateBeforeOpen)).toMatchObject({
      agents: {
        agents: [expect.objectContaining({ id: restoredAgent.id })],
      },
      prFlows: [expect.objectContaining({ id: prFlow.id })],
      syncFlows: [expect.objectContaining({ id: syncFlow.id })],
      layout: { nodes: [expect.objectContaining({ id: "restore-order-node" })] },
    });
    const promptManager = new BlockingPromptManager({
      workspaceRoot: root,
      promptRoot: path.join(root, "prompts"),
    });
    const host = new FakeReviewHost("feature/restore-barrier");
    const reviewQueue = new BranchReviewQueue();
    const pullRequestFlowManager = new PullRequestFlowManager({ host, reviewQueue });
    const syncFlowManager = new SyncFlowManager({ host, reviewQueue });
    const manager = new AgentManager({ query: emptyQuery, defaultCwd: root });
    const harness = await createHarness(root, manager, {
      promptManager,
      reviewQueue,
      pullRequestFlowManager,
      syncFlowManager,
    });
    cleanup.push(harness.dispose);

    const promptGate = promptManager.blockNextImport();
    cleanup.push(async () => promptGate.release());
    const openPromise = request(harness.port, "POST", "/api/canvas-projects/open", {
      id: projectA.json.project.id,
    });
    await promptGate.entered;

    expect(pullRequestFlowManager.list()).toEqual([]);
    expect(syncFlowManager.list()).toEqual([]);
    expect(host.runner.sent).toEqual([]);
    expect(manager.list()).toEqual([
      expect.objectContaining({ id: restoredAgent.id }),
    ]);

    const revision = harness.workspaceManager.captureProjectRevision();
    let concurrentMutationSettled = false;
    const concurrentPromptPromise = request(
      harness.port,
      "POST",
      "/api/prompts",
      {
        name: "queued-during-restore",
        content: "this mutation must wait for the project import transaction",
        kind: "normal",
      },
      {
        "X-Agent-Canvas-Project-Id": revision.projectId,
        "X-Agent-Canvas-Project-Revision": String(revision.generation),
      },
    ).then((response) => {
      concurrentMutationSettled = true;
      return response;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(concurrentMutationSettled).toBe(false);
    expect(await readFile(statePath, "utf-8")).toBe(stateBeforeOpen);

    promptGate.release();
    const reopened = await openPromise;
    expect(reopened.status).toBe(200);
    const concurrentPrompt = await concurrentPromptPromise;
    expect(concurrentPrompt.status).toBe(201);
    await waitUntil(
      () => pullRequestFlowManager.get(prFlow.id)?.status === "source_review_collecting",
    );
    await waitUntil(() => host.runner.sent.length === 1);

    const restoredPr = pullRequestFlowManager.get(prFlow.id);
    expect(restoredPr?.reviewRequests).toHaveLength(2);
    expect(restoredPr?.reviewRequests.at(-1)?.id).not.toBe(oldPrRequestId);
    expect(syncFlowManager.get(syncFlow.id)?.status).toBe("queued");
    expect(host.runner.sent[0]).toContain(`flowId: ${prFlow.id}`);
    expect((await request(harness.port, "GET", "/api/prompts")).json.prompts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: prompt.json.prompt.id, content: prompt.json.prompt.content }),
        expect.objectContaining({
          id: concurrentPrompt.json.prompt.id,
          content: "this mutation must wait for the project import transaction",
        }),
      ]),
    );
    expect((await request(harness.port, "GET", "/api/canvas-layout")).json.nodes).toEqual(
      layout.json.nodes,
    );

    await harness.flushCanvasState();
    await waitUntilAsync(async () => {
      const persisted = JSON.parse(await readFile(statePath, "utf-8"));
      return (
        persisted.prFlows?.[0]?.reviewRequests?.length === 2 &&
        persisted.prompts?.prompts?.some(
          (item: { id?: string }) => item.id === concurrentPrompt.json.prompt.id,
        )
      );
    });
    expect(JSON.parse(await readFile(statePath, "utf-8"))).toMatchObject({
      prompts: {
        prompts: expect.arrayContaining([
          expect.objectContaining({ id: prompt.json.prompt.id }),
          expect.objectContaining({ id: concurrentPrompt.json.prompt.id }),
        ]),
      },
      prFlows: [
        expect.objectContaining({
          id: prFlow.id,
          status: "source_review_collecting",
          reviewRequests: [expect.any(Object), expect.any(Object)],
        }),
      ],
      syncFlows: [expect.objectContaining({ id: syncFlow.id, status: "queued" })],
      layout: { nodes: [expect.objectContaining({ id: "restore-order-node" })] },
    });
  }, 15_000);
});

interface Resp {
  status: number;
  json: any;
}

interface QuerySession {
  options?: QueryOptions;
  output: AsyncMessageQueue<SdkMessage>;
  inputs: SdkUserInput[];
  steered: SdkUserInput[];
}

interface HarnessOptions {
  promptManager?: PromptManager;
  reviewQueue?: BranchReviewQueue;
  pullRequestFlowManager?: PullRequestFlowManager;
  syncFlowManager?: SyncFlowManager;
  workspaceProjectRoot?: string;
}

async function createHarness(
  root: string,
  manager: AgentManager,
  options: HarnessOptions = {},
): Promise<{
  port: number;
  syncFlowManager: SyncFlowManager;
  workspaceManager: WorkspaceManager;
  flushCanvasState: () => Promise<void>;
  close: () => Promise<void>;
  dispose: () => Promise<void>;
}> {
  const projectRoot = options.workspaceProjectRoot ?? path.join(root, "projects");
  const workspaceManager = new WorkspaceManager({
    defaultSourcePath: root,
    projectRoot,
    projectsRoot: path.join(root, "projects-index"),
    runGit: fakeGitRunner,
  });
  await workspaceManager.connect({ localPath: root });
  const fileManager = new FileManager({
    workspaceRoot: root,
    isolatedRoot: path.join(root, "isolated"),
  });
  const result = createServer(manager, fileManager, {
    defaultCwd: root,
    workspaceManager,
    promptManager: options.promptManager,
    reviewQueue: options.reviewQueue,
    pullRequestFlowManager: options.pullRequestFlowManager,
    syncFlowManager: options.syncFlowManager,
    codexModelDetection: {
      models: ["fake-model"],
      defaultModel: "fake-model",
      reasoningEfforts: ["medium"],
      modelCapabilities: [
        {
          model: "fake-model",
          reasoningEfforts: ["medium"],
          defaultReasoningEffort: "medium",
        },
      ],
      version: "test",
    },
  });
  await new Promise<void>((resolve) => result.httpServer.listen(0, resolve));
  const port = (result.httpServer.address() as AddressInfo).port;
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      // Drain the debounced canvas save before retiring review timers and runners. This preserves
      // the exact persisted reload fixture while preventing the old server from writing into a
      // project after the replacement server (or the next test) has taken ownership of it.
      await result.flushCanvasState();
    } finally {
      try {
        result.pullRequestFlowManager.importState(undefined, { deferActivation: true });
        result.syncFlowManager.importState(undefined, { deferActivation: true });
        await manager.clear();
      } finally {
        requestWorkspaceContexts.delete(port);
        await new Promise<void>((resolve, reject) =>
          result.httpServer.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }
  };
  return {
    port,
    syncFlowManager: result.syncFlowManager,
    workspaceManager,
    flushCanvasState: result.flushCanvasState,
    close,
    dispose: close,
  };
}

function makeQueryHub(): { query: QueryFn; sessions: QuerySession[] } {
  const sessions: QuerySession[] = [];
  const query: QueryFn = ({ prompt, options }) => {
    const session: QuerySession = {
      options,
      output: new AsyncMessageQueue<SdkMessage>(),
      inputs: [],
      steered: [],
    };
    sessions.push(session);
    if (typeof prompt !== "string") {
      void (async () => {
        for await (const input of prompt) session.inputs.push(input);
      })();
    }
    const handle: QueryHandle = {
      [Symbol.asyncIterator]: () => session.output[Symbol.asyncIterator](),
      steer: async (input) => {
        session.steered.push(input);
      },
      interrupt: async () => {
        session.output.close();
      },
      terminate: async () => {
        session.output.close();
      },
    };
    return handle;
  };
  return { query, sessions };
}

const emptyQuery: QueryFn = () => ({
  async *[Symbol.asyncIterator]() {
    // This test's real AgentManager remains idle.
  },
});

class FakeReviewRunner {
  readonly sent: string[] = [];

  constructor(private status: AgentSnapshot["status"]) {}

  getStatus(): string {
    return this.status;
  }

  setStatus(status: AgentSnapshot["status"]): void {
    this.status = status;
  }

  send(text: string): void {
    this.sent.push(text);
    this.status = "running";
  }

  async steer(text: string): Promise<void> {
    this.sent.push(text);
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

class FakeReviewHost implements SyncFlowAgentHost {
  readonly agentId = "agent_restore_barrier";
  readonly runner = new FakeReviewRunner("waiting_input");

  constructor(private readonly branch: string) {}

  list(): AgentSnapshot[] {
    return [
      {
        id: this.agentId,
        provider: "codex",
        status: this.runner.getStatus() as AgentSnapshot["status"],
        config: { prompt: "", provider: "codex", branch: this.branch },
        createdAt: 1,
        lastEventSeq: 0,
      },
    ];
  }

  get(id: string): FakeReviewRunner | undefined {
    return id === this.agentId ? this.runner : undefined;
  }

  async startAgent(id: string, config: AgentStartConfig): Promise<void> {
    const runner = this.get(id);
    if (!runner) throw new Error(`unknown agent: ${id}`);
    runner.send(config.prompt);
  }

  historyOf(_id: string): AgentEventEnvelope[] {
    return [];
  }

  currentTurnIndex(): number {
    return 0;
  }
}

class BlockingPromptManager extends PromptManager {
  private nextGate?: {
    entered: Deferred<void>;
    release: Deferred<void>;
  };

  blockNextImport(): { entered: Promise<void>; release: () => void } {
    const entered = deferred<void>();
    const release = deferred<void>();
    this.nextGate = { entered, release };
    return { entered: entered.promise, release: () => release.resolve(undefined) };
  }

  override async importState(state: PersistedPromptState | undefined): Promise<void> {
    const gate = this.nextGate;
    if (gate) {
      this.nextGate = undefined;
      gate.entered.resolve(undefined);
      await gate.release.promise;
    }
    await super.importState(state);
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const fakeGitRunner: GitRunner = async (args, options) => {
  if (args[0] === "remote") return "https://github.com/acme/review-reload.git";
  if (args[0] === "branch") return "main";
  if (args[0] === "clone") {
    await mkdir(path.join(String(args[2]), ".git", "info"), { recursive: true });
    await writeFile(path.join(String(args[2]), ".gitkeep"), "");
    return "";
  }
  if (args[0] === "worktree" && args[1] === "add") {
    await mkdir(path.join(String(args[4]), ".git", "info"), { recursive: true });
    return "";
  }
  if (args[0] === "rev-parse") {
    return path.join(options?.cwd ?? "", ".git", "info", "exclude");
  }
  return "";
};

const requestWorkspaceContexts = new Map<
  number,
  { canvasProjectId: string; revision: number }
>();

async function request(
  port: number,
  method: string,
  route: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<Resp> {
  const context = requestWorkspaceContexts.get(port);
  const projectHeaders: Record<string, string> =
    requiresTestProjectContext(method, route) &&
    !extraHeaders["X-Agent-Canvas-Project-Id"] &&
    context
      ? {
          "X-Agent-Canvas-Project-Id": context.canvasProjectId,
          "X-Agent-Canvas-Project-Revision": String(context.revision),
        }
      : {};
  const response = await rawRequest(port, method, route, body, {
    ...projectHeaders,
    ...extraHeaders,
  });
  const workspace = response.json?.workspace?.canvasProject
    ? response.json.workspace
    : response.json;
  if (
    typeof workspace?.canvasProject?.id === "string" &&
    Number.isSafeInteger(workspace?.revision)
  ) {
    requestWorkspaceContexts.set(port, {
      canvasProjectId: workspace.canvasProject.id,
      revision: workspace.revision,
    });
  }
  return response;
}

function rawRequest(
  port: number,
  method: string,
  route: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: route,
        headers: {
          ...extraHeaders,
          ...(data
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : undefined });
        });
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

function requiresTestProjectContext(method: string, route: string): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return false;
  const pathname = new URL(route, "http://localhost").pathname;
  return pathname.startsWith("/api/") && !pathname.startsWith("/api/canvas-projects");
}

function systemInit(agentId: string, cwd: string): SdkMessage {
  return {
    type: "system",
    subtype: "init",
    session_id: `session-${agentId}-${Date.now()}`,
    model: "fake-model",
    cwd,
    tools: ["Read", "Bash"],
  };
}

function inputText(input: SdkUserInput | undefined): string {
  const content = input?.message.content;
  if (typeof content === "string") return content;
  return (
    content
      ?.map((block) => (block.type === "text" ? String(block.text ?? "") : ""))
      .join("") ?? ""
  );
}

async function waitUntil(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (check()) return;
    await flush();
  }
  throw new Error("condition was not met before timeout");
}

async function waitUntilAsync(
  check: () => Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return;
    await flush();
  }
  throw new Error("async condition was not met before timeout");
}

async function removeTempRoot(target: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EBUSY" || attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}
