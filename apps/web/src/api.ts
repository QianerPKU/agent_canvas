/** 后端 REST 命令客户端。事件走 WebSocket，命令走这里。 */
import type { AgentSnapshot, AgentStartConfig, ForkOrigin } from "@agent-canvas/shared";

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
};
