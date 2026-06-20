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
  it("给 Claude 每轮输入追加当时的 @ 文件引用，并动态更新额外写目录", async () => {
    const prompt = new AsyncMessageQueue<SdkUserInput>();
    prompt.push({
      type: "user",
      message: { role: "user", content: "检查第一轮文件" },
      parent_tool_use_id: null,
      fileAccess: {
        readableFiles: [
          { name: "first.md", path: "C:/shared/first.md", previewKind: "markdown" },
        ],
        writableFiles: [
          { name: "first-output.md", path: "C:/shared/first-output.md", previewKind: "markdown" },
        ],
        writableDirectories: ["C:/shared/first-output"],
      },
      promptAccess: {
        readablePrompts: [
          { id: "prompt_1", name: "规则", content: "先写测试", kind: "shared" },
          { id: "prompt_2", name: "风格", content: "保持简单", kind: "normal" },
        ],
        writablePrompts: [
          { id: "prompt_3", name: "可更新规则", path: "C:/prompts/prompt_3.txt" },
        ],
        writableDirectories: ["C:/prompts"],
      },
    });

    realQuery({ prompt, options: {} });
    const sdkArgs = (sdk.query.mock.calls.at(-1)?.[0] as {
      prompt: AsyncIterable<SdkUserInput>;
    });
    const iterator = sdkArgs.prompt[Symbol.asyncIterator]();
    const first = await iterator.next();

    const firstContent = String(first.value?.message.content);
    expect(firstContent.indexOf("先写测试")).toBeLessThan(firstContent.indexOf("检查第一轮文件"));
    expect(firstContent.indexOf("保持简单")).toBeLessThan(firstContent.indexOf("检查第一轮文件"));
    expect(firstContent).toContain("@C:/shared/first.md");
    expect(firstContent).toContain("C:/shared/first-output.md");
    expect(firstContent).toContain("C:/prompts/prompt_3.txt");

    prompt.push({
      type: "user",
      message: { role: "user", content: "检查第二轮文件" },
      parent_tool_use_id: null,
      fileAccess: {
        readableFiles: [
          { name: "second.csv", path: "C:/shared/second.csv", previewKind: "csv" },
        ],
        writableFiles: [],
        writableDirectories: [],
      },
      promptAccess: {
        readablePrompts: [],
        writablePrompts: [],
        writableDirectories: [],
      },
    });
    const second = await iterator.next();

    expect(second.value?.message.content).toContain("@C:/shared/second.csv");
    expect(second.value?.message.content).not.toContain("@C:/shared/first.md");
    expect(sdk.applyFlagSettings).toHaveBeenNthCalledWith(1, {
      permissions: {
        additionalDirectories: ["C:/shared/first-output", "C:/prompts"],
      },
    });
    expect(sdk.applyFlagSettings).toHaveBeenNthCalledWith(2, {
      permissions: { additionalDirectories: [] },
    });
  });
});
