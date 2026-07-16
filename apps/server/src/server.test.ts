import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentEventEnvelope, AgentSnapshot } from "@agent-canvas/shared";
import { AgentManager } from "./AgentManager.js";
import { CommitManager } from "./commits/CommitManager.js";
import { createServer } from "./server.js";
import { FileManager } from "./files/FileManager.js";
import type { OpenInVscodeOptions } from "./files/VscodeFileOpener.js";
import { PromptManager } from "./prompts/PromptManager.js";
import { CodexAuthManager } from "./sdk/CodexAuthManager.js";
import { SyncFlowManager, type SyncFlowAgentHost } from "./sync/SyncFlowManager.js";
import type { QueryFn } from "./sdk/types.js";
import { WorkspaceManager, type GitRunner } from "./workspaces/WorkspaceManager.js";

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

function request(
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

describe("HTTP server", () => {
  let server: http.Server;
  let port = 0;
  let root = "";
  let projectRoot = "";
  let syncHost: FakeSyncHost;
  let syncFlowManager: SyncFlowManager;
  const openFile = vi
    .fn<(filePath: string, options?: OpenInVscodeOptions) => Promise<void>>()
    .mockResolvedValue(undefined);
  const pickDirectory = vi
    .fn<(initialDirectory?: string) => Promise<string | undefined>>()
    .mockResolvedValue("C:\\picked");

  beforeAll(async () => {
    const manager = new AgentManager({ query: emptyQuery });
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
      if (args[0] === "rev-parse") {
        return path.join(options?.cwd ?? "", ".git", "info", "exclude");
      }
      return "";
    };
    const workspaceManager = new WorkspaceManager({
      defaultSourcePath: root,
      projectRoot,
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
    syncHost = new FakeSyncHost();
    syncFlowManager = new SyncFlowManager({ host: syncHost });
    ({ httpServer: server } = createServer(manager, fileManager, {
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
    expect(initial).toEqual({ status: 200, json: { fullPermissionMode: false } });

    const updated = await request(port, "PATCH", "/api/settings", {
      fullPermissionMode: true,
    });
    expect(updated).toEqual({ status: 200, json: { fullPermissionMode: true } });

    await request(port, "PATCH", "/api/settings", { fullPermissionMode: false });
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
      path.join(root, "isolated", created.json.file.id, "brief.md"),
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

  it("canvas project REST 支持从自定义文件夹加载和删除项目", async () => {
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

  it("canvas project 保存并恢复节点快照和布局", async () => {
    const projectA = await request(port, "POST", "/api/canvas-projects", {
      name: "persist-a",
    });
    expect(projectA.status).toBe(201);
    await request(port, "POST", "/api/workspace/connect", { localPath: root });

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

    const layout = await request(port, "PATCH", "/api/canvas-layout", {
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
      agents: { agents: [expect.objectContaining({ id: agent.json.id })] },
      files: { files: [expect.objectContaining({ id: file.json.file.id })] },
      prompts: { prompts: [expect.objectContaining({ id: prompt.json.prompt.id })] },
      layout: {
        nodes: expect.arrayContaining([
          expect.objectContaining({ id: `${agent.json.id}#0` }),
        ]),
      },
    });

    const projectB = await request(port, "POST", "/api/canvas-projects", {
      name: "persist-b",
    });
    expect(projectB.status).toBe(201);
    expect((await request(port, "GET", "/api/agents")).json.agents).toHaveLength(0);

    const reopened = await request(port, "POST", "/api/canvas-projects/open", {
      id: projectA.json.project.id,
    });
    expect(reopened.status).toBe(200);

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
      expect.objectContaining({ id: prompt.json.prompt.id, content: "saved prompt" }),
    ]);
    expect(restoredLayout.json.nodes).toEqual(layout.json.nodes);
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
