import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket, { type RawData } from "ws";
import type {
  AgentEventEnvelope,
  AgentSnapshot,
  PullRequestFlowSnapshot,
} from "@agent-canvas/shared";
import { AgentManager } from "./AgentManager.js";
import { CommitManager } from "./commits/CommitManager.js";
import { createServer } from "./server.js";
import { FileManager } from "./files/FileManager.js";
import type { PickFiles } from "./files/FilePicker.js";
import type { OpenInVscodeOptions } from "./files/VscodeFileOpener.js";
import { PromptManager } from "./prompts/PromptManager.js";
import { PullRequestFlowManager } from "./pullRequests/PullRequestFlowManager.js";
import { BranchReviewQueue } from "./reviews/BranchReviewQueue.js";
import { CodexAuthManager } from "./sdk/CodexAuthManager.js";
import { SyncFlowManager, type SyncFlowAgentHost } from "./sync/SyncFlowManager.js";
import type { QueryFn, SdkMessage, SdkUserInput } from "./sdk/types.js";
import { AsyncMessageQueue } from "./util/AsyncMessageQueue.js";
import { WorkspaceManager, type GitRunner } from "./workspaces/WorkspaceManager.js";
import { writeManagedFileAtomically } from "./workspaces/safeManagedFile.js";

/** 立即结束消息流的假 query：足以测 HTTP 路由，不触达模型。 */
const emptyQuery: QueryFn = () => ({
  async *[Symbol.asyncIterator]() {
    // 无消息，迭代立即结束
  },
  terminate: async () => undefined,
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

async function uploadRequest(
  port: number,
  requestPath: string,
  data: Buffer,
  extraHeaders: Record<string, string> = {},
): Promise<Resp> {
  if (!requestWorkspaceContext) await request(port, "GET", "/api/workspace");
  const response = await new Promise<Resp>((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: requestPath,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(data.length),
          ...(requestWorkspaceContext
            ? {
                "X-Agent-Canvas-Project-Id": requestWorkspaceContext.canvasProjectId,
                "X-Agent-Canvas-Project-Revision": String(requestWorkspaceContext.revision),
              }
            : {}),
          ...extraHeaders,
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
    if (data.length > 0) req.write(data);
    req.end();
  });
  updateTestWorkspaceContext(response.json);
  return response;
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

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await lstat(targetPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
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
  let beforeNextAccessSnapshotRemoval: ((targetPath: string) => Promise<void>) | undefined;
  let resolveTurnContextForTest: () => Promise<{ baseCommitSha?: string }> = async () => ({});
  let workspaceManager: WorkspaceManager;
  let fileManager: FileManager;
  let syncHost: FakeSyncHost;
  let pullRequestFlowManager: PullRequestFlowManager;
  let syncFlowManager: SyncFlowManager;
  const openFile = vi
    .fn<(filePath: string, options?: OpenInVscodeOptions) => Promise<void>>()
    .mockResolvedValue(undefined);
  const pickDirectory = vi
    .fn<(initialDirectory?: string) => Promise<string | undefined>>()
    .mockResolvedValue("C:\\picked");
  const pickFiles = vi.fn<PickFiles>().mockResolvedValue([]);

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
    fileManager = new FileManager({
      workspaceRoot: root,
      isolatedRoot: path.join(root, "isolated"),
      accessSnapshotPathRemover: async (targetPath) => {
        const beforeRemoval = beforeNextAccessSnapshotRemoval;
        beforeNextAccessSnapshotRemoval = undefined;
        if (beforeRemoval) return await beforeRemoval(targetPath);
        await rm(targetPath, { recursive: true, force: true });
      },
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
      pickFiles,
      maxFileUploadBytes: 16,
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

  it("prepares immutable snapshots and waits for active transports before close cleanup", async () => {
    const isolatedRoot = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-access-server-"));
    const sourcePath = path.join(isolatedRoot, "external-reference.txt");
    await writeFile(sourcePath, "authorized bytes", "utf-8");
    let dispatchedPath: string | undefined;
    let releaseQuery!: () => void;
    let markTerminationStarted!: () => void;
    let releaseTermination!: () => void;
    let markDisposalStarted!: () => void;
    const queryHold = new Promise<void>((resolve) => {
      releaseQuery = resolve;
    });
    const terminationStarted = new Promise<void>((resolve) => {
      markTerminationStarted = resolve;
    });
    const terminationRelease = new Promise<void>((resolve) => {
      releaseTermination = resolve;
    });
    const disposalStarted = new Promise<void>((resolve) => {
      markDisposalStarted = resolve;
    });
    const lifecycleOrder: string[] = [];
    const isolatedQuery: QueryFn = ({ options }) => {
      dispatchedPath = options?.fileAccess?.readableFiles[0]?.path;
      return {
        async *[Symbol.asyncIterator]() {
          await queryHold;
        },
        terminate: async () => {
          lifecycleOrder.push("terminate-start");
          markTerminationStarted();
          await terminationRelease;
          lifecycleOrder.push("terminate-end");
          releaseQuery();
        },
      };
    };
    const isolatedManager = new AgentManager({
      query: isolatedQuery,
      defaultCwd: isolatedRoot,
    });
    const isolatedFileManager = new FileManager({
      workspaceRoot: isolatedRoot,
      isolatedRoot: path.join(isolatedRoot, "managed-files"),
    });
    const isolatedWorkspaceManager = new WorkspaceManager({
      defaultSourcePath: isolatedRoot,
    });
    const agent = isolatedManager.create({ systemPrompt: "preserve close state" });
    isolatedManager.updateAppSettings({ fullPermissionMode: true });
    const preparationOrder: string[] = [];
    const originalWorkspacePrepare = isolatedWorkspaceManager.prepareAgentWorkspace.bind(
      isolatedWorkspaceManager,
    );
    const workspacePrepareSpy = vi
      .spyOn(isolatedWorkspaceManager, "prepareAgentWorkspace")
      .mockImplementation(async (...args) => {
        const prepared = await originalWorkspacePrepare(...args);
        preparationOrder.push("workspace");
        return prepared;
      });
    const originalFilePrepare = isolatedFileManager.prepareAccessFor.bind(isolatedFileManager);
    const prepareSpy = vi
      .spyOn(isolatedFileManager, "prepareAccessFor")
      .mockImplementation(async (...args) => {
        preparationOrder.push("file");
        await originalFilePrepare(...args);
      });
    const originalDispose = isolatedFileManager.disposeAccessSnapshots.bind(isolatedFileManager);
    let disposal: Promise<void> | undefined;
    const disposeSpy = vi
      .spyOn(isolatedFileManager, "disposeAccessSnapshots")
      .mockImplementation(() => {
        lifecycleOrder.push("dispose");
        markDisposalStarted();
        return (disposal ??= originalDispose());
      });
    const { httpServer: isolatedServer } = createServer(
      isolatedManager,
      isolatedFileManager,
      { defaultCwd: isolatedRoot, workspaceManager: isolatedWorkspaceManager },
    );
    await new Promise<void>((resolve) => isolatedServer.listen(0, resolve));
    const isolatedPort = (isolatedServer.address() as AddressInfo).port;
    const socket = new WebSocket(`ws://127.0.0.1:${isolatedPort}/ws`);
    await once(socket, "open");
    const socketClosed = once(socket, "close");
    const selection = await isolatedFileManager.stagePickedFiles([sourcePath]);
    const [referenced] = await isolatedFileManager.importPicked(
      selection.id,
      "reference",
      "normal",
    );
    isolatedFileManager.connect(referenced!.id, agent.id, "read");

    let closing: Promise<void> | undefined;
    let closeResolved = false;
    try {
      await isolatedManager.startAgent(agent.id, {
        prompt: "inspect the referenced file",
        cwd: isolatedRoot,
      });
      expect(workspacePrepareSpy).toHaveBeenCalledWith(
        agent.id,
        expect.objectContaining({ cwd: isolatedRoot }),
        expect.any(Object),
      );
      expect(prepareSpy).toHaveBeenCalledWith(agent.id);
      expect(preparationOrder).toEqual(["workspace", "file"]);
      expect(dispatchedPath).toBeTruthy();
      expect(dispatchedPath).not.toBe(await realpath(sourcePath));
      await expect(readFile(dispatchedPath!, "utf-8")).resolves.toBe("authorized bytes");

      await rename(sourcePath, `${sourcePath}.replaced`);
      await writeFile(sourcePath, "replacement bytes", "utf-8");
      await expect(readFile(dispatchedPath!, "utf-8")).resolves.toBe("authorized bytes");

      closing = new Promise<void>((resolve, reject) =>
        isolatedServer.close((error) => error ? reject(error) : resolve()),
      ).then(() => {
        closeResolved = true;
      });
      await terminationStarted;
      await socketClosed;
      expect(socket.readyState).toBe(WebSocket.CLOSED);
      expect(closeResolved).toBe(false);
      expect(disposeSpy).not.toHaveBeenCalled();
      await expect(readFile(dispatchedPath!, "utf-8")).resolves.toBe("authorized bytes");
      expect(isolatedManager.list()).toHaveLength(1);

      releaseTermination();
      await closing;
      expect(closeResolved).toBe(true);
      await disposalStarted;
      await disposal;
    } finally {
      releaseTermination();
      releaseQuery();
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.terminate();
      }
      if (!closing && isolatedServer.listening) {
        closing = new Promise<void>((resolve) => isolatedServer.close(() => resolve()));
      }
      await closing;
      await disposal;
    }

    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(lifecycleOrder).toEqual(["terminate-start", "terminate-end", "dispose"]);
    await expect(readFile(dispatchedPath!, "utf-8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(isolatedManager.list()).toHaveLength(1);
    expect(isolatedManager.list()[0]).toMatchObject({
      id: agent.id,
      status: "terminated",
      config: expect.objectContaining({ systemPrompt: "preserve close state" }),
    });
    expect(isolatedManager.historyOf(agent.id).length).toBeGreaterThan(0);
    expect(isolatedManager.appSettings().fullPermissionMode).toBe(true);
    await removeTempRoot(isolatedRoot);
  });

  it("does not dispose snapshots after a failed provider termination and exposes a retryable shutdown", async () => {
    const isolatedRoot = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-shutdown-retry-"));
    const output = new AsyncMessageQueue<SdkMessage>();
    let terminationAttempts = 0;
    const isolatedManager = new AgentManager({
      defaultCwd: isolatedRoot,
      query: () => ({
        [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
        terminate: async () => {
          terminationAttempts += 1;
          if (terminationAttempts === 1) throw new Error("provider close failed");
          output.close();
        },
      }),
    });
    const isolatedFileManager = new FileManager({
      workspaceRoot: isolatedRoot,
      isolatedRoot: path.join(isolatedRoot, "managed-files"),
    });
    const disposeSpy = vi.spyOn(isolatedFileManager, "disposeAccessSnapshots");
    const isolatedWorkspaceManager = new WorkspaceManager({ defaultSourcePath: isolatedRoot });
    const agent = isolatedManager.create();
    const serverResult = createServer(isolatedManager, isolatedFileManager, {
      defaultCwd: isolatedRoot,
      workspaceManager: isolatedWorkspaceManager,
    });
    await new Promise<void>((resolve) => serverResult.httpServer.listen(0, resolve));

    try {
      await isolatedManager.startAgent(agent.id, { prompt: "active", cwd: isolatedRoot });
      output.push({
        type: "system",
        subtype: "init",
        session_id: "shutdown-retry-session",
        model: "test-model",
        cwd: isolatedRoot,
        tools: [],
      });
      await vi.waitFor(() => expect(isolatedManager.get(agent.id)?.getStatus()).toBe("running"));

      await expect(serverResult.shutdown()).rejects.toThrow(/Failed to terminate all agent transports/u);
      expect(disposeSpy).not.toHaveBeenCalled();
      expect(terminationAttempts).toBe(1);

      await expect(serverResult.shutdown()).resolves.toBeUndefined();
      expect(terminationAttempts).toBe(2);
      expect(disposeSpy).toHaveBeenCalledTimes(1);
    } finally {
      output.close();
      await new Promise<void>((resolve, reject) =>
        serverResult.httpServer.close((error) => error ? reject(error) : resolve()),
      );
      await removeTempRoot(isolatedRoot);
    }
  });

  it("closes through a hanging best-effort interrupt by using the exact terminate barrier", async () => {
    const isolatedRoot = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-hanging-stop-"));
    const output = new AsyncMessageQueue<SdkMessage>();
    let markInterruptStarted!: () => void;
    const interruptStarted = new Promise<void>((resolve) => {
      markInterruptStarted = resolve;
    });
    const neverInterrupts = new Promise<void>(() => undefined);
    let terminated = false;
    const isolatedManager = new AgentManager({
      defaultCwd: isolatedRoot,
      query: () => ({
        [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
        interrupt: async () => {
          markInterruptStarted();
          await neverInterrupts;
        },
        terminate: async () => {
          terminated = true;
          output.close();
        },
      }),
    });
    const isolatedFileManager = new FileManager({
      workspaceRoot: isolatedRoot,
      isolatedRoot: path.join(isolatedRoot, "managed-files"),
    });
    const isolatedWorkspaceManager = new WorkspaceManager({ defaultSourcePath: isolatedRoot });
    const serverResult = createServer(isolatedManager, isolatedFileManager, {
      defaultCwd: isolatedRoot,
      workspaceManager: isolatedWorkspaceManager,
    });
    const agent = isolatedManager.create();
    await new Promise<void>((resolve) => serverResult.httpServer.listen(0, resolve));

    try {
      await isolatedManager.startAgent(agent.id, { prompt: "active", cwd: isolatedRoot });
      output.push({
        type: "system",
        subtype: "init",
        session_id: "hanging-stop-session",
        model: "test-model",
        cwd: isolatedRoot,
        tools: [],
      });
      await vi.waitFor(() => expect(isolatedManager.get(agent.id)?.getStatus()).toBe("running"));
      await isolatedManager.get(agent.id)!.stop();
      await interruptStarted;

      await expect(
        Promise.race([
          new Promise<string>((resolve, reject) =>
            serverResult.httpServer.close((error) =>
              error ? reject(error) : resolve("closed"),
            ),
          ),
          new Promise<string>((resolve) => setTimeout(() => resolve("timed out"), 500)),
        ]),
      ).resolves.toBe("closed");
      expect(terminated).toBe(true);
      expect(isolatedManager.get(agent.id)?.getStatus()).toBe("terminated");
    } finally {
      output.close();
      if (serverResult.httpServer.listening) {
        await new Promise<void>((resolve) => serverResult.httpServer.close(() => resolve()));
      }
      await removeTempRoot(isolatedRoot);
    }
  });

  it("starts exact termination before the project queue when a native steer RPC hangs", async () => {
    const isolatedRoot = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-hanging-steer-"));
    const output = new AsyncMessageQueue<SdkMessage>();
    let markSteerStarted!: () => void;
    const steerStarted = new Promise<void>((resolve) => {
      markSteerStarted = resolve;
    });
    let rejectSteer: ((error: Error) => void) | undefined;
    const isolatedManager = new AgentManager({
      defaultCwd: isolatedRoot,
      query: () => ({
        [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
        steer: async () => {
          markSteerStarted();
          await new Promise<void>((_resolve, reject) => {
            rejectSteer = reject;
          });
        },
        terminate: async () => {
          rejectSteer?.(new Error("transport closed"));
          output.close();
        },
      }),
    });
    const isolatedFileManager = new FileManager({
      workspaceRoot: isolatedRoot,
      isolatedRoot: path.join(isolatedRoot, "managed-files"),
    });
    const isolatedWorkspaceManager = new WorkspaceManager({ defaultSourcePath: isolatedRoot });
    const serverResult = createServer(isolatedManager, isolatedFileManager, {
      defaultCwd: isolatedRoot,
      workspaceManager: isolatedWorkspaceManager,
    });
    await new Promise<void>((resolve) => serverResult.httpServer.listen(0, resolve));
    const isolatedPort = (serverResult.httpServer.address() as AddressInfo).port;
    const revision = isolatedWorkspaceManager.captureProjectRevision();
    const headers = {
      "X-Agent-Canvas-Project-Id": revision.projectId,
      "X-Agent-Canvas-Project-Revision": String(revision.generation),
    };

    try {
      const initialized = await rawRequest(
        isolatedPort,
        "POST",
        "/api/files",
        { name: "initialize-state", extension: "txt", kind: "normal" },
        headers,
      );
      expect(initialized.status, JSON.stringify(initialized.json)).toBe(201);
      const agentId = isolatedManager.create().id;
      await expect(rawRequest(
        isolatedPort,
        "POST",
        `/api/agents/${agentId}/start`,
        { prompt: "start", cwd: isolatedRoot },
        headers,
      )).resolves.toMatchObject({ status: 202 });
      output.push({
        type: "system",
        subtype: "init",
        session_id: "hanging-steer-session",
        model: "test-model",
        cwd: isolatedRoot,
        tools: [],
      });
      await vi.waitFor(() => expect(isolatedManager.get(agentId)?.getStatus()).toBe("running"));

      const steering = rawRequest(
        isolatedPort,
        "POST",
        `/api/agents/${agentId}/steer`,
        { text: "hang in provider RPC" },
        headers,
      );
      await steerStarted;
      const closing = new Promise<void>((resolve, reject) =>
        serverResult.httpServer.close((error) => error ? reject(error) : resolve()),
      );

      await expect(steering).resolves.toMatchObject({ status: 409 });
      serverResult.httpServer.closeIdleConnections?.();
      await expect(closing).resolves.toBeUndefined();
      expect(isolatedManager.get(agentId)?.getStatus()).toBe("terminated");
    } finally {
      rejectSteer?.(new Error("test cleanup"));
      output.close();
      if (serverResult.httpServer.listening) {
        await new Promise<void>((resolve) => serverResult.httpServer.close(() => resolve()));
      }
      await removeTempRoot(isolatedRoot);
    }
  });

  it("rejects a native picker that finishes after shutdown without staging its selection", async () => {
    const isolatedRoot = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-shutdown-picker-"));
    const isolatedManager = new AgentManager({ query: emptyQuery, defaultCwd: isolatedRoot });
    const isolatedFileManager = new FileManager({
      workspaceRoot: isolatedRoot,
      isolatedRoot: path.join(isolatedRoot, "managed-files"),
    });
    const isolatedWorkspaceManager = new WorkspaceManager({ defaultSourcePath: isolatedRoot });
    let markPickerStarted!: () => void;
    let finishPicker!: (paths: string[]) => void;
    const pickerStarted = new Promise<void>((resolve) => {
      markPickerStarted = resolve;
    });
    const pickFiles = vi.fn<PickFiles>(() => {
      markPickerStarted();
      return new Promise<string[]>((resolve) => {
        finishPicker = resolve;
      });
    });
    const stageSpy = vi.spyOn(isolatedFileManager, "stagePickedFiles");
    const serverResult = createServer(isolatedManager, isolatedFileManager, {
      defaultCwd: isolatedRoot,
      workspaceManager: isolatedWorkspaceManager,
      pickFiles,
    });
    await new Promise<void>((resolve) => serverResult.httpServer.listen(0, resolve));
    const isolatedPort = (serverResult.httpServer.address() as AddressInfo).port;
    const revision = isolatedWorkspaceManager.captureProjectRevision();
    const headers = {
      "X-Agent-Canvas-Project-Id": revision.projectId,
      "X-Agent-Canvas-Project-Revision": String(revision.generation),
    };

    try {
      const response = rawRequest(isolatedPort, "POST", "/api/files/pick", {}, headers);
      await pickerStarted;
      const closing = new Promise<void>((resolve, reject) =>
        serverResult.httpServer.close((error) => error ? reject(error) : resolve()),
      );
      finishPicker([path.join(isolatedRoot, "must-not-be-staged.txt")]);

      await expect(response).resolves.toEqual({
        status: 503,
        json: { error: "Agent Canvas server is shutting down" },
      });
      await closing;
      expect(stageSpy).not.toHaveBeenCalled();
    } finally {
      finishPicker?.([]);
      if (serverResult.httpServer.listening) {
        await new Promise<void>((resolve) => serverResult.httpServer.close(() => resolve()));
      }
      await removeTempRoot(isolatedRoot);
    }
  });

  it("retires a prepared snapshot when provider initialization fails", async () => {
    const isolatedRoot = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-access-error-"));
    const sourcePath = path.join(isolatedRoot, "external-reference.txt");
    await writeFile(sourcePath, "error snapshot", "utf-8");
    let dispatchedPath: string | undefined;
    const isolatedQuery: QueryFn = ({ options }) => {
      dispatchedPath = options?.fileAccess?.readableFiles[0]?.path;
      throw new Error("injected provider initialization failure");
    };
    const isolatedManager = new AgentManager({
      query: isolatedQuery,
      defaultCwd: isolatedRoot,
    });
    const isolatedFileManager = new FileManager({
      workspaceRoot: isolatedRoot,
      isolatedRoot: path.join(isolatedRoot, "managed-files"),
    });
    const isolatedWorkspaceManager = new WorkspaceManager({
      defaultSourcePath: isolatedRoot,
    });
    const agent = isolatedManager.create();
    const { httpServer: isolatedServer } = createServer(
      isolatedManager,
      isolatedFileManager,
      { defaultCwd: isolatedRoot, workspaceManager: isolatedWorkspaceManager },
    );
    await new Promise<void>((resolve) => isolatedServer.listen(0, resolve));
    const selection = await isolatedFileManager.stagePickedFiles([sourcePath]);
    const [referenced] = await isolatedFileManager.importPicked(
      selection.id,
      "reference",
      "normal",
    );
    isolatedFileManager.connect(referenced!.id, agent.id, "read");

    try {
      await expect(
        isolatedManager.startAgent(agent.id, {
          prompt: "fail after snapshot preparation",
          cwd: isolatedRoot,
        }),
      ).rejects.toThrow(/injected provider initialization failure/u);
      expect(dispatchedPath).toBeTruthy();
      await vi.waitFor(async () => {
        await expect(readFile(dispatchedPath!)).rejects.toMatchObject({ code: "ENOENT" });
      });
      expect(isolatedFileManager.accessFor(agent.id).readableFiles).toEqual([]);
      expect(isolatedManager.get(agent.id)?.getStatus()).toBe("error");
    } finally {
      await isolatedFileManager.disposeAccessSnapshots();
      await new Promise<void>((resolve) => isolatedServer.close(() => resolve()));
      await removeTempRoot(isolatedRoot);
    }
  });

  it("keeps stopped-turn snapshots until the provider settles, then retires them", async () => {
    const isolatedRoot = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-access-stop-"));
    const sourcePath = path.join(isolatedRoot, "external-reference.txt");
    await writeFile(sourcePath, "stopped snapshot", "utf-8");
    let dispatchedPath: string | undefined;
    let interrupted = false;
    let releaseQuery!: () => void;
    const queryHold = new Promise<void>((resolve) => {
      releaseQuery = resolve;
    });
    const isolatedQuery: QueryFn = ({ options }) => {
      dispatchedPath = options?.fileAccess?.readableFiles[0]?.path;
      return {
        async *[Symbol.asyncIterator]() {
          await queryHold;
        },
        interrupt: async () => {
          interrupted = true;
        },
        terminate: async () => releaseQuery(),
      };
    };
    const isolatedManager = new AgentManager({
      query: isolatedQuery,
      defaultCwd: isolatedRoot,
    });
    const isolatedFileManager = new FileManager({
      workspaceRoot: isolatedRoot,
      isolatedRoot: path.join(isolatedRoot, "managed-files"),
    });
    const isolatedWorkspaceManager = new WorkspaceManager({
      defaultSourcePath: isolatedRoot,
    });
    const agent = isolatedManager.create();
    const { httpServer: isolatedServer } = createServer(
      isolatedManager,
      isolatedFileManager,
      { defaultCwd: isolatedRoot, workspaceManager: isolatedWorkspaceManager },
    );
    await new Promise<void>((resolve) => isolatedServer.listen(0, resolve));
    const selection = await isolatedFileManager.stagePickedFiles([sourcePath]);
    const [referenced] = await isolatedFileManager.importPicked(
      selection.id,
      "reference",
      "normal",
    );
    isolatedFileManager.connect(referenced!.id, agent.id, "read");

    try {
      await isolatedManager.startAgent(agent.id, {
        prompt: "hold the referenced file",
        cwd: isolatedRoot,
      });
      expect(dispatchedPath).toBeTruthy();
      await isolatedManager.get(agent.id)!.stop();
      expect(interrupted).toBe(true);
      await expect(readFile(dispatchedPath!, "utf-8")).resolves.toBe("stopped snapshot");
      expect(isolatedFileManager.accessFor(agent.id).readableFiles[0]?.path).toBe(
        dispatchedPath,
      );

      releaseQuery();
      await vi.waitFor(async () => {
        await expect(readFile(dispatchedPath!)).rejects.toMatchObject({ code: "ENOENT" });
      });
      expect(isolatedManager.get(agent.id)?.getStatus()).toBe("stopped");
      expect(isolatedFileManager.accessFor(agent.id).readableFiles).toEqual([]);
    } finally {
      releaseQuery();
      await isolatedFileManager.disposeAccessSnapshots();
      await new Promise<void>((resolve) => isolatedServer.close(() => resolve()));
      await removeTempRoot(isolatedRoot);
    }
  });

  it("retires the previous snapshot when a queued turn dispatches with no file grants", async () => {
    const isolatedRoot = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-access-empty-next-"));
    const sourcePath = path.join(isolatedRoot, "external-reference.txt");
    await writeFile(sourcePath, "first turn only", "utf-8");
    const output = new AsyncMessageQueue<SdkMessage>();
    const inputs: SdkUserInput[] = [];
    const isolatedQuery: QueryFn = ({ prompt }) => {
      if (typeof prompt !== "string") {
        void (async () => {
          for await (const input of prompt) inputs.push(input);
        })();
      }
      return {
        [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
        terminate: async () => output.close(),
      };
    };
    const isolatedManager = new AgentManager({
      query: isolatedQuery,
      defaultCwd: isolatedRoot,
    });
    const isolatedFileManager = new FileManager({
      workspaceRoot: isolatedRoot,
      isolatedRoot: path.join(isolatedRoot, "managed-files"),
    });
    const isolatedWorkspaceManager = new WorkspaceManager({
      defaultSourcePath: isolatedRoot,
    });
    const agent = isolatedManager.create();
    const { httpServer: isolatedServer } = createServer(
      isolatedManager,
      isolatedFileManager,
      { defaultCwd: isolatedRoot, workspaceManager: isolatedWorkspaceManager },
    );
    await new Promise<void>((resolve) => isolatedServer.listen(0, resolve));
    const selection = await isolatedFileManager.stagePickedFiles([sourcePath]);
    const [referenced] = await isolatedFileManager.importPicked(
      selection.id,
      "reference",
      "normal",
    );
    const connection = isolatedFileManager.connect(referenced!.id, agent.id, "read");

    try {
      await isolatedManager.startAgent(agent.id, {
        prompt: "first turn",
        cwd: isolatedRoot,
      });
      await vi.waitFor(() => expect(inputs).toHaveLength(1));
      const firstPath = inputs[0]!.fileAccess!.readableFiles[0]!.path;
      await expect(readFile(firstPath, "utf-8")).resolves.toBe("first turn only");
      output.push({
        type: "system",
        subtype: "init",
        session_id: "empty-next-session",
        model: "test-model",
        cwd: isolatedRoot,
        tools: [],
      });
      await vi.waitFor(() => expect(isolatedManager.get(agent.id)?.getStatus()).toBe("running"));
      await isolatedManager.get(agent.id)!.send("queued second turn");
      isolatedFileManager.disconnect(connection.id);

      output.push({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "empty-next-session",
      });
      await vi.waitFor(() => expect(inputs).toHaveLength(2));
      expect(inputs[1]!.fileAccess?.readableFiles).toEqual([]);
      await vi.waitFor(async () => {
        await expect(readFile(firstPath)).rejects.toMatchObject({ code: "ENOENT" });
      });
      expect(isolatedManager.get(agent.id)?.getStatus()).toBe("running");
      expect(isolatedFileManager.accessFor(agent.id).readableFiles).toEqual([]);
    } finally {
      output.close();
      await new Promise<void>((resolve, reject) =>
        isolatedServer.close((error) => error ? reject(error) : resolve()),
      );
      await removeTempRoot(isolatedRoot);
    }
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

    const retryBranch = vi.spyOn(syncFlowManager.getReviewQueue(), "retryBranch");
    const created = await request(port, "POST", "/api/agents", {
      branchWorkspaceId: feature.json.branch.id,
      systemPrompt: "branch rules",
    });
    expect(created.status).toBe(201);
    expect(retryBranch).toHaveBeenCalledWith("feature/server-test");
    retryBranch.mockRestore();

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

    const retryBranch = vi.spyOn(syncFlowManager.getReviewQueue(), "retryBranch");
    const updated = await request(port, "PATCH", `/api/agents/${created.json.id}/settings`, {
      branchWorkspaceId: feature.json.branch.id,
      systemPrompt: "switchable",
    });
    expect(updated.status).toBe(200);
    expect(retryBranch).toHaveBeenCalledWith("feature/settings-switch");
    retryBranch.mockRestore();
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

  it("wakes a deferred target PR review when an idle fork is created on the target branch", async () => {
    const isolatedRoot = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-fork-review-retry-"));
    const isolatedProjectRoot = path.join(isolatedRoot, "project");
    const isolatedRunGit: GitRunner = async (args, options) => {
      if (args[0] === "remote") return "https://github.com/acme/fork-review-retry.git";
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
    const sourceBranch = await isolatedWorkspaceManager.createBranch({
      branch: "feature/fork-review-source",
    });
    const querySessions: Array<{
      cwd?: string;
      inputs: SdkUserInput[];
      close: () => void;
    }> = [];
    const isolatedQuery: QueryFn = ({ prompt, options }) => {
      let close!: () => void;
      const closed = new Promise<void>((resolve) => {
        close = () => resolve();
      });
      const session = { cwd: options?.cwd, inputs: [] as SdkUserInput[], close };
      querySessions.push(session);
      if (typeof prompt !== "string") {
        void (async () => {
          for await (const input of prompt) session.inputs.push(input);
        })();
      }
      return {
        async *[Symbol.asyncIterator]() {
          yield {
            type: "system" as const,
            subtype: "init" as const,
            session_id: `session-fork-review-${querySessions.length}`,
            model: "codex-test",
            cwd: options?.cwd ?? isolatedRoot,
            tools: [],
          };
          await closed;
        },
        terminate: async () => close(),
      };
    };
    const isolatedManager = new AgentManager({ query: isolatedQuery });
    const isolatedReviewQueue = new BranchReviewQueue();
    const retryBranch = vi.spyOn(isolatedReviewQueue, "retryBranch");
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
      const createdParent = await rawRequest(
        isolatedPort,
        "POST",
        "/api/agents",
        { branchWorkspaceId: sourceBranch.id },
        projectHeaders,
      );
      expect(createdParent.status).toBe(201);
      const parentId = createdParent.json.id as string;
      const startedParent = await rawRequest(
        isolatedPort,
        "POST",
        `/api/agents/${parentId}/start`,
        { prompt: "establish a forkable source session" },
        projectHeaders,
      );
      expect(startedParent.status).toBe(202);
      await vi.waitFor(() => {
        expect(isolatedManager.snapshot(parentId)).toMatchObject({
          status: "running",
          sessionId: expect.stringContaining("session-fork-review-"),
        });
      });

      const createdAt = Date.now();
      const queuedPr: PullRequestFlowSnapshot = {
        id: "pr_flow_99",
        proposerAgentId: parentId,
        sourceBranch: sourceBranch.branch,
        targetBranch: mainBranch.branch,
        title: "Wake target review from fork",
        summary: "The target review needs an idle fork on main",
        files: ["src/fork-review.ts"],
        fileChanges: [{ status: "M", path: "src/fork-review.ts" }],
        status: "queued",
        createdAt,
        updatedAt: createdAt,
        currentStage: "target_merge",
        reviewRequests: [],
        pr: {
          prNumber: 99,
          files: ["src/fork-review.ts"],
          fileChanges: [{ status: "M", path: "src/fork-review.ts" }],
          createdAt,
        },
      };
      isolatedPrManager.importState([queuedPr]);
      await vi.waitFor(() => {
        expect(isolatedPrManager.get(queuedPr.id)).toMatchObject({
          status: "queued",
          currentStage: "target_merge",
          failureReason: expect.stringContaining("active reviewer"),
        });
      });

      const forked = await rawRequest(
        isolatedPort,
        "POST",
        `/api/agents/${parentId}/fork`,
        {
          anchorUuid: "fork-review-anchor",
          branchWorkspaceId: mainBranch.id,
        },
        projectHeaders,
      );
      expect(forked.status).toBe(201);
      const forkedId = forked.json.id as string;
      await vi.waitFor(() => {
        expect(isolatedPrManager.get(queuedPr.id)).toMatchObject({
          status: "target_review_collecting",
          currentStage: "target_merge",
          failureReason: undefined,
        });
        expect(isolatedManager.snapshot(forkedId)?.status).toBe("running");
      });
      const forkSession = querySessions.find(
        (session) => path.resolve(session.cwd ?? "") === path.resolve(mainBranch.worktreePath),
      );
      expect(forkSession).toBeDefined();
      await vi.waitFor(() => expect(forkSession?.inputs).toHaveLength(1));
      expect(forkSession?.inputs[0]?.message.content).toContain(`flowId: ${queuedPr.id}`);
      expect(forkSession?.inputs[0]?.message.content).toContain('"stage": "target_merge"');

      // Starting the idle fork emits a later `running` status, which retries the branch again.
      // The already-active reservation must prevent that wake-up from delivering a duplicate.
      await vi.waitFor(() => {
        expect(
          retryBranch.mock.calls.filter(([branch]) => branch === mainBranch.branch).length,
        ).toBeGreaterThanOrEqual(2);
      });
      expect(forkSession?.inputs).toHaveLength(1);
      expect(isolatedPrManager.get(queuedPr.id)?.reviewRequests).toHaveLength(1);

      isolatedPrManager.cancel(queuedPr.id);
    } finally {
      retryBranch.mockRestore();
      for (const session of querySessions) session.close();
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
      allowSharedResourceWrites: true,
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
      allowSharedResourceWrites: true,
    });

    const updated = await request(port, "PATCH", `/api/agents/${created.json.id}/settings`, {
      systemPrompt: "updated private rules",
      allowSharedResourceWrites: false,
    });
    expect(updated.status).toBe(200);
    expect(updated.json.config.systemPrompt).toBe("updated private rules");
    expect(updated.json.config.allowSharedResourceWrites).toBe(false);
    expect(updated.json.config.cwd).toBe(path.join(projectRoot, "repos", "repo_1", "repo"));
  });

  it("validates create settings before creating a branch workspace", async () => {
    const targetBranch = "feature/malformed-create-settings";
    const targetWorktree = path.join(
      projectRoot,
      "worktrees",
      "repo_1",
      "feature-malformed-create-settings",
    );
    const agentsBefore = manager.list().map((agent) => agent.id);
    const createBranchSpy = vi.spyOn(workspaceManager, "createBranch");

    try {
      const created = await request(port, "POST", "/api/agents", {
        branch: targetBranch,
        model: 42,
      });

      expect(created.status).toBe(400);
      expect(createBranchSpy).not.toHaveBeenCalled();
      expect(manager.list().map((agent) => agent.id)).toEqual(agentsBefore);
      const workspace = await request(port, "GET", "/api/workspace");
      expect(
        workspace.json.branches.some(
          (branch: { branch: string }) => branch.branch === targetBranch,
        ),
      ).toBe(false);
      expect(await pathExists(targetWorktree)).toBe(false);
    } finally {
      createBranchSpy.mockRestore();
    }
  });

  it("validates PATCH settings before creating a branch workspace", async () => {
    const created = await request(port, "POST", "/api/agents", {
      model: "valid-model",
      reasoningEffort: "high",
    });
    const targetBranch = "feature/malformed-patch-settings";
    const targetWorktree = path.join(
      projectRoot,
      "worktrees",
      "repo_1",
      "feature-malformed-patch-settings",
    );
    const configBefore = manager.configOf(created.json.id);
    const createBranchSpy = vi.spyOn(workspaceManager, "createBranch");

    try {
      const malformed = await request(
        port,
        "PATCH",
        `/api/agents/${created.json.id}/settings`,
        {
          branchWorkspaceId: "branch_missing_malformed_patch",
          branch: targetBranch,
          model: 42,
        },
      );

      expect(malformed.status).toBe(400);
      expect(createBranchSpy).not.toHaveBeenCalled();
      expect(manager.configOf(created.json.id)).toEqual(configBefore);
      const workspace = await request(port, "GET", "/api/workspace");
      expect(
        workspace.json.branches.some(
          (branch: { branch: string }) => branch.branch === targetBranch,
        ),
      ).toBe(false);
      expect(await pathExists(targetWorktree)).toBe(false);

      const cleared = await request(
        port,
        "PATCH",
        `/api/agents/${created.json.id}/settings`,
        { model: null, reasoningEffort: null },
      );
      expect(cleared.status).toBe(200);
      expect(cleared.json.config.model).toBeUndefined();
      expect(cleared.json.config.reasoningEffort).toBeUndefined();
    } finally {
      createBranchSpy.mockRestore();
    }
  });

  it("validates fork settings and session before creating a branch workspace", async () => {
    const parent = await request(port, "POST", "/api/agents");
    const parentConfig = manager.configOf(parent.json.id);
    const agentsBefore = manager.list().map((agent) => agent.id);
    const malformedBranch = "feature/malformed-fork-settings";
    const targetBranch = "feature/no-session-fork-settings";
    const targetWorktrees = [
      path.join(projectRoot, "worktrees", "repo_1", "feature-malformed-fork-settings"),
      path.join(projectRoot, "worktrees", "repo_1", "feature-no-session-fork-settings"),
    ];
    const createBranchSpy = vi.spyOn(workspaceManager, "createBranch");

    try {
      const malformed = await request(port, "POST", `/api/agents/${parent.json.id}/fork`, {
        anchorUuid: "anchor-malformed",
        branch: malformedBranch,
        model: 42,
      });
      expect(malformed.status).toBe(400);

      const forked = await request(port, "POST", `/api/agents/${parent.json.id}/fork`, {
        anchorUuid: "anchor-no-session",
        branch: targetBranch,
        allowSharedResourceWrites: true,
      });

      expect(forked.status).toBe(409);
      expect(createBranchSpy).not.toHaveBeenCalled();
      expect(manager.list().map((agent) => agent.id)).toEqual(agentsBefore);
      expect(manager.configOf(parent.json.id)).toEqual(parentConfig);
      const workspace = await request(port, "GET", "/api/workspace");
      for (const branchName of [malformedBranch, targetBranch]) {
        expect(
          workspace.json.branches.some(
            (branch: { branch: string }) => branch.branch === branchName,
          ),
        ).toBe(false);
      }
      for (const targetWorktree of targetWorktrees) {
        expect(await pathExists(targetWorktree)).toBe(false);
      }
    } finally {
      createBranchSpy.mockRestore();
    }
  });

  it("rejects non-boolean shared resource write settings", async () => {
    const invalidBranch = "feature/invalid-shared-write-setting";
    const created = await request(port, "POST", "/api/agents", {
      branch: invalidBranch,
      allowSharedResourceWrites: "yes",
    });
    expect(created.status).toBe(400);
    const workspace = await request(port, "GET", "/api/workspace");
    expect(
      workspace.json.branches.some(
        (branch: { branch: string }) => branch.branch === invalidBranch,
      ),
    ).toBe(false);

    const valid = await request(port, "POST", "/api/agents");
    const updated = await request(port, "PATCH", `/api/agents/${valid.json.id}/settings`, {
      allowSharedResourceWrites: 1,
    });
    expect(updated.status).toBe(400);

    const forked = await request(port, "POST", `/api/agents/${valid.json.id}/fork`, {
      anchorUuid: "u",
      allowSharedResourceWrites: "yes",
    });
    expect(forked.status).toBe(400);
  });

  it.each(["starting", "running"] as const)(
    "preflights %s agent settings before creating branch workspaces",
    async (status) => {
      const created = await request(port, "POST", "/api/agents");
      const runner = manager.get(created.json.id)!;
      const configBefore = manager.configOf(created.json.id);
      const targetBranch = `feature/settings-preflight-${status}`;
      const targetWorktree = path.join(
        projectRoot,
        "worktrees",
        "repo_1",
        `feature-settings-preflight-${status}`,
      );
      const previousWorkDocumentation = manager.appSettings().workDocumentationEnabled;
      manager.updateAppSettings({ workDocumentationEnabled: true });
      const statusSpy = vi.spyOn(runner, "getStatus").mockReturnValue(status);
      const createBranchSpy = vi.spyOn(workspaceManager, "createBranch");
      const prepareWorkspaceSpy = vi.spyOn(workspaceManager, "prepareAgentWorkspace");
      const diffSpy = vi.spyOn(workspaceManager, "diffBetweenBranches");

      try {
        const updated = await request(
          port,
          "PATCH",
          `/api/agents/${created.json.id}/settings`,
          { branch: targetBranch, allowSharedResourceWrites: true },
        );

        expect(updated.status).toBe(400);
        expect(createBranchSpy).not.toHaveBeenCalled();
        expect(prepareWorkspaceSpy).not.toHaveBeenCalled();
        expect(diffSpy).not.toHaveBeenCalled();
        expect(manager.configOf(created.json.id)).toEqual(configBefore);
        const workspace = await request(port, "GET", "/api/workspace");
        expect(
          workspace.json.branches.some(
            (branch: { branch: string }) => branch.branch === targetBranch,
          ),
        ).toBe(false);
        expect(await pathExists(targetWorktree)).toBe(false);
      } finally {
        diffSpy.mockRestore();
        prepareWorkspaceSpy.mockRestore();
        createBranchSpy.mockRestore();
        statusSpy.mockRestore();
        manager.updateAppSettings({ workDocumentationEnabled: previousWorkDocumentation });
      }
    },
  );

  it("serializes a concurrent start behind a branch settings update", async () => {
    const created = await request(port, "POST", "/api/agents");
    const targetBranch = "feature/settings-start-race";
    const originalCreateBranch = workspaceManager.createBranch.bind(workspaceManager);
    let signalCreateBranch!: () => void;
    let releaseCreateBranch!: () => void;
    const createBranchEntered = new Promise<void>((resolve) => {
      signalCreateBranch = resolve;
    });
    const createBranchReleased = new Promise<void>((resolve) => {
      releaseCreateBranch = resolve;
    });
    const createBranchSpy = vi
      .spyOn(workspaceManager, "createBranch")
      .mockImplementationOnce(async (input) => {
        signalCreateBranch();
        await createBranchReleased;
        return await originalCreateBranch(input);
      });
    const startSpy = vi.spyOn(manager, "startAgent");

    try {
      const updating = request(
        port,
        "PATCH",
        `/api/agents/${created.json.id}/settings`,
        {
          branchWorkspaceId: "branch_missing_settings_start_race",
          branch: targetBranch,
        },
      );
      await createBranchEntered;

      const starting = request(port, "POST", `/api/agents/${created.json.id}/start`, {
        prompt: "run after branch switch",
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      expect(startSpy).not.toHaveBeenCalled();
      expect(manager.get(created.json.id)?.getStatus()).toBe("idle");

      releaseCreateBranch();
      const [updated, started] = await Promise.all([updating, starting]);
      expect(updated.status).toBe(200);
      expect(updated.json.config.branch).toBe(targetBranch);
      expect(started.status).toBe(202);
      expect(startSpy).toHaveBeenCalledTimes(1);
      expect(manager.configOf(created.json.id)?.branch).toBe(targetBranch);
    } finally {
      releaseCreateBranch?.();
      await manager.get(created.json.id)?.terminate();
      startSpy.mockRestore();
      createBranchSpy.mockRestore();
    }
  });

  it("rejects a fork queued behind a project switch before creating its branch", async () => {
    const isolatedRoot = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-fork-switch-race-"));
    const source = path.join(isolatedRoot, "source");
    const projectsRoot = path.join(isolatedRoot, "projects");
    await mkdir(source);
    const runGit: GitRunner = async (args, options) => {
      if (args[0] === "remote") return "https://github.com/acme/fork-switch-race.git";
      if (args[0] === "branch") return "main";
      if (args[0] === "clone") {
        await mkdir(path.join(String(args[2]), ".git", "info"), { recursive: true });
        return "";
      }
      if (args[0] === "rev-parse") {
        if (args[1] === "--verify") return "a".repeat(40);
        return path.join(options?.cwd ?? "", ".git", "info", "exclude");
      }
      return "";
    };
    const isolatedWorkspace = new WorkspaceManager({
      defaultSourcePath: source,
      projectsRoot,
      autoOpenDefault: false,
      runGit,
    });
    const projectA = await isolatedWorkspace.createCanvasProject({ name: "Fork source" });
    await isolatedWorkspace.connect({ localPath: source });
    const projectB = await isolatedWorkspace.createCanvasProject({ name: "Fork destination" });
    await isolatedWorkspace.openCanvasProject({ id: projectA.id });
    const isolatedManager = new AgentManager({ query: emptyQuery });
    const isolatedServer = createServer(isolatedManager, undefined, {
      defaultCwd: isolatedRoot,
      workspaceManager: isolatedWorkspace,
    }).httpServer;
    await new Promise<void>((resolve) => isolatedServer.listen(0, resolve));
    const isolatedPort = (isolatedServer.address() as AddressInfo).port;
    let signalOpen!: () => void;
    let releaseOpen!: () => void;
    const openEntered = new Promise<void>((resolve) => {
      signalOpen = resolve;
    });
    const openReleased = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const originalOpen = isolatedWorkspace.withCanvasProjectOpen.bind(isolatedWorkspace);
    const openSpy = vi
      .spyOn(isolatedWorkspace, "withCanvasProjectOpen")
      .mockImplementationOnce(async (input, apply) => {
        signalOpen();
        await openReleased;
        return await originalOpen(input, apply);
      });
    const createBranchSpy = vi.spyOn(isolatedWorkspace, "createBranch");

    try {
      const workspace = await rawRequest(isolatedPort, "GET", "/api/workspace");
      const projectHeaders = {
        "X-Agent-Canvas-Project-Id": workspace.json.canvasProject.id,
        "X-Agent-Canvas-Project-Revision": String(workspace.json.revision),
      };
      const parent = await rawRequest(
        isolatedPort,
        "POST",
        "/api/agents",
        undefined,
        projectHeaders,
      );
      const parentSnapshot = isolatedManager.snapshot(parent.json.id)!;
      isolatedManager.get(parent.json.id)!.restore({
        ...parentSnapshot,
        status: "done",
        sessionId: `session-${parent.json.id}`,
      });

      const opening = rawRequest(isolatedPort, "POST", "/api/canvas-projects/open", {
        id: projectB.id,
      });
      await openEntered;
      const targetBranch = "feature/fork-after-project-switch";
      const targetWorktree = path.join(
        projectA.projectRoot,
        "worktrees",
        "repo_1",
        "feature-fork-after-project-switch",
      );
      const forking = rawRequest(
        isolatedPort,
        "POST",
        `/api/agents/${parent.json.id}/fork`,
        { anchorUuid: "fork-switch-race", branch: targetBranch },
        projectHeaders,
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      expect(createBranchSpy).not.toHaveBeenCalled();

      releaseOpen();
      const [opened, forked] = await Promise.all([opening, forking]);
      expect(opened.status).toBe(200);
      expect(forked.status).toBe(409);
      expect(createBranchSpy).not.toHaveBeenCalled();
      expect(await pathExists(targetWorktree)).toBe(false);
    } finally {
      releaseOpen?.();
      createBranchSpy.mockRestore();
      openSpy.mockRestore();
      await new Promise<void>((resolve) => isolatedServer.close(() => resolve()));
      await rm(isolatedRoot, { recursive: true, force: true });
    }
  });

  it("does not allow start requests to override shared resource permission", async () => {
    const created = await request(port, "POST", "/api/agents");
    const started = await request(port, "POST", `/api/agents/${created.json.id}/start`, {
      prompt: "run",
      allowSharedResourceWrites: true,
    });
    expect(started.status).toBe(400);

    const snapshot = await request(port, "GET", `/api/agents/${created.json.id}`);
    expect(snapshot.json.config.allowSharedResourceWrites).toBe(false);
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

  it("passes an explicit shared write override to the fork manager", async () => {
    const parent = await request(port, "POST", "/api/agents", {
      allowSharedResourceWrites: true,
    });
    const parentSnapshot = manager.snapshot(parent.json.id)!;
    manager.get(parent.json.id)!.restore({
      ...parentSnapshot,
      status: "waiting_input",
      sessionId: `session-${parent.json.id}`,
      config: {
        ...parentSnapshot.config,
        resume: `session-${parent.json.id}`,
      },
    });
    const forkCall = vi.spyOn(manager, "fork");
    try {
      const forked = await request(port, "POST", `/api/agents/${parent.json.id}/fork`, {
        anchorUuid: "u",
        allowSharedResourceWrites: false,
      });
      expect(forked.status).toBe(201);
      expect(forkCall).toHaveBeenCalledWith(
        parent.json.id,
        "u",
        expect.objectContaining({ allowSharedResourceWrites: false }),
      );
      expect(manager.configOf(forked.json.id)?.allowSharedResourceWrites).toBe(false);
    } finally {
      forkCall.mockRestore();
    }
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

  it("stages a multi-file native selection and imports an exact copy", async () => {
    const firstPath = path.join(root, "picked-one.txt");
    const secondPath = path.join(root, "picked-two.png");
    await Promise.all([
      writeFile(firstPath, "picked text", "utf-8"),
      writeFile(secondPath, Buffer.from([0, 1, 2, 255])),
    ]);
    pickFiles.mockResolvedValueOnce([firstPath, secondPath]);

    const picked = await request(port, "POST", "/api/files/pick", {
      initialDirectory: root,
    });
    expect(picked.status).toBe(200);
    expect(picked.json.selection).toMatchObject({
      id: expect.any(String),
      files: [
        { name: "picked-one", extension: "txt", filename: "picked-one.txt", size: 11 },
        { name: "picked-two", extension: "png", filename: "picked-two.png", size: 4 },
      ],
    });
    expect(picked.json.selection.files[0]).not.toHaveProperty("path");
    expect(pickFiles).toHaveBeenLastCalledWith({
      initialDirectory: root,
      multiple: true,
    });

    const imported = await request(port, "POST", "/api/files/import-picked", {
      selectionId: picked.json.selection.id,
      mode: "copy",
      kind: "shared",
    });
    expect(imported.status).toBe(201);
    expect(imported.json.files).toHaveLength(2);
    expect(imported.json.files[0]).toMatchObject({
      filename: "picked-one.txt",
      storage: "isolated",
      kind: "shared",
      availability: "available",
    });
    await expect(readFile(imported.json.files[0].path, "utf-8")).resolves.toBe("picked text");
    await expect(readFile(imported.json.files[1].path)).resolves.toEqual(
      Buffer.from([0, 1, 2, 255]),
    );
  });

  it("rolls back every external authorization when a referenced batch fails validation", async () => {
    const firstPath = path.join(root, "reference-batch-first.txt");
    const secondPath = path.join(root, "reference-batch-second.txt");
    await Promise.all([
      writeFile(firstPath, "first", "utf-8"),
      writeFile(secondPath, "second", "utf-8"),
    ]);
    pickFiles.mockResolvedValueOnce([firstPath, secondPath]);
    const picked = await request(port, "POST", "/api/files/pick", {});
    expect(picked.status).toBe(200);

    const indexPath = path.join(root, "projects-index", "index.json");
    const indexBefore = await readFile(indexPath, "utf-8");
    const trustedBefore = workspaceManager.currentTrustedExternalFilePaths();
    const filesBefore = (await request(port, "GET", "/api/files")).json.files;
    await rm(secondPath);
    await mkdir(secondPath);

    const rejected = await request(port, "POST", "/api/files/import-picked", {
      selectionId: picked.json.selection.id,
      mode: "reference",
      kind: "normal",
    });

    expect(rejected.status).toBe(400);
    await expect(readFile(indexPath, "utf-8")).resolves.toBe(indexBefore);
    expect(workspaceManager.currentTrustedExternalFilePaths()).toEqual(trustedBefore);
    expect((await request(port, "GET", "/api/files")).json.files).toEqual(filesBefore);
    const released = await request(
      port,
      "DELETE",
      `/api/files/pick/${encodeURIComponent(picked.json.selection.id)}`,
    );
    expect(released.status).toBe(204);
  });

  it("returns null when native file selection is cancelled", async () => {
    pickFiles.mockResolvedValueOnce([]);

    const picked = await request(port, "POST", "/api/files/pick", {});

    expect(picked).toEqual({ status: 200, json: { selection: null } });
  });

  it("does not hold the project transaction while the native picker is open", async () => {
    let finishPicking!: (paths: string[]) => void;
    const previousPickCalls = pickFiles.mock.calls.length;
    pickFiles.mockReturnValueOnce(new Promise<string[]>((resolve) => {
      finishPicking = resolve;
    }));

    const pendingPick = request(port, "POST", "/api/files/pick", {});
    await vi.waitFor(() => expect(pickFiles).toHaveBeenCalledTimes(previousPickCalls + 1));
    let workspaceWhilePicking: Resp;
    try {
      workspaceWhilePicking = await Promise.race([
        request(port, "GET", "/api/workspace"),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("workspace request was blocked by native picker")), 200),
        ),
      ]);
    } finally {
      finishPicking([]);
    }
    expect(workspaceWhilePicking.status).toBe(200);

    await expect(pendingPick).resolves.toEqual({ status: 200, json: { selection: null } });
  });

  it("does not open a native picker before project headers are validated", async () => {
    const previousPickCalls = pickFiles.mock.calls.length;

    const rejected = await rawRequest(port, "POST", "/api/files/pick", {});

    expect(rejected.status).toBe(409);
    expect(pickFiles).toHaveBeenCalledTimes(previousPickCalls);
  });

  it("imports and relinks a read-only referenced file with a single-file picker", async () => {
    const sourcePath = path.join(root, "reference-source.txt");
    const replacementPath = path.join(root, "reference-replacement.txt");
    await Promise.all([
      writeFile(sourcePath, "source", "utf-8"),
      writeFile(replacementPath, "replacement", "utf-8"),
    ]);
    pickFiles.mockResolvedValueOnce([sourcePath]);
    const picked = await request(port, "POST", "/api/files/pick", {});
    const imported = await request(port, "POST", "/api/files/import-picked", {
      selectionId: picked.json.selection.id,
      mode: "reference",
      kind: "normal",
    });
    expect(imported.status).toBe(201);
    const referenced = imported.json.files[0];
    expect(referenced).toMatchObject({
      path: sourcePath,
      storage: "referenced",
      availability: "available",
    });
    expect(workspaceManager.currentTrustedExternalFilePaths()).toContain(path.resolve(sourcePath));

    let finishRelink!: (paths: string[]) => void;
    const previousRelinkPickCalls = pickFiles.mock.calls.length;
    pickFiles.mockReturnValueOnce(new Promise<string[]>((resolve) => {
      finishRelink = resolve;
    }));
    const pendingRelink = request(
      port,
      "POST",
      `/api/files/${encodeURIComponent(referenced.id)}/relink`,
    );
    await vi.waitFor(() =>
      expect(pickFiles).toHaveBeenCalledTimes(previousRelinkPickCalls + 1),
    );
    let workspaceWhileRelinking: Resp;
    try {
      workspaceWhileRelinking = await Promise.race([
        request(port, "GET", "/api/workspace"),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("workspace request was blocked by relink picker")), 200),
        ),
      ]);
    } finally {
      finishRelink([]);
    }
    expect(workspaceWhileRelinking.status).toBe(200);
    const cancelled = await pendingRelink;
    expect(cancelled).toEqual({ status: 200, json: { file: null } });

    pickFiles.mockResolvedValueOnce([replacementPath]);
    const relinked = await request(
      port,
      "POST",
      `/api/files/${encodeURIComponent(referenced.id)}/relink`,
    );
    expect(relinked.status).toBe(200);
    expect(relinked.json.file).toMatchObject({
      id: referenced.id,
      path: replacementPath,
      filename: "reference-source.txt",
      storage: "referenced",
      availability: "available",
    });
    expect(workspaceManager.currentTrustedExternalFilePaths()).toContain(
      path.resolve(replacementPath),
    );
    expect(pickFiles).toHaveBeenLastCalledWith({
      initialDirectory: path.dirname(sourcePath),
      multiple: false,
    });

    await rm(replacementPath);
    const refreshed = await request(
      port,
      "POST",
      `/api/files/${encodeURIComponent(referenced.id)}/refresh`,
    );
    expect(refreshed.status).toBe(200);
    expect(refreshed.json.file).toMatchObject({
      id: referenced.id,
      storage: "referenced",
      availability: "missing",
    });

    openFile.mockClear();
    const unavailableOpen = await request(
      port,
      "POST",
      `/api/files/${encodeURIComponent(referenced.id)}/open`,
    );
    expect(unavailableOpen.status).toBe(500);
    expect(unavailableOpen.json.error).toContain("missing");
    expect(openFile).not.toHaveBeenCalled();
  });

  it("does not retain authorization when a referenced-file relink fails validation", async () => {
    const sourcePath = path.join(root, "relink-rollback-source.txt");
    const invalidReplacement = path.join(root, "relink-rollback-directory");
    await writeFile(sourcePath, "source", "utf-8");
    await mkdir(invalidReplacement);
    pickFiles.mockResolvedValueOnce([sourcePath]);
    const picked = await request(port, "POST", "/api/files/pick", {});
    const imported = await request(port, "POST", "/api/files/import-picked", {
      selectionId: picked.json.selection.id,
      mode: "reference",
      kind: "normal",
    });
    expect(imported.status).toBe(201);
    const referenced = imported.json.files[0];
    await new Promise((resolve) => setTimeout(resolve, 150));

    const indexPath = path.join(root, "projects-index", "index.json");
    const indexBefore = await readFile(indexPath, "utf-8");
    const trustedBefore = workspaceManager.currentTrustedExternalFilePaths();
    pickFiles.mockResolvedValueOnce([invalidReplacement]);

    const rejected = await request(
      port,
      "POST",
      `/api/files/${encodeURIComponent(referenced.id)}/relink`,
    );

    expect(rejected.status).toBe(400);
    await expect(readFile(indexPath, "utf-8")).resolves.toBe(indexBefore);
    expect(workspaceManager.currentTrustedExternalFilePaths()).toEqual(trustedBefore);
    const current = (await request(port, "GET", "/api/files")).json.files.find(
      (file: { id: string }) => file.id === referenced.id,
    );
    expect(current).toEqual(referenced);
  });

  it("persists a referenced file that becomes missing during a content read", async () => {
    const sourcePath = path.join(root, "content-missing-reference.txt");
    const displacedPath = `${sourcePath}.displaced`;
    await writeFile(sourcePath, "source", "utf-8");
    pickFiles.mockResolvedValueOnce([sourcePath]);
    const picked = await request(port, "POST", "/api/files/pick", {});
    const imported = await request(port, "POST", "/api/files/import-picked", {
      selectionId: picked.json.selection.id,
      mode: "reference",
      kind: "normal",
    });
    expect(imported.status).toBe(201);
    const referenced = imported.json.files[0];
    await new Promise((resolve) => setTimeout(resolve, 150));

    await rename(sourcePath, displacedPath);
    await mkdir(sourcePath);
    const unavailable = await request(
      port,
      "GET",
      `/api/files/${encodeURIComponent(referenced.id)}/content`,
    );
    expect(unavailable.status).toBe(415);
    expect(unavailable.json.error).toContain("missing or unavailable");
    const inMemory = (await request(port, "GET", "/api/files")).json.files.find(
      (file: { id: string }) => file.id === referenced.id,
    );
    expect(inMemory).toMatchObject({ availability: "missing", path: sourcePath });
    await vi.waitFor(async () => {
      const persisted = JSON.parse(
        await readFile(path.join(projectRoot, "canvas-state.json"), "utf-8"),
      );
      expect(
        persisted.files.files.find((file: { id: string }) => file.id === referenced.id),
      ).toMatchObject({ availability: "missing", path: sourcePath });
    }, { timeout: 2_000, interval: 25 });
  });

  it("releases an unused native selection token", async () => {
    const sourcePath = path.join(root, "released-selection.txt");
    await writeFile(sourcePath, "unused", "utf-8");
    pickFiles.mockResolvedValueOnce([sourcePath]);
    const picked = await request(port, "POST", "/api/files/pick", {});

    const released = await request(
      port,
      "DELETE",
      `/api/files/pick/${encodeURIComponent(picked.json.selection.id)}`,
    );
    expect(released.status).toBe(204);

    const rejected = await request(port, "POST", "/api/files/import-picked", {
      selectionId: picked.json.selection.id,
      mode: "copy",
      kind: "normal",
    });
    expect(rejected.status).toBe(410);
    expect(rejected.json).toMatchObject({ code: "picked_selection_expired" });
    expect(rejected.json.error).toContain("Unknown or expired");
  });

  it("preserves raw upload bytes without JSON preloading and enforces the upload limit", async () => {
    const bytes = Buffer.from([0, 123, 34, 255, 10]);
    const uploaded = await uploadRequest(
      port,
      "/api/files/import-upload?filename=raw.bin&kind=normal",
      bytes,
    );
    expect(uploaded.status).toBe(201);
    expect(uploaded.json.file).toMatchObject({
      filename: "raw.bin",
      storage: "isolated",
      kind: "normal",
      availability: "available",
    });
    await expect(readFile(uploaded.json.file.path)).resolves.toEqual(bytes);

    const unusualName = await uploadRequest(
      port,
      "/api/files/import-upload?filename=%20notes.long%2BEXT&kind=normal",
      Buffer.from("named"),
    );
    expect(unusualName.status).toBe(201);
    expect(unusualName.json.file).toMatchObject({
      name: " notes",
      extension: "long+EXT",
      filename: " notes.long+EXT",
      previewKind: "none",
    });
    expect(path.basename(unusualName.json.file.path)).toBe(" notes.long+EXT");

    const oversized = await uploadRequest(
      port,
      "/api/files/import-upload?filename=too-large.bin&kind=normal",
      Buffer.alloc(17),
    );
    expect(oversized.status).toBe(413);
    expect(oversized.json.error).toContain("16 bytes");
  });

  it("reads a slow chunked upload before entering the global project transaction", async () => {
    if (!requestWorkspaceContext) await request(port, "GET", "/api/workspace");
    let slowRequest!: http.ClientRequest;
    let socketAssigned!: Promise<unknown[]>;
    const slowResponse = new Promise<Resp>((resolve, reject) => {
      slowRequest = http.request(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path: "/api/files/import-upload?filename=slow.bin&kind=normal",
          headers: {
            "Content-Type": "application/octet-stream",
            "X-Agent-Canvas-Project-Id": requestWorkspaceContext!.canvasProjectId,
            "X-Agent-Canvas-Project-Revision": String(requestWorkspaceContext!.revision),
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
      socketAssigned = once(slowRequest, "socket");
      slowRequest.on("error", reject);
      slowRequest.write(Buffer.from([1]));
      setTimeout(() => slowRequest.end(Buffer.from([2])), 250);
    });
    await socketAssigned;
    await new Promise((resolve) => setTimeout(resolve, 25));

    const workspaceWhileUploading = await Promise.race([
      request(port, "GET", "/api/workspace"),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("workspace request was blocked by upload body")), 200),
      ),
    ]);
    expect(workspaceWhileUploading.status).toBe(200);
    const uploaded = await slowResponse;
    expect(uploaded.status).toBe(201);
    await expect(readFile(uploaded.json.file.path)).resolves.toEqual(Buffer.from([1, 2]));
  });

  it("surfaces an unavailable native file picker without staging a selection", async () => {
    pickFiles.mockRejectedValueOnce(new Error("picker unavailable"));

    const picked = await request(port, "POST", "/api/files/pick", {});

    expect(picked).toEqual({ status: 501, json: { error: "picker unavailable" } });
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

    const openCalls = openFile.mock.calls.length;
    const missingProjectContext = await rawRequest(
      port,
      "POST",
      `/api/files/${created.json.file.id}/open`,
    );
    expect(missingProjectContext.status).toBe(409);
    expect(openFile).toHaveBeenCalledTimes(openCalls);

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
    const externalPath = path.join(root, "open-rollback-reference.txt");
    await writeFile(externalPath, "external reference", "utf-8");
    const projectAStatePath = path.join(projectA.json.project.projectRoot, "canvas-state.json");
    const projectAState = JSON.parse(await readFile(projectAStatePath, "utf-8"));
    projectAState.files.files.push({
      id: `file_${projectAState.files.files.length + 1}`,
      name: "open-rollback-reference",
      extension: "txt",
      filename: "open-rollback-reference.txt",
      path: externalPath,
      storage: "referenced",
      availability: "available",
      kind: "normal",
      sharedRead: false,
      sharedWrite: false,
      previewKind: "text",
      mimeType: "text/plain; charset=utf-8",
      createdAt: 1,
      updatedAt: 1,
    });
    await writeFile(
      projectAStatePath,
      `${JSON.stringify(projectAState, undefined, 2)}\n`,
      "utf-8",
    );
    const projectIndexPath = path.join(root, "projects-index", "index.json");
    const projectIndexBefore = await readFile(projectIndexPath, "utf-8");
    const trustedBefore = workspaceManager.currentTrustedExternalFilePaths();

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
      trustedExternalFilePaths: [externalPath],
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
    await expect(readFile(projectIndexPath, "utf-8")).resolves.toBe(projectIndexBefore);
    expect(workspaceManager.currentTrustedExternalFilePaths()).toEqual(trustedBefore);

    const rejectedRetry = await request(port, "POST", "/api/canvas-projects/open", {
      id: projectA.json.project.id,
    });
    expect(rejectedRetry.status).toBe(404);
    expect((await request(port, "GET", "/api/workspace")).json.canvasProject.id).toBe(
      projectB.json.project.id,
    );
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

  it("revokes target files when project-open recovery and snapshot cleanup both fail", async () => {
    const target = await request(port, "POST", "/api/canvas-projects", {
      name: "open-double-failure-target",
    });
    const externalPath = path.join(root, "open-double-failure-secret.txt");
    await writeFile(externalPath, "target external secret", "utf-8");
    pickFiles.mockResolvedValueOnce([externalPath]);
    const picked = await request(port, "POST", "/api/files/pick", {});
    const imported = await request(port, "POST", "/api/files/import-picked", {
      selectionId: picked.json.selection.id,
      mode: "reference",
      kind: "shared",
    });
    const targetFile = imported.json.files[0];
    expect(imported.status).toBe(201);
    expect((await request(port, "PATCH", `/api/files/${targetFile.id}`, {
      sharedRead: true,
    })).status).toBe(200);

    const previous = await request(port, "POST", "/api/canvas-projects", {
      name: "open-double-failure-previous",
    });
    const previousFile = await request(port, "POST", "/api/files", {
      name: "previous-file",
      extension: "txt",
      kind: "normal",
    });
    expect(previousFile.status).toBe(201);

    let retainedSnapshotPath = "";
    beforeNextProjectStatePromptImport = async () => {
      await fileManager.prepareAccessFor("double-failure-audit-agent");
      retainedSnapshotPath =
        fileManager.accessFor("double-failure-audit-agent").readableFiles[0]!.path;
      throw new Error("injected target prompt import failure");
    };
    const originalManagerImport = manager.importState.bind(manager);
    let managerImportCalls = 0;
    const managerImportSpy = vi.spyOn(manager, "importState").mockImplementation(async (state) => {
      managerImportCalls += 1;
      if (managerImportCalls === 2) {
        throw new Error("injected previous manager recovery failure");
      }
      await originalManagerImport(state);
    });
    beforeNextAccessSnapshotRemoval = async () => {
      throw Object.assign(new Error("injected recovery snapshot cleanup EBUSY"), {
        code: "EBUSY",
      });
    };

    try {
      const failed = await request(port, "POST", "/api/canvas-projects/open", {
        id: target.json.project.id,
      });
      expect(failed.status).toBe(404);
      expect(failed.json.error).toContain(
        "Project open, previous-project recovery, and unsafe-state cleanup all failed",
      );
      expect(managerImportCalls).toBe(2);
      expect((await request(port, "GET", "/api/workspace")).json.canvasProject.id).toBe(
        previous.json.project.id,
      );
      expect((await request(port, "GET", "/api/files")).json.files).toEqual([]);
      expect((await request(port, "GET", `/api/files/${targetFile.id}/content`)).status).toBe(404);
      await expect(readFile(retainedSnapshotPath, "utf-8")).resolves.toBe(
        "target external secret",
      );

      await expect(fileManager.importState(undefined)).resolves.toBeUndefined();
      await expect(readFile(retainedSnapshotPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      beforeNextProjectStatePromptImport = undefined;
      beforeNextAccessSnapshotRemoval = undefined;
      managerImportSpy.mockRestore();
    }

    await request(port, "GET", "/api/workspace");
    const restored = await request(port, "POST", "/api/canvas-projects/open", {
      id: previous.json.project.id,
    });
    expect(restored.status).toBe(200);
    expect((await request(port, "GET", "/api/files")).json.files).toContainEqual(
      expect.objectContaining({ id: previousFile.json.file.id }),
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
    const originalOpen = workspaceManager.withCanvasProjectOpen.bind(workspaceManager);
    const openSpy = vi.spyOn(workspaceManager, "withCanvasProjectOpen").mockImplementationOnce(
      async (input, apply) => await originalOpen(input, async (workspace) => {
        markProjectSelected();
        await projectOpenRelease;
        return await apply(workspace);
      }),
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
