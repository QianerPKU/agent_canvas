import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AgentEventEnvelope,
  AgentSnapshot,
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
    for (const dispose of cleanup.splice(0)) await dispose();
  });

  it("requeues a collecting review across a real project reload and resumes it after its reviewer restarts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-review-reload-"));
    const query = makeQueryHub();
    const manager = new AgentManager({
      query: query.query,
      codexQuery: query.query,
      defaultCwd: root,
    });
    const harness = await createHarness(root, manager);
    cleanup.push(harness.dispose);

    const projectA = await request(harness.port, "POST", "/api/canvas-projects", {
      name: "review-reload-a",
    });
    expect(projectA.status).toBe(201);

    const reviewer = manager.create({
      provider: "codex",
      branch: "feature/reload-review",
      cwd: root,
    });
    manager.startAgent(reviewer.id, {
      provider: "codex",
      branch: "feature/reload-review",
      cwd: root,
      prompt: "start reviewer",
    });
    const firstSession = query.sessions.at(-1);
    if (!firstSession) throw new Error("expected the reviewer's first query session");
    firstSession.output.push(systemInit(reviewer.id, root));
    await waitUntil(() => reviewer.getStatus() === "running");

    const created = await harness.syncFlowManager.create({
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

    const projectB = await request(harness.port, "POST", "/api/canvas-projects", {
      name: "review-reload-b",
    });
    expect(projectB.status).toBe(201);
    expect(manager.list()).toEqual([]);
    expect(harness.syncFlowManager.list()).toEqual([]);

    const reopened = await request(harness.port, "POST", "/api/canvas-projects/open", {
      id: projectA.json.project.id,
    });
    expect(reopened.status).toBe(200);
    await waitUntil(() => harness.syncFlowManager.get(created.id)?.status === "queued");

    const restoredReviewer = manager.get(reviewer.id);
    if (!restoredReviewer) throw new Error("expected the reviewer to be restored");
    expect(restoredReviewer.getStatus()).toBe("stopped");
    expect(harness.syncFlowManager.get(created.id)?.status).toBe("queued");
    expect(harness.syncFlowManager.get(created.id)?.applyAuthorization).toBeUndefined();
    expect(harness.syncFlowManager.get(created.id)?.reviewRequest?.responses).toEqual([]);

    manager.startAgent(reviewer.id, { prompt: "restart restored reviewer" });
    const restartedSession = query.sessions.at(-1);
    if (!restartedSession || restartedSession === firstSession) {
      throw new Error("expected a fresh query session for the restored reviewer");
    }
    restartedSession.output.push(systemInit(reviewer.id, root));

    await waitUntil(
      () => harness.syncFlowManager.get(created.id)?.status === "review_collecting",
    );
    await waitUntil(() => restartedSession.steered.length === 1);
    const resumed = harness.syncFlowManager.get(created.id);
    expect(resumed?.reviewRequest).toMatchObject({
      requestedAgentIds: [reviewer.id],
      pendingAgentIds: [reviewer.id],
      responses: [],
    });
    expect(resumed?.reviewRequest?.id).not.toBe(firstReviewRequestId);
    expect(inputText(restartedSession.steered[0])).toContain(`flowId: ${created.id}`);
  });

  it("waits for prompt and layout restoration before rebuilding or persisting PR and sync queues", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-review-barrier-"));
    const promptManager = new BlockingPromptManager({
      workspaceRoot: root,
      promptRoot: path.join(root, "prompts"),
    });
    const host = new FakeReviewHost("feature/restore-barrier");
    const reviewQueue = new BranchReviewQueue();
    const pullRequestFlowManager = new PullRequestFlowManager({
      host,
      reviewQueue,
    });
    const syncFlowManager = new SyncFlowManager({ host, reviewQueue });
    const manager = new AgentManager({ query: emptyQuery, defaultCwd: root });
    const harness = await createHarness(root, manager, {
      promptManager,
      reviewQueue,
      pullRequestFlowManager,
      syncFlowManager,
    });
    cleanup.push(harness.dispose);

    const projectA = await request(harness.port, "POST", "/api/canvas-projects", {
      name: "restore-barrier-a",
    });
    expect(projectA.status).toBe(201);
    const prompt = await request(harness.port, "POST", "/api/prompts", {
      name: "restore-order",
      content: "prompts restore before review delivery",
      kind: "normal",
    });
    expect(prompt.status).toBe(201);
    const layout = await request(harness.port, "PATCH", "/api/canvas-layout", {
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
    expect(layout.status).toBe(200);

    const prFlow = await pullRequestFlowManager.create({
      proposerAgentId: host.agentId,
      targetBranch: "main",
      title: "Restore queue ordering",
      summary: "Persist a collecting PR review",
      files: ["src/pr.ts"],
    });
    expect(prFlow.status).toBe("source_review_collecting");
    const oldPrRequestId = prFlow.reviewRequests.at(-1)?.id;
    expect(oldPrRequestId).toBeTruthy();
    const syncFlow = await syncFlowManager.create({
      kind: "branch_pull",
      proposerAgentId: host.agentId,
      sourceBranch: "main",
      targetBranch: "feature/restore-barrier",
      strategy: "merge",
      summary: "Persist a queued sync review",
      reason: "Share the branch review queue",
      files: ["src/sync.ts"],
    });
    expect(syncFlow.status).toBe("queued");

    host.runner.setStatus("waiting_input");
    const projectB = await request(harness.port, "POST", "/api/canvas-projects", {
      name: "restore-barrier-b",
    });
    expect(projectB.status).toBe(201);
    const statePath = path.join(projectA.json.project.projectRoot, "canvas-state.json");
    const stateBeforeOpen = await readFile(statePath, "utf-8");
    expect(JSON.parse(stateBeforeOpen)).toMatchObject({
      prFlows: [expect.objectContaining({ id: prFlow.id })],
      syncFlows: [expect.objectContaining({ id: syncFlow.id })],
      layout: { nodes: [expect.objectContaining({ id: "restore-order-node" })] },
    });

    host.runner.sent.length = 0;
    const promptGate = promptManager.blockNextImport();
    const openPromise = request(harness.port, "POST", "/api/canvas-projects/open", {
      id: projectA.json.project.id,
    });
    await promptGate.entered;

    expect(pullRequestFlowManager.list()).toEqual([]);
    expect(syncFlowManager.list()).toEqual([]);
    expect(host.runner.sent).toEqual([]);
    expect((await request(harness.port, "GET", "/api/canvas-layout")).json.nodes).toEqual([]);

    const concurrentLayout = await request(harness.port, "PATCH", "/api/canvas-layout", {
      nodes: [
        {
          id: "transient-during-restore",
          type: "prompt",
          position: { x: 1, y: 2 },
        },
      ],
    });
    expect(concurrentLayout.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await readFile(statePath, "utf-8")).toBe(stateBeforeOpen);

    promptGate.release();
    const reopened = await openPromise;
    expect(reopened.status).toBe(200);
    await waitUntil(
      () => pullRequestFlowManager.get(prFlow.id)?.status === "source_review_collecting",
    );
    await waitUntil(() => host.runner.sent.length === 1);

    const restoredPr = pullRequestFlowManager.get(prFlow.id);
    expect(restoredPr?.reviewRequests).toHaveLength(2);
    expect(restoredPr?.reviewRequests.at(-1)?.id).not.toBe(oldPrRequestId);
    expect(syncFlowManager.get(syncFlow.id)?.status).toBe("queued");
    expect(host.runner.sent[0]).toContain(`flowId: ${prFlow.id}`);
    expect((await request(harness.port, "GET", "/api/prompts")).json.prompts).toEqual([
      expect.objectContaining({ id: prompt.json.prompt.id, content: prompt.json.prompt.content }),
    ]);
    expect((await request(harness.port, "GET", "/api/canvas-layout")).json.nodes).toEqual(
      layout.json.nodes,
    );

    await waitUntilAsync(async () => {
      const persisted = JSON.parse(await readFile(statePath, "utf-8"));
      return persisted.prFlows?.[0]?.reviewRequests?.length === 2;
    });
    expect(JSON.parse(await readFile(statePath, "utf-8"))).toMatchObject({
      prompts: {
        prompts: [expect.objectContaining({ id: prompt.json.prompt.id })],
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
  });
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
}

async function createHarness(
  root: string,
  manager: AgentManager,
  options: HarnessOptions = {},
): Promise<{
  port: number;
  syncFlowManager: SyncFlowManager;
  dispose: () => Promise<void>;
}> {
  const projectRoot = path.join(root, "projects");
  const workspaceManager = new WorkspaceManager({
    defaultSourcePath: root,
    projectRoot,
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
  return {
    port,
    syncFlowManager: result.syncFlowManager,
    dispose: async () => {
      await manager.clear();
      await new Promise<void>((resolve) => result.httpServer.close(() => resolve()));
      await removeTempRoot(root);
    },
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

function request(port: number, method: string, route: string, body?: unknown): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: route,
        headers: data
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
          : {},
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

async function waitUntil(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (check()) return;
    await flush();
  }
  throw new Error("condition was not met before timeout");
}

async function waitUntilAsync(
  check: () => Promise<boolean>,
  timeoutMs = 2_000,
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
