import { beforeEach, describe, expect, it, vi } from "vitest";
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
  beforeEach(() => {
    sdk.query.mockClear();
    sdk.applyFlagSettings.mockClear();
  });

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
        readableDirectories: ["C:/datasets/raw"],
        writableFiles: [
          { name: "first-output.md", path: "C:/shared/first-output.md", previewKind: "markdown" },
        ],
        writableDirectories: ["C:/shared/first-output"],
        sharedResources: [
          {
            name: "raw dataset",
            mountPath: "C:/repo/data/raw",
            sourcePath: "C:/datasets/raw",
            access: "readOnly",
          },
        ],
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
    expect(firstContent).toContain("raw dataset [readOnly]: C:/repo/data/raw -> C:/datasets/raw");
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
        additionalDirectories: ["C:/datasets/raw", "C:/shared/first-output", "C:/prompts"],
      },
    });
    expect(sdk.applyFlagSettings).toHaveBeenNthCalledWith(2, {
      permissions: { additionalDirectories: [] },
    });
  });

  it("把 Claude AskUserQuestion 转发到前端问题处理器", async () => {
    const requestUserInput = vi.fn().mockResolvedValue({
      answers: { question_1: "React" },
    });

    realQuery({
      prompt: "x",
      options: {
        allowedTools: ["Read"],
        requestUserInput,
      },
    });
    const sdkArgs = sdk.query.mock.calls.at(-1)?.[0] as {
      options: {
        allowedTools?: string[];
        canUseTool?: (
          toolName: string,
          input: Record<string, unknown>,
          options: {
            signal: AbortSignal;
            toolUseID: string;
            title?: string;
            displayName?: string;
            description?: string;
          },
        ) => Promise<unknown>;
      };
    };

    expect(sdkArgs.options.allowedTools).toEqual(["Read", "AskUserQuestion"]);
    const result = await sdkArgs.options.canUseTool?.(
      "AskUserQuestion",
      {
        questions: [
          {
            question: "选择哪个框架？",
            header: "框架",
            options: [
              { label: "React", description: "使用 React" },
              { label: "Vue", description: "使用 Vue" },
            ],
            multiSelect: false,
          },
        ],
      },
      {
        signal: new AbortController().signal,
        toolUseID: "tool-1",
        title: "Claude 需要确认",
      },
    );

    expect(requestUserInput).toHaveBeenCalledWith({
      requestId: "claude:tool-1",
      kind: "ask_user_question",
      title: "Claude 需要确认",
      message: undefined,
      questions: [
        {
          id: "question_1",
          header: "框架",
          question: "选择哪个框架？",
          options: [
            { label: "React", description: "使用 React", preview: undefined },
            { label: "Vue", description: "使用 Vue", preview: undefined },
          ],
          multiSelect: false,
          isOther: true,
          isSecret: false,
        },
      ],
    });
    expect(result).toEqual({
      behavior: "allow",
      toolUseID: "tool-1",
      updatedInput: {
        questions: [
          {
            question: "选择哪个框架？",
            header: "框架",
            options: [
              { label: "React", description: "使用 React" },
              { label: "Vue", description: "使用 Vue" },
            ],
            multiSelect: false,
          },
        ],
        answers: { "选择哪个框架？": "React" },
      },
    });
  });

  it("adds Claude AskUserQuestion when no allowedTools were configured", () => {
    const requestUserInput = vi.fn().mockResolvedValue({ answers: {} });

    realQuery({
      prompt: "x",
      options: {
        requestUserInput,
      },
    });

    const sdkArgs = sdk.query.mock.calls.at(-1)?.[0] as {
      options: { allowedTools?: string[]; canUseTool?: unknown };
    };

    expect(sdkArgs.options.allowedTools).toEqual(["AskUserQuestion"]);
    expect(typeof sdkArgs.options.canUseTool).toBe("function");
  });

  it("把 Claude 非 AskUserQuestion 工具授权转发到前端审批处理器", async () => {
    const requestUserInput = vi.fn().mockResolvedValue({ answers: {} });
    const requestApproval = vi.fn().mockResolvedValue({ action: "approve", remember: true });

    realQuery({
      prompt: "x",
      options: {
        requestUserInput,
        requestApproval,
      },
    });
    const sdkArgs = sdk.query.mock.calls.at(-1)?.[0] as {
      options: {
        canUseTool?: (
          toolName: string,
          input: Record<string, unknown>,
          options: {
            signal: AbortSignal;
            toolUseID: string;
            title?: string;
            displayName?: string;
            description?: string;
            decisionReason?: string;
            blockedPath?: string;
            suggestions?: unknown[];
          },
        ) => Promise<unknown>;
      };
    };

    const suggestions = [{ type: "setMode", mode: "acceptEdits" }];
    const result = await sdkArgs.options.canUseTool?.(
      "Bash",
      { command: "npm test" },
      {
        signal: new AbortController().signal,
        toolUseID: "tool-bash",
        title: "Claude 想运行命令",
        description: "运行测试",
        suggestions,
      },
    );

    expect(requestApproval).toHaveBeenCalledWith({
      requestId: "claude-approval:tool-bash",
      kind: "tool",
      title: "Claude 想运行命令",
      message: "运行测试",
      toolName: "Bash",
      input: { command: "npm test" },
      blockedPath: undefined,
      suggestions,
    });
    expect(result).toEqual({
      behavior: "allow",
      toolUseID: "tool-bash",
      updatedPermissions: suggestions,
    });
  });
});
