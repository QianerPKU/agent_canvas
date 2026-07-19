import http from "node:http";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFile, stat } from "node:fs/promises";
import path, { dirname as pathDirname } from "node:path";
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
  CanvasFileImportMode,
  CanvasFileKind,
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
  ImportPickedCanvasFilesInput,
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
import { isTerminalStatus, PICKED_FILE_SELECTION_EXPIRED_CODE } from "@agent-canvas/shared";
import { AgentManager } from "./AgentManager.js";
import { detectCodexModels, type CodexModelDetection } from "./codexModels.js";
import { readCodexUsage } from "./codexUsage.js";
import { CommitManager } from "./commits/CommitManager.js";
import { pickDirectory as defaultPickDirectory, type PickDirectory } from "./files/DirectoryPicker.js";
import {
  pickFiles as defaultPickFiles,
  type PickFiles,
  type PickFilesOptions,
} from "./files/FilePicker.js";
import { FileManager, PickedFileSelectionExpiredError } from "./files/FileManager.js";
import {
  openFileInVscode,
  type OpenInVscodeOptions,
} from "./files/VscodeFileOpener.js";
import { PromptManager } from "./prompts/PromptManager.js";
import { PullRequestFlowManager } from "./pullRequests/PullRequestFlowManager.js";
import { BranchReviewQueue } from "./reviews/BranchReviewQueue.js";
import { CodexAuthManager } from "./sdk/CodexAuthManager.js";
import { SyncFlowManager } from "./sync/SyncFlowManager.js";
import {
  WorkspaceManager,
  WorkspaceProjectChangedError,
  type WorkspaceProjectRevision,
} from "./workspaces/WorkspaceManager.js";
import {
  type ManagedFileSnapshot,
  type ManagedTrustedRootBoundary,
  readManagedFileSnapshot,
  writeManagedFileAtomically,
} from "./workspaces/safeManagedFile.js";

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
  flushCanvasState(): Promise<void>;
}

type CodexModelDetectionInput =
  | Promise<CodexModelDetection>
  | CodexModelDetection
  | (() => Promise<CodexModelDetection> | CodexModelDetection);

export interface CreateServerOptions {
  defaultCwd?: string;
  allowedOrigins?: string[];
  openFile?: (filePath: string, options?: OpenInVscodeOptions) => Promise<void>;
  pickDirectory?: PickDirectory;
  pickFiles?: PickFiles;
  /** Test/deployment override; defaults to 100 MiB. */
  maxFileUploadBytes?: number;
  promptManager?: PromptManager;
  workspaceManager?: WorkspaceManager;
  pullRequestFlowManager?: PullRequestFlowManager;
  syncFlowManager?: SyncFlowManager;
  reviewQueue?: BranchReviewQueue;
  commitManager?: CommitManager;
  codexAuthManager?: CodexAuthManager;
  codexModelDetection?: CodexModelDetectionInput;
}

interface CanvasStateController {
  getLayout(): CanvasLayoutSnapshot;
  setLayout(layout: Partial<CanvasLayoutSnapshot>): Promise<CanvasLayoutSnapshot>;
  loadProjectState(): Promise<WorkDocumentationLoadStatus>;
  resetProjectStateAfterFailedLoad(error: unknown): Promise<WorkDocumentationLoadStatus>;
  assertProjectStateWritable(): Promise<void>;
  activateImportedFlowState(): void;
  unloadProjectState(): Promise<void>;
  runProjectTransaction<T>(
    operation: () => Promise<T>,
    options?: {
      saveCurrent?: boolean;
      forceEnqueue?: boolean;
      allowUnsafeCurrentState?: boolean;
    },
  ): Promise<T>;
  currentWorkspaceFrame(): Promise<Extract<ServerFrame, { type: "workspace" }>>;
  recordWorkDocumentationStatus(status: WorkDocumentationLoadStatus): void;
  beginDerivedAgentEvent(): () => void;
  hasPendingDerivedAgentEvents(): boolean;
  saveNow(): Promise<void>;
  saveSoon(): void;
}

interface WorkDocumentationLoadStatus {
  ready: boolean;
  error?: string;
}

const CANVAS_STATE_FILE = "canvas-state.json";
const MAX_FILE_UPLOAD_BYTES = 100 * 1024 * 1024;
const requestJsonBodies = new WeakMap<http.IncomingMessage, Promise<unknown | undefined>>();
const requestRawBodies = new WeakMap<http.IncomingMessage, Promise<Buffer>>();
const requestPickedFilePaths = new WeakMap<http.IncomingMessage, Promise<string[]>>();

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
    maxPickedFileBytes: options.maxFileUploadBytes ?? MAX_FILE_UPLOAD_BYTES,
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
  const injectedReviewQueues = [
    options.reviewQueue,
    options.pullRequestFlowManager?.getReviewQueue(),
    options.syncFlowManager?.getReviewQueue(),
  ].filter((queue): queue is BranchReviewQueue => queue !== undefined);
  const reviewQueue = injectedReviewQueues[0] ?? new BranchReviewQueue();
  if (injectedReviewQueues.some((queue) => queue !== reviewQueue)) {
    throw new Error("PR and sync flow managers must share the same branch review queue");
  }
  const pullRequestFlowManager =
    options.pullRequestFlowManager ??
    new PullRequestFlowManager({
      host: manager,
      reviewQueue,
      ensureBranchesReady: async ({ sourceBranch, targetBranch }) =>
        await workspaceManager.ensurePullRequestBranchesReady(sourceBranch, targetBranch),
      resolveChangedFiles: async ({ sourceBranch, targetBranch }) =>
        (await workspaceManager.diffPullRequestFiles(sourceBranch, targetBranch))?.files ?? [],
    });
  const syncFlowManager =
    options.syncFlowManager ??
    new SyncFlowManager({
      host: manager,
      reviewQueue,
      resolveChangedFiles: async ({ kind, sourceBranch, targetBranch, commitSha }) => {
        if (kind === "cherry_pick") {
          return await workspaceManager.changedFilesForCommit(commitSha, sourceBranch);
        }
        return (await workspaceManager.diffPullRequestFiles(sourceBranch, targetBranch))?.files;
      },
    });
  const commitManager = options.commitManager ?? new CommitManager();
  const codexAuthManager = options.codexAuthManager ?? new CodexAuthManager();
  const allowedOrigins = resolveAllowedOrigins(options.allowedOrigins);
  const pickFiles = options.pickFiles ?? defaultPickFiles;
  const maxFileUploadBytes = options.maxFileUploadBytes ?? MAX_FILE_UPLOAD_BYTES;
  manager.setPromptAccessResolver((agentId) => promptManager.accessFor(agentId));
  const canvasState = createCanvasStateController({
    manager,
    fileManager,
    promptManager,
    workspaceManager,
    reviewQueue,
    pullRequestFlowManager,
    syncFlowManager,
    commitManager,
  });
  manager.setFileAccessPreparer((agentId) =>
    canvasState.runProjectTransaction(async () => {
      await workspaceManager.prepareAgentWorkspace(agentId, manager.configOf(agentId), {
        workDocumentationEnabled: manager.appSettings().workDocumentationEnabled,
      });
    }),
  );
  const httpServer = http.createServer((req, res) => {
    const projectScoped = isProjectScopedHttpRequest(req);
    let expectedProjectRevision: WorkspaceProjectRevision | undefined;
    if (projectScoped) {
      try {
        expectedProjectRevision = workspaceManager.captureProjectRevision();
      } catch {
        expectedProjectRevision = undefined;
      }
    }
    const expectedNoProject = projectScoped && !expectedProjectRevision;
    const hasMatchingProjectHeaders =
      expectedProjectRevision !== undefined &&
      requestProjectHeadersMatch(req, expectedProjectRevision);
    const operation = async () => {
      if (projectScoped) {
        try {
          if (expectedProjectRevision) {
            workspaceManager.assertProjectRevision(expectedProjectRevision);
          } else if (expectedNoProject && workspaceManager.currentProjectId()) {
            throw new WorkspaceProjectChangedError();
          }
          if (workspaceManager.currentProjectId()) {
            await workspaceManager.validateCurrentProjectRoot();
          }
        } catch (error) {
          return sendJson(res, workspaceErrorStatus(error), {
            error: "请求所属项目已切换；已拒绝迟到的项目操作",
          });
        }
      }
      if (requiresWritableCanvasState(req)) {
        try {
          await canvasState.assertProjectStateWritable();
        } catch (error) {
          return sendJson(res, 409, { error: errMsg(error) });
        }
      }
      return await handleHttp(
        req,
        res,
        manager,
        fileManager,
        promptManager,
        workspaceManager,
        pullRequestFlowManager,
        syncFlowManager,
        reviewQueue,
        commitManager,
        codexAuthManager,
        defaultCwd,
        codexModels,
        options.openFile ?? openFileInVscode,
        options.pickDirectory ?? defaultPickDirectory,
        pickFiles,
        maxFileUploadBytes,
        canvasState,
        broadcastHello,
        broadcastFrame,
        allowedOrigins,
      );
    };
    const invoke = async () => {
      try {
        return projectScoped ? await canvasState.runProjectTransaction(operation) : await operation();
      } catch (error) {
        // Project transactions validate the live project-root boundary before invoking the
        // request operation. Route those queue-level preflight failures through the same status
        // mapping as the in-operation revision/boundary check instead of leaking them as a 500.
        if (projectScoped && !res.headersSent) {
          return sendJson(res, workspaceErrorStatus(error), { error: errMsg(error) });
        }
        throw error;
      }
    };
    const nativeFileSelection =
      hasMatchingProjectHeaders
        ? preloadNativeFileSelection(req, allowedOrigins, fileManager, pickFiles)
        : undefined;
    const result = nativeFileSelection
      ? nativeFileSelection.then(invoke, invoke)
      : shouldPreloadProjectRequestBody(req, allowedOrigins)
        ? preloadRequestJsonBody(req).then(invoke)
        : hasMatchingProjectHeaders && shouldPreloadFileUploadBody(req, allowedOrigins)
          ? preloadRequestRawBody(req, maxFileUploadBytes).then(invoke)
          : invoke();
    result.catch((err) => {
      if (!res.headersSent) {
        sendJson(res, err instanceof FileUploadTooLargeError ? 413 : 500, { error: errMsg(err) });
      }
    });
  });

  const wss = new WebSocketServer({
    server: httpServer,
    path: "/ws",
    verifyClient: (info, done) => {
      const trusted = isTrustedOrigin(info.origin, allowedOrigins);
      done(trusted, trusted ? undefined : 403, trusted ? undefined : "Forbidden origin");
    },
  });
  const initializingClients = new WeakSet<WebSocket>();
  const broadcastFrame = (frame: ServerFrame): void => {
    const data = JSON.stringify(frame);
    for (const client of wss.clients) {
      if (!initializingClients.has(client) && client.readyState === client.OPEN) client.send(data);
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
    initializingClients.add(ws);
    // Initial project-scoped snapshots must come from one serialized state. Otherwise a
    // connection racing a project import can observe a half-imported hello and a workspace
    // frame from the project selected later in the same transaction.
    void canvasState
      .runProjectTransaction(
        async () => {
          const workspace = await canvasState.currentWorkspaceFrame();
          const hello = helloFrame();
          send(ws, hello);
          send(ws, workspace);
        },
        { forceEnqueue: true },
      )
      .then(
        () => initializingClients.delete(ws),
        () => {
          initializingClients.delete(ws);
          ws.close();
        },
      );
  });

  // 把 manager 的事件广播到所有 WS 客户端
  manager.onEvent((envelope) => {
    // Agent completion can asynchronously advance PR/sync flows. Keep that derived mutation
    // ordered with project switches so a late old-project result cannot update newly imported
    // flow state. Calls are enqueued in listener order.
    const finishDerivedEvent = canvasState.beginDerivedAgentEvent();
    void canvasState
      .runProjectTransaction(
        async () => {
          broadcastFrame({ type: "event", envelope });
          if (
            envelope.event.kind === "status" &&
            (envelope.event.status === "running" ||
              envelope.event.status === "waiting_input")
          ) {
            const branch = manager.configOf(envelope.agentId)?.branch?.trim();
            if (branch) await reviewQueue.retryBranch(branch);
          }
          await Promise.all([
            pullRequestFlowManager.handleAgentEvent(envelope),
            syncFlowManager.handleAgentEvent(envelope),
          ]);
          canvasState.saveSoon();
        },
        { forceEnqueue: true },
      )
      .catch(() => undefined)
      .finally(finishDerivedEvent);
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
    flushCanvasState: async () => await canvasState.saveNow(),
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
  reviewQueue: BranchReviewQueue,
  commitManager: CommitManager,
  codexAuthManager: CodexAuthManager,
  defaultCwd: string,
  codexModels: () => Promise<CodexModelDetection>,
  openFile: (filePath: string, options?: OpenInVscodeOptions) => Promise<void>,
  pickDirectory: PickDirectory,
  pickFiles: PickFiles,
  maxFileUploadBytes: number,
  canvasState: CanvasStateController,
  broadcastHello: () => void,
  broadcastFrame: (frame: ServerFrame) => void,
  allowedOrigins: Set<string>,
): Promise<void> {
  setCors(req, res, allowedOrigins);
  if (req.method === "OPTIONS") {
    if (!isTrustedBrowserRequest(req, allowedOrigins)) {
      return sendJson(res, 403, { error: "forbidden origin" });
    }
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";
  const hasLiveProjectWork = (): boolean =>
    manager.list().some((agent) => !isTerminalStatus(agent.status)) ||
    canvasState.hasPendingDerivedAgentEvents() ||
    pullRequestFlowManager.hasOpenFlows() ||
    pullRequestFlowManager.hasPendingOperations() ||
    syncFlowManager.hasOpenFlows() ||
    syncFlowManager.hasPendingOperations();
  if (method !== "GET" && method !== "HEAD" && !isTrustedBrowserRequest(req, allowedOrigins)) {
    return sendJson(res, 403, { error: "forbidden origin" });
  }
  if (requiresExpectedProjectMutation(req)) {
    const expectedProjectId = singleHeader(req.headers["x-agent-canvas-project-id"]);
    const expectedRevisionText = singleHeader(
      req.headers["x-agent-canvas-project-revision"],
    );
    const expectedRevision = Number(expectedRevisionText);
    let currentRevision: WorkspaceProjectRevision | undefined;
    try {
      currentRevision = workspaceManager.captureProjectRevision();
    } catch {
      currentRevision = undefined;
    }
    if (
      !expectedProjectId ||
      !expectedRevisionText ||
      !Number.isSafeInteger(expectedRevision) ||
      currentRevision?.projectId !== expectedProjectId ||
      currentRevision.generation !== expectedRevision
    ) {
      return sendJson(res, 409, {
        error: "请求所属项目版本已切换；已拒绝迟到的项目写入",
      });
    }
  }

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
    const body = await readJson<
      Partial<AgentCanvasSettings> & { canvasProjectId?: string }
    >(req);
    if (
      !body?.canvasProjectId ||
      body.canvasProjectId !== workspaceManager.currentProjectId()
    ) {
      return sendJson(res, 409, {
        error: "设置所属项目已切换；已拒绝迟到的权限设置",
      });
    }
    if (
      (body?.fullPermissionMode !== undefined &&
        typeof body.fullPermissionMode !== "boolean") ||
      (body?.workDocumentationEnabled !== undefined &&
        typeof body.workDocumentationEnabled !== "boolean")
    ) {
      return sendJson(res, 400, { error: "设置项必须是 boolean" });
    }
    try {
      return await canvasState.runProjectTransaction(async () => {
        if (body?.workDocumentationEnabled) {
          const revision = workspaceManager.captureProjectRevision();
          await workspaceManager.prepareWorkDocumentationForAllBranches(revision);
          workspaceManager.assertProjectRevision(revision);
        }
        const settings = manager.updateAppSettings({
          fullPermissionMode: body.fullPermissionMode,
          workDocumentationEnabled: body.workDocumentationEnabled,
        });
        if (body?.workDocumentationEnabled !== undefined) {
          canvasState.recordWorkDocumentationStatus({ ready: true });
        }
        canvasState.saveSoon();
        return sendJson(res, 200, settings);
      });
    } catch (error) {
      return sendJson(res, workspaceErrorStatus(error), { error: errMsg(error) });
    }
  }

  if (method === "GET" && path === "/api/canvas-layout") {
    return sendJson(res, 200, canvasState.getLayout());
  }

  if (method === "PATCH" && path === "/api/canvas-layout") {
    const body = await readJson<
      Partial<CanvasLayoutSnapshot> & { canvasProjectId?: string }
    >(req);
    try {
      if (
        !body?.canvasProjectId ||
        body.canvasProjectId !== workspaceManager.currentProjectId()
      ) {
        return sendJson(res, 409, {
          error: "画布布局所属项目已切换；已拒绝迟到的布局保存",
        });
      }
      return sendJson(res, 200, await canvasState.setLayout(body ?? {}));
    } catch (error) {
      return sendJson(res, 400, { error: errMsg(error) });
    }
  }

  if (method === "GET" && path === "/api/canvas-projects") {
    return await canvasState.runProjectTransaction(async () =>
      sendJson(res, 200, { projects: await workspaceManager.listCanvasProjects() }),
    );
  }

  if (method === "POST" && path === "/api/canvas-projects") {
    const body = await readJson<CreateCanvasProjectInput>(req);
    if (!body?.name) return sendJson(res, 400, { error: "缺少项目名称" });
    if (hasLiveProjectWork()) {
      return sendJson(res, 409, {
        error: "当前项目仍有活动 agent 或流程；请先结束全部工作后再切换项目",
      });
    }
    manager.invalidatePendingTurnContexts();
    try {
      const created = await canvasState.runProjectTransaction(async () => {
        const previousWorkspace = await workspaceManager.project().catch(() => undefined);
        let project: Awaited<ReturnType<WorkspaceManager["createCanvasProject"]>> | undefined;
        try {
          project = await workspaceManager.createCanvasProject(body);
          const workDocumentation = await canvasState.loadProjectState();
          const workspace = await workspaceManager.project();
          broadcastFrame({ type: "workspace", workspace, workDocumentation });
          broadcastHello();
          canvasState.activateImportedFlowState();
          return { project, workspace };
        } catch (createError) {
          if (project) {
            // Project metadata has already committed. Keep that authoritative project open and
            // reset its in-memory canvas state instead of deleting a possibly user-owned root.
            const workDocumentation =
              await canvasState.resetProjectStateAfterFailedLoad(createError);
            const workspace = await workspaceManager.project();
            broadcastFrame({
              type: "workspace",
              workspace,
              partialSuccess: true,
              workDocumentation,
            });
            broadcastHello();
            canvasState.activateImportedFlowState();
            return { project, workspace, partialSuccess: true, workDocumentation };
          }
          const rollbackErrors: unknown[] = [];
          try {
            if (previousWorkspace?.canvasProject) {
              await workspaceManager.openCanvasProject({
                id: previousWorkspace.canvasProject.id,
                projectRoot: previousWorkspace.projectRoot,
              });
              const workDocumentation = await canvasState.loadProjectState();
              const workspace = await workspaceManager.project();
              broadcastFrame({
                type: "workspace",
                workspace,
                partialSuccess: !workDocumentation.ready || undefined,
                workDocumentation,
              });
            } else {
              await workspaceManager.closeCanvasProject();
              await canvasState.unloadProjectState();
              broadcastFrame({
                type: "workspace",
                workDocumentation: { ready: true },
              });
            }
            broadcastHello();
            canvasState.activateImportedFlowState();
          } catch (error) {
            rollbackErrors.push(error);
          }
          if (rollbackErrors.length > 0) {
            throw new Error(
              `创建项目失败，且恢复原项目失败：${errMsg(createError)}；${rollbackErrors.map(errMsg).join("；")}`,
              { cause: createError },
            );
          }
          throw createError;
        }
      }, { saveCurrent: true, allowUnsafeCurrentState: true });
      return sendJson(res, created.partialSuccess ? 207 : 201, created);
    } catch (error) {
      return sendJson(res, 400, { error: errMsg(error) });
    }
  }

  if (method === "POST" && path === "/api/canvas-projects/open") {
    const body = await readJson<OpenCanvasProjectInput>(req);
    if (!body?.id && !body?.projectRoot?.trim()) {
      return sendJson(res, 400, { error: "缺少项目 id 或项目文件夹" });
    }
    if (hasLiveProjectWork()) {
      return sendJson(res, 409, {
        error: "当前项目仍有活动 agent 或流程；请先结束全部工作后再切换项目",
      });
    }
    manager.invalidatePendingTurnContexts();
    try {
      const opened = await canvasState.runProjectTransaction(async () => {
        const previousWorkspace = await workspaceManager.project().catch(() => undefined);
        try {
          const workspace = await workspaceManager.openCanvasProject(body);
          const workDocumentation = await canvasState.loadProjectState();
          broadcastFrame({
            type: "workspace",
            workspace,
            partialSuccess: !workDocumentation.ready || undefined,
            workDocumentation,
          });
          broadcastHello();
          canvasState.activateImportedFlowState();
          return { workspace, workDocumentation };
        } catch (openError) {
          if (!previousWorkspace?.canvasProject) {
            try {
              await workspaceManager.closeCanvasProject();
              await canvasState.unloadProjectState();
              broadcastFrame({
                type: "workspace",
                workDocumentation: { ready: true },
              });
              broadcastHello();
              canvasState.activateImportedFlowState();
            } catch (rollbackError) {
              throw new Error(
                `打开项目失败，且清理失败项目状态失败：${errMsg(openError)}；${errMsg(rollbackError)}`,
                { cause: openError },
              );
            }
            throw openError;
          }
          try {
            await workspaceManager.openCanvasProject({
              id: previousWorkspace.canvasProject.id,
              projectRoot: previousWorkspace.projectRoot,
            });
            const workDocumentation = await canvasState.loadProjectState();
            const workspace = await workspaceManager.project();
            broadcastFrame({
              type: "workspace",
              workspace,
              partialSuccess: !workDocumentation.ready || undefined,
              workDocumentation,
            });
            broadcastHello();
            canvasState.activateImportedFlowState();
          } catch (rollbackError) {
            throw new Error(
              `打开项目失败，且恢复原项目失败：${errMsg(openError)}；${errMsg(rollbackError)}`,
              { cause: openError },
            );
          }
          throw openError;
        }
      }, { saveCurrent: true, allowUnsafeCurrentState: true });
      if (!opened.workDocumentation.ready) {
        return sendJson(res, 207, {
          workspace: opened.workspace,
          partialSuccess: true,
          workDocumentation: opened.workDocumentation,
        });
      }
      return sendJson(res, 200, { workspace: opened.workspace });
    } catch (error) {
      return sendJson(res, 404, { error: errMsg(error) });
    }
  }

  if (method === "POST" && path === "/api/canvas-projects/inspect") {
    const body = await readJson<{ projectRoot?: string }>(req);
    if (!body?.projectRoot?.trim()) {
      return sendJson(res, 400, { error: "缺少项目文件夹" });
    }
    try {
      const inspection = await workspaceManager.inspectCanvasProject(body.projectRoot);
      return sendJson(res, 200, { inspection });
    } catch (error) {
      return sendJson(res, 400, { error: errMsg(error) });
    }
  }

  const canvasProjectMatch = path.match(/^\/api\/canvas-projects\/([^/]+)$/u);
  if (method === "DELETE" && canvasProjectMatch) {
    if (req.headers["x-agent-canvas-intent"] !== "delete-project") {
      return sendJson(res, 403, { error: "missing delete-project intent" });
    }
    try {
      const projectId = decodeURIComponent(canvasProjectMatch[1]!);
      const deletingCurrentProject = workspaceManager.currentProjectId() === projectId;
      if (deletingCurrentProject && hasLiveProjectWork()) {
        return sendJson(res, 409, {
          error: "当前项目仍有活动 agent 或流程；请先结束全部工作后再删除",
        });
      }
      if (deletingCurrentProject) manager.invalidatePendingTurnContexts();
      return await canvasState.runProjectTransaction(async () => {
        const project = await workspaceManager.deleteCanvasProject(projectId);
        if (deletingCurrentProject) {
          await canvasState.unloadProjectState();
          broadcastFrame({
            type: "workspace",
            workDocumentation: { ready: true },
          });
        }
        broadcastHello();
        return sendJson(res, 200, { project });
      }, { saveCurrent: true, allowUnsafeCurrentState: true });
    } catch (error) {
      return sendJson(res, 404, { error: errMsg(error) });
    }
  }

  if (method === "GET" && path === "/api/workspace") {
    try {
      return await canvasState.runProjectTransaction(async () =>
        sendJson(res, 200, await workspaceManager.project()),
      );
    } catch (error) {
      return sendJson(res, 409, { error: errMsg(error) });
    }
  }

  if (method === "POST" && path === "/api/workspace/connect") {
    const body = await readJson<ConnectGitHubInput>(req);
    return await canvasState.runProjectTransaction(async () => {
      let connected: Awaited<ReturnType<WorkspaceManager["connectWithProjectRevision"]>>;
      try {
        connected = await workspaceManager.connectWithProjectRevision(body ?? {});
      } catch (error) {
        return sendJson(res, 400, { error: errMsg(error) });
      }
      if (manager.appSettings().workDocumentationEnabled) {
        try {
          await workspaceManager.prepareWorkDocumentationForAllBranches(connected.revision);
          workspaceManager.assertProjectRevision(connected.revision);
        } catch (error) {
          // The repository connection is already persisted; removing it here could discard
          // work created by another request, so expose the documentation failure explicitly.
          canvasState.saveSoon();
          canvasState.recordWorkDocumentationStatus({ ready: false, error: errMsg(error) });
          broadcastFrame({
            type: "workspace",
            workspace: connected.workspace,
            partialSuccess: true,
            workDocumentation: { ready: false, error: errMsg(error) },
          });
          return sendJson(res, 207, {
            ...connected.workspace,
            partialSuccess: true,
            workDocumentation: { ready: false, error: errMsg(error) },
          });
        }
      }
      canvasState.recordWorkDocumentationStatus({ ready: true });
      canvasState.saveSoon();
      broadcastFrame({
        type: "workspace",
        workspace: connected.workspace,
        workDocumentation: { ready: true },
      });
      return sendJson(res, 200, connected.workspace);
    });
  }

  if (method === "GET" && path === "/api/workspace/branches") {
    try {
      return await canvasState.runProjectTransaction(async () =>
        sendJson(res, 200, { branches: await workspaceManager.listBranches() }),
      );
    } catch (error) {
      return sendJson(res, 409, { error: errMsg(error) });
    }
  }

  if (method === "GET" && path === "/api/workspace/branch-options") {
    try {
      return await canvasState.runProjectTransaction(async () =>
        sendJson(res, 200, { branches: await workspaceManager.listBranchOptions() }),
      );
    } catch (error) {
      return sendJson(res, 409, { error: errMsg(error) });
    }
  }

  if (method === "POST" && path === "/api/workspace/branches") {
    const body = await readJson<CreateBranchWorkspaceInput>(req);
    // Validation stays outside the transaction; all project-dependent mutation work is inside.
    if (!body?.branch) return sendJson(res, 400, { error: "缺少 branch" });
    return await canvasState.runProjectTransaction(async () => {
      let created: Awaited<ReturnType<WorkspaceManager["createBranchWithProjectRevision"]>>;
      try {
        created = await workspaceManager.createBranchWithProjectRevision(body);
      } catch (error) {
        return sendJson(res, 400, { error: errMsg(error) });
      }
      if (manager.appSettings().workDocumentationEnabled) {
        try {
          await workspaceManager.prepareWorkDocumentationForAllBranches(created.revision);
          workspaceManager.assertProjectRevision(created.revision);
        } catch (error) {
          // The git worktree is already persisted. Do not delete it as compensation because
          // another process may have started using it before documentation preparation failed.
          canvasState.recordWorkDocumentationStatus({ ready: false, error: errMsg(error) });
          broadcastFrame({
            type: "workspace",
            workspace: await workspaceManager.project(),
            partialSuccess: true,
            workDocumentation: { ready: false, error: errMsg(error) },
          });
          return sendJson(res, 207, {
            branch: created.branch,
            partialSuccess: true,
            workDocumentation: { ready: false, error: errMsg(error) },
          });
        }
      }
      canvasState.recordWorkDocumentationStatus({ ready: true });
      broadcastFrame({
        type: "workspace",
        workspace: await workspaceManager.project(),
        workDocumentation: { ready: true },
      });
      return sendJson(res, 201, { branch: created.branch });
    });
  }

  if (method === "GET" && path === "/api/workspace/shared-resources") {
    try {
      return await canvasState.runProjectTransaction(async () =>
        sendJson(res, 200, {
          resources: (await workspaceManager.project()).sharedResources,
        }),
      );
    } catch (error) {
      return sendJson(res, 409, { error: errMsg(error) });
    }
  }

  if (method === "POST" && path === "/api/workspace/shared-resources") {
    const body = await readJson<CreateSharedResourceInput>(req);
    if (!body?.name || !body.mountPath) {
      return sendJson(res, 400, { error: "缺少共享资源名称或挂载路径" });
    }
    return await canvasState.runProjectTransaction(async () => {
      try {
        const resource = await workspaceManager.createSharedResource(body);
        broadcastFrame({
          type: "workspace",
          workspace: await workspaceManager.project(),
        });
        return sendJson(res, 201, { resource });
      } catch (error) {
        return sendJson(res, 400, { error: errMsg(error) });
      }
    });
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
    return await canvasState.runProjectTransaction(async () => {
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
    });
  }

  if (method === "GET" && path === "/api/files") {
    return sendJson(res, 200, { files: fileManager.list() });
  }

  if (method === "POST" && path === "/api/files/pick") {
    let paths: string[];
    try {
      paths = await preloadPickedFilePaths(req, pickFiles);
    } catch (error) {
      return sendJson(res, 501, { error: errMsg(error) });
    }
    if (paths.length === 0) return sendJson(res, 200, { selection: null });
    try {
      return sendJson(res, 200, {
        selection: await fileManager.stagePickedFiles(paths),
      });
    } catch (error) {
      return sendJson(res, 400, { error: errMsg(error) });
    }
  }

  if (method === "POST" && path === "/api/files/import-picked") {
    const body = await readJson<ImportPickedCanvasFilesInput>(req);
    if (
      !body?.selectionId?.trim() ||
      !isCanvasFileImportMode(body.mode) ||
      !isCanvasFileKind(body.kind)
    ) {
      return sendJson(res, 400, {
        error: "缺少文件选择、导入方式或节点类型",
      });
    }
    try {
      if (body.mode === "reference") {
        await workspaceManager.trustExternalFilePaths(
          fileManager.pickedSelectionPaths(body.selectionId),
        );
      }
      const files = await fileManager.importPicked(body.selectionId, body.mode, body.kind);
      canvasState.saveSoon();
      return sendJson(res, 201, { files });
    } catch (error) {
      if (error instanceof PickedFileSelectionExpiredError) {
        return sendJson(res, 410, {
          code: PICKED_FILE_SELECTION_EXPIRED_CODE,
          error: errMsg(error),
        });
      }
      return sendJson(res, 400, { error: errMsg(error) });
    }
  }

  const pickedSelectionMatch = path.match(/^\/api\/files\/pick\/([^/]+)$/u);
  if (method === "DELETE" && pickedSelectionMatch) {
    const selectionId = decodeURIComponent(pickedSelectionMatch[1]!);
    fileManager.releasePickedSelection(selectionId);
    return sendJson(res, 204, undefined);
  }

  if (method === "POST" && path === "/api/files/import-upload") {
    const filename = url.searchParams.get("filename");
    const kind = url.searchParams.get("kind");
    if (filename === null || filename.length === 0 || !isCanvasFileKind(kind)) {
      return sendJson(res, 400, { error: "缺少文件名或节点类型" });
    }
    try {
      const data = await preloadRequestRawBody(req, maxFileUploadBytes);
      const file = await fileManager.createUploaded(filename, data, kind);
      canvasState.saveSoon();
      return sendJson(res, 201, { file });
    } catch (error) {
      return sendJson(res, error instanceof FileUploadTooLargeError ? 413 : 400, {
        error: errMsg(error),
      });
    }
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
    if (method === "POST" && action === "relink") {
      const current = fileManager.get(id)!;
      if (current.storage !== "referenced") {
        return sendJson(res, 400, { error: "只有外部引用文件可以重新定位" });
      }
      let selected: string[];
      try {
        selected = await preloadPickedFilePaths(req, pickFiles, {
          initialDirectory: pathDirname(current.path),
          multiple: false,
        });
      } catch (error) {
        return sendJson(res, 501, { error: errMsg(error) });
      }
      if (!selected[0]) return sendJson(res, 200, { file: null });
      try {
        const [canonicalPath] = await workspaceManager.trustExternalFilePaths([selected[0]]);
        if (!canonicalPath) throw new Error("未能授权重新定位的文件路径");
        const file = await fileManager.relinkReferenced(id, canonicalPath);
        canvasState.saveSoon();
        return sendJson(res, 200, { file });
      } catch (error) {
        return sendJson(res, 400, { error: errMsg(error) });
      }
    }
    if (method === "POST" && action === "refresh") {
      try {
        const current = fileManager.get(id)!;
        const file = await fileManager.refreshAvailability(id);
        if (file !== current) canvasState.saveSoon();
        return sendJson(res, 200, { file });
      } catch (error) {
        return sendJson(res, 400, { error: errMsg(error) });
      }
    }
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
      const current = fileManager.get(id)!;
      try {
        const filePath = await fileManager.validatedOpenPath(id);
        await openFile(filePath, { windowMode: "reuse" });
        return sendJson(res, 202, { ok: true });
      } catch (error) {
        if (fileManager.get(id) !== current) canvasState.saveSoon();
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
      return await canvasState.runProjectTransaction(async () => {
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
          if (branchChanged && snapshot.status === "waiting_input") {
            const destinationBranch = snapshot.config?.branch?.trim();
            if (destinationBranch) {
              await reviewQueue.retryBranch(destinationBranch);
            }
          }
          canvasState.saveSoon();
          return sendJson(res, 200, snapshot);
        } catch (error) {
          return sendJson(res, 400, { error: errMsg(error) });
        }
      });
    }
    if (method === "GET" && action === "history") {
      return sendJson(res, 200, { events: manager.historyOf(id) });
    }
    if (method === "POST" && action === "open-workspace") {
      const cwd = manager.configOf(id)?.cwd?.trim();
      if (!cwd) return sendJson(res, 400, { error: "该 agent 尚未绑定 branch 工作目录" });
      try {
        await openFile(cwd, { windowMode: "new" });
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
      await manager.startAgent(id, body); // 若是 fork 产生的 agent，合并其 fork 配置
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
        await runner.send(body.text);
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
        await runner.compact();
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
      await runner.start(
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

function setCors(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  allowedOrigins: Set<string>,
): void {
  const origin = req.headers.origin;
  if (origin && isTrustedOrigin(origin, allowedOrigins)) {
    res.setHeader("Access-Control-Allow-Origin", new URL(origin).origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type,X-Agent-Canvas-Intent,X-Agent-Canvas-Project-Id,X-Agent-Canvas-Project-Revision",
  );
}

function resolveAllowedOrigins(configured: string[] | undefined): Set<string> {
  const fromEnvironment = process.env.AGENT_CANVAS_ALLOWED_ORIGINS
    ?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const origins = configured ?? fromEnvironment ?? [
    "http://127.0.0.1:5317",
    "http://localhost:5317",
  ];
  const normalized = new Set<string>();
  for (const origin of origins) {
    try {
      const parsed = new URL(origin);
      if ((parsed.protocol === "http:" || parsed.protocol === "https:") && isLoopbackHost(parsed.hostname)) {
        normalized.add(parsed.origin);
      }
    } catch {
      // Invalid configured origins are ignored instead of widening access.
    }
  }
  return normalized;
}

function isTrustedBrowserRequest(
  req: http.IncomingMessage,
  allowedOrigins: Set<string>,
): boolean {
  const fetchSite = req.headers["sec-fetch-site"];
  if (fetchSite === "cross-site") return false;
  return isTrustedOrigin(req.headers.origin, allowedOrigins);
}

function isTrustedOrigin(origin: string | undefined, allowedOrigins: Set<string>): boolean {
  if (!origin) return true;
  try {
    return allowedOrigins.has(new URL(origin).origin);
  } catch {
    return false;
  }
}

function isProjectScopedHttpRequest(req: http.IncomingMessage): boolean {
  if (req.method === "OPTIONS") return false;
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  if (!pathname.startsWith("/api/")) return false;
  return !(
    pathname === "/api/health" ||
    pathname === "/api/config" ||
    pathname === "/api/codex/usage" ||
    pathname === "/api/canvas-projects/inspect" ||
    pathname === "/api/directories/pick" ||
    pathname === "/api/codex-auth/status" ||
    pathname === "/api/codex-auth/login" ||
    pathname === "/api/codex-auth/login/cancel"
  );
}

function requiresWritableCanvasState(req: http.IncomingMessage): boolean {
  const method = req.method ?? "GET";
  if (["GET", "HEAD", "OPTIONS"].includes(method) || !isProjectScopedHttpRequest(req)) {
    return false;
  }
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  return !pathname.startsWith("/api/canvas-projects");
}

function requiresExpectedProjectMutation(req: http.IncomingMessage): boolean {
  const method = req.method ?? "GET";
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  if (!isProjectScopedHttpRequest(req)) return false;
  if (
    req.headers["x-agent-canvas-project-id"] !== undefined ||
    req.headers["x-agent-canvas-project-revision"] !== undefined
  ) {
    return true;
  }
  if (
    /^\/api\/agents\/[^/]+\/(?:commits|report-result)$/u.test(pathname) ||
    pathname === "/api/pr-flows" ||
    /^\/api\/pr-flows\/[^/]+(?:\/[^/]+)?$/u.test(pathname) ||
    pathname === "/api/sync-flows" ||
    /^\/api\/sync-flows\/[^/]+(?:\/[^/]+)?$/u.test(pathname)
  ) {
    return false;
  }
  return (
    pathname === "/api/settings" ||
    pathname === "/api/canvas-layout" ||
    pathname === "/api/workspace/connect" ||
    /^\/api\/workspace\/(?:branches|shared-resources)(?:\/[^/]+)?$/u.test(pathname) ||
    pathname === "/api/agents" ||
    /^\/api\/agents\/[^/]+(?:\/[^/]+(?:\/[^/]+)?)?$/u.test(pathname) ||
    pathname === "/api/files" ||
    /^\/api\/files\/pick\/[^/]+$/u.test(pathname) ||
    /^\/api\/files\/[^/]+(?:\/(?:open|relink|refresh))?$/u.test(pathname) ||
    pathname === "/api/prompts" ||
    /^\/api\/prompts\/[^/]+$/u.test(pathname) ||
    pathname === "/api/file-connections" ||
    /^\/api\/file-connections\/[^/]+$/u.test(pathname) ||
    pathname === "/api/prompt-connections" ||
    /^\/api\/prompt-connections\/[^/]+$/u.test(pathname)
  );
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function requestProjectHeadersMatch(
  req: http.IncomingMessage,
  expected: WorkspaceProjectRevision,
): boolean {
  const projectId = singleHeader(req.headers["x-agent-canvas-project-id"]);
  const revisionText = singleHeader(req.headers["x-agent-canvas-project-revision"]);
  const revision = Number(revisionText);
  return (
    projectId === expected.projectId &&
    !!revisionText &&
    Number.isSafeInteger(revision) &&
    revision === expected.generation
  );
}

function shouldPreloadProjectRequestBody(
  req: http.IncomingMessage,
  allowedOrigins: Set<string>,
): boolean {
  const method = req.method ?? "GET";
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  return (
    method !== "GET" &&
    method !== "HEAD" &&
    method !== "OPTIONS" &&
    pathname !== "/api/files/import-upload" &&
    isProjectScopedHttpRequest(req) &&
    isTrustedBrowserRequest(req, allowedOrigins)
  );
}

function shouldPreloadFileUploadBody(
  req: http.IncomingMessage,
  allowedOrigins: Set<string>,
): boolean {
  return (
    req.method === "POST" &&
    new URL(req.url ?? "/", "http://localhost").pathname === "/api/files/import-upload" &&
    isTrustedBrowserRequest(req, allowedOrigins)
  );
}

function preloadNativeFileSelection(
  req: http.IncomingMessage,
  allowedOrigins: Set<string>,
  fileManager: FileManager,
  pickFiles: PickFiles,
): Promise<string[]> | undefined {
  if (req.method !== "POST" || !isTrustedBrowserRequest(req, allowedOrigins)) {
    return undefined;
  }
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  if (pathname === "/api/files/pick") {
    return preloadRequestJsonBody(req).then(() => preloadPickedFilePaths(req, pickFiles));
  }
  const relinkMatch = pathname.match(/^\/api\/files\/([^/]+)\/relink$/u);
  if (!relinkMatch) return undefined;
  let id: string;
  try {
    id = decodeURIComponent(relinkMatch[1]!);
  } catch {
    return undefined;
  }
  const file = fileManager.get(id);
  if (file?.storage !== "referenced") return undefined;
  return preloadRequestJsonBody(req).then(() =>
    preloadPickedFilePaths(req, pickFiles, {
      initialDirectory: pathDirname(file.path),
      multiple: false,
    }),
  );
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(data);
}

function preloadRequestJsonBody(req: http.IncomingMessage): Promise<unknown | undefined> {
  const existing = requestJsonBodies.get(req);
  if (existing) return existing;
  const pending = readJsonBody(req);
  requestJsonBodies.set(req, pending);
  return pending;
}

async function readJson<T>(req: http.IncomingMessage): Promise<T | undefined> {
  return (await preloadRequestJsonBody(req)) as T | undefined;
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as unknown;
  } catch {
    return undefined;
  }
}

class FileUploadTooLargeError extends Error {}

async function readRawBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declaredLength = Number(singleHeader(req.headers["content-length"]));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    req.resume();
    throw new FileUploadTooLargeError(uploadLimitMessage(maxBytes));
  }

  const chunks: Buffer[] = [];
  let total = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      tooLarge = true;
      chunks.length = 0;
      continue;
    }
    if (!tooLarge) chunks.push(buffer);
  }
  if (tooLarge) throw new FileUploadTooLargeError(uploadLimitMessage(maxBytes));
  return Buffer.concat(chunks, total);
}

function preloadRequestRawBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  const existing = requestRawBodies.get(req);
  if (existing) return existing;
  const pending = readRawBody(req, maxBytes);
  requestRawBodies.set(req, pending);
  return pending;
}

function preloadPickedFilePaths(
  req: http.IncomingMessage,
  pickFiles: PickFiles,
  options?: PickFilesOptions,
): Promise<string[]> {
  const existing = requestPickedFilePaths.get(req);
  if (existing) return existing;
  const pending = options
    ? pickFiles(options)
    : readJson<{ initialDirectory?: string }>(req).then((body) =>
        pickFiles({
          initialDirectory:
            typeof body?.initialDirectory === "string" && body.initialDirectory.length > 0
              ? body.initialDirectory
              : undefined,
          multiple: true,
        }),
      );
  requestPickedFilePaths.set(req, pending);
  return pending;
}

function uploadLimitMessage(maxBytes: number): string {
  return maxBytes >= 1024 * 1024
    ? `上传文件不能超过 ${Math.floor(maxBytes / (1024 * 1024))} MiB`
    : `上传文件不能超过 ${maxBytes} bytes`;
}

function isCanvasFileKind(value: unknown): value is CanvasFileKind {
  return value === "normal" || value === "shared";
}

function isCanvasFileImportMode(value: unknown): value is CanvasFileImportMode {
  return value === "copy" || value === "reference";
}

function send(ws: WebSocket, frame: ServerFrame): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function workspaceErrorStatus(error: unknown): number {
  return error instanceof WorkspaceProjectChangedError ? 409 : 400;
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
  reviewQueue: BranchReviewQueue;
  pullRequestFlowManager: PullRequestFlowManager;
  syncFlowManager: SyncFlowManager;
  commitManager: CommitManager;
}

function createCanvasStateController(deps: CanvasStateControllerDeps): CanvasStateController {
  let layout = emptyCanvasLayout();
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let projectOperationChain: Promise<void> = Promise.resolve();
  let workDocumentationStatus: WorkDocumentationLoadStatus = { ready: true };
  let canvasStateProjectId: string | undefined;
  let canvasStateSnapshot: ManagedFileSnapshot | undefined;
  let canvasStateWritable = false;
  let pendingDerivedAgentEvents = 0;
  const projectOperationContext = new AsyncLocalStorage<{ active: boolean }>();

  const clearSaveTimer = (): void => {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = undefined;
  };

  const enqueueProjectOperation = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = projectOperationChain.then(operation, operation);
    projectOperationChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const applyProjectStorageRoots = (
    projectRoot: string,
    trustedRootBoundary?: ManagedTrustedRootBoundary,
  ): void => {
    deps.fileManager.setIsolatedRoot(
      path.join(projectRoot, "files"),
      projectRoot,
      trustedRootBoundary,
    );
    deps.promptManager.setPromptRoot(
      path.join(projectRoot, "prompts"),
      projectRoot,
      trustedRootBoundary,
    );
  };

  if (deps.workspaceManager.currentProjectId()) {
    applyProjectStorageRoots(
      deps.workspaceManager.root(),
      deps.workspaceManager.currentProjectRootBoundaryIfAvailable(),
    );
  }

  const saveCurrentProject = async (): Promise<void> => {
    if (!deps.workspaceManager.currentProjectId()) return;
    const project = await deps.workspaceManager.project();
    const projectId = project.canvasProject?.id;
    if (!projectId || projectId !== canvasStateProjectId || !canvasStateWritable) {
      throw new Error("Canvas project state was not safely loaded; refusing to overwrite it");
    }
    const trustedRootBoundary = deps.workspaceManager.currentProjectRootBoundary();
    applyProjectStorageRoots(project.projectRoot, trustedRootBoundary);
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
    await deps.workspaceManager.validateCurrentProjectRoot();
    canvasStateSnapshot = await writeManagedFileAtomically(
      statePath,
      `${JSON.stringify(state, null, 2)}\n`,
      {
        allowParentMapping: true,
        label: "canvas state",
        trustedRootBoundary,
        expectedContent: canvasStateSnapshot?.content,
        expectedIdentity: canvasStateSnapshot?.identity,
      },
    );
  };

  const loadProjectState = async (): Promise<WorkDocumentationLoadStatus> => {
    const project = await deps.workspaceManager.project();
    const trustedRootBoundary = deps.workspaceManager.currentProjectRootBoundary();
    applyProjectStorageRoots(project.projectRoot, trustedRootBoundary);
    canvasStateProjectId = project.canvasProject?.id;
    canvasStateSnapshot = undefined;
    canvasStateWritable = false;
    await deps.workspaceManager.validateCurrentProjectRoot();
    canvasStateSnapshot = await readManagedFileSnapshot(
      path.join(project.projectRoot, CANVAS_STATE_FILE),
      {
        allowMissing: true,
        allowParentMapping: true,
        label: "canvas state",
        trustedRootBoundary,
      },
    );
    await deps.workspaceManager.validateCurrentProjectRoot();
    const state = parseCanvasProjectState(canvasStateSnapshot?.content);

    // Retire old-project deliveries before any asynchronous import can yield. Retired leases keep
    // their branch reservation until the underlying transport settles, so a new same-branch
    // review cannot overlap a stale blocked steer.
    deps.reviewQueue.clear();
    deps.pullRequestFlowManager.importState(undefined, { deferActivation: true });
    deps.syncFlowManager.importState(undefined, { deferActivation: true });

    await deps.manager.importState(state?.agents);
    await deps.workspaceManager.validateCurrentProjectRoot();
    await deps.fileManager.importState(state?.files, {
      // WorkspaceManager loads only the canonical external paths authorized in the local project
      // index. FileManager compares the persisted state against that independently trusted set,
      // which also catches a canvas-state or parent-mapping swap during project loading.
      trustedReferencedPaths: deps.workspaceManager.currentTrustedExternalFilePaths(),
    });
    await deps.workspaceManager.validateCurrentProjectRoot();
    await deps.promptManager.importState(state?.prompts);
    await deps.workspaceManager.validateCurrentProjectRoot();
    deps.commitManager.importState(state?.commits);
    layout = sanitizeCanvasLayout(state?.layout);

    // Both owners are imported without activation only after agents, prompts, commits, and layout
    // are complete. The route activates them together after broadcasting the restored snapshot.
    deps.pullRequestFlowManager.importState(state?.prFlows, { deferActivation: true });
    deps.syncFlowManager.importState(state?.syncFlows, { deferActivation: true });
    canvasStateWritable = true;
    if (deps.manager.appSettings().workDocumentationEnabled) {
      try {
        await deps.workspaceManager.prepareWorkDocumentationForAllBranches();
      } catch (error) {
        workDocumentationStatus = { ready: false, error: errMsg(error) };
        return workDocumentationStatus;
      }
    }
    workDocumentationStatus = { ready: true };
    return workDocumentationStatus;
  };

  const runProjectTransaction = <T>(
    operation: () => Promise<T>,
    options: {
      saveCurrent?: boolean;
      forceEnqueue?: boolean;
      allowUnsafeCurrentState?: boolean;
    } = {},
  ): Promise<T> => {
    const execute = async (): Promise<T> => {
      if (deps.workspaceManager.currentProjectId()) {
        await deps.workspaceManager.validateCurrentProjectRoot();
      }
      if (options.saveCurrent) {
        clearSaveTimer();
        if (!options.allowUnsafeCurrentState || canvasStateWritable) {
          await saveCurrentProject();
        }
      }
      return await operation();
    };
    if (projectOperationContext.getStore()?.active && !options.forceEnqueue) return execute();
    return enqueueProjectOperation(() => {
      const context = { active: true };
      return projectOperationContext.run(context, async () => {
        try {
          return await execute();
        } finally {
          // Async resources (notably saveSoon timers) inherit the storage object. Marking the
          // transaction inactive makes those later callbacks enqueue instead of bypassing it.
          context.active = false;
        }
      });
    });
  };

  const saveNow = (): Promise<void> =>
    runProjectTransaction(async () => {
      clearSaveTimer();
      await saveCurrentProject();
    });

  return {
    assertProjectStateWritable: () =>
      runProjectTransaction(async () => {
        const projectId = deps.workspaceManager.currentProjectId();
        // The server can be constructed around an already-open WorkspaceManager. Its first
        // mutation must establish the same no-follow snapshot and imported state as an explicit
        // project open, and it must do so inside the project queue so concurrent first writes
        // cannot race duplicate imports. Once a load has started (successfully or otherwise),
        // never retry it implicitly: a failed or partially imported state remains read-only until
        // the user explicitly reopens or replaces it.
        if (projectId && canvasStateProjectId === undefined) {
          await loadProjectState();
          // An already-open WorkspaceManager has no explicit project-open route to perform the
          // deferred handoff. Activate both queue owners before the triggering mutation can add
          // new work, preserving restored FIFO order and zero-reviewer deferral on server start.
          deps.pullRequestFlowManager.activateImportedState();
          deps.syncFlowManager.activateImportedState();
        }
        if (!projectId || projectId !== canvasStateProjectId || !canvasStateWritable) {
          throw new Error(
            "Canvas project state is read-only because it was not safely loaded; reopen or replace the unsafe state file before making changes",
          );
        }
      }),
    getLayout: () => layout,
    setLayout: (nextLayout) =>
      runProjectTransaction(async () => {
        clearSaveTimer();
        const previousLayout = layout;
        layout = sanitizeCanvasLayout(nextLayout);
        try {
          await saveCurrentProject();
          return layout;
        } catch (error) {
          layout = previousLayout;
          throw error;
        }
      }),
    loadProjectState,
    resetProjectStateAfterFailedLoad: async (error) => {
      clearSaveTimer();
      deps.reviewQueue.clear();
      deps.pullRequestFlowManager.importState(undefined, { deferActivation: true });
      deps.syncFlowManager.importState(undefined, { deferActivation: true });
      await deps.manager.clear();
      await deps.fileManager.importState(undefined);
      await deps.promptManager.importState(undefined);
      deps.commitManager.importState(undefined);
      layout = emptyCanvasLayout();
      const project = await deps.workspaceManager.project();
      applyProjectStorageRoots(
        project.projectRoot,
        deps.workspaceManager.currentProjectRootBoundary(),
      );
      canvasStateProjectId = project.canvasProject?.id;
      canvasStateWritable = false;
      workDocumentationStatus = { ready: false, error: errMsg(error) };
      return workDocumentationStatus;
    },
    activateImportedFlowState: () => {
      deps.pullRequestFlowManager.activateImportedState();
      deps.syncFlowManager.activateImportedState();
    },
    unloadProjectState: async () => {
      clearSaveTimer();
      deps.reviewQueue.clear();
      deps.pullRequestFlowManager.importState(undefined, { deferActivation: true });
      deps.syncFlowManager.importState(undefined, { deferActivation: true });
      await deps.manager.clear();
      await deps.fileManager.importState(undefined);
      await deps.promptManager.importState(undefined);
      deps.commitManager.importState(undefined);
      layout = emptyCanvasLayout();
      workDocumentationStatus = { ready: true };
      canvasStateProjectId = undefined;
      canvasStateSnapshot = undefined;
      canvasStateWritable = false;
      applyProjectStorageRoots(path.join(deps.workspaceManager.projectListRoot(), ".inactive"));
    },
    runProjectTransaction,
    currentWorkspaceFrame: () =>
      runProjectTransaction(async () => {
        try {
          return {
            type: "workspace",
            workspace: await deps.workspaceManager.project(),
            partialSuccess: !workDocumentationStatus.ready || undefined,
            workDocumentation: workDocumentationStatus,
          };
        } catch {
          return {
            type: "workspace",
            workDocumentation: workDocumentationStatus,
          };
        }
      }),
    recordWorkDocumentationStatus: (status) => {
      workDocumentationStatus = status;
    },
    beginDerivedAgentEvent: () => {
      pendingDerivedAgentEvents += 1;
      let finished = false;
      return () => {
        if (finished) return;
        finished = true;
        pendingDerivedAgentEvents -= 1;
      };
    },
    hasPendingDerivedAgentEvents: () => pendingDerivedAgentEvents > 0,
    saveNow,
    saveSoon: () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        saveTimer = undefined;
        // A timer created inside an AsyncLocalStorage transaction inherits its context. Always
        // enter through the physical queue here so a long-running outer operation cannot be
        // bypassed when the debounce expires.
        void enqueueProjectOperation(saveCurrentProject);
      }, 100);
    },
  };
}

function parseCanvasProjectState(content: string | undefined): CanvasProjectState | undefined {
  if (content === undefined) return undefined;
  const parsed = JSON.parse(content) as CanvasProjectState;
  if (parsed?.version !== 1) throw new Error("unsupported canvas state version");
  return parsed;
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
