import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { AgentFileAccess, AgentFileReference } from "@agent-canvas/shared";
import type { QueryFn, QueryPrompt, SdkUserInput } from "./types.js";

/**
 * 把真实 SDK 的 `query` 适配成本地 `QueryFn`。
 * 仅在服务运行时引入；单测改用注入的假实现，故不会触达真实模型/鉴权。
 */
export const realQuery: QueryFn = (args) => {
  const { fileAccess, ...options } = args.options ?? {};
  const additionalDirectories = fileAccess?.writableDirectories;
  let handle: ReturnType<typeof sdkQuery> | undefined;
  const prompt = withFileReferences(args.prompt, async (directories) => {
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

async function* withFileReferences(
  prompt: QueryPrompt,
  updateWritableDirectories: (directories: string[]) => Promise<void>,
): AsyncGenerator<SdkUserInput> {
  if (typeof prompt === "string") {
    yield userInputWithReferences(prompt, []);
    return;
  }
  for await (const input of prompt) {
    await updateWritableDirectories(input.fileAccess?.writableDirectories ?? []);
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
        content: appendFileContext(text, input.fileAccess),
      },
      fileAccess: undefined,
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

function appendFileContext(text: string, access: AgentFileAccess | undefined): string {
  const withReadable = appendReferences(text, access?.readableFiles ?? []);
  const writableFiles = access?.writableFiles ?? [];
  if (writableFiles.length === 0) return withReadable;
  return `${withReadable}\n\n可写的画布文件（作为输出目标）：\n${writableFiles
    .map((file) => `- ${file.path}`)
    .join("\n")}`;
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
