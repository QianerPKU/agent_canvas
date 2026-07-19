// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AgentSettingsDialog } from "./AgentSettingsDialog.js";
import { newAgentView } from "../agentStore.js";

vi.mock("../api.js", () => ({
  api: {
    codexAuthStatus: vi.fn().mockResolvedValue({
      status: { state: "unauthenticated", message: "Not logged in" },
      login: null,
    }),
    startCodexLogin: vi.fn().mockResolvedValue({
      id: "codex_login_1",
      state: "running",
      startedAt: 1,
      updatedAt: 1,
      loginUrl: "https://auth.openai.com/device",
      userCode: "ABCD-EFGH",
      output: "",
    }),
  },
}));

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
        allowSharedResourceWrites: false,
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
    await waitFor(() => expect(onCreateBranch).toHaveBeenCalledWith("feature/a", "main"));

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

    await waitFor(() => expect(onCreateBranch).toHaveBeenCalledWith("feature/a", "main"));
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

  it("新建 branch 时可以选择继承来源", async () => {
    const onCreateBranch = vi.fn().mockResolvedValue({
      id: "branch_3",
      repoId: "repo_1",
      branch: "feature/from-dev",
      baseBranch: "develop",
      worktreePath: "E:\\project\\feature-from-dev",
      scratchRoot: "E:\\project\\feature-from-dev\\.agent-tmp",
      isDefault: false,
      createdAt: 3,
    });
    render(
      <AgentSettingsDialog
        mode="create"
        branches={[
          ...branches,
          {
            branch: "develop",
            branchWorkspaceId: "branch_2",
            worktreePath: "E:\\project\\develop",
            hasWorkspace: true,
            isDefault: false,
          },
        ]}
        onCreateBranch={onCreateBranch}
        onCreate={vi.fn().mockResolvedValue(undefined)}
        onClose={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("新建 branch"), {
      target: { value: "feature/from-dev" },
    });
    fireEvent.change(screen.getByLabelText("新建 branch 继承自"), {
      target: { value: "develop" },
    });
    fireEvent.click(screen.getByTitle("创建 branch"));

    await waitFor(() =>
      expect(onCreateBranch).toHaveBeenCalledWith("feature/from-dev", "develop"),
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
        model: null,
        allowSharedResourceWrites: false,
      }),
    );
  });

  it("编辑 Claude Agent 时可以切换模型", async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const agent = newAgentView("agent_1", {
      provider: "claude",
      branchWorkspaceId: "branch_1",
      branch: "main",
      cwd: "E:\\repo",
      model: "sonnet",
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

    fireEvent.change(screen.getByLabelText("Claude Code 模型"), {
      target: { value: "opus" },
    });
    fireEvent.click(screen.getByText("保存"));

    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith("agent_1", {
        systemPrompt: "old",
        model: "opus",
        allowSharedResourceWrites: false,
      }),
    );
  });

  it("编辑 Codex Agent 时可以切换模型", async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const agent = newAgentView("agent_1", {
      provider: "codex",
      branchWorkspaceId: "branch_1",
      branch: "main",
      cwd: "E:\\repo",
      model: "gpt-5.4",
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

    fireEvent.change(screen.getByLabelText("Codex 模型"), {
      target: { value: "gpt-5.4-mini" },
    });
    fireEvent.click(screen.getByText("保存"));

    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith("agent_1", {
        systemPrompt: "old",
        model: "gpt-5.4-mini",
        allowSharedResourceWrites: false,
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
        model: null,
        allowSharedResourceWrites: false,
        branchWorkspaceId: "branch_2",
        branch: "feature/a",
        cwd: "E:\\project\\feature-a",
      }),
    );
  });

  it("allows explicitly granting shared resource write access", async () => {
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

    const toggle = screen.getByRole("checkbox", { name: "允许写入只读共享目录" });
    expect((toggle as HTMLInputElement).checked).toBe(false);
    fireEvent.click(toggle);
    fireEvent.click(screen.getByText("创建"));

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({ allowSharedResourceWrites: true }),
      ),
    );
  });

  it("keeps an edited shared write setting across same-agent updates and can revoke it", async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const agent = newAgentView("agent_1", {
      provider: "claude",
      branchWorkspaceId: "branch_1",
      branch: "main",
      cwd: "E:\\repo",
      status: "waiting_input",
      allowSharedResourceWrites: true,
    });
    const dialog = (
      currentAgent: typeof agent,
    ) => (
      <AgentSettingsDialog
        mode="edit"
        agent={currentAgent}
        branches={branches}
        canChangeBranch={false}
        onCreateBranch={vi.fn()}
        onUpdate={onUpdate}
        onClose={vi.fn()}
      />
    );
    const { rerender } = render(dialog(agent));

    const toggle = screen.getByRole("checkbox", { name: "允许写入只读共享目录" });
    expect((toggle as HTMLInputElement).checked).toBe(true);
    fireEvent.click(toggle);
    rerender(dialog({ ...agent }));
    expect((toggle as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByText("保存"));

    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith(
        "agent_1",
        expect.objectContaining({ allowSharedResourceWrites: false }),
      ),
    );
  });
});
