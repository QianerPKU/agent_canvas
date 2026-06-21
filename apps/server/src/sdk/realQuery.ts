import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentFileAccess,
  AgentFileReference,
  AgentPromptAccess,
} from "@agent-canvas/shared";
import type { QueryFn, QueryPrompt, SdkUserInput } from "./types.js";

/**
 * 把真实 SDK 的 `query` 适配成本地 `QueryFn`。
 * 仅在服务运行时引入；单测改用注入的假实现，故不会触达真实模型/鉴权。
 */
export const realQuery: QueryFn = (args) => {
  const { fileAccess, promptAccess, ...options } = args.options ?? {};
  const additionalDirectories = accessibleDirectories(fileAccess, promptAccess);
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
      additionalDirectories:
        additionalDirectories && additionalDirectories.length > 0
          ? additionalDirectories
          : undefined,
    },
  } as unknown as Parameters<typeof sdkQuery>[0]);
  return adaptQuery(handle);
};

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
