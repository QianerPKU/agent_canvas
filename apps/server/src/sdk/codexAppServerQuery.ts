import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import type { AgentFileAccess, AgentPromptAccess } from "@agent-canvas/shared";
import { AsyncMessageQueue } from "../util/AsyncMessageQueue.js";
import {
  createCodexAppServerMapState,
  mapCodexNotification,
  mapCodexThreadInit,
} from "./codexAppServerMapper.js";
import type {
  QueryFn,
  QueryHandle,
  QueryOptions,
  QueryPrompt,
  SdkMessage,
  SdkUserInput,
} from "./types.js";

type JsonRpcId = number | string;

interface JsonRpcMessage {
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string; code?: number };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export interface CodexAppServerQueryDeps {
  command?: string;
  spawnFn?: typeof spawn;
}

export function createCodexAppServerQuery(
  deps: CodexAppServerQueryDeps = {},
): QueryFn {
  return ({ prompt, options }) => createHandle(prompt, options, deps);
}

export const realCodexQuery: QueryFn = createCodexAppServerQuery();

function createHandle(
  prompt: QueryPrompt,
  options: QueryOptions | undefined,
  deps: CodexAppServerQueryDeps,
): QueryHandle {
  let client: CodexAppServerClient | undefined;
  let threadId: string | undefined;
  let turnId: string | undefined;

  const run = async function* (): AsyncGenerator<SdkMessage> {
    client = new CodexAppServerClient(deps);
    await client.start();

    const state = createCodexAppServerMapState();
    try {
      const promptIterator = promptTurns(prompt)[Symbol.asyncIterator]();
      const first = await promptIterator.next();
      if (first.done) return;

      const initResult = await openThread(client, options);
      const initMessage = mapCodexThreadInit(initResult, options);
      threadId = (initMessage as { session_id?: string }).session_id ?? "";
      state.threadId = threadId;
      yield initMessage;

      let next: IteratorResult<PromptTurn> = first;
      while (!next.done) {
        if (next.value.text.trim() === "/compact") {
          await client.request("thread/compact/start", { threadId });
          yield* client.readCompactMessages(threadId);
        } else {
          const started = await client.request("turn/start", {
            ...turnOverrides(options, next.value.fileAccess, next.value.promptAccess),
            threadId,
            input: codexInputs(next.value),
          });
          turnId = stringValue(asRecord(asRecord(started)?.turn)?.id);
          yield* client.readTurnMessages(threadId, turnId, state);
          turnId = undefined;
        }
        next = await promptIterator.next();
      }
    } finally {
      client.close();
    }
  };

  const iterator = run();
  return {
    [Symbol.asyncIterator]: () => iterator,
    interrupt: async () => {
      if (client && threadId && turnId) {
        void client.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
      }
      client?.close();
    },
    steer: async (input) => {
      if (!client || !threadId || !turnId) {
        throw new Error("Codex turn is not active");
      }
      await client.request("turn/steer", {
        threadId,
        input: codexInputs({
          text: inputText(input),
          fileAccess: input.fileAccess,
          promptAccess: input.promptAccess,
        }),
      });
    },
    terminate: async () => {
      client?.close();
      await iterator.return(undefined).catch(() => undefined);
    },
  };
}

async function openThread(
  client: CodexAppServerClient,
  options: QueryOptions | undefined,
): Promise<unknown> {
  const params = threadParams(options);
  const sourceThreadId = stringValue(options?.resume);
  if (options?.forkSession && sourceThreadId) {
    return client.request("thread/fork", { ...params, threadId: sourceThreadId });
  }
  if (sourceThreadId) {
    return client.request("thread/resume", { ...params, threadId: sourceThreadId });
  }
  return client.request("thread/start", params);
}

function threadParams(options: QueryOptions | undefined): Record<string, unknown> {
  const params: Record<string, unknown> = {
    model: options?.model ?? null,
    cwd: options?.cwd ?? null,
    threadSource: "appServer",
  };
  const sandbox = sandboxMode(options?.permissionMode);
  const approvalPolicy = approvalPolicyFor(options?.permissionMode);
  if (sandbox) params.sandbox = sandbox;
  if (approvalPolicy) params.approvalPolicy = approvalPolicy;
  if (typeof options?.systemPrompt === "string") params.baseInstructions = options.systemPrompt;
  return params;
}

function turnOverrides(
  options: QueryOptions | undefined,
  fileAccess: AgentFileAccess | undefined,
  promptAccess: AgentPromptAccess | undefined,
): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  const writableDirectories = [
    ...new Set([
      ...(fileAccess?.writableDirectories ?? options?.fileAccess?.writableDirectories ?? []),
      ...(promptAccess?.writableDirectories ??
        options?.promptAccess?.writableDirectories ??
        []),
    ]),
  ];
  const approvalPolicy = approvalPolicyFor(
    options?.permissionMode,
    writableDirectories.length > 0,
  );
  if (approvalPolicy) params.approvalPolicy = approvalPolicy;
  if (options?.model) params.model = options.model;
  const sandboxPolicy = sandboxPolicyFor(
    options?.permissionMode,
    options?.cwd,
    writableDirectories,
  );
  if (sandboxPolicy) params.sandboxPolicy = sandboxPolicy;
  return params;
}

function approvalPolicyFor(
  permissionMode: unknown,
  hasWritableFiles = false,
): string | undefined {
  switch (permissionMode) {
    case "acceptEdits":
    case "bypassPermissions":
      return "never";
    default:
      return hasWritableFiles ? "never" : undefined;
  }
}

function sandboxMode(permissionMode: unknown): string | undefined {
  switch (permissionMode) {
    case "acceptEdits":
      return "workspace-write";
    case "bypassPermissions":
      return "danger-full-access";
    case "plan":
      return "read-only";
    default:
      return undefined;
  }
}

interface PromptTurn {
  text: string;
  fileAccess?: AgentFileAccess;
  promptAccess?: AgentPromptAccess;
}

async function* promptTurns(prompt: QueryPrompt): AsyncGenerator<PromptTurn> {
  if (typeof prompt === "string") {
    yield { text: prompt };
    return;
  }
  for await (const input of prompt) {
    yield {
      text: inputText(input),
      fileAccess: input.fileAccess,
      promptAccess: input.promptAccess,
    };
  }
}

function codexInputs(turn: PromptTurn): Record<string, unknown>[] {
  const inputs: Record<string, unknown>[] = [
    {
      type: "text",
      text: appendWritableTargets(
        prependPromptContext(turn.text, turn.promptAccess),
        turn.fileAccess,
        turn.promptAccess,
      ),
      text_elements: [],
    },
  ];
  for (const file of turn.fileAccess?.readableFiles ?? []) {
    inputs.push(
      file.previewKind === "image"
        ? { type: "localImage", path: file.path }
        : { type: "mention", name: file.name, path: file.path },
    );
  }
  return inputs;
}

function appendWritableTargets(
  text: string,
  fileAccess: AgentFileAccess | undefined,
  promptAccess: AgentPromptAccess | undefined,
): string {
  const writableFiles = fileAccess?.writableFiles ?? [];
  const withFiles =
    writableFiles.length === 0
      ? text
      : `${text}\n\n可写的画布文件（作为输出目标）：\n${writableFiles
          .map((file) => `- ${file.path}`)
          .join("\n")}`;
  const writablePrompts = promptAccess?.writablePrompts ?? [];
  if (writablePrompts.length === 0) return withFiles;
  return `${withFiles}\n\n可写的提示词节点（修改对应文本文件）：\n${writablePrompts
    .map((prompt) => `- ${prompt.name}: ${prompt.path}`)
    .join("\n")}`;
}

function prependPromptContext(text: string, access: AgentPromptAccess | undefined): string {
  const prompts = access?.readablePrompts.map((prompt) => prompt.content) ?? [];
  return prompts.length === 0 ? text : `${prompts.join("\n\n")}\n\n${text}`;
}

function sandboxPolicyFor(
  permissionMode: unknown,
  cwd: string | undefined,
  writableDirectories: string[],
): Record<string, unknown> | undefined {
  if (permissionMode === "bypassPermissions") return { type: "dangerFullAccess" };
  if (permissionMode === "plan") {
    return { type: "readOnly", networkAccess: false };
  }
  if (permissionMode !== "acceptEdits" && writableDirectories.length === 0) {
    return undefined;
  }
  const writableRoots = [
    path.resolve(cwd ?? process.cwd()),
    ...writableDirectories.map((directory) => path.resolve(directory)),
  ];
  return {
    type: "workspaceWrite",
    writableRoots: [...new Set(writableRoots)],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function inputText(input: SdkUserInput): string {
  const content = input.message.content;
  if (typeof content === "string") return content;
  return content
    .map((block) => {
      if (block.type === "text" && typeof (block as { text?: unknown }).text === "string") {
        return (block as { text: string }).text;
      }
      return JSON.stringify(block);
    })
    .join("\n");
}

class CodexAppServerClient {
  private readonly command: string;
  private readonly spawnFn: typeof spawn;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly notifications = new AsyncMessageQueue<JsonRpcMessage>();
  private proc?: ChildProcessWithoutNullStreams;
  private rl?: readline.Interface;
  private nextId = 0;
  private closed = false;
  private stderrTail = "";

  constructor(deps: CodexAppServerQueryDeps) {
    this.command = deps.command ?? "codex";
    this.spawnFn = deps.spawnFn ?? spawn;
  }

  async start(): Promise<void> {
    this.proc = this.spawnFn(this.command, ["app-server", "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.proc.once("exit", (code, signal) => this.onExit(code, signal));
    this.proc.once("error", (err) => this.onProcessError(err));
    this.proc.stderr.on("data", (chunk: Buffer) => this.rememberStderr(chunk.toString("utf-8")));
    this.rl = readline.createInterface({ input: this.proc.stdout });
    this.rl.on("line", (line) => this.onLine(line));

    await this.request("initialize", {
      clientInfo: {
        name: "agent_canvas",
        title: "agent_canvas",
        version: "0.0.1",
      },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized", {});
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.closed || !this.proc?.stdin.writable) {
      return Promise.reject(new Error("Codex app-server is not running"));
    }
    const id = ++this.nextId;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.write({ id, method, params });
    return promise;
  }

  notify(method: string, params: unknown): void {
    if (this.closed || !this.proc?.stdin.writable) return;
    this.write({ method, params });
  }

  async *readTurnMessages(
    threadId: string,
    turnId: string,
    state: ReturnType<typeof createCodexAppServerMapState>,
  ): AsyncGenerator<SdkMessage> {
    const iterator = this.notifications[Symbol.asyncIterator]();
    while (true) {
      const next = await iterator.next();
      if (next.done) {
        throw new Error(`Codex app-server exited before turn completed${this.stderrSuffix()}`);
      }
      const msg = next.value;
      if (!belongsToTurn(msg, threadId, turnId)) continue;
      for (const mapped of mapCodexNotification(msg, state)) {
        yield mapped;
      }
      if (isTurnCompleted(msg, threadId, turnId)) return;
    }
  }

  async *readCompactMessages(threadId: string): AsyncGenerator<SdkMessage> {
    const iterator = this.notifications[Symbol.asyncIterator]();
    let compactTurnId = "";
    let emittedBoundary = false;
    while (true) {
      const next = await iterator.next();
      if (next.done) {
        throw new Error(`Codex app-server exited before compact completed${this.stderrSuffix()}`);
      }
      const msg = next.value;
      const params = asRecord(msg.params);
      if (stringValue(params?.threadId) !== threadId) continue;

      if (msg.method === "turn/started") {
        compactTurnId = stringValue(asRecord(params?.turn)?.id);
      }

      if (isContextCompactionCompleted(msg)) {
        emittedBoundary = true;
        yield {
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: { trigger: "manual" },
          uuid: stringValue(asRecord(params?.item)?.id) || `compact-${Date.now()}`,
          session_id: threadId,
        };
      }

      if (msg.method === "error") {
        const error = asRecord(params?.error);
        throw new Error(stringValue(error?.message) || "Codex compact failed");
      }

      if (
        msg.method === "turn/completed" &&
        (!compactTurnId || stringValue(asRecord(params?.turn)?.id) === compactTurnId)
      ) {
        if (!emittedBoundary) {
          yield {
            type: "system",
            subtype: "compact_boundary",
            compact_metadata: { trigger: "manual" },
            uuid: `compact-${Date.now()}`,
            session_id: threadId,
          };
        }
        return;
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.rl?.close();
    this.notifications.close();
    this.rejectPending(new Error("Codex app-server closed"));
    try {
      this.proc?.stdin.end();
    } catch {
      // ignore
    }
    if (this.proc && this.proc.exitCode === null) {
      this.proc.kill();
    }
  }

  private write(message: JsonRpcMessage): void {
    this.proc?.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      this.rememberStderr(line);
      return;
    }

    if (message.method && message.id !== undefined) {
      this.respondToServerRequest(message);
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? `Codex request failed: ${message.id}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method) {
      this.notifications.push(message);
    }
  }

  private respondToServerRequest(message: JsonRpcMessage): void {
    const id = message.id;
    if (id === undefined) return;
    switch (message.method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        this.write({ id, result: { decision: "decline" } });
        break;
      case "item/permissions/requestApproval":
        this.write({ id, result: { permissions: {}, scope: "turn" } });
        break;
      case "item/tool/requestUserInput":
        this.write({ id, result: { answers: {} } });
        break;
      case "mcpServer/elicitation/request":
        this.write({ id, result: { action: "decline", content: null, _meta: null } });
        break;
      case "item/tool/call":
        this.write({
          id,
          result: {
            contentItems: [{ type: "inputText", text: "Unsupported by agent_canvas." }],
            success: false,
          },
        });
        break;
      default:
        this.write({
          id,
          error: { code: -32000, message: `Unsupported app-server request: ${message.method}` },
        });
    }
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closed) return;
    this.closed = true;
    this.notifications.close();
    const err = new Error(
      `Codex app-server exited (${signal ?? code ?? "unknown"})${this.stderrSuffix()}`,
    );
    this.rejectPending(err);
  }

  private onProcessError(err: Error): void {
    this.rejectPending(err);
    this.notifications.close();
  }

  private rejectPending(err: Error): void {
    for (const pending of this.pending.values()) pending.reject(err);
    this.pending.clear();
  }

  private rememberStderr(text: string): void {
    this.stderrTail = (this.stderrTail + text).slice(-4000);
  }

  private stderrSuffix(): string {
    const tail = this.stderrTail.trim();
    return tail ? `: ${tail}` : "";
  }
}

function isTurnCompleted(message: JsonRpcMessage, threadId: string, turnId: string): boolean {
  if (message.method !== "turn/completed") return false;
  const params = asRecord(message.params);
  const turn = asRecord(params?.turn);
  return stringValue(params?.threadId) === threadId && stringValue(turn?.id) === turnId;
}

function belongsToTurn(message: JsonRpcMessage, threadId: string, turnId: string): boolean {
  const params = asRecord(message.params);
  const messageThreadId = stringValue(params?.threadId);
  const messageTurnId =
    stringValue(params?.turnId) || stringValue(asRecord(params?.turn)?.id);
  if (messageThreadId && messageThreadId !== threadId) return false;
  if (messageTurnId && messageTurnId !== turnId) return false;
  return true;
}

function isContextCompactionCompleted(message: JsonRpcMessage): boolean {
  if (message.method !== "item/completed") return false;
  return stringValue(asRecord(asRecord(message.params)?.item)?.type) === "contextCompaction";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
