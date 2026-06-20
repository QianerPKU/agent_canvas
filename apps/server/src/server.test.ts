import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentManager } from "./AgentManager.js";
import { createServer } from "./server.js";
import { FileManager } from "./files/FileManager.js";
import type { QueryFn } from "./sdk/types.js";

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

function request(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: data
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
          : {},
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
  const openFile = vi.fn<(filePath: string) => Promise<void>>().mockResolvedValue(undefined);

  beforeAll(async () => {
    const manager = new AgentManager({ query: emptyQuery });
    root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-server-"));
    const fileManager = new FileManager({
      workspaceRoot: root,
      isolatedRoot: path.join(root, "isolated"),
      resolveAgentCwd: () => root,
    });
    ({ httpServer: server } = createServer(manager, fileManager, { openFile }));
    await new Promise<void>((r) => server.listen(0, r));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await rm(root, { recursive: true, force: true });
  });

  it("GET /api/health → 200 ok", async () => {
    const { status, json } = await request(port, "GET", "/api/health");
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
  });

  it("POST /api/agents 新建，GET /api/agents 能列出", async () => {
    const created = await request(port, "POST", "/api/agents");
    expect(created.status).toBe(201);
    expect(created.json.id).toMatch(/^agent_/);

    const listed = await request(port, "GET", "/api/agents");
    expect(listed.status).toBe(200);
    expect(listed.json.agents.length).toBeGreaterThanOrEqual(1);
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
    expect(openFile).toHaveBeenCalledWith(updated.json.file.path);

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
});
