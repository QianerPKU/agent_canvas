/** 后端 REST 命令客户端。事件走 WebSocket，命令走这里。 */
import type {
  AgentEventEnvelope,
  AgentSnapshot,
  AgentStartConfig,
  CanvasFileConnection,
  CanvasFileNode,
  CanvasPromptConnection,
  CanvasPromptNode,
  CreateCanvasFileInput,
  CreateCanvasPromptInput,
  FileConnectionAccess,
  ForkOrigin,
  PromptConnectionAccess,
  UpdateCanvasFileInput,
  UpdateCanvasPromptInput,
} from "@agent-canvas/shared";

const BASE = "/api";

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${text}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  list: () => call<{ agents: AgentSnapshot[] }>("/agents").then((r) => r.agents),
  history: (id: string) =>
    call<{ events: AgentEventEnvelope[] }>(`/agents/${id}/history`).then((r) => r.events),
  create: () => call<{ id: string }>("/agents", { method: "POST" }).then((r) => r.id),
  start: (id: string, config: AgentStartConfig) =>
    call(`/agents/${id}/start`, { method: "POST", body: JSON.stringify(config) }),
  send: (id: string, text: string) =>
    call(`/agents/${id}/send`, { method: "POST", body: JSON.stringify({ text }) }),
  compact: (id: string) => call(`/agents/${id}/compact`, { method: "POST" }),
  stop: (id: string) => call(`/agents/${id}/stop`, { method: "POST" }),
  terminate: (id: string) => call(`/agents/${id}/terminate`, { method: "POST" }),
  resume: (id: string, sessionId: string, text: string) =>
    call(`/agents/${id}/resume`, { method: "POST", body: JSON.stringify({ sessionId, text }) }),
  fork: (id: string, anchorUuid: string, model?: string) =>
    call<{ id: string; origin: ForkOrigin }>(`/agents/${id}/fork`, {
      method: "POST",
      body: JSON.stringify({ anchorUuid, model }),
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
