import { describe, expect, it, vi } from "vitest";
import { AsyncMessageQueue } from "../util/AsyncMessageQueue.js";
import type { SdkUserInput } from "./types.js";

const sdk = vi.hoisted(() => {
  const applyFlagSettings = vi.fn().mockResolvedValue(undefined);
  const query = vi.fn((args: unknown) => ({
    async *[Symbol.asyncIterator]() {
      // no model messages needed
    },
    interrupt: vi.fn().mockResolvedValue(undefined),
    return: vi.fn().mockResolvedValue(undefined),
    applyFlagSettings,
    args,
  }));
  return { query, applyFlagSettings };
});

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: sdk.query }));

import { realQuery } from "./realQuery.js";

describe("realQuery file access", () => {
  it("给 Claude 输入追加 @ 文件引用，并动态更新额外写目录", async () => {
    const prompt = new AsyncMessageQueue<SdkUserInput>();
    prompt.push({
      type: "user",
      message: { role: "user", content: "检查文件" },
      parent_tool_use_id: null,
      fileAccess: {
        readableFiles: [
          { name: "notes.md", path: "C:/shared/notes.md", previewKind: "markdown" },
        ],
        writableFiles: [
          { name: "output.md", path: "C:/shared/output.md", previewKind: "markdown" },
        ],
        writableDirectories: ["C:/shared/output"],
      },
    });

    realQuery({ prompt, options: {} });
    const sdkArgs = (sdk.query.mock.calls.at(-1)?.[0] as {
      prompt: AsyncIterable<SdkUserInput>;
    });
    const next = await sdkArgs.prompt[Symbol.asyncIterator]().next();

    expect(next.value?.message.content).toContain("@C:/shared/notes.md");
    expect(next.value?.message.content).toContain("C:/shared/output.md");
    expect(sdk.applyFlagSettings).toHaveBeenCalledWith({
      permissions: { additionalDirectories: ["C:/shared/output"] },
    });
  });
});
