import http from "node:http";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type {
  AgentApprovalResponse,
  AgentCanvasSettings,
  AgentCanvasConfig,
  AgentFileAccess,
  AgentQuestionResponse,
  AgentPromptReference,
  AgentSettings,
  AgentStartConfig,
  BranchDiffSummary,
  CanvasFileNode,
  CanvasLayoutSnapshot,
  CanvasNodeLayout,
  CanvasProjectState,
  ConnectGitHubInput,
  CreateBranchWorkspaceInput,
  CreateAgentInput,
  CreateCanvasProjectInput,
  CreateCanvasFileInput,
  CreateCanvasPromptInput,
  CreateSharedResourceInput,
  CreateSyncFlowInput,
  ForkAgentInput,
  OpenCanvasProjectInput,
  PullRequestCreatedInput,
  CreatePullRequestFlowInput,
  ReportAgentCommitInput,
  ReportAgentResultInput,
  ServerFrame,
  SyncFlowAppliedInput,
  UpdateAgentSettingsInput,
  UpdateCanvasFileInput,
  UpdateCanvasPromptInput,
} from "@agent-canvas/shared";
import { AgentManager } from "./AgentManager.js";
import { detectCodexModels, type CodexModelDetection } from "./codexModels.js";
import { readCodexUsage } from "./codexUsage.js";
import { CommitManager } from "./commits/CommitManager.js";
import { pickDirectory as defaultPickDirectory, type PickDirectory } from "./files/DirectoryPicker.js";
import { FileManager } from "./files/FileManager.js";
import { openFileInVscode } from "./files/VscodeFileOpener.js";
import { PromptManager } from "./prompts/PromptManager.js";
import { PullRequestFlowManager } from "./pullRequests/PullRequestFlowManager.js";
import { CodexAuthManager } from "./sdk/CodexAuthManager.js";
import { SyncFlowManager } from "./sync/SyncFlowManager.js";
import { WorkspaceManager } from "./workspaces/WorkspaceManager.js";

export interface CreateServerResult {
  httpServer: http.Server;
  wss: WebSocketServer;
  manager: AgentManager;
  fileManager: FileManager;
  promptManager: PromptManager;
  workspaceManager: WorkspaceManager;
  pullRequestFlowManager: PullRequestFlowManager;
  syncFlowManager: SyncFlowManager;
  commitManager: CommitManager;
  codexAuthManager: CodexAuthManager;
}

type CodexModelDetectionInput =
  | Promise<CodexModelDetection>
  | CodexModelDetection
  | (() => Promise<CodexModelDetection> | CodexModelDetection);

export interface CreateServerOptions {
  defaultCwd?: string;
  openFile?: (filePath: string) => Promise<void>;
  pickDirectory?: PickDirectory;
  promptManager?: PromptManager;
  workspaceManager?: WorkspaceManager;
  pullRequestFlowManager?: PullRequestFlowManager;
  syncFlowManager?: SyncFlowManager;
  commitManager?: CommitManager;
  codexAuthManager?: CodexAuthManager;
  codexModelDetection?: CodexModelDetectionInput;
}

interface CanvasStateController {
  getLayout(): CanvasLayoutSnapshot;
  setLayout(layout: Partial<CanvasLayoutSnapshot>): Promise<CanvasLayoutSnapshot>;
  loadProjectState(): Promise<void>;
  saveNow(): Promise<void>;
  saveSoon(): void;
}

const CANVAS_STATE_FILE = "canvas-state.json";

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
  const codexModels = codexModelDetectionSource(options.codexModelDetection);
  fileManager ??= new FileManager({
    workspaceRoot: defaultCwd,
  });
  const workspaceManager =
    options.workspaceManager ?? new WorkspaceManager({ defaultSourcePath: defaultCwd });
  manager.setFileAccessResolver((agentId) =>
    mergeFileAccess(
      fileManager.accessFor(agentId),
      workspaceManager.accessForAgent(manager.configOf(agentId), {
        workDocumentationEnabled: manager.appSettings().workDocumentationEnabled,
      }),
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
      ensureBranchesReady: async ({ sourceBranch, targetBranch }) =>
        await workspaceManager.ensurePullRequestBranchesReady(sourceBranch, targetBranch),
      resolveChangedFiles: async ({ sourceBranch, targetBranch }) =>
        (await workspaceManager.diffPullRequestFiles(sourceBranch, targetBranch))?.files ?? [],
    });
  const syncFlowManager =
    options.syncFlowManager ??
    new SyncFlowManager({
      host: manager,
      resolveChangedFiles: async ({ kind, sourceBranch, targetBranch, commitSha }) => {
        if (kind === "cherry_pick") {
          return await workspaceManager.changedFilesForCommit(commitSha, sourceBranch);
        }
        return (await workspaceManager.diffPullRequestFiles(sourceBranch, targetBranch))?.files;
      },
    });
  const commitManager = options.commitManager ?? new CommitManager();
  const codexAuthManager = options.codexAuthManager ?? new CodexAuthManager();
  manager.setPromptAccessResolver((agentId) => promptManager.accessFor(agentId));
  const canvasState = createCanvasStateController({
    manager,
    fileManager,
    promptManager,
    workspaceManager,
    pullRequestFlowManager,
    syncFlowManager,
    commitManager,
  });
  const httpServer = http.createServer((req, res) => {
    handleHttp(
      req,
      res,
      manager,
      fileManager,
      promptManager,
      workspaceManager,
      pullRequestFlowManager,
      syncFlowManager,
      commitManager,
      codexAuthManager,
      defaultCwd,
      codexModels,
      options.openFile ?? openFileInVscode,
      options.pickDirectory ?? defaultPickDirectory,
      canvasState,
      broadcastHello,
      broadcastFrame,
    ).catch((err) => {
      sendJson(res, 500, { error: errMsg(err) });
    });
  });

  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
  const broadcastFrame = (frame: ServerFrame): void => {
    const data = JSON.stringify(frame);
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send(data);
    }
  };
  const helloFrame = (): ServerFrame => ({
    type: "hello",
    agents: manager.list(),
    histories: manager.exportState().histories,
    prFlows: pullRequestFlowManager.list(),
    syncFlows: syncFlowManager.list(),
    commits: commitManager.list(),
  });
  const broadcastHello = (): void => broadcastFrame(helloFrame());
  wss.on("connection", (ws: WebSocket) => {
    send(ws, helloFrame());
  });

  // 把 manager 的事件广播到所有 WS 客户端
  manager.onEvent((envelope) => {
    void pullRequestFlowManager.handleAgentEvent(envelope);
    void syncFlowManager.handleAgentEvent(envelope);
    broadcastFrame({ type: "event", envelope });
    canvasState.saveSoon();
  });

  pullRequestFlowManager.onFlow((flow) => {
    broadcastFrame({ type: "pr_flow", flow });
    canvasState.saveSoon();
  });

  syncFlowManager.onFlow((flow) => {
    broadcastFrame({ type: "sync_flow", flow });
    canvasState.saveSoon();
  });

  commitManager.onCommit((commit) => {
    broadcastFrame({ type: "commit", commit });
    canvasState.saveSoon();
  });

  return {
    httpServer,
    wss,
    manager,
    fileManager,
    promptManager,
    workspaceManager,
    pullRequestFlowManager,
    syncFlowManager,
    commitManager,
    codexAuthManager,
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
  syncFlowManager: SyncFlowManager,
  commitManager: CommitManager,
  codexAuthManager: CodexAuthManager,
  defaultCwd: string,
  codexModels: () => Promise<CodexModelDetection>,
  openFile: (filePath: string) => Promise<void>,
  pickDirectory: PickDirectory,
  canvasState: CanvasStateController,
  broadcastHello: () => void,
  broadcastFrame: (frame: ServerFrame) => void,
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
    return sendJson(res, 200, await serverConfig(defaultCwd, workspaceManager, codexModels));
  }

  if (method === "GET" && path === "/api/codex/usage") {
    try {
      return sendJson(res, 200, await readCodexUsage());
    } catch (error) {
      return sendJson(res, 503, { error: errMsg(error) });
    }
  }

  if (method === "GET" && path === "/api/settings") {
    return sendJson(res, 200, manager.appSettings());
  }

  if (method === "PATCH" && path === "/api/settings") {
    const body = await readJson<Partial<AgentCanvasSettings>>(req);
    if (
      (body?.fullPermissionMode !== undefined &&
        typeof body.fullPermissionMode !== "boolean") ||
      (body?.workDocumentationEnabled !== undefined &&
        typeof body.workDocumentationEnabled !== "boolean")
    ) {
      return sendJson(res, 400, { error: "设置项必须是 boolean" });
    }
    try {
      if (body?.workDocumentationEnabled) {
        await workspaceManager.prepareWorkDocumentationForAllBranches();
      }
      const settings = manager.updateAppSettings(body ?? {});
      canvasState.saveSoon();
      return sendJson(res, 200, settings);
    } catch (error) {
      return sendJson(res, 400, { error: errMsg(error) });
    }
  }

  if (method === "GET" && path === "/api/canvas-layout") {
    return sendJson(res, 200, canvasState.getLayout());
  }

  if (method === "PATCH" && path === "/api/canvas-layout") {
    const body = await readJson<Partial<CanvasLayoutSnapshot>>(req);
    try {
      return sendJson(res, 200, await canvasState.setLayout(body ?? {}));
    } catch (error) {
      return sendJson(res, 400, { error: errMsg(error) });
    }
  }

  if (method === "GET" && path === "/api/canvas-projects") {
    return sendJson(res, 200, { projects: await workspaceManager.listCanvasProjects() });
  }

  if (method === "POST" && path === "/api/canvas-projects") {
    const body = await readJson<CreateCanvasProjectInput>(req);
    if (!body?.name) return sendJson(res, 400, { error: "缺少项目名称" });
    try {
      await canvasState.saveNow();
      const project = await workspaceManager.createCanvasProject(body);
      await canvasState.loadProjectState();
      broadcastHello();
      return sendJson(res, 201, { project, workspace: await workspaceManager.project() });
    } catch (error) {
      return sendJson(res, 400, { error: errMsg(error) });
    }
  }

  if (method === "POST" && path === "/api/canvas-projects/open") {
    const body = await readJson<OpenCanvasProjectInput>(req);
    if (!body?.id) return sendJson(res, 400, { error: "缺少项目 id" });
    try {
      await canvasState.saveNow();
      const workspace = await workspaceManager.openCanvasProject(body);
      await canvasState.loadProjectState();
      broadcastHello();
      return sendJson(res, 200, { workspace });
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
      const workspace = await workspaceManager.connect(body ?? {});
      if (manager.appSettings().workDocumentationEnabled) {
        await workspaceManager.prepareWorkDocumentationForAllBranches();
      }
      canvasState.saveSoon();
      return sendJson(res, 200, workspace);
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
      const branch = await workspaceManager.createBranch(body);
      if (manager.appSettings().workDocumentationEnabled) {
        await workspaceManager.prepareWorkDocumentationForAllBranches();
      }
      return sendJson(res, 201, { branch });
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

  if (method === "GET" && path === "/api/sync-flows") {
    return sendJson(res, 200, { flows: syncFlowManager.list() });
  }

  if (method === "GET" && path === "/api/commits") {
    return sendJson(res, 200, { commits: commitManager.list() });
  }

  if (method === "GET" && path === "/api/codex-auth/status") {
    try {
      return sendJson(res, 200, {
        status: await codexAuthManager.status(),
        login: codexAuthManager.loginSession() ?? null,
      });
    } catch (error) {
      return sendJson(res, 500, { error: errMsg(error) });
    }
  }

  if (method === "POST" && path === "/api/codex-auth/login") {
    try {
      return sendJson(res, 202, { login: codexAuthManager.startDeviceLogin() });
    } catch (error) {
      return sendJson(res, 500, { error: errMsg(error) });
    }
  }

  if (method === "POST" && path === "/api/codex-auth/login/cancel") {
    return sendJson(res, 200, { login: codexAuthManager.cancelLogin() ?? null });
  }

  if (method === "POST" && path === "/api/pr-flows") {
    const body = await readJson<CreatePullRequestFlowInput>(req);
    try {
      const flow = await pullRequestFlowManager.create(body ?? ({} as CreatePullRequestFlowInput));
      canvasState.saveSoon();
      return sendJson(res, 201, {
        flow,
      });
    } catch (error) {
      return sendJson(res, 400, { error: errMsg(error) });
    }
  }

  if (method === "POST" && path === "/api/sync-flows") {
    const body = await readJson<CreateSyncFlowInput>(req);
    try {
      const flow = await syncFlowManager.create(body ?? ({} as CreateSyncFlowInput));
      canvasState.saveSoon();
      return sendJson(res, 201, {
        flow,
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
        const flow = await pullRequestFlowManager.recordPrCreated(id, body ?? {});
        canvasState.saveSoon();
        return sendJson(res, 200, {
          flow,
        });
      } catch (error) {
        return sendJson(res, 400, { error: errMsg(error) });
      }
    }
    if (method === "POST" && action === "merged") {
      try {
        const flow = pullRequestFlowManager.recordMerged(id);
        canvasState.saveSoon();
        return sendJson(res, 200, { flow });
      } catch (error) {
        return sendJson(res, 400, { error: errMsg(error) });
      }
    }
    if (method === "POST" && action === "cancel") {
      try {
        const flow = pullRequestFlowManager.cancel(id);
        canvasState.saveSoon();
        return sendJson(res, 200, { flow });
      } catch (error) {
        return sendJson(res, 404, { error: errMsg(error) });
      }
    }
    if (method === "POST" && action === "retry") {
      try {
        const flow = await pullRequestFlowManager.retryQueued(id);
        canvasState.saveSoon();
        return sendJson(res, 200, { flow });
      } catch (error) {
        return sendJson(res, 400, { error: errMsg(error) });
      }
    }
  }

  const syncFlowMatch = path.match(/^\/api\/sync-flows\/([^/]+)(?:\/([^/]+))?$/);
  if (syncFlowMatch) {
    const id = decodeURIComponent(syncFlowMatch[1]!);
    const action = syncFlowMatch[2];
    if (method === "GET" && !action) {
      const flow = syncFlowManager.get(id);
      return flow
        ? sendJson(res, 200, { flow })
        : sendJson(res, 404, { error: `unknown sync flow: ${id}` });
    }
    if (method === "POST" && action === "applied") {
      const body = await readJson<SyncFlowAppliedInput>(req);
      try {
        const flow = syncFlowManager.recordApplied(id, body ?? {});
        canvasState.saveSoon();
        return sendJson(res, 200, {
          flow,
        });
      } catch (error) {
        return sendJson(res, 400, { error: errMsg(error) });
      }
    }
    if (method === "POST" && action === "cancel") {
      try {
        const flow = syncFlowManager.cancel(id);
        canvasState.saveSoon();
        return sendJson(res, 200, { flow });
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
      canvasState.saveSoon();
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
      const file = await fileManager.create(body);
      canvasState.saveSoon();
      return sendJson(res, 201, { file });
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
      const prompt = await promptManager.create(body);
      canvasState.saveSoon();
      return sendJson(res, 201, { prompt });
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
        const prompt = await promptManager.update(id, body ?? {});
        canvasState.saveSoon();
        return sendJson(res, 200, {
          prompt,
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
        const file = await fileManager.update(id, body ?? {});
        canvasState.saveSoon();
        return sendJson(res, 200, { file });
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
      const connection = fileManager.connect(body.fileId, body.agentId, body.access);
      canvasState.saveSoon();
      return sendJson(res, 201, {
        connection,
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
      const connection = promptManager.connect(body.promptId, body.agentId, body.access);
      canvasState.saveSoon();
      return sendJson(res, 201, {
        connection,
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
    canvasState.saveSoon();
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
    canvasState.saveSoon();
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
      const commit = await commitManager.recordFromAgent(
        id,
        manager.configOf(id),
        manager.currentTurnIndex(id),
        body ?? {},
      );
      canvasState.saveSoon();
      return sendJson(res, 201, {
        commit,
      });
    } catch (error) {
      return sendJson(res, 400, { error: errMsg(error) });
    }
  }

  const resultReportMatch = path.match(/^\/api\/agents\/([^/]+)\/report-result$/);
  if (resultReportMatch) {
    const id = decodeURIComponent(resultReportMatch[1]!);
    if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
    if (!manager.get(id)) return sendJson(res, 404, { error: `unknown agent: ${id}` });
    const body = await readJson<ReportAgentResultInput>(req);
    try {
      const file = await createAgentResultFile(
        fileManager,
        id,
        manager.configOf(id),
        manager.currentTurnIndex(id),
        body ?? ({} as ReportAgentResultInput),
      );
      canvasState.saveSoon();
      broadcastFrame({ type: "file", file });
      return sendJson(res, 201, { file });
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
        const resolvedWorkspaceSettings = branchChanged
          ? await resolveAgentWorkspaceSettings(
              workspaceManager,
              settingsForWorkspaceResolution(currentConfig, body),
              defaultCwd,
              true,
            )
          : undefined;
        const settings = branchChanged
          ? {
              ...(body ?? {}),
              branchWorkspaceId: resolvedWorkspaceSettings?.branchWorkspaceId,
              branch: resolvedWorkspaceSettings?.branch,
              cwd: resolvedWorkspaceSettings?.cwd,
              scratchDirectory: resolvedWorkspaceSettings?.scratchDirectory,
            }
          : body ?? {};
        if (branchChanged && manager.appSettings().workDocumentationEnabled) {
          await workspaceManager.prepareAgentWorkspace(id, settings, {
            workDocumentationEnabled: true,
          });
        }
        const diff = branchChanged
          ? await workspaceManager.diffBetweenBranches(currentConfig?.branch, settings.branch)
          : undefined;
        const snapshot = manager.updateSettings(id, settings, {
          branchSwitchPrompt: branchChanged ? branchSwitchPrompt(diff) : undefined,
        });
        canvasState.saveSoon();
        return sendJson(res, 200, snapshot);
      } catch (error) {
        return sendJson(res, 400, { error: errMsg(error) });
      }
    }
    if (method === "GET" && action === "history") {
      return sendJson(res, 200, { events: manager.historyOf(id) });
    }
    if (method === "POST" && action === "open-workspace") {
      const cwd = manager.configOf(id)?.cwd?.trim();
      if (!cwd) return sendJson(res, 400, { error: "该 agent 尚未绑定 branch 工作目录" });
      try {
        await openFile(cwd);
        return sendJson(res, 202, { ok: true });
      } catch (error) {
        return sendJson(res, 400, { error: errMsg(error) });
      }
    }
    if (method === "POST" && action === "start") {
      const body = await readJson<AgentStartConfig>(req);
      if (!body?.prompt) return sendJson(res, 400, { error: "缺少 prompt" });
      await workspaceManager.prepareAgentWorkspace(
        id,
        {
          ...manager.configOf(id),
          ...body,
        },
        {
          workDocumentationEnabled: manager.appSettings().workDocumentationEnabled,
        },
      );
      manager.startAgent(id, body); // 若是 fork 产生的 agent，合并其 fork 配置
      return sendJson(res, 202, { ok: true });
    }
    if (method === "POST" && action === "fork") {
      const body = await readJson<Partial<ForkAgentInput>>(req);
      if (!body?.anchorUuid) return sendJson(res, 400, { error: "缺少 anchorUuid" });
      try {
        const branchChanged =
          body.branchWorkspaceId !== undefined || body.branch !== undefined;
        const branchSettings = branchChanged
          ? await resolveAgentWorkspaceSettings(
              workspaceManager,
              {
                branchWorkspaceId: body.branchWorkspaceId,
                branch: body.branch,
                cwd: body.cwd,
                scratchDirectory: body.scratchDirectory,
                reasoningEffort: body.reasoningEffort,
              },
              defaultCwd,
              true,
            )
          : undefined;
        const forked = manager.fork(id, body.anchorUuid, {
          model: body.model,
          reasoningEffort: body.reasoningEffort,
          branchWorkspaceId: branchSettings?.branchWorkspaceId,
          branch: branchSettings?.branch,
          cwd: branchSettings?.cwd,
          scratchDirectory: branchSettings?.scratchDirectory,
        });
        if (!forked) return sendJson(res, 409, { error: "源会话尚未建立，无法 fork" });
        fileManager.copyAgentConnections(id, forked.id);
        promptManager.copyAgentConnections(id, forked.id);
        canvasState.saveSoon();
        return sendJson(res, 201, { id: forked.id, origin: forked.origin });
      } catch (error) {
        return sendJson(res, 400, { error: errMsg(error) });
      }
    }
    if (method === "POST" && action === "send") {
      const body = await readJson<{ text?: string }>(req);
      if (!body?.text) return sendJson(res, 400, { error: "缺少 text" });
      try {
        await workspaceManager.prepareAgentWorkspace(id, manager.configOf(id), {
          workDocumentationEnabled: manager.appSettings().workDocumentationEnabled,
        });
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
        await workspaceManager.prepareAgentWorkspace(id, manager.configOf(id), {
          workDocumentationEnabled: manager.appSettings().workDocumentationEnabled,
        });
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
      await workspaceManager.prepareAgentWorkspace(id, manager.configOf(id), {
        workDocumentationEnabled: manager.appSettings().workDocumentationEnabled,
      });
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

async function serverConfig(
  defaultCwd: string,
  workspaceManager: WorkspaceManager,
  codexModels: () => Promise<CodexModelDetection>,
): Promise<AgentCanvasConfig> {
  const detected = await codexModels();
  return {
    defaultCwd,
    projectRoot: workspaceManager.root(),
    codexModels: detected.models,
    defaultCodexModel: detected.defaultModel,
    codexReasoningEfforts: detected.reasoningEfforts,
    codexModelCapabilities: detected.modelCapabilities,
    codexVersion: detected.version,
  };
}

function codexModelDetectionSource(
  input: CodexModelDetectionInput | undefined,
): () => Promise<CodexModelDetection> {
  if (typeof input === "function") return () => Promise.resolve(input());
  if (input !== undefined) return () => Promise.resolve(input);
  return () => detectCodexModels();
}

interface CanvasStateControllerDeps {
  manager: AgentManager;
  fileManager: FileManager;
  promptManager: PromptManager;
  workspaceManager: WorkspaceManager;
  pullRequestFlowManager: PullRequestFlowManager;
  syncFlowManager: SyncFlowManager;
  commitManager: CommitManager;
}

function createCanvasStateController(deps: CanvasStateControllerDeps): CanvasStateController {
  let layout = emptyCanvasLayout();
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let saveChain: Promise<void> = Promise.resolve();

  const applyProjectStorageRoots = (projectRoot: string): void => {
    deps.fileManager.setIsolatedRoot(path.join(projectRoot, "files"));
    deps.promptManager.setPromptRoot(path.join(projectRoot, "prompts"));
  };

  const saveCurrentProject = async (): Promise<void> => {
    let project: Awaited<ReturnType<WorkspaceManager["project"]>>;
    try {
      project = await deps.workspaceManager.project();
    } catch {
      return;
    }
    applyProjectStorageRoots(project.projectRoot);
    const state: CanvasProjectState = {
      version: 1,
      updatedAt: Date.now(),
      agents: deps.manager.exportState(),
      files: deps.fileManager.exportState(),
      prompts: deps.promptManager.exportState(),
      commits: deps.commitManager.exportState(),
      prFlows: deps.pullRequestFlowManager.exportState(),
      syncFlows: deps.syncFlowManager.exportState(),
      layout,
    };
    const statePath = path.join(project.projectRoot, CANVAS_STATE_FILE);
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
  };

  const saveNow = async (): Promise<void> => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = undefined;
    }
    saveChain = saveChain.then(saveCurrentProject, saveCurrentProject);
    await saveChain;
  };

  return {
    getLayout: () => layout,
    setLayout: async (nextLayout) => {
      layout = sanitizeCanvasLayout(nextLayout);
      await saveNow();
      return layout;
    },
    loadProjectState: async () => {
      const project = await deps.workspaceManager.project();
      applyProjectStorageRoots(project.projectRoot);
      const state = await readCanvasProjectState(path.join(project.projectRoot, CANVAS_STATE_FILE));
      deps.manager.importState(state?.agents);
      deps.fileManager.importState(state?.files);
      await deps.promptManager.importState(state?.prompts);
      deps.commitManager.importState(state?.commits);
      deps.pullRequestFlowManager.importState(state?.prFlows);
      deps.syncFlowManager.importState(state?.syncFlows);
      if (deps.manager.appSettings().workDocumentationEnabled) {
        await deps.workspaceManager.prepareWorkDocumentationForAllBranches();
      }
      layout = sanitizeCanvasLayout(state?.layout);
    },
    saveNow,
    saveSoon: () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        saveTimer = undefined;
        void saveNow();
      }, 100);
    },
  };
}

async function readCanvasProjectState(
  statePath: string,
): Promise<CanvasProjectState | undefined> {
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf-8")) as CanvasProjectState;
    if (parsed?.version !== 1) throw new Error("unsupported canvas state version");
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function emptyCanvasLayout(): CanvasLayoutSnapshot {
  return { nodes: [], updatedAt: 0 };
}

function sanitizeCanvasLayout(
  layout: Partial<CanvasLayoutSnapshot> | undefined,
): CanvasLayoutSnapshot {
  const nodes = Array.isArray(layout?.nodes)
    ? layout.nodes.flatMap((node) => sanitizeCanvasNodeLayout(node))
    : [];
  return {
    nodes,
    updatedAt: finiteNumber(layout?.updatedAt) ?? Date.now(),
  };
}

function sanitizeCanvasNodeLayout(node: unknown): CanvasNodeLayout[] {
  if (!isRecord(node)) return [];
  const id = typeof node.id === "string" ? node.id.trim() : "";
  const position = isRecord(node.position) ? node.position : undefined;
  const x = finiteNumber(position?.x);
  const y = finiteNumber(position?.y);
  if (!id || x === undefined || y === undefined) return [];
  const windowState = sanitizeWindowState(node.windowState);
  return [
    {
      id,
      type: typeof node.type === "string" ? node.type : undefined,
      position: { x, y },
      width: positiveNumber(node.width),
      height: positiveNumber(node.height),
      windowState,
    },
  ];
}

function sanitizeWindowState(value: unknown): CanvasNodeLayout["windowState"] {
  if (!isRecord(value) || typeof value.minimized !== "boolean") return undefined;
  return {
    minimized: value.minimized,
    restoreWidth: positiveNumber(value.restoreWidth),
    restoreHeight: positiveNumber(value.restoreHeight),
  };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number !== undefined && number > 0 ? number : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
    model: input?.model?.trim() || undefined,
    reasoningEffort: input?.reasoningEffort?.trim() || undefined,
    branchWorkspaceId: input?.branchWorkspaceId,
    branch: input?.branch,
    cwd: input?.cwd?.trim() || defaultCwd,
    scratchDirectory: input?.scratchDirectory,
    systemPrompt: input?.systemPrompt ?? "",
  };
}

function settingsForWorkspaceResolution(
  currentConfig: AgentStartConfig | undefined,
  input: UpdateAgentSettingsInput | null | undefined,
): AgentSettings {
  return {
    provider: currentConfig?.provider,
    model: input?.model === null ? undefined : input?.model ?? currentConfig?.model,
    reasoningEffort:
      input?.reasoningEffort === null
        ? undefined
        : input?.reasoningEffort ?? currentConfig?.reasoningEffort,
    branchWorkspaceId: input?.branchWorkspaceId ?? currentConfig?.branchWorkspaceId,
    branch: input?.branch ?? currentConfig?.branch,
    cwd: input?.cwd ?? currentConfig?.cwd,
    scratchDirectory: input?.scratchDirectory ?? currentConfig?.scratchDirectory,
    systemPrompt: input?.systemPrompt ?? currentConfig?.systemPrompt,
  };
}

async function createAgentResultFile(
  fileManager: FileManager,
  agentId: string,
  config: AgentStartConfig | undefined,
  sourceTurnIndex: number,
  input: ReportAgentResultInput,
): Promise<CanvasFileNode> {
  const hasSourcePath = typeof input.sourcePath === "string" && input.sourcePath.trim() !== "";
  const hasContent = input.content !== undefined;
  if (hasSourcePath && hasContent) {
    throw new Error("report result accepts either sourcePath or content, not both");
  }
  if (!hasSourcePath && !hasContent) {
    throw new Error("report result requires content or sourcePath");
  }
  const sourcePath = hasSourcePath ? input.sourcePath!.trim() : undefined;
  const { name, extension } = reportFileNameParts(input, sourcePath);
  const resultKind = normalizeResultReportKind(input.resultKind);
  const content =
    sourcePath !== undefined
      ? await readReportSourceFile(sourcePath, config?.cwd)
      : reportContentBuffer(input);

  return await fileManager.createWithContent(
    {
      name,
      extension,
      storage: "isolated",
      kind: "normal",
    },
    content,
    {
      origin: {
        kind: "agent_result",
        agentId,
        sourceTurnIndex,
        resultKind,
        title: trimmedOptional(input.title),
        summary: trimmedOptional(input.summary),
      },
    },
  );
}

function reportFileNameParts(
  input: ReportAgentResultInput,
  sourcePath: string | undefined,
): { name: string; extension?: string } {
  let name = input.name?.trim();
  if (!name) throw new Error("report result requires a file name");
  let extension = input.extension?.trim();
  if (!extension) {
    const nameExtension = path.extname(name);
    if (nameExtension && name.length > nameExtension.length) {
      name = name.slice(0, -nameExtension.length);
      extension = nameExtension.slice(1);
    }
  }
  if (!extension && sourcePath) {
    const sourceExtension = path.extname(sourcePath);
    if (sourceExtension) extension = sourceExtension.slice(1);
  }
  if (extension) {
    const normalizedExtension = extension.replace(/^\./u, "");
    const suffix = `.${normalizedExtension}`;
    if (name.toLowerCase().endsWith(suffix.toLowerCase())) {
      name = name.slice(0, -suffix.length);
    }
  }
  return { name, extension };
}

async function readReportSourceFile(sourcePath: string, cwd: string | undefined): Promise<Buffer> {
  const base = cwd?.trim();
  if (!base) throw new Error("agent has no workspace cwd for sourcePath report");
  const resolvedBase = path.resolve(base);
  const resolvedPath = path.resolve(resolvedBase, sourcePath);
  if (!isPathInside(resolvedPath, resolvedBase)) {
    throw new Error("sourcePath must be inside the agent workspace");
  }
  const info = await stat(resolvedPath);
  if (!info.isFile()) throw new Error("sourcePath must point to a file");
  return await readFile(resolvedPath);
}

function reportContentBuffer(input: ReportAgentResultInput): string | Buffer {
  const content = input.content ?? "";
  if (input.encoding === undefined || input.encoding === "utf8") return content;
  if (input.encoding === "base64") return Buffer.from(content, "base64");
  throw new Error("unsupported report result encoding");
}

function normalizeResultReportKind(
  value: ReportAgentResultInput["resultKind"],
): ReportAgentResultInput["resultKind"] {
  if (value === undefined) return undefined;
  if (["image", "table", "document", "artifact"].includes(value)) return value;
  throw new Error("unsupported report result kind");
}

function trimmedOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function mergeFileAccess(...items: AgentFileAccess[]): AgentFileAccess {
  const sandboxWritableDirectories = [
    ...new Set(items.flatMap((item) => item.sandboxWritableDirectories ?? [])),
  ];
  return {
    readableFiles: items.flatMap((item) => item.readableFiles),
    readableDirectories: [...new Set(items.flatMap((item) => item.readableDirectories ?? []))],
    writableFiles: items.flatMap((item) => item.writableFiles),
    ...(sandboxWritableDirectories.length > 0 ? { sandboxWritableDirectories } : {}),
    writableDirectories: [...new Set(items.flatMap((item) => item.writableDirectories))],
    sharedResources: items.flatMap((item) => item.sharedResources ?? []),
  };
}
