// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AgentSettingsDialog } from "./AgentSettingsDialog.js";
import { newAgentView } from "../agentStore.js";

afterEach(cleanup);

describe("AgentSettingsDialog", () => {
  const branches = [
    {
      branch: "main",
      branchWorkspaceId: "branch_1",
      worktreePath: "E:\\project\\repo",
      hasWorkspace: true,
      isDefault: true,
    },
  ];

  it("新建时提交运行器、branch 和私有系统提示词", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(
      <AgentSettingsDialog
        mode="create"
        branches={branches}
        onCreateBranch={vi.fn()}
        onCreate={onCreate}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("Codex"));
    fireEvent.change(screen.getByLabelText("Codex 模型"), {
      target: { value: "gpt-5.4-mini" },
    });
    fireEvent.change(screen.getByLabelText("Agent 私有系统提示词"), {
      target: { value: "只修改测试相关文件" },
    });
    fireEvent.click(screen.getByText("创建"));

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith({
        provider: "codex",
        model: "gpt-5.4-mini",
        branchWorkspaceId: "branch_1",
        branch: "main",
        cwd: "E:\\project\\repo",
        systemPrompt: "只修改测试相关文件",
      }),
    );
  });

  it("新建时可以创建并选择 branch", async () => {
    const onCreateBranch = vi.fn().mockResolvedValue({
      id: "branch_2",
      repoId: "repo_1",
      branch: "feature/a",
      worktreePath: "E:\\project\\feature-a",
      scratchRoot: "E:\\project\\feature-a\\.agent-tmp",
      isDefault: false,
      createdAt: 2,
    });
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(
      <AgentSettingsDialog
        mode="create"
        branches={branches}
        onCreateBranch={onCreateBranch}
        onCreate={onCreate}
        onClose={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("新建 branch"), {
      target: { value: "feature/a" },
    });
    fireEvent.click(screen.getByTitle("创建 branch"));
    await waitFor(() => expect(onCreateBranch).toHaveBeenCalledWith("feature/a"));

    fireEvent.click(screen.getByText("创建"));
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          branchWorkspaceId: "branch_2",
          branch: "feature/a",
          cwd: "E:\\project\\feature-a",
        }),
      ),
    );
  });

  it("创建同名远端 branch 后不会在列表中显示重复项", async () => {
    const onCreateBranch = vi.fn().mockResolvedValue({
      id: "branch_2",
      repoId: "repo_1",
      branch: "feature/a",
      worktreePath: "E:\\project\\feature-a",
      scratchRoot: "E:\\project\\feature-a\\.agent-tmp",
      isDefault: false,
      createdAt: 2,
    });
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(
      <AgentSettingsDialog
        mode="create"
        branches={[
          ...branches,
          {
            branch: "feature/a",
            hasWorkspace: false,
            isDefault: false,
          },
        ]}
        onCreateBranch={onCreateBranch}
        onCreate={onCreate}
        onClose={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("新建 branch"), {
      target: { value: "feature/a" },
    });
    fireEvent.click(screen.getByTitle("创建 branch"));

    await waitFor(() => expect(onCreateBranch).toHaveBeenCalledWith("feature/a"));
    const options = Array.from(
      (screen.getByLabelText("Agent branch") as HTMLSelectElement).options,
    ).filter((option) => option.value === "feature/a");
    expect(options).toHaveLength(1);

    fireEvent.click(screen.getByText("创建"));
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          branchWorkspaceId: "branch_2",
          branch: "feature/a",
          cwd: "E:\\project\\feature-a",
        }),
      ),
    );
  });

  it("编辑已创建 Agent 时只提交私有系统提示词", async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const agent = newAgentView("agent_1", {
      provider: "claude",
      branchWorkspaceId: "branch_1",
      branch: "main",
      cwd: "E:\\repo",
      systemPrompt: "old",
    });
    render(
      <AgentSettingsDialog
        mode="edit"
        agent={agent}
        branches={branches}
        canChangeBranch={false}
        onCreateBranch={vi.fn()}
        onUpdate={onUpdate}
        onClose={vi.fn()}
      />,
    );

    expect((screen.getByLabelText("Agent branch") as HTMLSelectElement).disabled).toBe(true);
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

  it("编辑活跃 Agent 时可以切换到已有 branch", async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const agent = newAgentView("agent_1", {
      provider: "claude",
      branchWorkspaceId: "branch_1",
      branch: "main",
      cwd: "E:\\repo",
      systemPrompt: "old",
      status: "waiting_input",
    });
    render(
      <AgentSettingsDialog
        mode="edit"
        agent={agent}
        branches={[
          ...branches,
          {
            branch: "feature/a",
            branchWorkspaceId: "branch_2",
            worktreePath: "E:\\project\\feature-a",
            hasWorkspace: true,
            isDefault: false,
          },
        ]}
        canChangeBranch
        onCreateBranch={vi.fn()}
        onUpdate={onUpdate}
        onClose={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Agent branch"), {
      target: { value: "feature/a" },
    });
    fireEvent.click(screen.getByText("保存"));

    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith("agent_1", {
        systemPrompt: "old",
        branchWorkspaceId: "branch_2",
        branch: "feature/a",
        cwd: "E:\\project\\feature-a",
      }),
    );
  });
});
