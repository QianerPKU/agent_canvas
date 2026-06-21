import http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type {
  AgentApprovalResponse,
  AgentCanvasSettings,
  AgentFileAccess,
  AgentQuestionResponse,
  AgentPromptReference,
  AgentSettings,
  AgentStartConfig,
  BranchDiffSummary,
  ConnectGitHubInput,
  CreateBranchWorkspaceInput,
  CreateAgentInput,
  CreateCanvasProjectInput,
  CreateCanvasFileInput,
  CreateCanvasPromptInput,
  CreateSharedResourceInput,
  OpenCanvasProjectInput,
  PullRequestCreatedInput,
  CreatePullRequestFlowInput,
  ReportAgentCommitInput,
  ServerFrame,
  UpdateAgentSettingsInput,
  UpdateCanvasFileInput,
  UpdateCanvasPromptInput,
} from "@agent-canvas/shared";
import { AgentManager } from "./AgentManager.js";
import { CommitManager } from "./commits/CommitManager.js";
import { pickDirectory as defaultPickDirectory, type PickDirectory } from "./files/DirectoryPicker.js";
import { FileManager } from "./files/FileManager.js";
import { openFileInVscode } from "./files/VscodeFileOpener.js";
import { PromptManager } from "./prompts/PromptManager.js";
import { PullRequestFlowManager } from "./pullRequests/PullRequestFlowManager.js";
import { WorkspaceManager } from "./workspaces/WorkspaceManager.js";

export interface CreateServerResult {
  httpServer: http.Server;
  wss: WebSocketServer;
  manager: AgentManager;
  fileManager: FileManager;
  promptManager: PromptManager;
  workspaceManager: WorkspaceManager;
  pullRequestFlowManager: PullRequestFlowManager;
  commitManager: CommitManager;
}

export interface CreateServerOptions {
  defaultCwd?: string;
  openFile?: (filePath: string) => Promise<void>;
  pickDirectory?: PickDirectory;
  promptManager?: PromptManager;
  workspaceManager?: WorkspaceManager;
  pullRequestFlowManager?: PullRequestFlowManager;
  commitManager?: CommitManager;
}

/**
 * 组装 HTTP（REST 命令）+ WebSocket（事件广播）服务。
 * 命令端到端：前端 POST /api/... → manager/runner；事件 runner → manager → WS。
 */
export function createServer(
  manager: AgentManager,
  fileManager?: FileManager,
  options: CreateServerOptions = {},
): CreateServerResult {
  const defaultCwd = options.defaultCwd ?? process.cwd();
  fileManager ??= new FileManager({
    workspaceRoot: defaultCwd,
  });
  const workspaceManager =
    options.workspaceManager ?? new WorkspaceManager({ defaultSourcePath: defaultCwd });
  manager.setFileAccessResolver((agentId) =>
    mergeFileAccess(
      fileManager.accessFor(agentId),
      workspaceManager.accessForAgent(manager.configOf(agentId)),
    ),
  );
  const promptManager =
    options.promptManager ??
    new PromptManager({
      workspaceRoot: defaultCwd,
    });
  const pullRequestFlowManager =
    options.pullRequestFlowManager ??
    new PullRequestFlowManager({
      host: manager,
      resolveChangedFiles: async ({ sourceBranch, targetBranch }) =>
        (await workspaceManager.diffPullRequestFiles(sourceBranch, targetBranch))?.files ?? [],
    });
  const commitManager = options.commitManager ?? new CommitManager();
  manager.setPromptAccessResolver((agentId) => promptManager.accessFor(agentId));
  const httpServer = http.createServer((req, res) => {
    handleHttp(
      req,
      res,
      manager,
      fileManager,
      promptManager,
      workspaceManager,
      pullRequestFlowManager,
      commitManager,
      defaultCwd,
      options.openFile ?? openFileInVscode,
      options.pickDirectory ?? defaultPickDirectory,
    ).catch((err) => {
      sendJson(res, 500, { error: errMsg(err) });
    });
  });

  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
  wss.on("connection", (ws: WebSocket) => {
    // 连接即下发当前快照
    send(ws, {
      type: "hello",
      agents: manager.list(),
      prFlows: pullRequestFlowManager.list(),
      commits: commitManager.list(),
    });
  });

  // 把 manager 的事件广播到所有 WS 客户端
  manager.onEvent((envelope) => {
    void pullRequestFlowManager.handleAgentEvent(envelope);
    const frame: ServerFrame = { type: "event", envelope };
    const data = JSON.stringify(frame);
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send(data);
    }
  });

  pullRequestFlowManager.onFlow((flow) => {
    const frame: ServerFrame = { type: "pr_flow", flow };
    const data = JSON.stringify(frame);
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send(data);
    }
  });

  commitManager.onCommit((commit) => {
    const frame: ServerFrame = { type: "commit", commit };
    const data = JSON.stringify(frame);
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send(data);
    }
  });

  return {
    httpServer,
    wss,
    manager,
    fileManager,
    promptManager,
    workspaceManager,
    pullRequestFlowManager,
    commitManager,
  };
}

async function handleHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  manager: AgentManager,
  fileManager: FileManager,
  promptManager: PromptManager,
  workspaceManager: WorkspaceManager,
  pullRequestFlowManager: PullRequestFlowManager,
  commitManager: CommitManager,
  defaultCwd: string,
  openFile: (filePath: string) => Promise<void>,
  pickDirectory: PickDirectory,
): Promise<void> {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (method === "GET" && path === "/api/health") {
    return sendJson(res, 200, { ok: true });
  }

  if (method === "GET" && path === "/api/config") {
    return sendJson(res, 200, { defaultCwd, projectRoot: workspaceManager.root() });
  }

  if (method === "GET" && path === "/api/settings") {
    return sendJson(res, 200, manager.appSettings());
  }

  if (method === "PATCH" && path === "/api/settings") {
    const body = await readJson<Partial<AgentCanvasSettings>>(req);
    return sendJson(res, 200, manager.updateAppSettings(body ?? {}));
  }

  if (method === "GET" && path === "/api/canvas-projects") {
    return sendJson(res, 200, { projects: await workspaceManager.listCanvasProjects() });
  }

  if (method === "POST" && path === "/api/canvas-projects") {
    const body = await readJson<CreateCanvasProjectInput>(req);
    if (!body?.name) return sendJson(res, 400, { error: "缺少项目名称" });
    try {
      const project = await workspaceManager.createCanvasProject(body);
      return sendJson(res, 201, { project, workspace: await workspaceManager.project() });
    } catch (error) {
      return sendJson(res, 400, { error: errMsg(error) });
    }
  }

  if (method === "POST" && path === "/api/canvas-projects/open") {
    const body = await readJson<OpenCanvasProjectInput>(req);
    if (!body?.id) return sendJson(res, 400, { error: "缺少项目 id" });
    try {
      return sendJson(res, 200, { workspace: await workspaceManager.openCanvasProject(body) });
    } catch (error) {
      return sendJson(res, 404, { error: errMsg(error) });
    }
  }

  if (method === "GET" && path === "/api/workspace") {
    try {
      return sendJson(res, 200, await workspaceManager.project());
    } catch (error) {
      return sendJson(res, 409, { error: errMsg(error) });
    }
  }

  if (method === "POST" && path === "/api/workspace/connect") {
    const body = await readJson<ConnectGitHubInput>(req);
    try {
      return sendJson(res, 200, await workspaceManager.connect(body ?? {}));
    } catch (error) {
      return sendJson(res, 400, { error: errMsg(error) });
    }
  }

  if (method === "GET" && path === "/api/workspace/branches") {
    try {
      return sendJson(res, 200, { branches: await workspaceManager.listBranches() });
    } catch (error) {
      return sendJson(res, 409, { error: errMsg(error) });
    }
  }

  if (method === "GET" && path === "/api/workspace/branch-options") {
    try {
      return sendJson(res, 200, { branches: await workspaceManager.listBranchOptions() });
    } catch (error) {
      return sendJson(res, 409, { error: errMsg(error) });
    }
  }

  if (method === "POST" && path === "/api/workspace/branches") {
    const body = await readJson<CreateBranchWorkspaceInput>(req);
    if (!body?.branch) return sendJson(res, 400, { error: "缺少 branch" });
    try {
      return sendJson(res, 201, { branch: await workspaceManager.createBranch(body) });
    } catch (error) {
      return sendJson(res, 400, { error: errMsg(error) });
    }
  }

  if (method === "GET" && path === "/api/workspace/shared-resources") {
    try {
      return sendJson(res, 200, {
        resources: (await workspaceManager.project()).sharedResources,
      });
    } catch (error) {
      return sendJson(res, 409, { error: errMsg(error) });
    }
  }

  if (method === "POST" && path === "/api/workspace/shared-resources") {
    const body = await readJson<CreateSharedResourceInput>(req);
    if (!body?.name || !body.mountPath) {
      return sendJson(res, 400, { error: "缺少共享资源名称或挂载路径" });
    }
    try {
      return sendJson(res, 201, {
        resource: await workspaceManager.createSharedResource(body),
      });
    } catch (error) {
      return sendJson(res, 400, { error: errMsg(error) });
    }
  }

  if (method === "POST" && path === "/api/directories/pick") {
    const body = await readJson<{ initialDirectory?: string }>(req);
    try {
      return sendJson(res, 200, {
        path: (await pickDirectory(body?.initialDirectory)) ?? null,
      });
    } catch (error) {
      return sendJson(res, 501, { error: errMsg(error) });
    }
  }

  if (method === "GET" && path === "/api/agents") {
    return sendJson(res, 200, { agents: manager.list() });
  }

  if (method === "GET" && path === "/api/pr-flows") {
    return sendJson(res, 200, { flows: pullRequestFlowManager.list() });
  }

  if (method === "GET" && path === "/api/commits") {
    return sendJson(res, 200, { commits: commitManager.list() });
  }

  if (method === "POST" && path === "/api/pr-flows") {
    const body = await readJson<CreatePullRequestFlowInput>(req);
    try {
      return sendJson(res, 201, {
        flow: await pullRequestFlowManager.create(body ?? ({} as CreatePullRequestFlowInput)),
      });
    } catch (error) {
      return sendJson(res, 400, { error: errMsg(error) });
    }
  }

  const prFlowMatch = path.match(/^\/api\/pr-flows\/([^/]+)(?:\/([^/]+))?$/);
  if (prFlowMatch) {
    const id = decodeURIComponent(prFlowMatch[1]!);
    const action = prFlowMatch[2];
    if (method === "GET" && !action) {
      const flow = pullRequestFlowManager.get(id);
      return flow
        ? sendJson(res, 200, { flow })
        : sendJson(res, 404, { error: `unknown PR flow: ${id}` });
    }
    if (method === "POST" && action === "pr-created") {
      const body = await readJson<PullRequestCreatedInput>(req);
      try {
        return sendJson(res, 200, {
          flow: await pullRequestFlowManager.recordPrCreated(id, body ?? {}),
        });
      } catch (error) {
        return sendJson(res, 400, { error: errMsg(error) });
      }
    }
    if (method === "POST" && action === "merged") {
      try {
        return sendJson(res, 200, { flow: pullRequestFlowManager.recordMerged(id) });
      } catch (error) {
        return sendJson(res, 400, { error: errMsg(error) });
      }
    }
    if (method === "POST" && action === "cancel") {
      try {
        return sendJson(res, 200, { flow: pullRequestFlowManager.cancel(id) });
      } catch (error) {
        return sendJson(res, 404, { error: errMsg(error) });
      }
    }
  }

  if (method === "POST" && path === "/api/agents") {
    const body = await readJson<CreateAgentInput>(req);
    try {
      const settings = normalizeAgentSettings(
        await resolveAgentWorkspaceSettings(workspaceManager, body, defaultCwd, true),
        defaultCwd,
      );
      const runner = manager.create(settings);
      return sendJson(res, 201, { id: runner.id });
    } catch (error) {
      return sendJson(res, 400, { error: errMsg(error) });
    }
  }

  if (method === "GET" && path === "/api/files") {
    return sendJson(res, 200, { files: fileManager.list() });
  }

  if (method === "POST" && path === "/api/files") {
    const body = await readJson<CreateCanvasFileInput>(req);
    if (
      !body?.name ||
      (body.storage !== undefined && body.storage !== "isolated") ||
      !["normal", "shared"].includes(body.kind)
    ) {
      return sendJson(res, 400, { error: "缺少文件名、节点类型，或文件节点存储位置不是隔离目录" });
    }
    try {
      return sendJson(res, 201, { file: await fileManager.create(body) });
    } catch (error) {
      return sendJson(res, 400, { error: errMsg(error) });
    }
  }

  if (method === "GET" && path === "/api/prompts") {
    return sendJson(res, 200, { prompts: promptManager.list() });
  }

  if (method === "POST" && path === "/api/prompts") {
    const body = await readJson<CreateCanvasPromptInput>(req);
    if (
      !body?.name ||
      typeof body.content !== "string" ||
      !["normal", "shared"].includes(body.kind)
    ) {
      return sendJson(res, 400, { error: "缺少提示词名称、内容或节点类型" });
    }
    try {
      return sendJson(res, 201, { prompt: await promptManager.create(body) });
    } catch (error) {
      return sendJson(res, 400, { error: errMsg(error) });
    }
  }

  const promptMatch = path.match(/^\/api\/prompts\/([^/]+)$/);
  if (promptMatch) {
    const id = decodeURIComponent(promptMatch[1]!);
    if (!promptManager.get(id)) {
      return sendJson(res, 404, { error: `未知提示词节点: ${id}` });
    }
    if (method === "PATCH") {
      const body = await readJson<UpdateCanvasPromptInput>(req);
      try {
        return sendJson(res, 200, {
          prompt: await promptManager.update(id, body ?? {}),
        });
      } catch (error) {
        return sendJson(res, 400, { error: errMsg(error) });
      }
    }
  }

  const fileMatch = path.match(/^\/api\/files\/([^/]+)(?:\/([^/]+))?$/);
  if (fileMatch) {
    const id = decodeURIComponent(fileMatch[1]!);
    const action = fileMatch[2];
    if (!fileManager.get(id)) return sendJson(res, 404, { error: `未知文件节点: ${id}` });
    if (method === "PATCH" && !action) {
      const body = await readJson<UpdateCanvasFileInput>(req);
      try {
        return sendJson(res, 200, { file: await fileManager.update(id, body ?? {}) });
      } catch (error) {
        return sendJson(res, 400, { error: errMsg(error) });
      }
    }
    if (method === "GET" && action === "content") {
      try {
        return sendJson(
          res,
          200,
          url.searchParams.get("full") === "1"
            ? await fileManager.readContent(id)
            : await fileManager.readPreview(id),
        );
      } catch (error) {
        return sendJson(res, 415, { error: errMsg(error) });
      }
    }
    if (method === "GET" && action === "raw") {
      const { file, data } = await fileManager.readRaw(id);
      res.writeHead(200, {
        "Content-Type": file.mimeType,
        "Content-Length": data.length,
        "Cache-Control": "no-store",
      });
      res.end(data);
      return;
    }
    if (method === "POST" && action === "open") {
      try {
        await openFile(fileManager.get(id)!.path);
        return sendJson(res, 202, { ok: true });
      } catch (error) {
        return sendJson(res, 500, { error: errMsg(error) });
      }
    }
  }

  if (method === "GET" && path === "/api/file-connections") {
    return sendJson(res, 200, { connections: fileManager.listConnections() });
  }

  if (method === "POST" && path === "/api/file-connections") {
    const body = await readJson<{ fileId?: string; agentId?: string; access?: "read" | "write" }>(
      req,
    );
    if (
      !body?.fileId ||
      !body.agentId ||
      !body.access ||
      !["read", "write"].includes(body.access)
    ) {
      return sendJson(res, 400, { error: "缺少 fileId、agentId 或 access" });
    }
    if (!manager.get(body.agentId)) {
      return sendJson(res, 404, { error: `未知 agent: ${body.agentId}` });
    }
    try {
      return sendJson(res, 201, {
        connection: fileManager.connect(body.fileId, body.agentId, body.access),
      });
    } catch (error) {
      return sendJson(res, 400, { error: errMsg(error) });
    }
  }

  if (method === "GET" && path === "/api/prompt-connections") {
    return sendJson(res, 200, { connections: promptManager.listConnections() });
  }

  if (method === "POST" && path === "/api/prompt-connections") {
    const body = await readJson<{
      promptId?: string;
      agentId?: string;
      access?: "read" | "write";
    }>(req);
    if (
      !body?.promptId ||
      !body.agentId ||
      !body.access ||
      !["read", "write"].includes(body.access)
    ) {
      return sendJson(res, 400, { error: "缺少 promptId、agentId 或 access" });
    }
    if (!manager.get(body.agentId)) {
      return sendJson(res, 404, { error: `未知 agent: ${body.agentId}` });
    }
    try {
      return sendJson(res, 201, {
        connection: promptManager.connect(body.promptId, body.agentId, body.access),
      });
    } catch (error) {
      return sendJson(res, 400, { error: errMsg(error) });
    }
  }

  const promptConnectionMatch = path.match(/^\/api\/prompt-connections\/([^/]+)$/);
  if (method === "DELETE" && promptConnectionMatch) {
    const id = decodeURIComponent(promptConnectionMatch[1]!);
    if (!promptManager.disconnect(id)) {
      return sendJson(res, 404, { error: `未知提示词连线: ${id}` });
    }
    res.writeHead(204);
    res.end();
    return;
  }

  const connectionMatch = path.match(/^\/api\/file-connections\/([^/]+)$/);
  if (method === "DELETE" && connectionMatch) {
    const id = decodeURIComponent(connectionMatch[1]!);
    if (!fileManager.disconnect(id)) {
      return sendJson(res, 404, { error: `未知文件连线: ${id}` });
    }
    res.writeHead(204);
    res.end();
    return;
  }

  const questionMatch = path.match(/^\/api\/agents\/([^/]+)\/questions\/([^/]+)$/);
  if (questionMatch) {
    const id = decodeURIComponent(questionMatch[1]!);
    const requestId = decodeURIComponent(questionMatch[2]!);
    if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
    const body = await readJson<AgentQuestionResponse>(req);
    try {
      manager.answerQuestion(id, requestId, body ?? {});
      return sendJson(res, 202, { ok: true });
    } catch (error) {
      return sendJson(res, 409, { error: errMsg(error) });
    }
  }

  const approvalMatch = path.match(/^\/api\/agents\/([^/]+)\/approvals\/([^/]+)$/);
  if (approvalMatch) {
    const id = decodeURIComponent(approvalMatch[1]!);
    const requestId = decodeURIComponent(approvalMatch[2]!);
    if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
    const body = await readJson<AgentApprovalResponse>(req);
    try {
      manager.answerApproval(id, requestId, body ?? { action: "cancel" });
      return sendJson(res, 202, { ok: true });
    } catch (error) {
      return sendJson(res, 409, { error: errMsg(error) });
    }
  }

  const commitMatch = path.match(/^\/api\/agents\/([^/]+)\/commits$/);
  if (commitMatch) {
    const id = decodeURIComponent(commitMatch[1]!);
    if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
    if (!manager.get(id)) return sendJson(res, 404, { error: `未知 agent: ${id}` });
    const body = await readJson<ReportAgentCommitInput>(req);
    try {
      return sendJson(res, 201, {
        commit: await commitManager.recordFromAgent(
          id,
          manager.configOf(id),
          manager.currentTurnIndex(id),
          body ?? {},
        ),
      });
    } catch (error) {
      return sendJson(res, 400, { error: errMsg(error) });
    }
  }

  // /api/agents/:id(/action)
  const m = path.match(/^\/api\/agents\/([^/]+)(?:\/([^/]+))?$/);
  if (m) {
    const id = decodeURIComponent(m[1]!);
    const action = m[2];
    const runner = manager.get(id);
    if (!runner) return sendJson(res, 404, { error: `未知 agent: ${id}` });

    if (method === "GET" && !action) {
      return sendJson(res, 200, manager.snapshot(id));
    }
    if (method === "PATCH" && action === "settings") {
      const body = await readJson<UpdateAgentSettingsInput>(req);
      try {
        const currentConfig = manager.configOf(id);
        const branchChanged =
          body?.branchWorkspaceId !== undefined || body?.branch !== undefined;
        const settings = branchChanged
          ? await resolveAgentWorkspaceSettings(
              workspaceManager,
              { ...currentConfig, ...(body ?? {}) },
              defaultCwd,
              true,
            )
          : body ?? {};
        const diff = branchChanged
          ? await workspaceManager.diffBetweenBranches(currentConfig?.branch, settings.branch)
          : undefined;
        return sendJson(
          res,
          200,
          manager.updateSettings(id, settings, {
            branchSwitchPrompt: branchChanged ? branchSwitchPrompt(diff) : undefined,
          }),
        );
      } catch (error) {
        return sendJson(res, 400, { error: errMsg(error) });
      }
    }
    if (method === "GET" && action === "history") {
      return sendJson(res, 200, { events: manager.historyOf(id) });
    }
    if (method === "POST" && action === "start") {
      const body = await readJson<AgentStartConfig>(req);
      if (!body?.prompt) return sendJson(res, 400, { error: "缺少 prompt" });
      await workspaceManager.prepareAgentWorkspace(id, {
        ...manager.configOf(id),
        ...body,
      });
      manager.startAgent(id, body); // 若是 fork 产生的 agent，合并其 fork 配置
      return sendJson(res, 202, { ok: true });
    }
    if (method === "POST" && action === "fork") {
      const body = await readJson<{ anchorUuid?: string; model?: string }>(req);
      if (!body?.anchorUuid) return sendJson(res, 400, { error: "缺少 anchorUuid" });
      const forked = manager.fork(id, body.anchorUuid, body.model);
      if (!forked) return sendJson(res, 409, { error: "源会话尚未建立，无法 fork" });
      fileManager.copyAgentConnections(id, forked.id);
      promptManager.copyAgentConnections(id, forked.id);
      return sendJson(res, 201, { id: forked.id, origin: forked.origin });
    }
    if (method === "POST" && action === "send") {
      const body = await readJson<{ text?: string }>(req);
      if (!body?.text) return sendJson(res, 400, { error: "缺少 text" });
      try {
        runner.send(body.text);
      } catch (err) {
        return sendJson(res, 409, { error: errMsg(err) });
      }
      return sendJson(res, 202, { ok: true });
    }
    if (method === "POST" && action === "steer") {
      const body = await readJson<{ text?: string }>(req);
      if (!body?.text) return sendJson(res, 400, { error: "缺少 text" });
      try {
        await runner.steer(body.text);
      } catch (err) {
        return sendJson(res, 409, { error: errMsg(err) });
      }
      return sendJson(res, 202, { ok: true });
    }
    if (method === "POST" && action === "compact") {
      try {
        runner.compact();
      } catch (err) {
        return sendJson(res, 409, { error: errMsg(err) });
      }
      return sendJson(res, 202, { ok: true });
    }
    if (method === "POST" && action === "resume") {
      const body = await readJson<{ sessionId?: string; text?: string }>(req);
      if (!body?.sessionId || !body?.text)
        return sendJson(res, 400, { error: "缺少 sessionId 或 text" });
      runner.start(
        { ...(runner.snapshot().config ?? { prompt: body.text }), prompt: body.text },
        { resumeSessionId: body.sessionId },
      );
      return sendJson(res, 202, { ok: true });
    }
    if (method === "POST" && action === "stop") {
      await runner.stop();
      return sendJson(res, 202, { ok: true });
    }
    if (method === "POST" && action === "terminate") {
      await runner.terminate();
      return sendJson(res, 202, { ok: true });
    }
  }

  sendJson(res, 404, { error: "not found" });
}

// ---- helpers ----

function setCors(res: http.ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(data);
}

async function readJson<T>(req: http.IncomingMessage): Promise<T | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as T;
  } catch {
    return undefined;
  }
}

function send(ws: WebSocket, frame: ServerFrame): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function resolveAgentWorkspaceSettings<T extends AgentSettings>(
  workspaceManager: WorkspaceManager,
  input: T | undefined,
  defaultCwd: string,
  requireWorkspace: boolean,
): Promise<T> {
  const settings = { ...(input ?? {}) } as T;
  if (requireWorkspace || settings.branchWorkspaceId || settings.branch) {
    await workspaceManager.project();
  }
  let workspace =
    settings.branchWorkspaceId ? workspaceManager.branchOf(settings.branchWorkspaceId) : undefined;
  if (!workspace && settings.branch) {
    workspace = await workspaceManager.createBranch({ branch: settings.branch });
  }
  if (!workspace && requireWorkspace) {
    workspace = workspaceManager.defaultBranch();
  }
  if (!workspace && requireWorkspace) {
    throw new Error("请先打开 canvas 项目并连接 GitHub repo");
  }
  if (!workspace) {
    return {
      ...settings,
      cwd: settings.cwd?.trim() || defaultCwd,
    };
  }
  return {
    ...settings,
    branchWorkspaceId: workspace.id,
    branch: workspace.branch,
    cwd: workspace.worktreePath,
  };
}

function branchSwitchPrompt(diff: BranchDiffSummary | undefined): AgentPromptReference | undefined {
  if (!diff) return undefined;
  const files =
    diff.files.length === 0
      ? "- 无文件差异"
      : diff.files.map((file) => `- ${file.status} ${file.path}`).join("\n");
  return {
    id: `agent-canvas:branch-switch:${diff.fromBranch}->${diff.toBranch}`,
    name: "Agent Canvas branch 切换说明",
    kind: "shared",
    content:
      `Agent Canvas 已将你的工作 branch 从 \`${diff.fromBranch}\` 切换到 \`${diff.toBranch}\`。\n` +
      "下一次对话必须以新的 branch workspace 为准，不要继续在旧 branch 目录中工作。\n\n" +
      "两个 branch 当前的 git diff 文件列表（name-status）：\n" +
      files,
  };
}

function normalizeAgentSettings(
  input: CreateAgentInput | undefined,
  defaultCwd: string,
): AgentSettings {
  const provider = input?.provider === "codex" ? "codex" : "claude";
  return {
    provider,
    model: provider === "codex" ? input?.model : undefined,
    branchWorkspaceId: input?.branchWorkspaceId,
    branch: input?.branch,
    cwd: input?.cwd?.trim() || defaultCwd,
    scratchDirectory: input?.scratchDirectory,
    systemPrompt: input?.systemPrompt ?? "",
  };
}

function mergeFileAccess(...items: AgentFileAccess[]): AgentFileAccess {
  return {
    readableFiles: items.flatMap((item) => item.readableFiles),
    readableDirectories: [...new Set(items.flatMap((item) => item.readableDirectories ?? []))],
    writableFiles: items.flatMap((item) => item.writableFiles),
    writableDirectories: [...new Set(items.flatMap((item) => item.writableDirectories))],
    sharedResources: items.flatMap((item) => item.sharedResources ?? []),
  };
}
