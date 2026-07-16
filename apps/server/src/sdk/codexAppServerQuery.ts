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

interface TurnSecurityDefaults {
  approvalPolicy?: unknown;
  sandboxPolicy?: Record<string, unknown>;
}

interface TurnOverrides {
  params: Record<string, unknown>;
  restoreSecurity: boolean;
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
  let currentModel = options?.model;
  let currentReasoningEffort = stringValue(options?.reasoningEffort);

  const run = async function* (): AsyncGenerator<SdkMessage> {
    client = new CodexAppServerClient(deps, options?.requestUserInput, options?.requestApproval);
    await client.start();

    const state = createCodexAppServerMapState();
    try {
      const promptIterator = promptTurns(prompt)[Symbol.asyncIterator]();
      const first = await promptIterator.next();
      if (first.done) return;

      const initResult = await openThread(client, options, currentModel);
      const initMessage = mapCodexThreadInit(initResult, { ...options, model: currentModel });
      threadId = (initMessage as { session_id?: string }).session_id ?? "";
      state.threadId = threadId;
      const securityDefaults = turnSecurityDefaults(initResult, options);
      yield initMessage;

      let next: IteratorResult<PromptTurn> = first;
      let securityRestoreCapabilityProbed = false;
      while (!next.done) {
        if (next.value.text.trim() === "/compact") {
          await client.request("thread/compact/start", { threadId });
          yield* client.readCompactMessages(threadId);
        } else {
          const overrides = turnOverrides(
            options,
            currentModel,
            next.value.fileAccess,
            next.value.promptAccess,
            securityDefaults,
          );
          if (overrides.restoreSecurity && !securityRestoreCapabilityProbed) {
            await client.request("thread/settings/update", { threadId });
            securityRestoreCapabilityProbed = true;
          }
          let completedMessage: SdkMessage | undefined;
          try {
            let started: unknown;
            try {
              started = await client.request("turn/start", {
                ...overrides.params,
                ...reasoningOverride(currentReasoningEffort),
                threadId,
                input: codexInputs(next.value),
              });
            } catch (startError) {
              if (overrides.restoreSecurity) {
                try {
                  await restoreSecurityDefaults(client, threadId, undefined, securityDefaults);
                } catch (restoreError) {
                  throw new AggregateError(
                    [asError(startError), asError(restoreError)],
                    "Codex turn/start failed and thread security defaults could not be restored",
                  );
                }
              }
              throw startError;
            }
            turnId = stringValue(asRecord(asRecord(started)?.turn)?.id);
            if (overrides.restoreSecurity) {
              await restoreSecurityDefaults(client, threadId, turnId, securityDefaults);
            }
            for await (const message of client.readTurnMessages(threadId, turnId, state)) {
              if (message.type === "result") completedMessage = message;
              else yield message;
            }
          } finally {
            turnId = undefined;
          }
          if (completedMessage) yield completedMessage;
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
        await client.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
      }
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
    setModel: async (model) => {
      currentModel = model;
    },
    setReasoningEffort: async (reasoningEffort) => {
      currentReasoningEffort = stringValue(reasoningEffort);
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
  model: string | undefined,
): Promise<unknown> {
  const params = threadParams(options, model);
  const sourceThreadId = stringValue(options?.resume);
  if (options?.forkSession && sourceThreadId) {
    return client.request("thread/fork", { ...params, threadId: sourceThreadId });
  }
  if (sourceThreadId) {
    return client.request("thread/resume", { ...params, threadId: sourceThreadId });
  }
  return client.request("thread/start", params);
}

function threadParams(
  options: QueryOptions | undefined,
  model: string | undefined,
): Record<string, unknown> {
  const params: Record<string, unknown> = {
    model: model ?? null,
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
  model: string | undefined,
  fileAccess: AgentFileAccess | undefined,
  promptAccess: AgentPromptAccess | undefined,
  securityDefaults: TurnSecurityDefaults,
): TurnOverrides {
  const params: Record<string, unknown> = {};
  const approvalExemptWritableDirectories = [
    ...new Set([
      ...(fileAccess?.writableDirectories ?? options?.fileAccess?.writableDirectories ?? []),
      ...(promptAccess?.writableDirectories ??
        options?.promptAccess?.writableDirectories ??
        []),
    ]),
  ];
  const writableDirectories = [
    ...new Set([
      ...approvalExemptWritableDirectories,
      ...(fileAccess
        ? fileAccess.sandboxWritableDirectories ?? []
        : options?.fileAccess?.sandboxWritableDirectories ?? []),
    ]),
  ];
  const supportsWritableOverrides = canUseWritableOverrides(
    securityDefaults.sandboxPolicy,
  );
  const approvalOverride = turnApprovalPolicy(
    securityDefaults.approvalPolicy,
    approvalExemptWritableDirectories.length > 0,
    supportsWritableOverrides,
  );
  if (approvalOverride.policy !== undefined) {
    params.approvalPolicy = approvalOverride.policy;
  }
  if (model) params.model = model;
  const sandboxOverride = turnSandboxPolicy(
    securityDefaults.sandboxPolicy,
    writableDirectories,
  );
  if (sandboxOverride.policy) params.sandboxPolicy = sandboxOverride.policy;
  return {
    params,
    restoreSecurity: approvalOverride.changed || sandboxOverride.changed,
  };
}

function turnSecurityDefaults(
  initResult: unknown,
  options: QueryOptions | undefined,
): TurnSecurityDefaults {
  const result = asRecord(initResult);
  const thread = asRecord(result?.thread);
  const responseSandbox = sandboxPolicyValue(result?.sandbox ?? thread?.sandbox);
  const responseApproval = ownValue(result, "approvalPolicy") ?? ownValue(thread, "approvalPolicy");
  return {
    sandboxPolicy:
      responseSandbox ?? explicitSandboxPolicyFor(options?.permissionMode),
    approvalPolicy:
      responseApproval ?? explicitApprovalPolicyFor(options?.permissionMode),
  };
}

function securityDefaultParams(defaults: TurnSecurityDefaults): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (defaults.approvalPolicy !== undefined) {
    params.approvalPolicy = defaults.approvalPolicy;
  }
  if (defaults.sandboxPolicy) params.sandboxPolicy = defaults.sandboxPolicy;
  return params;
}

async function restoreSecurityDefaults(
  client: CodexAppServerClient,
  threadId: string,
  activeTurnId: string | undefined,
  defaults: TurnSecurityDefaults,
): Promise<void> {
  const params = { threadId, ...securityDefaultParams(defaults) };
  try {
    await client.request("thread/settings/update", params);
    return;
  } catch (initialRestoreError) {
    const recoveryErrors = [asError(initialRestoreError)];
    if (activeTurnId) {
      try {
        await client.request("turn/interrupt", { threadId, turnId: activeTurnId });
      } catch (interruptError) {
        recoveryErrors.push(asError(interruptError));
      }
    }
    let restoredOnRetry = false;
    try {
      await client.request("thread/settings/update", params);
      restoredOnRetry = true;
    } catch (retryRestoreError) {
      recoveryErrors.push(asError(retryRestoreError));
    }
    throw new AggregateError(
      recoveryErrors,
      restoredOnRetry
        ? "Codex thread security restore initially failed; the active turn was stopped and defaults were restored on retry"
        : "Codex thread security defaults could not be restored after retry",
    );
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function reasoningOverride(reasoningEffort: string): Record<string, unknown> {
  return reasoningEffort ? { effort: reasoningEffort } : {};
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

function explicitApprovalPolicyFor(permissionMode: unknown): string | undefined {
  return approvalPolicyFor(permissionMode);
}

function turnApprovalPolicy(
  securityDefault: unknown,
  hasApprovalExemptWritableDirectories: boolean,
  supportsWritableOverrides: boolean,
): { policy?: unknown; changed: boolean } {
  if (securityDefault === undefined) {
    // An older app-server may not report its effective policy. In that case,
    // do not create a sticky override that cannot be restored exactly.
    return { changed: false };
  }
  const policy =
    hasApprovalExemptWritableDirectories && supportsWritableOverrides
      ? "never"
      : securityDefault;
  return {
    policy,
    changed:
      hasApprovalExemptWritableDirectories &&
      supportsWritableOverrides &&
      !sameJsonValue(policy, securityDefault),
  };
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

function turnSandboxPolicy(
  securityDefault: Record<string, unknown> | undefined,
  writableDirectories: string[],
): { policy?: Record<string, unknown>; changed: boolean } {
  if (!securityDefault) {
    // Preserve unknown user configuration instead of guessing a replacement.
    return { changed: false };
  }
  const type = sandboxPolicyType(securityDefault);
  if (
    writableDirectories.length === 0 ||
    type === "dangerFullAccess" ||
    type === "externalSandbox"
  ) {
    return { policy: securityDefault, changed: false };
  }
  if (type === "workspaceWrite") {
    const writableRoots = arrayValue(securityDefault.writableRoots).filter(
      (root): root is string => typeof root === "string",
    );
    const extendedRoots = [
      ...new Set([
        ...writableRoots,
        ...writableDirectories.map((directory) => path.resolve(directory)),
      ]),
    ];
    if (extendedRoots.length === writableRoots.length) {
      return { policy: securityDefault, changed: false };
    }
    return {
      policy: { ...securityDefault, writableRoots: extendedRoots },
      changed: true,
    };
  }
  // workspaceWrite always grants the entire cwd. Never use it to satisfy a
  // narrower file/directory grant when the original sandbox was read-only.
  return { policy: securityDefault, changed: false };
}

function canUseWritableOverrides(
  securityDefault: Record<string, unknown> | undefined,
): boolean {
  if (!securityDefault) return false;
  const type = sandboxPolicyType(securityDefault);
  return (
    type === "workspaceWrite" ||
    type === "dangerFullAccess" ||
    type === "externalSandbox"
  );
}

function explicitSandboxPolicyFor(
  permissionMode: unknown,
): Record<string, unknown> | undefined {
  switch (permissionMode) {
    case "bypassPermissions":
      return { type: "dangerFullAccess" };
    case "plan":
      return { type: "readOnly", networkAccess: false };
    case "acceptEdits":
      return {
        type: "workspaceWrite",
        // workspaceWrite already includes cwd; writableRoots are additional.
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
    default:
      return undefined;
  }
}

function sandboxPolicyValue(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value);
  if (!record || !isRestorableSandboxPolicy(record)) return undefined;
  return { ...record };
}

function isRestorableSandboxPolicy(value: Record<string, unknown>): boolean {
  switch (sandboxPolicyType(value)) {
    case "dangerFullAccess":
      return true;
    case "readOnly":
      return typeof value.networkAccess === "boolean";
    case "workspaceWrite":
      return (
        (value.writableRoots === undefined ||
          (Array.isArray(value.writableRoots) &&
            value.writableRoots.every((root) => typeof root === "string"))) &&
        typeof value.networkAccess === "boolean" &&
        typeof value.excludeTmpdirEnvVar === "boolean" &&
        typeof value.excludeSlashTmp === "boolean"
      );
    case "externalSandbox":
      return value.networkAccess === "restricted" || value.networkAccess === "enabled";
    default:
      return false;
  }
}

function sandboxPolicyType(value: Record<string, unknown>): string {
  switch (stringValue(value.type)) {
    case "danger-full-access":
    case "dangerFullAccess":
      return "dangerFullAccess";
    case "read-only":
    case "readOnly":
      return "readOnly";
    case "workspace-write":
    case "workspaceWrite":
      return "workspaceWrite";
    case "external-sandbox":
    case "externalSandbox":
      return "externalSandbox";
    default:
      return "";
  }
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function ownValue(
  record: Record<string, unknown> | undefined,
  key: string,
): unknown | undefined {
  return record && Object.prototype.hasOwnProperty.call(record, key)
    ? record[key]
    : undefined;
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
