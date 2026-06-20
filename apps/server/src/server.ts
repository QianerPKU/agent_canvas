import http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type {
  AgentStartConfig,
  CreateCanvasFileInput,
  CreateCanvasPromptInput,
  ServerFrame,
  UpdateCanvasFileInput,
  UpdateCanvasPromptInput,
} from "@agent-canvas/shared";
import { AgentManager } from "./AgentManager.js";
import { FileManager } from "./files/FileManager.js";
import { openFileInVscode } from "./files/VscodeFileOpener.js";
import { PromptManager } from "./prompts/PromptManager.js";

export interface CreateServerResult {
  httpServer: http.Server;
  wss: WebSocketServer;
  manager: AgentManager;
  fileManager: FileManager;
  promptManager: PromptManager;
}

export interface CreateServerOptions {
  openFile?: (filePath: string) => Promise<void>;
  promptManager?: PromptManager;
}

/**
 * 组装 HTTP（REST 命令）+ WebSocket（事件广播）服务。
 * 命令端到端：前端 POST /api/... → manager/runner；事件 runner → manager → WS。
 */
export function createServer(
  manager: AgentManager,
  fileManager = new FileManager({
    resolveAgentCwd: (agentId) => manager.get(agentId)?.snapshot().config?.cwd,
  }),
  options: CreateServerOptions = {},
): CreateServerResult {
  manager.setFileAccessResolver((agentId) => fileManager.accessFor(agentId));
  const promptManager =
    options.promptManager ??
    new PromptManager({
      workspaceRoot: process.cwd(),
    });
  manager.setPromptAccessResolver((agentId) => promptManager.accessFor(agentId));
  const httpServer = http.createServer((req, res) => {
    handleHttp(
      req,
      res,
      manager,
      fileManager,
      promptManager,
      options.openFile ?? openFileInVscode,
    ).catch((err) => {
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

  return { httpServer, wss, manager, fileManager, promptManager };
}

async function handleHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  manager: AgentManager,
  fileManager: FileManager,
  promptManager: PromptManager,
  openFile: (filePath: string) => Promise<void>,
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

  if (method === "GET" && path === "/api/files") {
    return sendJson(res, 200, { files: fileManager.list() });
  }

  if (method === "POST" && path === "/api/files") {
    const body = await readJson<CreateCanvasFileInput>(req);
    if (
      !body?.name ||
      !["agent", "isolated"].includes(body.storage) ||
      !["normal", "shared"].includes(body.kind)
    ) {
      return sendJson(res, 400, { error: "缺少文件名、存储位置或节点类型" });
    }
    if (body.storage === "agent" && (!body.agentId || !manager.get(body.agentId))) {
      return sendJson(res, 400, { error: "请选择有效的 agent 工作目录" });
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
      fileManager.copyAgentConnections(id, forked.id);
      promptManager.copyAgentConnections(id, forked.id);
      return sendJson(res, 201, { id: forked.id, origin: forked.origin });
    }
    if (method === "POST" && action === "send") {
      const body = await readJson<{ text?: string }>(req);
      if (!body?.text) return sendJson(res, 400, { error: "缺少 text" });
      runner.send(body.text);
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
