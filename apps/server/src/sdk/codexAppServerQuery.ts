import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import type {
  AgentApprovalRequest,
  AgentApprovalResponse,
  AgentFileAccess,
  AgentPromptAccess,
  AgentQuestionItem,
  AgentQuestionOption,
  AgentQuestionRequest,
  AgentQuestionResponse,
} from "@agent-canvas/shared";
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
    client = new CodexAppServerClient(deps, options?.requestUserInput, options?.requestApproval);
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
        expectedTurnId: turnId,
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
        appendSharedResources(prependPromptContext(turn.text, turn.promptAccess), turn.fileAccess),
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

function appendSharedResources(
  text: string,
  fileAccess: AgentFileAccess | undefined,
): string {
  const resources = fileAccess?.sharedResources ?? [];
  if (resources.length === 0) return text;
  return `${text}\n\n共享映射资源（除非用户明确授权，否则 readOnly 资源不能修改）：\n${resources
    .map(
      (resource) =>
        `- ${resource.name} [${resource.access}]: ${resource.mountPath} -> ${resource.sourcePath}`,
    )
    .join("\n")}`;
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

function codexUserInputRequest(id: JsonRpcId, params: unknown): AgentQuestionRequest {
  const record = asRecord(params);
  return {
    requestId: `codex:${String(id)}`,
    kind: "ask_user_question",
    title: "Codex 需要确认",
    questions: arrayValue(record?.questions).map((question, index) =>
      codexQuestionItem(question, index),
    ),
    autoResolutionMs: numberOrNull(record?.autoResolutionMs),
  };
}

function codexQuestionItem(question: unknown, index: number): AgentQuestionItem {
  const record = asRecord(question);
  const id = stringValue(record?.id) || `question_${index + 1}`;
  return {
    id,
    header: stringValue(record?.header) || undefined,
    question: stringValue(record?.question) || id,
    options: arrayValue(record?.options).map(codexQuestionOption),
    multiSelect: false,
    isOther: booleanValue(record?.isOther),
    isSecret: booleanValue(record?.isSecret),
  };
}

function codexQuestionOption(option: unknown): AgentQuestionOption {
  const record = asRecord(option);
  return {
    label: stringValue(record?.label),
    description: stringValue(record?.description) || undefined,
  };
}

function codexUserInputResponse(response: AgentQuestionResponse): Record<string, unknown> {
  if (response.action === "decline" || response.action === "cancel") return { answers: {} };
  const answers: Record<string, { answers: string[] }> = {};
  for (const [id, value] of Object.entries(response.answers ?? {})) {
    answers[id] = {
      answers: Array.isArray(value) ? value.map(String) : [String(value)],
    };
  }
  return { answers };
}

function codexMcpElicitationRequest(id: JsonRpcId, params: unknown): AgentQuestionRequest {
  const record = asRecord(params);
  const mode = stringValue(record?.mode);
  const serverName = stringValue(record?.serverName);
  const message = stringValue(record?.message);
  const requestedSchema = record?.requestedSchema;
  return {
    requestId: `codex:${String(id)}`,
    kind: "mcp_elicitation",
    title: serverName ? `MCP: ${serverName}` : "MCP 需要输入",
    message,
    questions: questionsFromJsonSchema(requestedSchema),
    requestedSchema,
    url: mode === "url" ? stringValue(record?.url) || undefined : undefined,
  };
}

function codexMcpElicitationResponse(response: AgentQuestionResponse): Record<string, unknown> {
  const action = response.action ?? "accept";
  if (action !== "accept") return { action, content: null, _meta: null };
  return {
    action: "accept",
    content: response.content ?? response.answers ?? (response.response ? { response: response.response } : null),
    _meta: null,
  };
}

function codexCommandApprovalRequest(id: JsonRpcId, params: unknown): AgentApprovalRequest {
  const record = asRecord(params);
  const command = stringValue(record?.command);
  const reason = stringValue(record?.reason);
  return {
    requestId: `codex-approval:${String(id)}`,
    kind: "command",
    title: "Codex 请求执行命令",
    message: reason || undefined,
    command: command || undefined,
    cwd: stringValue(record?.cwd) || undefined,
    raw: params,
  };
}

function codexCommandApprovalResponse(
  response: AgentApprovalResponse,
): Record<string, unknown> {
  switch (response.action) {
    case "approve":
      return { decision: response.remember ? "acceptForSession" : "accept" };
    case "deny":
      return { decision: "decline" };
    case "cancel":
      return { decision: "cancel" };
  }
}

function codexFileChangeApprovalRequest(id: JsonRpcId, params: unknown): AgentApprovalRequest {
  const record = asRecord(params);
  const grantRoot = stringValue(record?.grantRoot);
  const reason = stringValue(record?.reason);
  return {
    requestId: `codex-approval:${String(id)}`,
    kind: "file_change",
    title: "Codex 请求修改文件",
    message: reason || undefined,
    fileChanges: grantRoot
      ? [{ path: grantRoot, status: "grantRoot", summary: "允许写入此目录" }]
      : [],
    raw: params,
  };
}

function codexFileChangeApprovalResponse(
  response: AgentApprovalResponse,
): Record<string, unknown> {
  switch (response.action) {
    case "approve":
      return { decision: response.remember ? "acceptForSession" : "accept" };
    case "deny":
      return { decision: "decline" };
    case "cancel":
      return { decision: "cancel" };
  }
}

function codexPermissionsApprovalRequest(id: JsonRpcId, params: unknown): AgentApprovalRequest {
  const record = asRecord(params);
  return {
    requestId: `codex-approval:${String(id)}`,
    kind: "permissions",
    title: "Codex 请求扩大权限",
    message: stringValue(record?.reason) || undefined,
    cwd: stringValue(record?.cwd) || undefined,
    permissions: record?.permissions,
    raw: params,
  };
}

function codexPermissionsApprovalResponse(
  response: AgentApprovalResponse,
  params: unknown,
): Record<string, unknown> {
  if (response.action !== "approve") {
    return { permissions: {}, scope: "turn" };
  }
  const permissions = asRecord(params)?.permissions;
  return {
    permissions: permissions ?? {},
    scope: response.remember ? "session" : "turn",
  };
}

function questionsFromJsonSchema(schema: unknown): AgentQuestionItem[] {
  const root = asRecord(schema);
  const properties = asRecord(root?.properties);
  if (!properties) return [];
  return Object.entries(properties).map(([id, property]) => {
    const record = asRecord(property);
    return {
      id,
      header: stringValue(record?.title) || id,
      question: stringValue(record?.description) || stringValue(record?.title) || id,
      options: enumOptions(record),
      multiSelect: stringValue(record?.type) === "array",
      isOther: false,
      isSecret: stringValue(record?.format) === "password",
    };
  });
}

function enumOptions(record: Record<string, unknown> | undefined): AgentQuestionOption[] {
  if (!record) return [];
  const values = arrayValue(record.enum);
  if (values.length === 0) return [];
  return values.map((value) => {
    const label = String(value);
    return { label, description: label };
  });
}

class CodexAppServerClient {
  private readonly command: string;
  private readonly spawnFn: typeof spawn;
  private readonly requestUserInput?: QueryOptions["requestUserInput"];
  private readonly requestApproval?: QueryOptions["requestApproval"];
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly notifications = new AsyncMessageQueue<JsonRpcMessage>();
  private proc?: ChildProcessWithoutNullStreams;
  private rl?: readline.Interface;
  private nextId = 0;
  private closed = false;
  private stderrTail = "";

  constructor(
    deps: CodexAppServerQueryDeps,
    requestUserInput: QueryOptions["requestUserInput"] | undefined,
    requestApproval: QueryOptions["requestApproval"] | undefined,
  ) {
    this.command = deps.command ?? "codex";
    this.spawnFn = deps.spawnFn ?? spawn;
    this.requestUserInput = requestUserInput;
    this.requestApproval = requestApproval;
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
      void this.respondToServerRequest(message);
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

  private async respondToServerRequest(message: JsonRpcMessage): Promise<void> {
    const id = message.id;
    if (id === undefined) return;
    switch (message.method) {
      case "item/commandExecution/requestApproval":
        await this.respondToCommandApprovalRequest(id, message.params);
        break;
      case "item/fileChange/requestApproval":
        await this.respondToFileChangeApprovalRequest(id, message.params);
        break;
      case "item/permissions/requestApproval":
        await this.respondToPermissionsApprovalRequest(id, message.params);
        break;
      case "item/tool/requestUserInput":
        await this.respondToUserInputRequest(id, message.params);
        break;
      case "mcpServer/elicitation/request":
        await this.respondToMcpElicitationRequest(id, message.params);
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

  private async respondToCommandApprovalRequest(id: JsonRpcId, params: unknown): Promise<void> {
    if (!this.requestApproval) {
      this.writeApprovalHandlerMissing(id);
      return;
    }
    try {
      const request = codexCommandApprovalRequest(id, params);
      const response = await this.requestApproval(request);
      this.write({ id, result: codexCommandApprovalResponse(response) });
    } catch (error) {
      this.writeRequestError(id, error);
    }
  }

  private async respondToFileChangeApprovalRequest(id: JsonRpcId, params: unknown): Promise<void> {
    if (!this.requestApproval) {
      this.writeApprovalHandlerMissing(id);
      return;
    }
    try {
      const request = codexFileChangeApprovalRequest(id, params);
      const response = await this.requestApproval(request);
      this.write({ id, result: codexFileChangeApprovalResponse(response) });
    } catch (error) {
      this.writeRequestError(id, error);
    }
  }

  private async respondToPermissionsApprovalRequest(id: JsonRpcId, params: unknown): Promise<void> {
    if (!this.requestApproval) {
      this.writeApprovalHandlerMissing(id);
      return;
    }
    try {
      const request = codexPermissionsApprovalRequest(id, params);
      const response = await this.requestApproval(request);
      this.write({ id, result: codexPermissionsApprovalResponse(response, params) });
    } catch (error) {
      this.writeRequestError(id, error);
    }
  }

  private async respondToUserInputRequest(id: JsonRpcId, params: unknown): Promise<void> {
    if (!this.requestUserInput) {
      this.write({
        id,
        error: { code: -32000, message: "Agent Canvas user input handler is not available." },
      });
      return;
    }
    try {
      const request = codexUserInputRequest(id, params);
      const response = await this.requestUserInput(request);
      this.write({ id, result: codexUserInputResponse(response) });
    } catch (error) {
      this.writeRequestError(id, error);
    }
  }

  private async respondToMcpElicitationRequest(id: JsonRpcId, params: unknown): Promise<void> {
    if (!this.requestUserInput) {
      this.write({
        id,
        error: { code: -32000, message: "Agent Canvas user input handler is not available." },
      });
      return;
    }
    try {
      const request = codexMcpElicitationRequest(id, params);
      const response = await this.requestUserInput(request);
      this.write({ id, result: codexMcpElicitationResponse(response) });
    } catch (error) {
      this.writeRequestError(id, error);
    }
  }

  private writeApprovalHandlerMissing(id: JsonRpcId): void {
    this.write({
      id,
      error: { code: -32000, message: "Agent Canvas approval handler is not available." },
    });
  }

  private writeRequestError(id: JsonRpcId, error: unknown): void {
    this.write({
      id,
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : String(error),
      },
    });
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

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function booleanValue(value: unknown): boolean {
  return typeof value === "boolean" ? value : false;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}
