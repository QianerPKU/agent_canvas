import http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type {
  AgentStartConfig,
  ServerFrame,
} from "@agent-canvas/shared";
import { AgentManager } from "./AgentManager.js";

export interface CreateServerResult {
  httpServer: http.Server;
  wss: WebSocketServer;
  manager: AgentManager;
}

/**
 * 组装 HTTP（REST 命令）+ WebSocket（事件广播）服务。
 * 命令端到端：前端 POST /api/... → manager/runner；事件 runner → manager → WS。
 */
export function createServer(manager: AgentManager): CreateServerResult {
  const httpServer = http.createServer((req, res) => {
    handleHttp(req, res, manager).catch((err) => {
      sendJson(res, 500, { error: errMsg(err) });
    });
  });

  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
  wss.on("connection", (ws: WebSocket) => {
    // 连接即下发当前快照
    send(ws, { type: "hello", agents: manager.list() });
  });

  // 把 manager 的事件广播到所有 WS 客户端
  manager.onEvent((envelope) => {
    const frame: ServerFrame = { type: "event", envelope };
    const data = JSON.stringify(frame);
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send(data);
    }
  });

  return { httpServer, wss, manager };
}

async function handleHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  manager: AgentManager,
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

  if (method === "GET" && path === "/api/agents") {
    return sendJson(res, 200, { agents: manager.list() });
  }

  if (method === "POST" && path === "/api/agents") {
    const runner = manager.create();
    return sendJson(res, 201, { id: runner.id });
  }

  // /api/agents/:id(/action)
  const m = path.match(/^\/api\/agents\/([^/]+)(?:\/([^/]+))?$/);
  if (m) {
    const id = decodeURIComponent(m[1]!);
    const action = m[2];
    const runner = manager.get(id);
    if (!runner) return sendJson(res, 404, { error: `未知 agent: ${id}` });

    if (method === "GET" && !action) {
      return sendJson(res, 200, runner.snapshot());
    }
    if (method === "GET" && action === "history") {
      return sendJson(res, 200, { events: manager.historyOf(id) });
    }
    if (method === "POST" && action === "start") {
      const body = await readJson<AgentStartConfig>(req);
      if (!body?.prompt) return sendJson(res, 400, { error: "缺少 prompt" });
      manager.startAgent(id, body); // 若是 fork 产生的 agent，合并其 fork 配置
      return sendJson(res, 202, { ok: true });
    }
    if (method === "POST" && action === "fork") {
      const body = await readJson<{ anchorUuid?: string; model?: string }>(req);
      if (!body?.anchorUuid) return sendJson(res, 400, { error: "缺少 anchorUuid" });
      const forked = manager.fork(id, body.anchorUuid, body.model);
      if (!forked) return sendJson(res, 409, { error: "源会话尚未建立，无法 fork" });
      return sendJson(res, 201, { id: forked.id, origin: forked.origin });
    }
    if (method === "POST" && action === "send") {
      const body = await readJson<{ text?: string }>(req);
      if (!body?.text) return sendJson(res, 400, { error: "缺少 text" });
      runner.send(body.text);
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
  }

  sendJson(res, 404, { error: "not found" });
}

// ---- helpers ----

function setCors(res: http.ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
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
