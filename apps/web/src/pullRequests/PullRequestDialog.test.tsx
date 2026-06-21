// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { BranchOption } from "@agent-canvas/shared";
import type { AgentMap } from "../agentStore.js";
import type { PullRequestActions } from "../useAgentCanvas.js";
import { PullRequestDialog } from "./PullRequestDialog.js";

const branches: BranchOption[] = [
  { branch: "main", hasWorkspace: true, isDefault: true },
  { branch: "feature/a", hasWorkspace: true, isDefault: false },
];

const agents: AgentMap = {
  agent_1: {
    id: "agent_1",
    status: "waiting_input",
    branch: "feature/a",
    turns: [{ index: 0, status: "idle", lines: [] }],
    lastSeq: 1,
  },
  agent_done: {
    id: "agent_done",
    status: "terminated",
    branch: "feature/a",
    turns: [{ index: 0, status: "terminated", lines: [] }],
    lastSeq: 1,
  },
};

describe("PullRequestDialog", () => {
  it("creates a PR flow from an active proposer agent", async () => {
    const actions: PullRequestActions = {
      create: vi.fn().mockResolvedValue(undefined),
      recordCreated: vi.fn().mockResolvedValue(undefined),
      recordMerged: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn().mockResolvedValue(undefined),
    };

    render(
      <PullRequestDialog
        agents={agents}
        branches={branches}
        flows={[]}
        actions={actions}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("提 PR Agent").textContent).toContain("agent_1");
    expect(screen.getByLabelText("提 PR Agent").textContent).not.toContain("agent_done");

    fireEvent.change(screen.getByLabelText("目标 branch"), { target: { value: "main" } });
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "Add feature" } });
    fireEvent.change(screen.getByLabelText("概括"), { target: { value: "Ship feature A" } });
    fireEvent.change(screen.getByLabelText("文件范围"), {
      target: { value: "src/a.ts\nsrc/b.ts" },
    });
    fireEvent.click(screen.getByText("发起审查"));

    await waitFor(() => expect(actions.create).toHaveBeenCalledOnce());
    expect(actions.create).toHaveBeenCalledWith({
      proposerAgentId: "agent_1",
      sourceBranch: "feature/a",
      targetBranch: "main",
      title: "Add feature",
      summary: "Ship feature A",
      files: ["src/a.ts", "src/b.ts"],
    });
  });
});
