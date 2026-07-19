import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket, { type RawData } from "ws";
import type { AgentEventEnvelope, AgentSnapshot } from "@agent-canvas/shared";
import { AgentManager } from "./AgentManager.js";
import { CommitManager } from "./commits/CommitManager.js";
import { createServer } from "./server.js";
import { FileManager } from "./files/FileManager.js";
import type { OpenInVscodeOptions } from "./files/VscodeFileOpener.js";
import { PromptManager } from "./prompts/PromptManager.js";
import { PullRequestFlowManager } from "./pullRequests/PullRequestFlowManager.js";
import { BranchReviewQueue } from "./reviews/BranchReviewQueue.js";
import { CodexAuthManager } from "./sdk/CodexAuthManager.js";
import { SyncFlowManager, type SyncFlowAgentHost } from "./sync/SyncFlowManager.js";
import type { QueryFn } from "./sdk/types.js";
import { WorkspaceManager, type GitRunner } from "./workspaces/WorkspaceManager.js";
import { writeManagedFileAtomically } from "./workspaces/safeManagedFile.js";

/** 立即结束消息流的假 query：足以测 HTTP 路由，不触达模型。 */
const emptyQuery: QueryFn = () => ({
  async *[Symbol.asyncIterator]() {
    // 无消息，迭代立即结束
  },
});

interface Resp {
  status: number;
  json: any;
}

class FakeSyncRunner {
  readonly sent: string[] = [];

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

class FakeSyncHost implements SyncFlowAgentHost {
  readonly runner = new FakeSyncRunner("waiting_input");
  readonly history: AgentEventEnvelope[] = [];
  seq = 0;

  list(): AgentSnapshot[] {
    return [
      {
        id: "agent_sync",
        provider: "codex",
        status: this.runner.getStatus() as AgentSnapshot["status"],
        config: { prompt: "", provider: "codex", branch: "feature/server-test" },
        createdAt: 0,
        lastEventSeq: this.seq,
      },
    ];
  }

  get(id: string): FakeSyncRunner | undefined {
    return id === "agent_sync" ? this.runner : undefined;
  }

  historyOf(id: string): AgentEventEnvelope[] {
    return id === "agent_sync" ? this.history : [];
  }

  currentTurnIndex(): number {
    return 0;
  }

  assistant(text: string, at: number): void {
    this.history.push({
      agentId: "agent_sync",
      seq: ++this.seq,
      at,
      event: { kind: "assistant_text", text },
    });
  }

  result(at: number): AgentEventEnvelope {
    const envelope: AgentEventEnvelope = {
      agentId: "agent_sync",
      seq: ++this.seq,
      at,
      event: { kind: "result", subtype: "success", isError: false },
    };
    this.history.push(envelope);
    this.runner.setStatus("waiting_input");
    return envelope;
  }
}

class FakeCodexAuthManager extends CodexAuthManager {
  private loginStarted = false;

  override async status() {
    return {
      state: this.loginStarted ? ("authenticated" as const) : ("unauthenticated" as const),
      message: this.loginStarted ? "Logged in with ChatGPT" : "Not logged in",
    };
  }

  override startDeviceLogin() {
    this.loginStarted = true;
    return this.loginSession()!;
  }

  override loginSession() {
    return this.loginStarted
      ? {
          id: "codex_login_1",
          state: "running" as const,
          startedAt: 1,
          updatedAt: 1,
          loginUrl: "https://auth.openai.com/device",
          userCode: "ABCD-EFGH",
          output: "Open https://auth.openai.com/device and enter code: ABCD-EFGH",
        }
      : undefined;
  }

  override cancelLogin() {
    this.loginStarted = false;
    return undefined;
  }
}

let requestWorkspaceContext:
  | { canvasProjectId: string; revision: number }
  | undefined;

async function request(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<Resp> {
  if (
    requiresTestProjectContext(method, path) &&
    !extraHeaders["X-Agent-Canvas-Project-Id"] &&
    !requestWorkspaceContext
  ) {
    await request(port, "GET", "/api/workspace");
  }
  const projectHeaders: Record<string, string> =
    requiresTestProjectContext(method, path) &&
    !extraHeaders["X-Agent-Canvas-Project-Id"] &&
    requestWorkspaceContext
      ? {
          "X-Agent-Canvas-Project-Id": requestWorkspaceContext.canvasProjectId,
          "X-Agent-Canvas-Project-Revision": String(requestWorkspaceContext.revision),
        }
      : {};
  const response = await rawRequest(port, method, path, body, {
    ...projectHeaders,
    ...extraHeaders,
  });
  updateTestWorkspaceContext(response.json);
  if (method === "DELETE" && response.status >= 200 && response.status < 300) {
    const deletedProject = new URL(path, "http://localhost").pathname.match(
      /^\/api\/canvas-projects\/([^/]+)$/u,
    );
    if (
      deletedProject &&
      requestWorkspaceContext?.canvasProjectId === decodeURIComponent(deletedProject[1]!)
    ) {
      requestWorkspaceContext = undefined;
    }
  }
  return response;
}

function rawRequest(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: {
          ...extraHeaders,
          ...(data
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
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

function requiresTestProjectContext(method: string, requestPath: string): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return false;
  const pathname = new URL(requestPath, "http://localhost").pathname;
  return pathname.startsWith("/api/");
}

function updateTestWorkspaceContext(payload: any): void {
  const workspace = payload?.workspace?.canvasProject ? payload.workspace : payload;
  const canvasProjectId = workspace?.canvasProject?.id;
  const revision = workspace?.revision;
  if (typeof canvasProjectId === "string" && Number.isSafeInteger(revision)) {
    requestWorkspaceContext = { canvasProjectId, revision };
  }
}

async function patchAppSettings(
  port: number,
  settings: Record<string, unknown>,
): Promise<Resp> {
  const workspace = await request(port, "GET", "/api/workspace");
  return await request(port, "PATCH", "/api/settings", {
    ...settings,
    canvasProjectId: workspace.json.canvasProject.id,
  });
}

function streamingRequest(
  port: number,
  method: string,
  requestPath: string,
  includeProjectContext = true,
): { req: http.ClientRequest; response: Promise<Resp> } {
  let req!: http.ClientRequest;
  const projectHeaders: Record<string, string> = {};
  if (
    includeProjectContext &&
    requiresTestProjectContext(method, requestPath) &&
    requestWorkspaceContext
  ) {
    projectHeaders["X-Agent-Canvas-Project-Id"] = requestWorkspaceContext.canvasProjectId;
    projectHeaders["X-Agent-Canvas-Project-Revision"] = String(
      requestWorkspaceContext.revision,
    );
  }
  const response = new Promise<Resp>((resolve, reject) => {
    req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: requestPath,
        headers: {
          "Content-Type": "application/json",
          ...projectHeaders,
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
  });
  return { req, response };
}

function nextWebSocketFrame(socket: WebSocket, type: string): Promise<any> {
  return new Promise((resolve) => {
    const onMessage = (payload: RawData) => {
      const frame = JSON.parse(String(payload));
      if (frame.type !== type) return;
      socket.off("message", onMessage);
      resolve(frame);
    };
    socket.on("message", onMessage);
  });
}

describe("HTTP server", () => {
  let server: http.Server;
  let manager: AgentManager;
  let port = 0;
  let root = "";
  let projectRoot = "";
  let trackedWorkDocumentationCwd: string | undefined;
  let beforeNextProjectStatePromptImport: (() => Promise<void>) | undefined;
  let resolveTurnContextForTest: () => Promise<{ baseCommitSha?: string }> = async () => ({});
  let workspaceManager: WorkspaceManager;
  let syncHost: FakeSyncHost;
  let pullRequestFlowManager: PullRequestFlowManager;
  let syncFlowManager: SyncFlowManager;
  const openFile = vi
    .fn<(filePath: string, options?: OpenInVscodeOptions) => Promise<void>>()
    .mockResolvedValue(undefined);
  const pickDirectory = vi
    .fn<(initialDirectory?: string) => Promise<string | undefined>>()
    .mockResolvedValue("C:\\picked");

  beforeAll(async () => {
    manager = new AgentManager({
      query: emptyQuery,
      resolveTurnContext: async () => await resolveTurnContextForTest(),
    });
    root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-server-"));
    projectRoot = path.join(root, "project");
    const runGit: GitRunner = async (args, options) => {
      if (args[0] === "remote") return "https://github.com/acme/demo.git";
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
      if (args[0] === "worktree" && args[1] === "move") {
        await rename(String(args[2]), String(args[3]));
        return "";
      }
      if (args[0] === "rev-parse") {
        if (args[1] === "--verify") return "a".repeat(40);
        return path.join(options?.cwd ?? "", ".git", "info", "exclude");
      }
      if (
        args[0] === "ls-files" &&
        trackedWorkDocumentationCwd &&
        path.resolve(options?.cwd ?? "").toLowerCase() ===
          path.resolve(trackedWorkDocumentationCwd).toLowerCase()
      ) {
        return ".agent-docs/index.md";
      }
      return "";
    };
    workspaceManager = new WorkspaceManager({
      defaultSourcePath: root,
      projectRoot,
      projectsRoot: path.join(root, "projects-index"),
      runGit,
    });
    await workspaceManager.connect({ localPath: root });
    const fileManager = new FileManager({
      workspaceRoot: root,
      isolatedRoot: path.join(root, "isolated"),
    });
    const promptManager = new PromptManager({
      workspaceRoot: root,
      promptRoot: path.join(root, "prompts"),
    });
    const importPromptState = promptManager.importState.bind(promptManager);
    vi.spyOn(promptManager, "importState").mockImplementation(async (state) => {
      const beforeImport = beforeNextProjectStatePromptImport;
      beforeNextProjectStatePromptImport = undefined;
      if (beforeImport) await beforeImport();
      await importPromptState(state);
    });
    syncHost = new FakeSyncHost();
    syncFlowManager = new SyncFlowManager({ host: syncHost });
    ({ httpServer: server, pullRequestFlowManager } = createServer(manager, fileManager, {
      defaultCwd: root,
      openFile,
      pickDirectory,
      promptManager,
      workspaceManager,
      syncFlowManager,
      codexAuthManager: new FakeCodexAuthManager(),
      codexModelDetection: {
        models: ["gpt-5.6-sol", "gpt-5.6-terra"],
        defaultModel: "gpt-5.6-sol",
        reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
        modelCapabilities: [
          {
            model: "gpt-5.6-sol",
            reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
            defaultReasoningEffort: "medium",
          },
          {
            model: "gpt-5.6-terra",
            reasoningEfforts: ["low", "medium", "high", "xhigh"],
            defaultReasoningEffort: "medium",
          },
        ],
        version: "0.141.0",
      },
      commitManager: new CommitManager({
        runGit: async (args) => {
          if (args[0] === "rev-parse") return "abcdef1234567890";
          if (args[0] === "branch") return "feature/server-test";
          if (args[0] === "show" && args.includes("--name-status")) return "M\tsrc/a.ts";
          if (args[0] === "show" && args.includes("--patch")) {
            return [
              "diff --git a/src/a.ts b/src/a.ts",
              "index 1111111..2222222 100644",
              "--- a/src/a.ts",
              "+++ b/src/a.ts",
              "@@ -1 +1 @@",
              "-old",
              "+new",
            ].join("\n");
          }
          if (args[0] === "show" && args.includes("-s")) {
            return [
              "abcdef1234567890",
              "abcdef1",
              "Agent",
              "agent@example.com",
              "2026-06-22T00:00:00Z",
              "2026-06-22T00:00:01Z",
              "feat: server commit",
              "",
            ].join("\x1f");
          }
          return "";
        },
      }),
    }));
    await new Promise<void>((r) => server.listen(0, r));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await removeTempRoot(root);
  });

  it("GET /api/health → 200 ok", async () => {
    const { status, json } = await request(port, "GET", "/api/health");
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
  });

  it("exposes default cwd and directory picker", async () => {
    const config = await request(port, "GET", "/api/config");
    expect(config).toEqual({
      status: 200,
      json: {
        defaultCwd: root,
        projectRoot,
        codexModels: ["gpt-5.6-sol", "gpt-5.6-terra"],
        defaultCodexModel: "gpt-5.6-sol",
        codexReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
        codexModelCapabilities: [
          {
            model: "gpt-5.6-sol",
            reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
            defaultReasoningEffort: "medium",
          },
          {
            model: "gpt-5.6-terra",
            reasoningEfforts: ["low", "medium", "high", "xhigh"],
            defaultReasoningEffort: "medium",
          },
        ],
        codexVersion: "0.141.0",
      },
    });

    const picked = await request(port, "POST", "/api/directories/pick", {
      initialDirectory: root,
    });
    expect(picked).toEqual({ status: 200, json: { path: "C:\\picked" } });
    expect(pickDirectory).toHaveBeenCalledWith(root);
  });

  it("exposes and updates app settings", async () => {
    const initial = await request(port, "GET", "/api/settings");
    expect(initial).toEqual({
      status: 200,
      json: { fullPermissionMode: false, workDocumentationEnabled: false },
    });

    const invalid = await patchAppSettings(port, {
      workDocumentationEnabled: "false",
    });
    expect(invalid).toEqual({
      status: 400,
      json: { error: "设置项必须是 boolean" },
    });

    const updated = await patchAppSettings(port, {
      fullPermissionMode: true,
      workDocumentationEnabled: true,
    });
    expect(updated).toEqual({
      status: 200,
      json: { fullPermissionMode: true, workDocumentationEnabled: true },
    });
    const mainWorkspace = path.join(projectRoot, "repos", "repo_1", "repo");
    await expect(
      readFile(path.join(mainWorkspace, ".agent-docs", "index.md"), "utf-8"),
    ).resolves.toContain("Branch 工作文档索引");
    await expect(
      readFile(path.join(mainWorkspace, ".agent-shared-docs", "index.md"), "utf-8"),
    ).resolves.toContain("共享 Branch 文档索引");

    await patchAppSettings(port, {
      fullPermissionMode: false,
      workDocumentationEnabled: false,
    });
  });

  it("reports work-documentation failures as partial success after workspace mutations", async () => {
    const mainWorkspace = path.join(projectRoot, "repos", "repo_1", "repo");
    const enabled = await patchAppSettings(port, {
      workDocumentationEnabled: true,
    });
    expect(enabled.status).toBe(200);

    trackedWorkDocumentationCwd = mainWorkspace;
    const connected = await request(port, "POST", "/api/workspace/connect", {
      localPath: root,
    });
    expect(connected.status).toBe(207);
    expect(connected.json).toMatchObject({
      partialSuccess: true,
      workDocumentation: {
        ready: false,
        error: expect.stringContaining("Git"),
      },
      branches: [{ branch: "main", worktreePath: mainWorkspace }],
    });
    expect((await request(port, "GET", "/api/workspace")).json.branches).toContainEqual(
      expect.objectContaining({ branch: "main", worktreePath: mainWorkspace }),
    );

    trackedWorkDocumentationCwd = undefined;
    expect(
      (await patchAppSettings(port, { workDocumentationEnabled: true }))
        .status,
    ).toBe(200);

    const branchName = "feature/partial-documentation";
    const branchWorkspace = path.join(
      projectRoot,
      "worktrees",
      "repo_1",
      "feature-partial-documentation",
    );
    trackedWorkDocumentationCwd = branchWorkspace;
    const created = await request(port, "POST", "/api/workspace/branches", {
      branch: branchName,
    });
    expect(created.status).toBe(207);
    expect(created.json).toMatchObject({
      branch: { branch: branchName, worktreePath: branchWorkspace },
      partialSuccess: true,
      workDocumentation: {
        ready: false,
        error: expect.stringContaining("Git"),
      },
    });
    expect((await request(port, "GET", "/api/workspace/branches")).json.branches).toContainEqual(
      expect.objectContaining({ branch: branchName, worktreePath: branchWorkspace }),
    );

    trackedWorkDocumentationCwd = undefined;
    expect(
      (await patchAppSettings(port, { workDocumentationEnabled: false }))
        .status,
    ).toBe(200);
  });

  it("exposes Codex login status and starts device auth", async () => {
    const initial = await request(port, "GET", "/api/codex-auth/status");
    expect(initial).toEqual({
      status: 200,
      json: {
        status: { state: "unauthenticated", message: "Not logged in" },
        login: null,
      },
    });

    const started = await request(port, "POST", "/api/codex-auth/login");
    expect(started.status).toBe(202);
    expect(started.json.login).toMatchObject({
      state: "running",
      loginUrl: "https://auth.openai.com/device",
      userCode: "ABCD-EFGH",
    });

    const authenticated = await request(port, "GET", "/api/codex-auth/status");
    expect(authenticated.json.status.state).toBe("authenticated");
  });

  it("exposes GitHub workspace branches and creates agents on a selected branch", async () => {
    const branches = await request(port, "GET", "/api/workspace/branches");
    expect(branches.status).toBe(200);
    expect(branches.json.branches[0]).toMatchObject({
      branch: "main",
      worktreePath: path.join(projectRoot, "repos", "repo_1", "repo"),
    });

    const feature = await request(port, "POST", "/api/workspace/branches", {
      branch: "feature/server-test",
    });
    expect(feature.status).toBe(201);

    const resource = await request(port, "POST", "/api/workspace/shared-resources", {
      name: "dataset",
      mountPath: "data/raw",
      access: "readOnly",
    });
    expect(resource.status).toBe(201);

    const created = await request(port, "POST", "/api/agents", {
      branchWorkspaceId: feature.json.branch.id,
      systemPrompt: "branch rules",
    });
    expect(created.status).toBe(201);

    const listed = await request(port, "GET", "/api/agents");
    const snapshot = listed.json.agents.find(
      (agent: { id: string }) => agent.id === created.json.id,
    );
    expect(snapshot.config).toMatchObject({
      branchWorkspaceId: feature.json.branch.id,
      branch: "feature/server-test",
      cwd: feature.json.branch.worktreePath,
      systemPrompt: "branch rules",
    });
  });

  it("updates an idle agent to another branch workspace", async () => {
    const feature = await request(port, "POST", "/api/workspace/branches", {
      branch: "feature/settings-switch",
    });
    expect(feature.status).toBe(201);

    const created = await request(port, "POST", "/api/agents", {
      branch: "main",
      systemPrompt: "switchable",
    });
    expect(created.status).toBe(201);

    const updated = await request(port, "PATCH", `/api/agents/${created.json.id}/settings`, {
      branchWorkspaceId: feature.json.branch.id,
      systemPrompt: "switchable",
    });
    expect(updated.status).toBe(200);
    expect(updated.json.config).toMatchObject({
      branchWorkspaceId: feature.json.branch.id,
      branch: "feature/settings-switch",
      cwd: feature.json.branch.worktreePath,
      systemPrompt: "switchable",
    });
  });

  it("retries deferred PR and sync reviews when waiting agents switch to their destination branches", async () => {
    const isolatedRoot = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-branch-retry-"));
    const isolatedProjectRoot = path.join(isolatedRoot, "project");
    const isolatedRunGit: GitRunner = async (args, options) => {
      if (args[0] === "remote") return "https://github.com/acme/branch-retry.git";
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
      if (args[0] === "worktree" && args[1] === "move") {
        await rename(String(args[2]), String(args[3]));
        return "";
      }
      if (args[0] === "rev-parse") {
        if (args[1] === "--verify") return "a".repeat(40);
        return path.join(options?.cwd ?? "", ".git", "info", "exclude");
      }
      return "";
    };
    const isolatedWorkspaceManager = new WorkspaceManager({
      defaultSourcePath: isolatedRoot,
      projectRoot: isolatedProjectRoot,
      projectsRoot: path.join(isolatedRoot, "projects-index"),
      runGit: isolatedRunGit,
    });
    const isolatedProject = await isolatedWorkspaceManager.connect({
      localPath: isolatedRoot,
    });
    const mainBranch = isolatedProject.branches[0]!;
    const destinationBranch = await isolatedWorkspaceManager.createBranch({
      branch: "feature/branch-retry",
    });
    const isolatedQuery: QueryFn = () => {
      let close!: () => void;
      const closed = new Promise<void>((resolve) => {
        close = resolve;
      });
      return {
        async *[Symbol.asyncIterator]() {
          yield {
            type: "system" as const,
            subtype: "init" as const,
            session_id: "session-branch-retry",
            model: "codex-test",
            cwd: destinationBranch.worktreePath,
            tools: [],
          };
          await closed;
        },
        terminate: async () => close(),
      };
    };
    const isolatedManager = new AgentManager({ query: isolatedQuery });
    const isolatedReviewQueue = new BranchReviewQueue();
    const isolatedPrManager = new PullRequestFlowManager({
      host: isolatedManager,
      reviewQueue: isolatedReviewQueue,
    });
    const isolatedSyncManager = new SyncFlowManager({
      host: isolatedManager,
      reviewQueue: isolatedReviewQueue,
    });
    const { httpServer: isolatedServer } = createServer(isolatedManager, undefined, {
      defaultCwd: isolatedRoot,
      workspaceManager: isolatedWorkspaceManager,
      reviewQueue: isolatedReviewQueue,
      pullRequestFlowManager: isolatedPrManager,
      syncFlowManager: isolatedSyncManager,
    });

    try {
      await new Promise<void>((resolve) => isolatedServer.listen(0, resolve));
      const isolatedPort = (isolatedServer.address() as AddressInfo).port;
      const workspace = await rawRequest(isolatedPort, "GET", "/api/workspace");
      const projectHeaders = {
        "X-Agent-Canvas-Project-Id": workspace.json.canvasProject.id as string,
        "X-Agent-Canvas-Project-Revision": String(workspace.json.revision),
      };
      const createdReviewer = await rawRequest(
        isolatedPort,
        "POST",
        "/api/agents",
        { branchWorkspaceId: mainBranch.id },
        projectHeaders,
      );
      expect(createdReviewer.status).toBe(201);
      const reviewerId = createdReviewer.json.id as string;
      const reviewerSnapshot = isolatedManager.snapshot(reviewerId)!;
      isolatedManager.get(reviewerId)!.restore({
        ...reviewerSnapshot,
        status: "waiting_input",
        sessionId: `session-${reviewerId}`,
        config: {
          ...reviewerSnapshot.config,
          resume: `session-${reviewerId}`,
        },
      });
      const prFlow = await isolatedPrManager.create({
        proposerAgentId: reviewerId,
        sourceBranch: destinationBranch.branch,
        targetBranch: "main",
        summary: "Wait for the reviewer to switch to the PR source branch",
        files: ["src/pr.ts"],
      });
      const syncFlow = await isolatedSyncManager.create({
        kind: "branch_pull",
        proposerAgentId: reviewerId,
        sourceBranch: "main",
        targetBranch: destinationBranch.branch,
        strategy: "merge",
        summary: "Wait for the reviewer to switch to the pull target branch",
        reason: "Exercise destination-branch retry",
        files: ["src/sync.ts"],
      });

      expect(isolatedPrManager.get(prFlow.id)).toMatchObject({
        status: "queued",
        failureReason: expect.stringContaining("active reviewer"),
      });
      expect(isolatedSyncManager.get(syncFlow.id)).toMatchObject({
        status: "queued",
      });
      expect(isolatedSyncManager.get(syncFlow.id)?.reviewRequest).toBeUndefined();

      const prSwitch = await rawRequest(
        isolatedPort,
        "PATCH",
        `/api/agents/${reviewerId}/settings`,
        { branchWorkspaceId: destinationBranch.id },
        projectHeaders,
      );
      expect(prSwitch.status).toBe(200);
      expect(isolatedPrManager.get(prFlow.id)).toMatchObject({
        status: "source_review_collecting",
        currentStage: "source_preflight",
      });
      expect(isolatedPrManager.get(prFlow.id)?.reviewRequests.at(-1)?.requestedAgentIds).toEqual([
        reviewerId,
      ]);
      expect(isolatedSyncManager.get(syncFlow.id)?.status).toBe("queued");

      await vi.waitFor(() => {
        expect(isolatedManager.snapshot(reviewerId)?.status).toBe("running");
      });
      isolatedPrManager.cancel(prFlow.id);
      await vi.waitFor(() => {
        expect(isolatedSyncManager.get(syncFlow.id)?.status).toBe("review_collecting");
      });
      expect(isolatedSyncManager.get(syncFlow.id)).toMatchObject({
        status: "review_collecting",
      });
      expect(isolatedSyncManager.get(syncFlow.id)?.reviewRequest?.requestedAgentIds).toEqual([
        reviewerId,
      ]);

      isolatedSyncManager.cancel(syncFlow.id);
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      await new Promise<void>((resolve) => isolatedServer.close(() => resolve()));
      await isolatedManager.clear();
      await removeTempRoot(isolatedRoot);
    }
  });

  it("POST /api/agents 新建，GET /api/agents 能列出", async () => {
    const created = await request(port, "POST", "/api/agents");
    expect(created.status).toBe(201);
    expect(created.json.id).toMatch(/^agent_/);

    const listed = await request(port, "GET", "/api/agents");
    expect(listed.status).toBe(200);
    expect(listed.json.agents.length).toBeGreaterThanOrEqual(1);
  });

  it("opens an agent branch workspace with VS Code", async () => {
    const feature = await request(port, "POST", "/api/workspace/branches", {
      branch: "feature/open-workspace",
    });
    expect(feature.status).toBe(201);

    const created = await request(port, "POST", "/api/agents", {
      branchWorkspaceId: feature.json.branch.id,
    });
    expect(created.status).toBe(201);

    openFile.mockClear();
    const opened = await request(port, "POST", `/api/agents/${created.json.id}/open-workspace`);

    expect(opened).toEqual({ status: 202, json: { ok: true } });
    expect(openFile).toHaveBeenCalledWith(feature.json.branch.worktreePath, {
      windowMode: "new",
    });
  });

  it("creates agents with settings and updates private system prompt", async () => {
    const created = await request(port, "POST", "/api/agents", {
      provider: "codex",
      model: "gpt-5.4-mini",
      cwd: path.join(root, "agent-work"),
      systemPrompt: "private rules",
    });
    expect(created.status).toBe(201);

    const listed = await request(port, "GET", "/api/agents");
    const snapshot = listed.json.agents.find(
      (agent: { id: string }) => agent.id === created.json.id,
    );
    expect(snapshot.config).toMatchObject({
      provider: "codex",
      model: "gpt-5.4-mini",
      cwd: path.join(projectRoot, "repos", "repo_1", "repo"),
      systemPrompt: "private rules",
    });

    const updated = await request(port, "PATCH", `/api/agents/${created.json.id}/settings`, {
      systemPrompt: "updated private rules",
    });
    expect(updated.status).toBe(200);
    expect(updated.json.config.systemPrompt).toBe("updated private rules");
    expect(updated.json.config.cwd).toBe(path.join(projectRoot, "repos", "repo_1", "repo"));
  });

  it("对未知 agent start → 404", async () => {
    const r = await request(port, "POST", "/api/agents/nope/start", { prompt: "x" });
    expect(r.status).toBe(404);
  });

  it("start 缺 prompt → 400", async () => {
    const c = await request(port, "POST", "/api/agents");
    const r = await request(port, "POST", `/api/agents/${c.json.id}/start`, {});
    expect(r.status).toBe(400);
  });

  it("新建后 start → 202", async () => {
    const c = await request(port, "POST", "/api/agents");
    const r = await request(port, "POST", `/api/agents/${c.json.id}/start`, { prompt: "hi" });
    expect(r.status).toBe(202);
  });

  it("agent 上报 commit 后返回 commit 节点快照", async () => {
    const created = await request(port, "POST", "/api/agents", {
      branch: "feature/server-test",
    });
    expect(created.status).toBe(201);

    const reported = await request(port, "POST", `/api/agents/${created.json.id}/commits`, {
      commit: "HEAD",
      summary: "server route summary",
    });

    expect(reported.status).toBe(201);
    expect(reported.json.commit).toMatchObject({
      agentId: created.json.id,
      sourceTurnIndex: 0,
      commitSha: "abcdef1234567890",
      shortSha: "abcdef1",
      branch: "feature/server-test",
      summary: "server route summary",
      files: [{ status: "M", path: "src/a.ts", additions: 1, deletions: 1 }],
    });

    const listed = await request(port, "GET", "/api/commits");
    expect(listed.json.commits.some((commit: { id: string }) => commit.id === reported.json.commit.id)).toBe(
      true,
    );
  });

  it("agent can report result files from content or a workspace sourcePath", async () => {
    const created = await request(port, "POST", "/api/agents", {
      branch: "feature/server-test",
    });
    expect(created.status).toBe(201);

    const reported = await request(
      port,
      "POST",
      `/api/agents/${created.json.id}/report-result`,
      {
        name: "metrics-summary",
        extension: "md",
        resultKind: "document",
        title: "Metrics summary",
        summary: "small report",
        content: "## Metrics\n\naccuracy: 0.92",
      },
    );

    expect(reported.status).toBe(201);
    expect(reported.json.file).toMatchObject({
      name: "metrics-summary",
      filename: "metrics-summary.md",
      previewKind: "markdown",
      origin: {
        kind: "agent_result",
        agentId: created.json.id,
        sourceTurnIndex: 0,
        resultKind: "document",
        title: "Metrics summary",
        summary: "small report",
      },
    });
    const content = await request(
      port,
      "GET",
      `/api/files/${reported.json.file.id}/content?full=1`,
    );
    expect(content.json.content).toBe("## Metrics\n\naccuracy: 0.92");

    const agents = await request(port, "GET", "/api/agents");
    const snapshot = agents.json.agents.find(
      (agent: { id: string }) => agent.id === created.json.id,
    );
    if (!snapshot) throw new Error("missing created agent snapshot");
    const sourceDirectory = path.join(snapshot.config.cwd, ".agent-tmp", created.json.id);
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(path.join(sourceDirectory, "table.csv"), "metric,value\naccuracy,0.92\n");

    const copied = await request(
      port,
      "POST",
      `/api/agents/${created.json.id}/report-result`,
      {
        name: "table.csv",
        resultKind: "table",
        summary: "copied csv",
        sourcePath: `.agent-tmp/${created.json.id}/table.csv`,
      },
    );

    expect(copied.status).toBe(201);
    expect(copied.json.file).toMatchObject({
      name: "table",
      filename: "table.csv",
      previewKind: "csv",
      origin: {
        kind: "agent_result",
        agentId: created.json.id,
        sourceTurnIndex: 0,
        resultKind: "table",
        summary: "copied csv",
      },
    });
    const copiedContent = await request(
      port,
      "GET",
      `/api/files/${copied.json.file.id}/content?full=1`,
    );
    expect(copiedContent.json.content).toBe("metric,value\naccuracy,0.92\n");
  });

  it("sync flow REST supports create, review authorization and applied fallback", async () => {
    const created = await request(port, "POST", "/api/sync-flows", {
      kind: "cherry_pick",
      proposerAgentId: "agent_sync",
      sourceBranch: "main",
      commitSha: "abcdef123456",
      summary: "Apply shared fix",
      reason: "Feature branch needs this commit",
      files: ["src/sync.ts"],
    });

    expect(created.status).toBe(201);
    expect(created.json.flow).toMatchObject({
      kind: "cherry_pick",
      proposerAgentId: "agent_sync",
      status: "review_collecting",
      files: ["src/sync.ts"],
    });

    const reviewedAt = Date.now() + 1;
    syncHost.assistant(
      JSON.stringify({
        agentCanvasSyncReview: true,
        flowId: created.json.flow.id,
        decision: "approve",
        summary: "safe to apply",
        risks: [],
        filesReviewed: ["src/sync.ts"],
        requiredChanges: [],
      }),
      reviewedAt,
    );
    await syncFlowManager.handleAgentEvent(syncHost.result(reviewedAt));

    const authorized = await request(port, "GET", `/api/sync-flows/${created.json.flow.id}`);
    expect(authorized.json.flow.status).toBe("apply_authorized");

    const applied = await request(
      port,
      "POST",
      `/api/sync-flows/${created.json.flow.id}/applied`,
      {
        summary: "Applied shared fix",
        files: ["src/sync.ts"],
      },
    );

    expect(applied.status).toBe(200);
    expect(applied.json.flow).toMatchObject({
      status: "applied",
      applied: { summary: "Applied shared fix", files: ["src/sync.ts"] },
    });

    const listedSyncFlows = await request(port, "GET", "/api/sync-flows");
    expect(
      listedSyncFlows.json.flows.some((flow: { id: string }) => flow.id === created.json.flow.id),
    ).toBe(true);
  });

  it("keeps tokenless agent flow callbacks compatible with project revision enforcement", async () => {
    const created = await rawRequest(port, "POST", "/api/sync-flows", {
      kind: "cherry_pick",
      proposerAgentId: "agent_sync",
      sourceBranch: "main",
      commitSha: "abcdef123456",
      summary: "Agent protocol compatibility",
      reason: "Agent callbacks do not receive browser workspace revision headers",
      files: ["src/compatibility.ts"],
    });

    expect(created.status).toBe(201);
    const cancelled = await rawRequest(
      port,
      "POST",
      `/api/sync-flows/${created.json.flow.id}/cancel`,
    );
    expect(cancelled.status).toBe(200);
    expect(cancelled.json.flow.status).toBe("cancelled");
  });

  it("history 记录用户输入", async () => {
    const c = await request(port, "POST", "/api/agents");
    await request(port, "POST", `/api/agents/${c.json.id}/start`, { prompt: "保留这条输入" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const history = await request(port, "GET", `/api/agents/${c.json.id}/history`);
    expect(history.status).toBe(200);
    expect(history.json.events.some(
      (entry: { event?: { kind?: string; text?: string } }) =>
        entry.event?.kind === "user_input" && entry.event.text === "保留这条输入",
    )).toBe(true);
  });

  it("未建立会话时 compact → 409", async () => {
    const c = await request(port, "POST", "/api/agents");
    const r = await request(port, "POST", `/api/agents/${c.json.id}/compact`);
    expect(r.status).toBe(409);
  });

  it("steer 缺 text → 400，非运行状态 → 409", async () => {
    const c = await request(port, "POST", "/api/agents");
    const missingText = await request(port, "POST", `/api/agents/${c.json.id}/steer`, {});
    expect(missingText.status).toBe(400);

    const notRunning = await request(port, "POST", `/api/agents/${c.json.id}/steer`, {
      text: "请立刻调整",
    });
    expect(notRunning.status).toBe(409);
  });

  it("terminate → 202", async () => {
    const c = await request(port, "POST", "/api/agents");
    const r = await request(port, "POST", `/api/agents/${c.json.id}/terminate`);
    expect(r.status).toBe(202);
  });

  it("fork 缺 anchorUuid → 400", async () => {
    const c = await request(port, "POST", "/api/agents");
    const r = await request(port, "POST", `/api/agents/${c.json.id}/fork`, {});
    expect(r.status).toBe(400);
  });

  it("源会话未建立时 fork → 409", async () => {
    const c = await request(port, "POST", "/api/agents");
    const r = await request(port, "POST", `/api/agents/${c.json.id}/fork`, { anchorUuid: "u" });
    expect(r.status).toBe(409);
  });

  it("未知路由 → 404", async () => {
    const r = await request(port, "GET", "/nope");
    expect(r.status).toBe(404);
  });

  it("creates file nodes only in isolated storage", async () => {
    const created = await request(port, "POST", "/api/files", {
      name: "brief",
      extension: "md",
      kind: "normal",
    });
    expect(created.status).toBe(201);
    expect(created.json.file.path).toBe(
      path.join(projectRoot, "files", created.json.file.id, "brief.md"),
    );
    expect(created.json.file.storage).toBe("isolated");

    const rejected = await request(port, "POST", "/api/files", {
      name: "bad",
      storage: "agent",
      kind: "normal",
    });
    expect(rejected.status).toBe(400);
  });

  it("文件节点 REST 支持创建、重命名、预览与普通读连线", async () => {
    const agent = await request(port, "POST", "/api/agents");
    const created = await request(port, "POST", "/api/files", {
      name: "notes",
      extension: "txt",
      storage: "isolated",
      kind: "normal",
    });
    expect(created.status).toBe(201);
    expect(created.json.file.filename).toBe("notes.txt");

    const updated = await request(port, "PATCH", `/api/files/${created.json.file.id}`, {
      name: "renamed",
      extension: "md",
    });
    expect(updated.status).toBe(200);
    expect(updated.json.file.filename).toBe("renamed.md");

    const preview = await request(port, "GET", `/api/files/${created.json.file.id}/content`);
    expect(preview).toMatchObject({
      status: 200,
      json: { content: "", truncated: false },
    });

    const longContent = "x".repeat(300 * 1024);
    await writeFile(updated.json.file.path, longContent, "utf-8");
    const truncated = await request(port, "GET", `/api/files/${created.json.file.id}/content`);
    expect(truncated.json.truncated).toBe(true);
    const full = await request(
      port,
      "GET",
      `/api/files/${created.json.file.id}/content?full=1`,
    );
    expect(full).toEqual({
      status: 200,
      json: { content: longContent, truncated: false },
    });

    const opened = await request(
      port,
      "POST",
      `/api/files/${created.json.file.id}/open`,
    );
    expect(opened).toEqual({ status: 202, json: { ok: true } });
    expect(openFile).toHaveBeenCalledWith(updated.json.file.path, {
      windowMode: "reuse",
    });

    const connection = await request(port, "POST", "/api/file-connections", {
      fileId: created.json.file.id,
      agentId: agent.json.id,
      access: "read",
    });
    expect(connection.status).toBe(201);

    const listed = await request(port, "GET", "/api/file-connections");
    expect(listed.json.connections).toContainEqual(connection.json.connection);

    const removed = await request(
      port,
      "DELETE",
      `/api/file-connections/${connection.json.connection.id}`,
    );
    expect(removed.status).toBe(204);
  });

  it("提示词节点 REST 支持创建、编辑、共享开关与普通连线", async () => {
    const agent = await request(port, "POST", "/api/agents");
    const normal = await request(port, "POST", "/api/prompts", {
      name: "工程规范",
      content: "先写测试",
      kind: "normal",
    });
    expect(normal.status).toBe(201);

    const updated = await request(port, "PATCH", `/api/prompts/${normal.json.prompt.id}`, {
      content: "先写测试，再实现",
    });
    expect(updated.json.prompt.content).toBe("先写测试，再实现");

    const connection = await request(port, "POST", "/api/prompt-connections", {
      promptId: normal.json.prompt.id,
      agentId: agent.json.id,
      access: "read",
    });
    expect(connection.status).toBe(201);

    const shared = await request(port, "POST", "/api/prompts", {
      name: "共享规范",
      content: "保持简洁",
      kind: "shared",
    });
    const enabled = await request(port, "PATCH", `/api/prompts/${shared.json.prompt.id}`, {
      sharedRead: true,
      sharedWrite: true,
    });
    expect(enabled.json.prompt).toMatchObject({
      sharedRead: true,
      sharedWrite: true,
    });

    const listed = await request(port, "GET", "/api/prompts");
    expect(listed.json.prompts).toHaveLength(2);
    const connections = await request(port, "GET", "/api/prompt-connections");
    expect(connections.json.connections).toContainEqual(connection.json.connection);
  });

  it("broadcasts authoritative workspace revisions to every connected client", async () => {
    await manager.clear();
    const created = await request(port, "POST", "/api/canvas-projects", {
      name: "workspace-broadcasts",
    });
    expect(created.status).toBe(201);
    const socketA = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const socketB = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const initialFrames = [
      nextWebSocketFrame(socketA, "hello"),
      nextWebSocketFrame(socketA, "workspace"),
      nextWebSocketFrame(socketB, "hello"),
      nextWebSocketFrame(socketB, "workspace"),
    ];
    await Promise.all([once(socketA, "open"), once(socketB, "open")]);
    await Promise.all(initialFrames);

    const connectedFrames = [
      nextWebSocketFrame(socketA, "workspace"),
      nextWebSocketFrame(socketB, "workspace"),
    ];
    const connected = await request(port, "POST", "/api/workspace/connect", {
      localPath: root,
    });
    expect(connected.status).toBe(200);
    const [connectedA, connectedB] = await Promise.all(connectedFrames);
    for (const frame of [connectedA, connectedB]) {
      expect(frame.workspace).toMatchObject({
        canvasProject: { id: created.json.project.id },
        revision: connected.json.revision,
        repo: { defaultBranch: "main" },
      });
    }

    const branchFrames = [
      nextWebSocketFrame(socketA, "workspace"),
      nextWebSocketFrame(socketB, "workspace"),
    ];
    const branch = await request(port, "POST", "/api/workspace/branches", {
      branch: "feature/broadcast-to-peers",
    });
    expect(branch.status).toBe(201);
    const [branchA, branchB] = await Promise.all(branchFrames);
    for (const frame of [branchA, branchB]) {
      expect(frame.workspace.revision).toBe(connected.json.revision);
      expect(frame.workspace.branches).toContainEqual(
        expect.objectContaining({ branch: "feature/broadcast-to-peers" }),
      );
    }
    socketA.close();
    socketB.close();
  });

  it("canvas project REST 支持从自定义文件夹加载和删除项目", async () => {
    await manager.clear();
    const customProjectRoot = path.join(root, "custom-project-root");
    const created = await request(port, "POST", "/api/canvas-projects", {
      name: "custom-root",
      projectRoot: customProjectRoot,
    });

    expect(created.status).toBe(201);
    expect(created.json.project).toMatchObject({
      name: "custom-root",
      projectRoot: customProjectRoot,
    });
    expect(created.json.workspace.projectRoot).toBe(customProjectRoot);
    await expect(readFile(path.join(customProjectRoot, "workspace.json"), "utf-8")).resolves.toContain(
      '"schema": "agent-canvas/workspace"',
    );

    const loaded = await request(port, "POST", "/api/canvas-projects/open", {
      projectRoot: customProjectRoot,
    }, {
      Origin: "http://127.0.0.1:5317",
      "Sec-Fetch-Site": "same-origin",
    });
    expect(loaded.status).toBe(200);
    expect(loaded.json.workspace.canvasProject.id).toBe(created.json.project.id);

    const missingIntent = await request(
      port,
      "DELETE",
      `/api/canvas-projects/${encodeURIComponent(created.json.project.id)}`,
    );
    expect(missingIntent.status).toBe(403);

    const crossOrigin = await request(
      port,
      "DELETE",
      `/api/canvas-projects/${encodeURIComponent(created.json.project.id)}`,
      undefined,
      {
        Origin: "https://attacker.example",
        "Sec-Fetch-Site": "cross-site",
        "X-Agent-Canvas-Intent": "delete-project",
      },
    );
    expect(crossOrigin.status).toBe(403);
    await expect(readFile(path.join(customProjectRoot, "workspace.json"), "utf-8")).resolves.toContain(
      '"schema": "agent-canvas/workspace"',
    );

    await request(port, "POST", "/api/workspace/connect", { localPath: root });
    const activeAgent = await request(port, "POST", "/api/agents", { branch: "main" });
    expect(activeAgent.status).toBe(201);

    const activeCreate = await request(port, "POST", "/api/canvas-projects", {
      name: "blocked-by-active-agent",
    });
    expect(activeCreate.status).toBe(409);
    expect(activeCreate.json.error).toContain("活动 agent");
    const activeOpen = await request(port, "POST", "/api/canvas-projects/open", {
      id: created.json.project.id,
    });
    expect(activeOpen.status).toBe(409);
    expect(activeOpen.json.error).toContain("活动 agent");

    const activeDelete = await request(
      port,
      "DELETE",
      `/api/canvas-projects/${encodeURIComponent(created.json.project.id)}`,
      undefined,
      { "X-Agent-Canvas-Intent": "delete-project" },
    );
    expect(activeDelete.status).toBe(409);
    expect(activeDelete.json.error).toContain("活动 agent");
    await request(port, "POST", `/api/agents/${activeAgent.json.id}/terminate`);

    const activeFlow = await request(port, "POST", "/api/sync-flows", {
      kind: "cherry_pick",
      proposerAgentId: "agent_sync",
      sourceBranch: "main",
      commitSha: "feedface1234",
      summary: "Keep this project active while review is pending",
      reason: "Regression coverage for project switching",
      files: ["src/project-flow.ts"],
    });
    expect(activeFlow.status).toBe(201);
    const flowCreate = await request(port, "POST", "/api/canvas-projects", {
      name: "blocked-by-active-flow",
    });
    expect(flowCreate.status).toBe(409);
    expect(flowCreate.json.error).toContain("流程");
    const flowOpen = await request(port, "POST", "/api/canvas-projects/open", {
      id: created.json.project.id,
    });
    expect(flowOpen.status).toBe(409);
    expect(flowOpen.json.error).toContain("流程");
    const flowDelete = await request(
      port,
      "DELETE",
      `/api/canvas-projects/${encodeURIComponent(created.json.project.id)}`,
      undefined,
      { "X-Agent-Canvas-Intent": "delete-project" },
    );
    expect(flowDelete.status).toBe(409);
    expect(flowDelete.json.error).toContain("流程");
    expect(
      (
        await request(
          port,
          "POST",
          `/api/sync-flows/${encodeURIComponent(activeFlow.json.flow.id)}/cancel`,
        )
      ).status,
    ).toBe(200);

    const deleted = await request(
      port,
      "DELETE",
      `/api/canvas-projects/${encodeURIComponent(created.json.project.id)}`,
      undefined,
      { "X-Agent-Canvas-Intent": "delete-project" },
    );
    expect(deleted.status).toBe(200);
    expect(deleted.json.project.id).toBe(created.json.project.id);
    expect((await request(port, "GET", "/api/agents")).json.agents).toEqual([]);
    expect((await request(port, "GET", "/api/files")).json.files).toEqual([]);
    expect((await request(port, "GET", "/api/prompts")).json.prompts).toEqual([]);
    expect((await request(port, "GET", "/api/commits")).json.commits).toEqual([]);
    expect((await request(port, "GET", "/api/pr-flows")).json.flows).toEqual([]);
    expect((await request(port, "GET", "/api/sync-flows")).json.flows).toEqual([]);
    expect((await request(port, "GET", "/api/canvas-layout")).json.nodes).toEqual([]);
    await expect(readFile(path.join(customProjectRoot, "workspace.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps the current in-memory state intact when deleting its project fails", async () => {
    const created = await request(port, "POST", "/api/canvas-projects", {
      name: "delete-rollback",
    });
    const file = await request(port, "POST", "/api/files", {
      name: "must-survive-delete-failure",
      extension: "txt",
      kind: "normal",
    });
    expect(file.status).toBe(201);
    const workspacePath = path.join(created.json.project.projectRoot, "workspace.json");
    const validWorkspace = await readFile(workspacePath, "utf-8");
    await writeFile(workspacePath, "not valid json", "utf-8");

    const failed = await request(
      port,
      "DELETE",
      `/api/canvas-projects/${encodeURIComponent(created.json.project.id)}`,
      undefined,
      { "X-Agent-Canvas-Intent": "delete-project" },
    );
    expect(failed.status).toBe(404);
    expect((await request(port, "GET", "/api/files")).json.files).toContainEqual(
      expect.objectContaining({ id: file.json.file.id }),
    );
    expect((await request(port, "GET", "/api/workspace")).json.canvasProject.id).toBe(
      created.json.project.id,
    );

    await writeFile(workspacePath, validWorkspace, "utf-8");
    const deleted = await request(
      port,
      "DELETE",
      `/api/canvas-projects/${encodeURIComponent(created.json.project.id)}`,
      undefined,
      { "X-Agent-Canvas-Intent": "delete-project" },
    );
    expect(deleted.status).toBe(200);
  });

  it("rolls back a failed project open and broadcasts the restored workspace", async () => {
    const projectA = await request(port, "POST", "/api/canvas-projects", {
      name: "open-rollback-a",
    });
    await request(port, "POST", "/api/files", {
      name: "file-from-a",
      extension: "txt",
      kind: "normal",
    });
    const projectB = await request(port, "POST", "/api/canvas-projects", {
      name: "open-rollback-b",
    });
    const fileB = await request(port, "POST", "/api/files", {
      name: "file-from-b",
      extension: "txt",
      kind: "normal",
    });

    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const initialHello = nextWebSocketFrame(socket, "hello");
    const initialWorkspace = nextWebSocketFrame(socket, "workspace");
    await once(socket, "open");
    await initialHello;
    await initialWorkspace;
    const restoredWorkspace = nextWebSocketFrame(socket, "workspace");
    beforeNextProjectStatePromptImport = async () => {
      throw new Error("injected prompt import failure");
    };

    const failed = await request(port, "POST", "/api/canvas-projects/open", {
      id: projectA.json.project.id,
    });
    expect(failed.status).toBe(404);
    expect(failed.json.error).toContain("injected prompt import failure");
    await expect(restoredWorkspace).resolves.toMatchObject({
      type: "workspace",
      workspace: { canvasProject: { id: projectB.json.project.id } },
    });
    expect((await request(port, "GET", "/api/workspace")).json.canvasProject.id).toBe(
      projectB.json.project.id,
    );
    expect((await request(port, "GET", "/api/files")).json.files).toEqual([
      expect.objectContaining({ id: fileB.json.file.id, name: "file-from-b" }),
    ]);
    socket.close();

    await request(
      port,
      "DELETE",
      `/api/canvas-projects/${encodeURIComponent(projectA.json.project.id)}`,
      undefined,
      { "X-Agent-Canvas-Intent": "delete-project" },
    );
    await request(
      port,
      "DELETE",
      `/api/canvas-projects/${encodeURIComponent(projectB.json.project.id)}`,
      undefined,
      { "X-Agent-Canvas-Intent": "delete-project" },
    );
  });

  it("clears a failed project open when there is no previous project", async () => {
    const target = await request(port, "POST", "/api/canvas-projects", {
      name: "open-without-previous-target",
    });
    const disposable = await request(port, "POST", "/api/canvas-projects", {
      name: "open-without-previous-disposable",
    });
    expect(target.status).toBe(201);
    expect(disposable.status).toBe(201);
    await writeFile(
      path.join(target.json.project.projectRoot, "canvas-state.json"),
      "not valid json",
      "utf-8",
    );
    const deleted = await request(
      port,
      "DELETE",
      `/api/canvas-projects/${encodeURIComponent(disposable.json.project.id)}`,
      undefined,
      { "X-Agent-Canvas-Intent": "delete-project" },
    );
    expect(deleted.status).toBe(200);

    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const initialHello = nextWebSocketFrame(socket, "hello");
    const initialWorkspace = nextWebSocketFrame(socket, "workspace");
    await once(socket, "open");
    await initialHello;
    await initialWorkspace;
    const clearedWorkspace = nextWebSocketFrame(socket, "workspace");
    const clearedHello = nextWebSocketFrame(socket, "hello");

    const failed = await request(port, "POST", "/api/canvas-projects/open", {
      id: target.json.project.id,
    });
    expect(failed.status).toBe(404);
    expect(failed.json.error).toContain("JSON");
    await expect(clearedWorkspace).resolves.toMatchObject({
      type: "workspace",
      workDocumentation: { ready: true },
    });
    expect((await clearedWorkspace).workspace).toBeUndefined();
    await expect(clearedHello).resolves.toMatchObject({
      type: "hello",
      agents: [],
    });
    expect((await request(port, "GET", "/api/workspace")).status).toBe(409);
    expect((await request(port, "GET", "/api/files")).json.files).toEqual([]);
    socket.close();
  });

  it("keeps an adopted project root and reports authoritative partial success when state loading fails", async () => {
    const previous = await request(port, "POST", "/api/canvas-projects", {
      name: "create-rollback-previous",
    });
    const preservedFile = await request(port, "POST", "/api/files", {
      name: "preserved-across-create-failure",
      extension: "txt",
      kind: "normal",
    });
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const initialHello = nextWebSocketFrame(socket, "hello");
    const initialWorkspace = nextWebSocketFrame(socket, "workspace");
    await once(socket, "open");
    await initialHello;
    await initialWorkspace;
    const partialWorkspace = nextWebSocketFrame(socket, "workspace");
    const adoptedRoot = path.join(root, "adopted-create-failure");
    const sentinel = path.join(adoptedRoot, "user-sentinel.txt");
    await mkdir(adoptedRoot);
    beforeNextProjectStatePromptImport = async () => {
      await writeFile(sentinel, "preserve me", "utf-8");
      throw new Error("injected create import failure");
    };

    const failed = await request(port, "POST", "/api/canvas-projects", {
      name: "create-rollback-failed",
      projectRoot: adoptedRoot,
    });
    expect(failed.status).toBe(207);
    expect(failed.json).toMatchObject({
      project: { name: "create-rollback-failed", projectRoot: adoptedRoot },
      workspace: { canvasProject: { name: "create-rollback-failed" } },
      partialSuccess: true,
      workDocumentation: {
        ready: false,
        error: expect.stringContaining("injected create import failure"),
      },
    });
    await expect(partialWorkspace).resolves.toMatchObject({
      type: "workspace",
      workspace: { canvasProject: { name: "create-rollback-failed" } },
      partialSuccess: true,
      workDocumentation: { ready: false },
    });
    expect((await request(port, "GET", "/api/workspace")).json.canvasProject.name).toBe(
      "create-rollback-failed",
    );
    const rejectedMutation = await request(port, "POST", "/api/files", {
      name: "must-not-be-created",
      extension: "txt",
      kind: "normal",
    });
    expect(rejectedMutation.status).toBe(409);
    expect(rejectedMutation.json.error).toContain("read-only");
    expect((await request(port, "GET", "/api/files")).json.files).toEqual([]);
    await expect(readFile(sentinel, "utf-8")).resolves.toBe("preserve me");
    expect(
      (await request(port, "GET", "/api/canvas-projects")).json.projects.some(
        (project: { name: string }) => project.name === "create-rollback-failed",
      ),
    ).toBe(true);
    socket.close();
    expect(preservedFile.status).toBe(201);
    expect(previous.status).toBe(201);
  });

  it("canvas project 保存并恢复节点快照和布局", async () => {
    const projectA = await request(port, "POST", "/api/canvas-projects", {
      name: "persist-a",
    });
    expect(projectA.status).toBe(201);
    const connectedA = await request(port, "POST", "/api/workspace/connect", {
      localPath: root,
    });
    const mainWorkspace = connectedA.json.branches[0].worktreePath as string;
    await patchAppSettings(port, { workDocumentationEnabled: true });

    const agent = await request(port, "POST", "/api/agents", {
      branch: "main",
      systemPrompt: "persist me",
    });
    const file = await request(port, "POST", "/api/files", {
      name: "persisted-file",
      extension: "txt",
      kind: "normal",
    });
    const prompt = await request(port, "POST", "/api/prompts", {
      name: "persisted-prompt",
      content: "saved prompt",
      kind: "normal",
    });
    expect(agent.status).toBe(201);
    expect(file.status).toBe(201);
    expect(prompt.status).toBe(201);

    await writeManagedFileAtomically(file.json.file.path, "saved file atomically", {
      label: "authorized file save",
      expectedContent: "",
    });
    const promptPath = path.join(
      projectA.json.project.projectRoot,
      "prompts",
      prompt.json.prompt.id,
      "prompt.txt",
    );
    await writeManagedFileAtomically(promptPath, "saved prompt atomically", {
      label: "authorized prompt save",
      expectedContent: "saved prompt",
    });
    expect(
      (await request(port, "GET", `/api/files/${file.json.file.id}/content?full=1`)).json,
    ).toEqual({ content: "saved file atomically", truncated: false });
    expect((await request(port, "GET", "/api/prompts")).json.prompts).toContainEqual(
      expect.objectContaining({
        id: prompt.json.prompt.id,
        content: "saved prompt atomically",
      }),
    );

    const layout = await request(port, "PATCH", "/api/canvas-layout", {
      canvasProjectId: projectA.json.project.id,
      nodes: [
        {
          id: `${agent.json.id}#0`,
          type: "turn",
          position: { x: 123, y: 456 },
          width: 410,
          height: 320,
        },
        {
          id: `file:${file.json.file.id}`,
          type: "file",
          position: { x: 700, y: 120 },
          width: 68,
          height: 48,
          windowState: { minimized: true, restoreWidth: 280, restoreHeight: 240 },
        },
      ],
    });
    expect(layout.status).toBe(200);

    const persistedState = JSON.parse(
      await readFile(path.join(projectA.json.project.projectRoot, "canvas-state.json"), "utf-8"),
    );
    expect(persistedState).toMatchObject({
      version: 1,
      agents: {
        agents: [expect.objectContaining({ id: agent.json.id })],
        appSettings: {
          fullPermissionMode: false,
          workDocumentationEnabled: true,
        },
      },
      files: { files: [expect.objectContaining({ id: file.json.file.id })] },
      prompts: { prompts: [expect.objectContaining({ id: prompt.json.prompt.id })] },
      layout: {
        nodes: expect.arrayContaining([
          expect.objectContaining({ id: `${agent.json.id}#0` }),
        ]),
      },
    });

    await request(port, "POST", `/api/agents/${agent.json.id}/terminate`);

    const projectB = await request(port, "POST", "/api/canvas-projects", {
      name: "persist-b",
    });
    expect(projectB.status).toBe(201);
    expect((await request(port, "GET", "/api/agents")).json.agents).toHaveLength(0);
    expect((await request(port, "GET", "/api/settings")).json).toEqual({
      fullPermissionMode: false,
      workDocumentationEnabled: false,
    });

    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const initialHello = once(socket, "message");
    await once(socket, "open");
    await initialHello;
    const broadcastWorkspace = nextWebSocketFrame(socket, "workspace");
    const broadcastHello = nextWebSocketFrame(socket, "hello");
    trackedWorkDocumentationCwd = mainWorkspace;
    const reopened = await request(port, "POST", "/api/canvas-projects/open", {
      id: projectA.json.project.id,
    });
    trackedWorkDocumentationCwd = undefined;
    expect(reopened.status).toBe(207);
    expect(reopened.json).toMatchObject({
      workspace: {
        canvasProject: { id: projectA.json.project.id },
        branches: [{ branch: "main", worktreePath: mainWorkspace }],
      },
      partialSuccess: true,
      workDocumentation: {
        ready: false,
        error: expect.stringContaining("Git"),
      },
    });
    await expect(broadcastWorkspace).resolves.toMatchObject({
      type: "workspace",
      workspace: { canvasProject: { id: projectA.json.project.id } },
      partialSuccess: true,
      workDocumentation: { ready: false },
    });
    await expect(broadcastHello).resolves.toMatchObject({
      type: "hello",
      agents: [expect.objectContaining({ id: agent.json.id })],
    });
    socket.close();
    const lateSocket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const lateHello = nextWebSocketFrame(lateSocket, "hello");
    const lateWorkspace = nextWebSocketFrame(lateSocket, "workspace");
    await once(lateSocket, "open");
    await expect(lateHello).resolves.toMatchObject({
      type: "hello",
      agents: [expect.objectContaining({ id: agent.json.id })],
    });
    await expect(lateWorkspace).resolves.toMatchObject({
      type: "workspace",
      workspace: { canvasProject: { id: projectA.json.project.id } },
      partialSuccess: true,
      workDocumentation: { ready: false },
    });
    lateSocket.close();
    expect((await request(port, "GET", "/api/workspace")).json.canvasProject.id).toBe(
      projectA.json.project.id,
    );
    expect((await request(port, "GET", "/api/settings")).json).toEqual({
      fullPermissionMode: false,
      workDocumentationEnabled: true,
    });

    const restoredAgents = await request(port, "GET", "/api/agents");
    const restoredFiles = await request(port, "GET", "/api/files");
    const restoredPrompts = await request(port, "GET", "/api/prompts");
    const restoredLayout = await request(port, "GET", "/api/canvas-layout");

    expect(restoredAgents.json.agents).toEqual([
      expect.objectContaining({
        id: agent.json.id,
        config: expect.objectContaining({ systemPrompt: "persist me" }),
      }),
    ]);
    expect(restoredFiles.json.files).toEqual([
      expect.objectContaining({ id: file.json.file.id, name: "persisted-file" }),
    ]);
    expect(restoredPrompts.json.prompts).toEqual([
      expect.objectContaining({ id: prompt.json.prompt.id, content: "saved prompt atomically" }),
    ]);
    expect(
      (await request(port, "GET", `/api/files/${file.json.file.id}/content?full=1`)).json,
    ).toEqual({ content: "saved file atomically", truncated: false });
    expect(restoredLayout.json.nodes).toEqual(layout.json.nodes);
  });

  it("rejects a hard-linked canvas state without modifying its outside sentinel", async () => {
    const created = await request(port, "POST", "/api/canvas-projects", {
      name: "canvas-state-hardlink",
    });
    expect(created.status, JSON.stringify(created.json)).toBe(201);

    const projectId = created.json.project.id as string;
    const statePath = path.join(created.json.project.projectRoot, "canvas-state.json");
    const initialSave = await request(port, "PATCH", "/api/canvas-layout", {
      canvasProjectId: projectId,
      nodes: [],
    });
    expect(initialSave.status, JSON.stringify(initialSave.json)).toBe(200);
    const originalState = await readFile(statePath, "utf-8");
    const outsideSentinel = path.join(root, "outside-canvas-state-sentinel.json");
    const displacedState = `${statePath}.original`;
    await writeFile(outsideSentinel, originalState, "utf-8");
    await rename(statePath, displacedState);
    await link(outsideSentinel, statePath);

    try {
      const rejected = await request(port, "PATCH", "/api/canvas-layout", {
        canvasProjectId: projectId,
        nodes: [
          {
            id: "must-not-persist",
            type: "file",
            position: { x: 10, y: 20 },
          },
        ],
      });

      expect(rejected.status).toBe(400);
      expect(rejected.json.error).toContain("no-follow single-link regular file");
      await expect(readFile(outsideSentinel, "utf-8")).resolves.toBe(originalState);
      const inMemoryLayout = await request(port, "GET", "/api/canvas-layout");
      expect(inMemoryLayout.status).toBe(200);
      expect(inMemoryLayout.json.nodes).toEqual([]);
    } finally {
      await rm(statePath, { force: true });
      await rename(displacedState, statePath);
      await rm(outsideSentinel, { force: true });
    }

    const recovered = await request(port, "PATCH", "/api/canvas-layout", {
      canvasProjectId: projectId,
      nodes: [],
    });
    expect(recovered.status, JSON.stringify(recovered.json)).toBe(200);
  });

  it("rejects a live canvas-state inode replacement until the tracked file is restored", async () => {
    const created = await request(port, "POST", "/api/canvas-projects", {
      name: "canvas-state-live-replacement",
    });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const projectId = created.json.project.id as string;
    const statePath = path.join(created.json.project.projectRoot, "canvas-state.json");
    expect(
      (
        await request(port, "PATCH", "/api/canvas-layout", {
          canvasProjectId: projectId,
          nodes: [],
        })
      ).status,
    ).toBe(200);
    const originalState = await readFile(statePath, "utf-8");
    const displacedState = `${statePath}.tracked`;
    await rename(statePath, displacedState);
    await writeFile(statePath, originalState, "utf-8");

    try {
      const rejected = await request(port, "PATCH", "/api/canvas-layout", {
        canvasProjectId: projectId,
        nodes: [{ id: "must-not-replace", type: "file", position: { x: 1, y: 2 } }],
      });
      expect(rejected.status).toBe(400);
      expect(rejected.json.error).toContain("identity changed");
      await expect(readFile(statePath, "utf-8")).resolves.toBe(originalState);
      expect((await request(port, "GET", "/api/canvas-layout")).json.nodes).toEqual([]);
    } finally {
      await rm(statePath, { force: true });
      await rename(displacedState, statePath);
    }

    expect(
      (
        await request(port, "PATCH", "/api/canvas-layout", {
          canvasProjectId: projectId,
          nodes: [],
        })
      ).status,
    ).toBe(200);
  });

  it("rejects a live project-root junction swap before canvas-state persistence", async (context) => {
    const created = await request(port, "POST", "/api/canvas-projects", {
      name: "canvas-project-root-swap",
    });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const projectId = created.json.project.id as string;
    const activeRoot = created.json.project.projectRoot as string;
    const displacedRoot = `${activeRoot}.original`;
    const outside = path.join(root, "outside-canvas-project-root");
    const outsideState = path.join(outside, "canvas-state.json");
    await mkdir(outside);
    await writeFile(outsideState, "outside canvas sentinel", "utf-8");
    await rename(activeRoot, displacedRoot);
    let linked = false;
    try {
      try {
        await symlink(
          outside,
          activeRoot,
          process.platform === "win32" ? "junction" : "dir",
        );
        linked = true;
      } catch (error) {
        await rename(displacedRoot, activeRoot);
        if (["EPERM", "EACCES", "UNKNOWN"].includes((error as NodeJS.ErrnoException).code ?? "")) {
          context.skip();
          return;
        }
        throw error;
      }

      const rejected = await request(port, "PATCH", "/api/canvas-layout", {
        canvasProjectId: projectId,
        nodes: [{ id: "outside-write", type: "file", position: { x: 4, y: 5 } }],
      });
      expect(rejected.status).toBe(400);
      await expect(readFile(outsideState, "utf-8")).resolves.toBe(
        "outside canvas sentinel",
      );
    } finally {
      if (linked) {
        await rm(activeRoot, { force: true });
        await rename(displacedRoot, activeRoot);
      }
    }

    expect(
      (
        await request(port, "PATCH", "/api/canvas-layout", {
          canvasProjectId: projectId,
          nodes: [],
        })
      ).status,
    ).toBe(200);
  });

  it("publishes the authoritative workspace and hello before activating overdue imported flows", async () => {
    const target = await request(port, "POST", "/api/canvas-projects", {
      name: "overdue-flow-target",
    });
    const source = await request(port, "POST", "/api/canvas-projects", {
      name: "overdue-flow-source",
    });
    expect(target.status).toBe(201);
    expect(source.status).toBe(201);

    const statePath = path.join(target.json.project.projectRoot, "canvas-state.json");
    const state = JSON.parse(await readFile(statePath, "utf-8"));
    state.prFlows = [
      {
        id: "pr_flow_1",
        proposerAgentId: "agent_old",
        sourceBranch: "feature/old",
        targetBranch: "main",
        summary: "Expired imported PR",
        files: ["src/old-pr.ts"],
        fileChanges: [{ status: "M", path: "src/old-pr.ts" }],
        status: "create_pr_authorized",
        createdAt: 1,
        updatedAt: 1,
        deadlineAt: 1,
        createAuthorization: {
          agentId: "agent_old",
          issuedAt: 1,
          expiresAt: 1,
        },
        reviewRequests: [],
      },
    ];
    state.syncFlows = [
      {
        id: "sync_flow_1",
        kind: "cherry_pick",
        proposerAgentId: "agent_old",
        targetBranch: "feature/old",
        commitSha: "abcdef123456",
        summary: "Expired imported sync",
        reason: "Exercise activation ordering",
        files: ["src/old-sync.ts"],
        fileChanges: [{ status: "M", path: "src/old-sync.ts" }],
        status: "apply_authorized",
        createdAt: 1,
        updatedAt: 1,
        deadlineAt: 1,
        applyAuthorization: {
          agentId: "agent_old",
          issuedAt: 1,
          expiresAt: 1,
        },
      },
    ];
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");

    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const initialHello = nextWebSocketFrame(socket, "hello");
    const initialWorkspace = nextWebSocketFrame(socket, "workspace");
    await once(socket, "open");
    await initialHello;
    await initialWorkspace;
    const frames: any[] = [];
    socket.on("message", (payload: RawData) => {
      frames.push(JSON.parse(String(payload)));
    });

    const opened = await request(port, "POST", "/api/canvas-projects/open", {
      id: target.json.project.id,
    });
    expect(opened.status).toBe(200);
    await vi.waitFor(() => {
      expect(frames.some((frame) => frame.type === "pr_flow")).toBe(true);
      expect(frames.some((frame) => frame.type === "sync_flow")).toBe(true);
    });

    const workspaceIndex = frames.findIndex(
      (frame) =>
        frame.type === "workspace" &&
        frame.workspace?.canvasProject?.id === target.json.project.id,
    );
    const helloIndex = frames.findIndex(
      (frame, index) => index > workspaceIndex && frame.type === "hello",
    );
    const prFlowIndex = frames.findIndex((frame) => frame.type === "pr_flow");
    const syncFlowIndex = frames.findIndex((frame) => frame.type === "sync_flow");
    expect(workspaceIndex).toBeGreaterThanOrEqual(0);
    expect(helloIndex).toBeGreaterThan(workspaceIndex);
    expect(prFlowIndex).toBeGreaterThan(helloIndex);
    expect(syncFlowIndex).toBeGreaterThan(helloIndex);
    expect(frames[helloIndex]).toMatchObject({
      prFlows: [{ id: "pr_flow_1", status: "create_pr_authorized" }],
      syncFlows: [{ id: "sync_flow_1", status: "apply_authorized" }],
    });
    expect(frames[prFlowIndex]).toMatchObject({
      type: "pr_flow",
      flow: { id: "pr_flow_1", status: "timed_out" },
    });
    expect(frames[syncFlowIndex]).toMatchObject({
      type: "sync_flow",
      flow: { id: "sync_flow_1", status: "timed_out" },
    });
    socket.close();
  });

  it("rejects a delayed canvas layout save from a previous project", async () => {
    const projectA = await request(port, "POST", "/api/canvas-projects", {
      name: "layout-owner-a",
    });
    const projectB = await request(port, "POST", "/api/canvas-projects", {
      name: "layout-owner-b",
    });
    expect(projectA.status, JSON.stringify(projectA.json)).toBe(201);
    expect(projectB.status).toBe(201);

    const missingOwner = await request(port, "PATCH", "/api/canvas-layout", {
      nodes: [],
    });
    expect(missingOwner.status).toBe(409);

    const staleSave = await request(port, "PATCH", "/api/canvas-layout", {
      canvasProjectId: projectA.json.project.id,
      nodes: [
        {
          id: "stale-node",
          type: "file",
          position: { x: 10, y: 20 },
        },
      ],
    });
    expect(staleSave.status).toBe(409);
    expect(staleSave.json.error).toContain("项目已切换");
    expect((await request(port, "GET", "/api/canvas-layout")).json.nodes).toEqual([]);
  });

  it("rejects delayed permission settings from a previous project", async () => {
    const projectA = await request(port, "POST", "/api/canvas-projects", {
      name: "settings-owner-a",
    });
    const projectB = await request(port, "POST", "/api/canvas-projects", {
      name: "settings-owner-b",
    });
    expect(projectA.status, JSON.stringify(projectA.json)).toBe(201);
    expect(projectB.status).toBe(201);

    const missingOwner = await request(port, "PATCH", "/api/settings", {
      fullPermissionMode: true,
    });
    expect(missingOwner.status).toBe(409);

    const staleSettings = await request(port, "PATCH", "/api/settings", {
      canvasProjectId: projectA.json.project.id,
      fullPermissionMode: true,
      workDocumentationEnabled: true,
    });
    expect(staleSettings.status).toBe(409);
    expect(staleSettings.json.error).toContain("项目已切换");
    expect((await request(port, "GET", "/api/settings")).json).toEqual({
      fullPermissionMode: false,
      workDocumentationEnabled: false,
    });
  });

  it("rejects stale project-version headers on project-local mutations", async () => {
    const projectA = await request(port, "POST", "/api/canvas-projects", {
      name: "mutation-token-a",
    });
    const projectB = await request(port, "POST", "/api/canvas-projects", {
      name: "mutation-token-b",
    });
    expect(projectA.status).toBe(201);
    expect(projectB.status).toBe(201);
    const staleHeaders = {
      "X-Agent-Canvas-Project-Id": projectA.json.project.id,
      "X-Agent-Canvas-Project-Revision": String(projectA.json.workspace.revision),
    };

    const staleConnect = await request(
      port,
      "POST",
      "/api/workspace/connect",
      { localPath: root },
      staleHeaders,
    );
    expect(staleConnect.status).toBe(409);
    const staleFile = await request(
      port,
      "POST",
      "/api/files",
      { name: "must-not-land-in-b", extension: "txt", kind: "normal" },
      staleHeaders,
    );
    expect(staleFile.status).toBe(409);
    const missingToken = await rawRequest(port, "POST", "/api/files", {
      name: "missing-token",
      extension: "txt",
      kind: "normal",
    });
    expect(missingToken.status).toBe(409);

    const current = await request(port, "GET", "/api/workspace");
    expect(current.json.canvasProject.id).toBe(projectB.json.project.id);
    expect(current.json.repo).toBeUndefined();
    expect(current.json.branches).toEqual([]);
    expect((await request(port, "GET", "/api/files")).json.files).toEqual([]);
  });

  it("rejects stale revisions after an A-to-B-to-A project cycle", async () => {
    const firstA = await request(port, "POST", "/api/canvas-projects", {
      name: "revision-aba-a",
    });
    const projectB = await request(port, "POST", "/api/canvas-projects", {
      name: "revision-aba-b",
    });
    const reopenedA = await request(port, "POST", "/api/canvas-projects/open", {
      id: firstA.json.project.id,
    });
    expect(firstA.status).toBe(201);
    expect(projectB.status).toBe(201);
    expect(reopenedA.status).toBe(200);
    expect(reopenedA.json.workspace.revision).not.toBe(firstA.json.workspace.revision);
    const staleHeaders = {
      "X-Agent-Canvas-Project-Id": firstA.json.project.id,
      "X-Agent-Canvas-Project-Revision": String(firstA.json.workspace.revision),
    };

    const staleSettings = await request(
      port,
      "PATCH",
      "/api/settings",
      {
        canvasProjectId: firstA.json.project.id,
        fullPermissionMode: true,
      },
      staleHeaders,
    );
    expect(staleSettings.status).toBe(409);
    expect(
      await request(
        port,
        "POST",
        "/api/files",
        { name: "stale-aba", extension: "txt", kind: "normal" },
        staleHeaders,
      ),
    ).toMatchObject({ status: 409 });
    expect(
      await request(port, "POST", "/api/agents", { branch: "main" }, staleHeaders),
    ).toMatchObject({ status: 409 });
    expect(
      await request(
        port,
        "POST",
        "/api/pr-flows",
        {
          proposerAgentId: "agent_1",
          targetBranch: "main",
          summary: "must not use an old project revision",
          files: ["src/stale.ts"],
        },
        staleHeaders,
      ),
    ).toMatchObject({ status: 409 });

    expect((await request(port, "GET", "/api/settings")).json.fullPermissionMode).toBe(false);
    expect((await request(port, "GET", "/api/agents")).json.agents).toEqual([]);
    expect((await request(port, "GET", "/api/pr-flows")).json.flows).toEqual([]);
    const validFile = await request(port, "POST", "/api/files", {
      name: "current-aba",
      extension: "txt",
      kind: "normal",
    });
    expect(validFile.status).toBe(201);
  });

  it("sends an atomic hello and workspace snapshot to a socket connected mid-project import", async () => {
    const projectA = await request(port, "POST", "/api/canvas-projects", {
      name: "socket-snapshot-a",
    });
    const projectB = await request(port, "POST", "/api/canvas-projects", {
      name: "socket-snapshot-b",
    });
    expect(projectA.status, JSON.stringify(projectA.json)).toBe(201);
    expect(projectB.status, JSON.stringify(projectB.json)).toBe(201);

    const oldProjectRunner = manager.create();
    await manager.startAgent(oldProjectRunner.id, { prompt: "old project agent" });
    await vi.waitFor(() => {
      expect(manager.snapshot(oldProjectRunner.id)?.status).toBe("done");
    });

    let markImportStarted!: () => void;
    let releaseImport!: () => void;
    const importStarted = new Promise<void>((resolve) => {
      markImportStarted = resolve;
    });
    const importRelease = new Promise<void>((resolve) => {
      releaseImport = resolve;
    });
    const originalImport = manager.importState.bind(manager);
    const importSpy = vi.spyOn(manager, "importState").mockImplementationOnce(async (state) => {
      markImportStarted();
      await importRelease;
      await originalImport(state);
    });
    let socket: WebSocket | undefined;
    try {
      const opening = request(port, "POST", "/api/canvas-projects/open", {
        id: projectA.json.project.id,
      });
      await importStarted;

      const frames: any[] = [];
      socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      socket.on("message", (payload: RawData) => frames.push(JSON.parse(String(payload))));
      await once(socket, "open");
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(frames).toEqual([]);

      releaseImport();
      await expect(opening).resolves.toMatchObject({ status: 200 });
      await vi.waitFor(() => expect(frames.length).toBeGreaterThanOrEqual(2));
      expect(frames[0]).toMatchObject({ type: "hello" });
      expect(frames[0].agents).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: oldProjectRunner.id })]),
      );
      expect(frames[1]).toMatchObject({
        type: "workspace",
        workspace: { canvasProject: { id: projectA.json.project.id } },
      });
    } finally {
      releaseImport();
      importSpy.mockRestore();
      socket?.close();
    }
  });

  it("serializes concurrent project opens through state load and authoritative broadcasts", async () => {
    const projectA = await request(port, "POST", "/api/canvas-projects", {
      name: "concurrent-open-a",
    });
    const projectB = await request(port, "POST", "/api/canvas-projects", {
      name: "concurrent-open-b",
    });
    expect(projectA.status).toBe(201);
    expect(projectB.status).toBe(201);

    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const initialHello = nextWebSocketFrame(socket, "hello");
    const initialWorkspace = nextWebSocketFrame(socket, "workspace");
    await once(socket, "open");
    await initialHello;
    await initialWorkspace;

    let markImportStarted!: () => void;
    let releaseImport!: () => void;
    const importStarted = new Promise<void>((resolve) => {
      markImportStarted = resolve;
    });
    const importRelease = new Promise<void>((resolve) => {
      releaseImport = resolve;
    });
    beforeNextProjectStatePromptImport = async () => {
      markImportStarted();
      await importRelease;
    };

    const broadcastProjectIds: string[] = [];
    socket.on("message", (payload: RawData) => {
      const frame = JSON.parse(String(payload));
      if (frame.type === "workspace") {
        broadcastProjectIds.push(frame.workspace.canvasProject.id);
      }
    });
    const responseOrder: string[] = [];
    const openA = request(port, "POST", "/api/canvas-projects/open", {
      id: projectA.json.project.id,
    }).then((response) => {
      responseOrder.push(response.json.workspace.canvasProject.id);
      return response;
    });
    await importStarted;

    let fileFinished = false;
    const fileDuringOpen = request(port, "POST", "/api/files", {
      name: "created-after-open-transaction",
      extension: "txt",
      kind: "normal",
    }).then((response) => {
      fileFinished = true;
      return response;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    let refreshFinished = false;
    const filesDuringOpen = request(port, "GET", "/api/files").then((response) => {
      refreshFinished = true;
      return response;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    let connectFinished = false;
    const connectA = request(port, "POST", "/api/workspace/connect", {
      localPath: root,
    }).then((response) => {
      connectFinished = true;
      return response;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    let branchFinished = false;
    const createBranchA = request(port, "POST", "/api/workspace/branches", {
      branch: "feature/concurrent-open-transaction",
    }).then((response) => {
      branchFinished = true;
      return response;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    let openBFinished = false;
    const openB = request(port, "POST", "/api/canvas-projects/open", {
      id: projectB.json.project.id,
    }).then((response) => {
      openBFinished = true;
      if (response.status === 200) {
        responseOrder.push(response.json.workspace.canvasProject.id);
      }
      return response;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fileFinished).toBe(false);
    expect(refreshFinished).toBe(false);
    expect(connectFinished).toBe(false);
    expect(branchFinished).toBe(false);
    expect(openBFinished).toBe(false);

    releaseImport();
    const [responseA, createdFile, listedFiles, connectedA, branchA, responseB] = await Promise.all([
      openA,
      fileDuringOpen,
      filesDuringOpen,
      connectA,
      createBranchA,
      openB,
    ]);
    expect(responseA.status).toBe(200);
    expect(createdFile.status).toBe(409);
    expect(listedFiles.json.files).toEqual([]);
    expect(connectedA.status).toBe(409);
    expect(branchA.status).toBe(409);
    expect(responseB.status).toBe(409);
    expect(responseOrder).toEqual([projectA.json.project.id]);
    await vi.waitFor(() => {
      expect(broadcastProjectIds).toEqual([projectA.json.project.id]);
    });
    expect((await request(port, "GET", "/api/workspace")).json.canvasProject.id).toBe(
      projectA.json.project.id,
    );
    socket.close();
  });

  it("does not let a slow project request body jump ahead of terminal agent events", async () => {
    const current = await request(port, "GET", "/api/workspace");
    const slowOpen = streamingRequest(port, "POST", "/api/canvas-projects/open");
    slowOpen.req.write('{"id":"');

    const runner = manager.create();
    await manager.startAgent(runner.id, { prompt: "finish before project open" });
    await vi.waitFor(() => {
      expect(manager.snapshot(runner.id)?.status).toBe("done");
    });
    // This project-scoped read sits behind the force-enqueued derived event and proves it
    // completed while the trusted POST body was still streaming outside the transaction gate.
    expect((await request(port, "GET", "/api/agents")).status).toBe(200);

    slowOpen.req.end(`${current.json.canvasProject.id}"}`);
    await expect(slowOpen.response).resolves.toMatchObject({
      status: 200,
      json: { workspace: { canvasProject: { id: current.json.canvasProject.id } } },
    });
  });

  it("invalidates delayed turn context before an asynchronous project open", async () => {
    await manager.clear();
    await vi.waitFor(() => {
      expect(pullRequestFlowManager.hasPendingOperations()).toBe(false);
      expect(syncFlowManager.hasPendingOperations()).toBe(false);
    });
    await request(port, "GET", "/api/workspace");
    const projectB = await request(port, "POST", "/api/canvas-projects", {
      name: "turn-context-target-b",
    });
    expect(projectB.status, JSON.stringify(projectB.json)).toBe(201);
    const currentB = await request(port, "GET", "/api/workspace");
    expect(currentB.json).toMatchObject({
      canvasProject: { id: projectB.json.project.id },
      revision: projectB.json.workspace.revision,
    });
    const projectA = await request(port, "POST", "/api/canvas-projects", {
      name: "turn-context-origin-a",
    });
    expect(projectA.status, JSON.stringify(projectA.json)).toBe(201);

    let markContextRequested!: () => void;
    let releaseContext!: (metadata: { baseCommitSha?: string }) => void;
    const contextRequested = new Promise<void>((resolve) => {
      markContextRequested = resolve;
    });
    const delayedContext = new Promise<{ baseCommitSha?: string }>((resolve) => {
      releaseContext = resolve;
    });
    resolveTurnContextForTest = async () => {
      markContextRequested();
      return await delayedContext;
    };
    const observedTurnContexts: AgentEventEnvelope[] = [];
    const unsubscribe = manager.onEvent((envelope) => {
      if (envelope.event.kind === "turn_context") observedTurnContexts.push(envelope);
    });

    let markProjectSelected!: () => void;
    let releaseProjectOpen!: () => void;
    const projectSelected = new Promise<void>((resolve) => {
      markProjectSelected = resolve;
    });
    const projectOpenRelease = new Promise<void>((resolve) => {
      releaseProjectOpen = resolve;
    });
    const originalOpen = workspaceManager.openCanvasProject.bind(workspaceManager);
    const openSpy = vi.spyOn(workspaceManager, "openCanvasProject").mockImplementationOnce(
      async (input) => {
        const opened = await originalOpen(input);
        markProjectSelected();
        await projectOpenRelease;
        return opened;
      },
    );

    try {
      const runner = manager.create();
      await manager.startAgent(runner.id, { prompt: "resolve context later" });
      await contextRequested;
      await vi.waitFor(() => {
        expect(manager.snapshot(runner.id)?.status).toBe("done");
      });

      const opening = request(port, "POST", "/api/canvas-projects/open", {
        id: projectB.json.project.id,
      });
      await projectSelected;
      releaseContext({ baseCommitSha: "abcdef1234567890" });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(observedTurnContexts).toEqual([]);

      releaseProjectOpen();
      await expect(opening).resolves.toMatchObject({
        status: 200,
        json: { workspace: { canvasProject: { id: projectB.json.project.id } } },
      });
    } finally {
      releaseProjectOpen();
      releaseContext({});
      openSpy.mockRestore();
      unsubscribe();
      resolveTurnContextForTest = async () => ({});
    }
  });

  it("rejects a slow mutation after its originating project has changed", async () => {
    await vi.waitFor(() => {
      expect(pullRequestFlowManager.hasPendingOperations()).toBe(false);
      expect(syncFlowManager.hasPendingOperations()).toBe(false);
    });
    await request(port, "GET", "/api/workspace");
    const projectB = await request(port, "POST", "/api/canvas-projects", {
      name: "slow-request-target-b",
    });
    expect(projectB.status, JSON.stringify(projectB.json)).toBe(201);
    const currentB = await request(port, "GET", "/api/workspace");
    expect(currentB.json).toMatchObject({
      canvasProject: { id: projectB.json.project.id },
      revision: projectB.json.workspace.revision,
    });
    const projectA = await request(port, "POST", "/api/canvas-projects", {
      name: "slow-request-origin-a",
    });
    expect(projectA.status, JSON.stringify(projectA.json)).toBe(201);

    const slowFile = streamingRequest(port, "POST", "/api/files");
    slowFile.req.write('{"name":"stale');
    await new Promise<void>((resolve) => setImmediate(resolve));

    const openedB = await request(port, "POST", "/api/canvas-projects/open", {
      id: projectB.json.project.id,
    });
    expect(openedB.status).toBe(200);
    slowFile.req.end('-file","extension":"txt","kind":"normal"}');

    await expect(slowFile.response).resolves.toMatchObject({
      status: 409,
      json: { error: expect.stringContaining("项目已切换") },
    });
    expect((await request(port, "GET", "/api/files")).json.files).toEqual([]);
    expect((await request(port, "GET", "/api/workspace")).json.canvasProject.id).toBe(
      projectB.json.project.id,
    );
  });

  it("rejects a tokenless agent callback after an A-to-B-to-A project cycle", async () => {
    await manager.clear();
    await vi.waitFor(() => {
      expect(pullRequestFlowManager.hasPendingOperations()).toBe(false);
      expect(syncFlowManager.hasPendingOperations()).toBe(false);
    });
    const projectA = await request(port, "POST", "/api/canvas-projects", {
      name: "slow-agent-callback-a",
    });
    const projectB = await request(port, "POST", "/api/canvas-projects", {
      name: "slow-agent-callback-b",
    });
    expect(projectA.status, JSON.stringify(projectA.json)).toBe(201);
    expect(projectB.status, JSON.stringify(projectB.json)).toBe(201);
    expect(
      await request(port, "POST", "/api/canvas-projects/open", {
        id: projectA.json.project.id,
      }),
    ).toMatchObject({ status: 200 });

    const runner = manager.create();
    await manager.startAgent(runner.id, { prompt: "finish before callback" });
    await vi.waitFor(() => {
      expect(manager.snapshot(runner.id)?.status).toBe("done");
    });
    const slowReport = streamingRequest(
      port,
      "POST",
      `/api/agents/${runner.id}/report-result`,
      false,
    );
    slowReport.req.write(
      '{"name":"stale-callback","extension":"txt","resultKind":"document","content":"',
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(
      await request(port, "POST", "/api/canvas-projects/open", {
        id: projectB.json.project.id,
      }),
    ).toMatchObject({ status: 200 });
    expect(
      await request(port, "POST", "/api/canvas-projects/open", {
        id: projectA.json.project.id,
      }),
    ).toMatchObject({ status: 200 });
    slowReport.req.end('must not land"}');

    await expect(slowReport.response).resolves.toMatchObject({
      status: 409,
      json: { error: expect.any(String) },
    });
    expect((await request(port, "GET", "/api/files")).json.files).toEqual([]);
  });
});

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
