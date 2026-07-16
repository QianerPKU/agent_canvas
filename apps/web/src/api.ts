/** 后端 REST 命令客户端。事件走 WebSocket，命令走这里。 */
import type {
  AgentApprovalResponse,
  AgentCanvasSettings,
  AgentCanvasConfig,
  AgentCommitSnapshot,
  CodexUsageSnapshot,
  AgentEventEnvelope,
  AgentQuestionResponse,
  AgentSettings,
  AgentSnapshot,
  AgentStartConfig,
  BranchOption,
  BranchWorkspace,
  CanvasLayoutSnapshot,
  CanvasProjectInspection,
  CodexAuthStatus,
  CodexLoginSession,
  CanvasProjectSummary,
  CanvasFileConnection,
  CanvasFileNode,
  CanvasPromptConnection,
  CanvasPromptNode,
  ConnectGitHubInput,
  CreateBranchWorkspaceInput,
  CreateCanvasFileInput,
  CreateCanvasProjectInput,
  CreateCanvasPromptInput,
  CreatePullRequestFlowInput,
  CreateSyncFlowInput,
  FileConnectionAccess,
  ForkAgentInput,
  ForkOrigin,
  OpenCanvasProjectInput,
  PullRequestCreatedInput,
  PullRequestFlowSnapshot,
  PromptConnectionAccess,
  SyncFlowAppliedInput,
  SyncFlowSnapshot,
  UpdateAgentSettingsInput,
  UpdateCanvasFileInput,
  UpdateCanvasPromptInput,
  WorkspaceProject,
} from "@agent-canvas/shared";

const BASE = "/api";

export interface WorkDocumentationMutationStatus {
  partialSuccess?: boolean;
  workDocumentation?: {
    ready: boolean;
    error?: string;
  };
}

export type WorkspaceConnectionResult = WorkspaceProject & WorkDocumentationMutationStatus;
export type BranchCreationResult = BranchWorkspace & WorkDocumentationMutationStatus;
export type CanvasProjectOpenResult = WorkspaceProject & WorkDocumentationMutationStatus;

let activeWorkspaceContext:
  | { canvasProjectId: string; revision: number }
  | undefined;

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (activeWorkspaceContext) {
    headers.set("X-Agent-Canvas-Project-Id", activeWorkspaceContext.canvasProjectId);
    headers.set(
      "X-Agent-Canvas-Project-Revision",
      String(activeWorkspaceContext.revision),
    );
  }
  const res = await fetch(BASE + path, {
    ...init,
    headers,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${text}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  setWorkspaceContext: (workspace?: WorkspaceProject) => {
    const canvasProjectId = workspace?.canvasProject?.id?.trim();
    const revision = workspace?.revision;
    const nextContext =
      canvasProjectId && Number.isSafeInteger(revision) && (revision ?? -1) >= 0
        ? { canvasProjectId, revision: revision! }
        : undefined;
    if (
      nextContext &&
      activeWorkspaceContext &&
      nextContext.canvasProjectId === activeWorkspaceContext.canvasProjectId &&
      nextContext.revision < activeWorkspaceContext.revision
    ) {
      return;
    }
    activeWorkspaceContext = nextContext;
  },
  list: () => call<{ agents: AgentSnapshot[] }>("/agents").then((r) => r.agents),
  canvasLayout: () => call<CanvasLayoutSnapshot>("/canvas-layout"),
  saveCanvasLayout: (input: CanvasLayoutSnapshot, canvasProjectId?: string) =>
    call<CanvasLayoutSnapshot>("/canvas-layout", {
      method: "PATCH",
      body: JSON.stringify({ ...input, canvasProjectId }),
    }),
  config: () => call<AgentCanvasConfig>("/config"),
  codexUsage: () => call<CodexUsageSnapshot>("/codex/usage"),
  settings: () => call<AgentCanvasSettings>("/settings"),
  updateSettings: (input: Partial<AgentCanvasSettings>, canvasProjectId: string) =>
    call<AgentCanvasSettings>("/settings", {
      method: "PATCH",
      body: JSON.stringify({ ...input, canvasProjectId }),
    }),
  listCanvasProjects: () =>
    call<{ projects: CanvasProjectSummary[] }>("/canvas-projects").then((r) => r.projects),
  createCanvasProject: (input: CreateCanvasProjectInput) =>
    call<{ project: CanvasProjectSummary; workspace: WorkspaceProject }>("/canvas-projects", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  openCanvasProject: (input: OpenCanvasProjectInput | string) =>
    call<{ workspace: WorkspaceProject } & WorkDocumentationMutationStatus>("/canvas-projects/open", {
      method: "POST",
      body: JSON.stringify(typeof input === "string" ? { id: input } : input),
    }).then((result): CanvasProjectOpenResult => ({
      ...result.workspace,
      partialSuccess: result.partialSuccess,
      workDocumentation: result.workDocumentation,
    })),
  inspectCanvasProject: (projectRoot: string) =>
    call<{ inspection: CanvasProjectInspection }>("/canvas-projects/inspect", {
      method: "POST",
      body: JSON.stringify({ projectRoot }),
    }).then((r) => r.inspection),
  deleteCanvasProject: (id: string) =>
    call<{ project: CanvasProjectSummary }>(`/canvas-projects/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { "X-Agent-Canvas-Intent": "delete-project" },
    }).then((r) => r.project),
  workspace: () => call<WorkspaceProject>("/workspace"),
  connectWorkspace: (input: ConnectGitHubInput) =>
    call<WorkspaceConnectionResult>("/workspace/connect", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  listBranches: () =>
    call<{ branches: BranchWorkspace[] }>("/workspace/branches").then((r) => r.branches),
  listBranchOptions: () =>
    call<{ branches: BranchOption[] }>("/workspace/branch-options").then((r) => r.branches),
  createBranch: (input: CreateBranchWorkspaceInput) =>
    call<{ branch: BranchWorkspace } & WorkDocumentationMutationStatus>("/workspace/branches", {
      method: "POST",
      body: JSON.stringify(input),
    }).then((result): BranchCreationResult => ({
      ...result.branch,
      partialSuccess: result.partialSuccess,
      workDocumentation: result.workDocumentation,
    })),
  listPullRequestFlows: () =>
    call<{ flows: PullRequestFlowSnapshot[] }>("/pr-flows").then((r) => r.flows),
  listSyncFlows: () =>
    call<{ flows: SyncFlowSnapshot[] }>("/sync-flows").then((r) => r.flows),
  listCommits: () =>
    call<{ commits: AgentCommitSnapshot[] }>("/commits").then((r) => r.commits),
  codexAuthStatus: () =>
    call<{ status: CodexAuthStatus; login: CodexLoginSession | null }>("/codex-auth/status"),
  startCodexLogin: () =>
    call<{ login: CodexLoginSession }>("/codex-auth/login", { method: "POST" }).then(
      (r) => r.login,
    ),
  cancelCodexLogin: () =>
    call<{ login: CodexLoginSession | null }>("/codex-auth/login/cancel", {
      method: "POST",
    }).then((r) => r.login),
  createPullRequestFlow: (input: CreatePullRequestFlowInput) =>
    call<{ flow: PullRequestFlowSnapshot }>("/pr-flows", {
      method: "POST",
      body: JSON.stringify(input),
    }).then((r) => r.flow),
  recordPullRequestCreated: (id: string, input: PullRequestCreatedInput) =>
    call<{ flow: PullRequestFlowSnapshot }>(`/pr-flows/${encodeURIComponent(id)}/pr-created`, {
      method: "POST",
      body: JSON.stringify(input),
    }).then((r) => r.flow),
  recordPullRequestMerged: (id: string) =>
    call<{ flow: PullRequestFlowSnapshot }>(`/pr-flows/${encodeURIComponent(id)}/merged`, {
      method: "POST",
    }).then((r) => r.flow),
  cancelPullRequestFlow: (id: string) =>
    call<{ flow: PullRequestFlowSnapshot }>(`/pr-flows/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
    }).then((r) => r.flow),
  retryPullRequestFlow: (id: string) =>
    call<{ flow: PullRequestFlowSnapshot }>(`/pr-flows/${encodeURIComponent(id)}/retry`, {
      method: "POST",
    }).then((r) => r.flow),
  createSyncFlow: (input: CreateSyncFlowInput) =>
    call<{ flow: SyncFlowSnapshot }>("/sync-flows", {
      method: "POST",
      body: JSON.stringify(input),
    }).then((r) => r.flow),
  recordSyncFlowApplied: (id: string, input: SyncFlowAppliedInput) =>
    call<{ flow: SyncFlowSnapshot }>(`/sync-flows/${encodeURIComponent(id)}/applied`, {
      method: "POST",
      body: JSON.stringify(input),
    }).then((r) => r.flow),
  cancelSyncFlow: (id: string) =>
    call<{ flow: SyncFlowSnapshot }>(`/sync-flows/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
    }).then((r) => r.flow),
  history: (id: string) =>
    call<{ events: AgentEventEnvelope[] }>(`/agents/${id}/history`).then((r) => r.events),
  create: (settings: AgentSettings) =>
    call<{ id: string }>("/agents", {
      method: "POST",
      body: JSON.stringify(settings),
    }).then((r) => r.id),
  updateAgentSettings: (id: string, input: UpdateAgentSettingsInput) =>
    call<AgentSnapshot>(`/agents/${id}/settings`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  pickDirectory: (initialDirectory?: string) =>
    call<{ path: string | null }>("/directories/pick", {
      method: "POST",
      body: JSON.stringify({ initialDirectory }),
    }),
  start: (id: string, config: AgentStartConfig) =>
    call(`/agents/${id}/start`, { method: "POST", body: JSON.stringify(config) }),
  send: (id: string, text: string) =>
    call(`/agents/${id}/send`, { method: "POST", body: JSON.stringify({ text }) }),
  steer: (id: string, text: string) =>
    call(`/agents/${id}/steer`, { method: "POST", body: JSON.stringify({ text }) }),
  answerQuestion: (id: string, requestId: string, response: AgentQuestionResponse) =>
    call(`/agents/${id}/questions/${encodeURIComponent(requestId)}`, {
      method: "POST",
      body: JSON.stringify(response),
    }),
  answerApproval: (id: string, requestId: string, response: AgentApprovalResponse) =>
    call(`/agents/${id}/approvals/${encodeURIComponent(requestId)}`, {
      method: "POST",
      body: JSON.stringify(response),
    }),
  compact: (id: string) => call(`/agents/${id}/compact`, { method: "POST" }),
  stop: (id: string) => call(`/agents/${id}/stop`, { method: "POST" }),
  terminate: (id: string) => call(`/agents/${id}/terminate`, { method: "POST" }),
  openAgentWorkspace: (id: string) =>
    call<{ ok: true }>(`/agents/${encodeURIComponent(id)}/open-workspace`, {
      method: "POST",
    }),
  resume: (id: string, sessionId: string, text: string) =>
    call(`/agents/${id}/resume`, { method: "POST", body: JSON.stringify({ sessionId, text }) }),
  fork: (id: string, anchorUuid: string, options: Omit<ForkAgentInput, "anchorUuid"> = {}) =>
    call<{ id: string; origin: ForkOrigin }>(`/agents/${id}/fork`, {
      method: "POST",
      body: JSON.stringify({ anchorUuid, ...options }),
    }),
  listFiles: () => call<{ files: CanvasFileNode[] }>("/files").then((r) => r.files),
  createFile: (input: CreateCanvasFileInput) =>
    call<{ file: CanvasFileNode }>("/files", {
      method: "POST",
      body: JSON.stringify(input),
    }).then((r) => r.file),
  updateFile: (id: string, input: UpdateCanvasFileInput) =>
    call<{ file: CanvasFileNode }>(`/files/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }).then((r) => r.file),
  fileContent: (id: string) =>
    call<{ content: string; truncated: boolean }>(`/files/${id}/content`),
  fileFullContent: (id: string) =>
    call<{ content: string; truncated: false }>(`/files/${id}/content?full=1`),
  openFileInVscode: (id: string) =>
    call<{ ok: true }>(`/files/${encodeURIComponent(id)}/open`, { method: "POST" }),
  fileRawUrl: (id: string, version?: number) =>
    `${BASE}/files/${encodeURIComponent(id)}/raw${version ? `?v=${version}` : ""}`,
  listFileConnections: () =>
    call<{ connections: CanvasFileConnection[] }>("/file-connections").then(
      (r) => r.connections,
    ),
  connectFile: (fileId: string, agentId: string, access: FileConnectionAccess) =>
    call<{ connection: CanvasFileConnection }>("/file-connections", {
      method: "POST",
      body: JSON.stringify({ fileId, agentId, access }),
    }).then((r) => r.connection),
  disconnectFile: (id: string) =>
    call<void>(`/file-connections/${encodeURIComponent(id)}`, { method: "DELETE" }),
  listPrompts: () =>
    call<{ prompts: CanvasPromptNode[] }>("/prompts").then((r) => r.prompts),
  createPrompt: (input: CreateCanvasPromptInput) =>
    call<{ prompt: CanvasPromptNode }>("/prompts", {
      method: "POST",
      body: JSON.stringify(input),
    }).then((r) => r.prompt),
  updatePrompt: (id: string, input: UpdateCanvasPromptInput) =>
    call<{ prompt: CanvasPromptNode }>(`/prompts/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }).then((r) => r.prompt),
  listPromptConnections: () =>
    call<{ connections: CanvasPromptConnection[] }>("/prompt-connections").then(
      (r) => r.connections,
    ),
  connectPrompt: (
    promptId: string,
    agentId: string,
    access: PromptConnectionAccess,
  ) =>
    call<{ connection: CanvasPromptConnection }>("/prompt-connections", {
      method: "POST",
      body: JSON.stringify({ promptId, agentId, access }),
    }).then((r) => r.connection),
  disconnectPrompt: (id: string) =>
    call<void>(`/prompt-connections/${encodeURIComponent(id)}`, { method: "DELETE" }),
};
