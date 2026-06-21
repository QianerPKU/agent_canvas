// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AgentSettingsDialog } from "./AgentSettingsDialog.js";
import { newAgentView } from "../agentStore.js";

afterEach(cleanup);

describe("AgentSettingsDialog", () => {
  it("新建时提交运行器、工作目录和私有系统提示词", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(
      <AgentSettingsDialog
        mode="create"
        defaultCwd="E:\\repo"
        onPickDirectory={vi.fn()}
        onCreate={onCreate}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("Codex"));
    fireEvent.change(screen.getByLabelText("Codex 模型"), {
      target: { value: "gpt-5.4-mini" },
    });
    fireEvent.change(screen.getByLabelText("Agent 工作目录"), {
      target: { value: "D:\\experiment" },
    });
    fireEvent.change(screen.getByLabelText("Agent 私有系统提示词"), {
      target: { value: "只修改测试相关文件" },
    });
    fireEvent.click(screen.getByText("创建"));

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith({
        provider: "codex",
        model: "gpt-5.4-mini",
        cwd: "D:\\experiment",
        systemPrompt: "只修改测试相关文件",
      }),
    );
  });

  it("编辑已创建 Agent 时只提交私有系统提示词", async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const agent = newAgentView("agent_1", {
      provider: "claude",
      cwd: "E:\\repo",
      systemPrompt: "old",
    });
    render(
      <AgentSettingsDialog
        mode="edit"
        agent={agent}
        defaultCwd="E:\\repo"
        onPickDirectory={vi.fn()}
        onUpdate={onUpdate}
        onClose={vi.fn()}
      />,
    );

    expect((screen.getByLabelText("Agent 工作目录") as HTMLInputElement).readOnly).toBe(true);
    fireEvent.change(screen.getByLabelText("Agent 私有系统提示词"), {
      target: { value: "new prompt" },
    });
    fireEvent.click(screen.getByText("保存"));

    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith("agent_1", {
        systemPrompt: "new prompt",
      }),
    );
  });
});
