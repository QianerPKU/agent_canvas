import { spawn } from "node:child_process";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type {
  CanUseTool,
  PermissionResult,
  SpawnOptions,
  SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentApprovalResponse,
  AgentFileAccess,
  AgentFileReference,
  AgentQuestionItem,
  AgentQuestionOption,
  AgentQuestionResponse,
  AgentPromptAccess,
} from "@agent-canvas/shared";
import type { QueryFn, QueryOptions, QueryPrompt, SdkUserInput } from "./types.js";

/**
 * 把真实 SDK 的 `query` 适配成本地 `QueryFn`。
 * 仅在服务运行时引入；单测改用注入的假实现，故不会触达真实模型/鉴权。
 */
export const realQuery: QueryFn = (args) => {
  const { fileAccess, promptAccess, requestUserInput, requestApproval, ...options } =
    args.options ?? {};
  const processExit = new ClaudeProcessExitBarrier();
  const configuredSpawner = typeof options.spawnClaudeCodeProcess === "function"
    ? options.spawnClaudeCodeProcess as (options: SpawnOptions) => SpawnedProcess
    : undefined;
  const stderr = typeof options.stderr === "function"
    ? options.stderr as (data: string) => void
    : undefined;
  const spawnClaudeCodeProcess = (spawnOptions: SpawnOptions): SpawnedProcess =>
    processExit.track(
      configuredSpawner
        ? configuredSpawner(spawnOptions)
        : spawnDefaultClaudeCodeProcess(spawnOptions, stderr),
    );
  const additionalDirectories = accessibleDirectories(fileAccess, promptAccess);
  const existingCanUseTool =
    typeof options.canUseTool === "function" ? (options.canUseTool as CanUseTool) : undefined;
  let handle: ReturnType<typeof sdkQuery> | undefined;
  const prompt = withContext(args.prompt, async (directories) => {
    if (!handle) return;
    await handle.applyFlagSettings({
      permissions: { additionalDirectories: directories },
    });
  });
  handle = sdkQuery({
    prompt,
    options: {
      ...options,
      allowedTools: includeAskUserQuestion(options.allowedTools, !!requestUserInput),
      canUseTool: requestUserInput
        ? createCanUseTool(requestUserInput, requestApproval, existingCanUseTool)
        : existingCanUseTool,
      additionalDirectories:
        additionalDirectories && additionalDirectories.length > 0
          ? additionalDirectories
          : undefined,
      // Query.return() only waits for the Claude SDK transport for a bounded grace period. Track
      // the concrete process ourselves so callers cannot revoke dispatch snapshots while the CLI
      // is still alive. Wrapping (rather than replacing) a caller-provided spawner preserves VMs,
      // containers, and other custom transports that implement SpawnedProcess.
      spawnClaudeCodeProcess,
    },
  } as unknown as Parameters<typeof sdkQuery>[0]);
  return adaptQuery(handle, processExit);
};

function createCanUseTool(
  requestUserInput: NonNullable<QueryOptions["requestUserInput"]>,
  requestApproval: QueryOptions["requestApproval"] | undefined,
  fallback: CanUseTool | undefined,
): CanUseTool {
  return async (toolName, input, options): Promise<PermissionResult> => {
    if (toolName !== "AskUserQuestion") {
      if (fallback) return fallback(toolName, input, options);
      if (!requestApproval) {
        throw new Error("Agent Canvas approval handler is not available.");
      }
      const response = await requestApproval({
        requestId: `claude-approval:${options.toolUseID}`,
        kind: "tool",
        title: options.title ?? options.displayName ?? `Claude 请求使用 ${toolName}`,
        message: options.description ?? options.decisionReason,
        toolName,
        input,
        blockedPath: options.blockedPath,
        suggestions: options.suggestions,
      });
      return claudeApprovalResult(response, options.toolUseID, options.suggestions);
    }

    const questions = claudeQuestions(input);
    const response = await requestUserInput({
      requestId: `claude:${options.toolUseID}`,
      kind: "ask_user_question",
      title: options.title ?? options.displayName ?? "Claude 需要确认",
      message: options.description,
      questions,
    });

    if (response.action === "decline" || response.action === "cancel") {
      return {
        behavior: "deny",
        message: "用户未提供回答。",
        toolUseID: options.toolUseID,
      };
    }

    return {
      behavior: "allow",
      toolUseID: options.toolUseID,
      updatedInput: {
        ...input,
        answers: claudeAnswerMap(questions, response),
      },
    };
  };
}

function claudeApprovalResult(
  response: AgentApprovalResponse,
  toolUseID: string,
  suggestions: unknown,
): PermissionResult {
  if (response.action === "approve") {
    return {
      behavior: "allow",
      toolUseID,
      updatedPermissions:
        response.remember && Array.isArray(suggestions) ? suggestions : undefined,
    };
  }
  return {
    behavior: "deny",
    message: response.message ?? (response.action === "cancel" ? "用户取消授权。" : "用户拒绝授权。"),
    interrupt: response.action === "cancel",
    toolUseID,
  };
}

function claudeQuestions(input: Record<string, unknown>): AgentQuestionItem[] {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  return questions.map((question, index) => {
    const record = asRecord(question);
    const text = stringValue(record?.question) || `question_${index + 1}`;
    return {
      id: `question_${index + 1}`,
      header: stringValue(record?.header) || undefined,
      question: text,
      options: arrayValue(record?.options).map(questionOption),
      multiSelect: booleanValue(record?.multiSelect),
      isOther: true,
      isSecret: false,
    };
  });
}

function questionOption(option: unknown): AgentQuestionOption {
  const record = asRecord(option);
  return {
    label: stringValue(record?.label),
    description: stringValue(record?.description) || undefined,
    preview: stringValue(record?.preview) || undefined,
  };
}

function claudeAnswerMap(
  questions: AgentQuestionItem[],
  response: AgentQuestionResponse,
): Record<string, string | string[]> {
  const source = response.answers ?? {};
  const answers: Record<string, string | string[]> = {};
  for (const question of questions) {
    const value = source[question.id] ?? source[question.question];
    if (value !== undefined) answers[question.question] = value;
  }
  return answers;
}

function includeAskUserQuestion(
  allowedTools: string[] | undefined,
  enabled: boolean,
): string[] | undefined {
  if (!enabled) return allowedTools;
  if (!allowedTools) return ["AskUserQuestion"];
  return allowedTools.includes("AskUserQuestion")
    ? allowedTools
    : [...allowedTools, "AskUserQuestion"];
}

async function* withContext(
  prompt: QueryPrompt,
  updateWritableDirectories: (directories: string[]) => Promise<void>,
): AsyncGenerator<SdkUserInput> {
  if (typeof prompt === "string") {
    yield userInputWithReferences(prompt, []);
    return;
  }
  for await (const input of prompt) {
    await updateWritableDirectories(accessibleDirectories(input.fileAccess, input.promptAccess));
    const content = input.message.content;
    const text =
      typeof content === "string"
        ? content
        : content
            .filter((block) => block.type === "text")
            .map((block) => String((block as { text?: unknown }).text ?? ""))
            .join("\n");
    yield {
      ...input,
      message: {
        ...input.message,
        content: appendContext(text, input.fileAccess, input.promptAccess),
      },
      fileAccess: undefined,
      promptAccess: undefined,
    };
  }
}

function userInputWithReferences(
  text: string,
  references: AgentFileReference[],
): SdkUserInput {
  return {
    type: "user",
    message: { role: "user", content: appendReferences(text, references) },
    parent_tool_use_id: null,
  };
}

function appendReferences(text: string, references: AgentFileReference[]): string {
  if (references.length === 0) return text;
  const lines = references.map((file) => `- @${file.path}`);
  return `${text}\n\n可读取的画布文件：\n${lines.join("\n")}`;
}

function appendContext(
  text: string,
  fileAccess: AgentFileAccess | undefined,
  promptAccess: AgentPromptAccess | undefined,
): string {
  const withPrompts = prependPromptContext(text, promptAccess);
  const withSharedResources = appendSharedResources(withPrompts, fileAccess);
  const withReadableFiles = appendReferences(withSharedResources, fileAccess?.readableFiles ?? []);
  const writableFiles = fileAccess?.writableFiles ?? [];
  const withWritableFiles =
    writableFiles.length === 0
      ? withReadableFiles
      : `${withReadableFiles}\n\n可写的画布文件（作为输出目标）：\n${writableFiles
          .map((file) => `- ${file.path}`)
          .join("\n")}`;
  const writablePrompts = promptAccess?.writablePrompts ?? [];
  if (writablePrompts.length === 0) return withWritableFiles;
  return `${withWritableFiles}\n\n可写的提示词节点（修改对应文本文件）：\n${writablePrompts
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

function accessibleDirectories(
  fileAccess: AgentFileAccess | undefined,
  promptAccess: AgentPromptAccess | undefined,
): string[] {
  return [
    ...new Set([
      ...(fileAccess?.readableDirectories ?? []),
      ...(fileAccess?.writableDirectories ?? []),
      ...(fileAccess?.sandboxWritableDirectories ?? []),
      ...(promptAccess?.writableDirectories ?? []),
    ]),
  ];
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

function adaptQuery(
  handle: ReturnType<typeof sdkQuery>,
  processExit: ClaudeProcessExitBarrier,
): ReturnType<QueryFn> {
  return {
    [Symbol.asyncIterator]: () => handle,
    interrupt: () => handle.interrupt(),
    setModel: (model) => handle.setModel(model),
    terminate: async () => {
      // Interrupt is best-effort and can wait forever for an unresponsive CLI control response.
      // Start it before return() so a responsive turn gets a graceful interrupt, but never let it
      // delay the authoritative generator-close + exact process-exit barrier.
      const interrupting = invokePromise(() => handle.interrupt());
      void interrupting.catch(() => undefined);

      const errors: unknown[] = [];
      const closing = invokePromise(() => handle.return(undefined));
      try {
        await closing;
      } catch (error) {
        errors.push(error);
      }
      if (errors.length === 0) {
        try {
          await processExit.waitForExit();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, "Failed to terminate Claude SDK query");
      }
    },
  };
}

type ExitWaiter = {
  resolve: () => void;
  reject: (error: unknown) => void;
};

/**
 * Tracks the exact lifecycle of the process created for one Claude Query.
 *
 * An error rejects the current wait attempt without being cached forever. The process and its
 * exit listener remain retained, so AgentRunner's next termination attempt can safely retry.
 */
class ClaudeProcessExitBarrier {
  private process?: SpawnedProcess;
  private exited = false;
  private readonly pendingErrors: unknown[] = [];
  private readonly waiters = new Set<ExitWaiter>();

  track(process: SpawnedProcess): SpawnedProcess {
    if (this.process && this.process !== process && !this.exited) {
      throw new Error("Claude SDK spawned a replacement process before the previous process exited");
    }
    this.process = process;
    this.exited = process.exitCode !== null;
    this.pendingErrors.length = 0;
    if (this.exited) return process;

    const onExit = (): void => {
      if (this.process !== process) return;
      this.exited = true;
      this.pendingErrors.length = 0;
      process.off("exit", onExit);
      process.off("error", onError);
      for (const waiter of this.waiters) waiter.resolve();
      this.waiters.clear();
    };
    const onError = (error: Error): void => {
      if (this.process !== process || this.exited) return;
      // Node emits AbortError when ProcessTransport's forwarded abort signal performs its normal
      // delayed kill. That is a termination request, not proof of exit and not a failed barrier;
      // keep waiting for the authoritative exit event.
      if (isAbortProcessError(error)) return;
      if (this.waiters.size === 0) {
        this.pendingErrors.push(error);
        return;
      }
      for (const waiter of this.waiters) waiter.reject(error);
      this.waiters.clear();
    };
    process.on("exit", onExit);
    process.on("error", onError);
    // A custom spawner may synchronously return an already-exited process.
    if (process.exitCode !== null) onExit();
    return process;
  }

  waitForExit(): Promise<void> {
    if (!this.process || this.exited || this.process.exitCode !== null) {
      this.exited = !!this.process;
      this.pendingErrors.length = 0;
      return Promise.resolve();
    }
    const pendingError = this.pendingErrors.shift();
    if (pendingError !== undefined) return Promise.reject(pendingError);
    return new Promise<void>((resolve, reject) => {
      this.waiters.add({ resolve, reject });
    });
  }
}

function invokePromise(operation: () => PromiseLike<unknown>): Promise<unknown> {
  try {
    return Promise.resolve(operation());
  } catch (error) {
    return Promise.reject(error);
  }
}

function spawnDefaultClaudeCodeProcess(
  options: SpawnOptions,
  stderr: ((data: string) => void) | undefined,
): SpawnedProcess {
  const debug = enabledEnvironmentFlag(options.env.DEBUG_CLAUDE_AGENT_SDK);
  const captureStderr = debug || !!stderr;
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    signal: options.signal,
    stdio: ["pipe", "pipe", captureStderr ? "pipe" : "ignore"],
    windowsHide: true,
  });
  if (captureStderr && child.stderr) {
    child.stderr.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      stderr?.(text);
      if (debug && !stderr) process.stderr.write(text);
    });
  }
  return child as unknown as SpawnedProcess;
}

function enabledEnvironmentFlag(value: string | undefined): boolean {
  if (!value) return false;
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

function isAbortProcessError(error: Error): boolean {
  return error.name === "AbortError" || (error as NodeJS.ErrnoException).code === "ABORT_ERR";
}
