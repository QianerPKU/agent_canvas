import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
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
    },
  } as unknown as Parameters<typeof sdkQuery>[0]);
  return adaptQuery(handle);
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
  if (!enabled || !allowedTools) return allowedTools;
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

function adaptQuery(handle: ReturnType<typeof sdkQuery>): ReturnType<QueryFn> {
  return {
    [Symbol.asyncIterator]: () => handle,
    interrupt: () => handle.interrupt(),
    terminate: async () => {
      await handle.interrupt().catch(() => undefined);
      await handle.return(undefined).catch(() => undefined);
    },
  };
}
