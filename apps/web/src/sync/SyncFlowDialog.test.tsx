// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { BranchOption } from "@agent-canvas/shared";
import type { AgentMap } from "../agentStore.js";
import type { SyncFlowActions } from "../useAgentCanvas.js";
import { SyncFlowDialog } from "./SyncFlowDialog.js";

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

function actions(): SyncFlowActions {
  return {
    create: vi.fn().mockResolvedValue(undefined),
    recordApplied: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
  };
}

describe("SyncFlowDialog", () => {
  it("creates a cherry-pick sync flow from an active proposer agent", async () => {
    const syncActions = actions();

    render(
      <SyncFlowDialog
        agents={agents}
        branches={branches}
        flows={[]}
        actions={syncActions}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Proposer agent").textContent).toContain("agent_1");
    expect(screen.getByLabelText("Proposer agent").textContent).not.toContain("agent_done");

    fireEvent.change(screen.getByLabelText("Source branch"), { target: { value: "main" } });
    fireEvent.change(screen.getByLabelText("Commit SHA"), {
      target: { value: "abcdef123456" },
    });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Pick fix" } });
    fireEvent.change(screen.getByLabelText("Summary"), {
      target: { value: "Apply focused fix" },
    });
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "Needed without merging all of main" },
    });
    fireEvent.change(screen.getByLabelText("Files"), {
      target: { value: "src/a.ts\nsrc/b.ts" },
    });
    fireEvent.click(screen.getByText("Start review"));

    await waitFor(() => expect(syncActions.create).toHaveBeenCalledOnce());
    expect(syncActions.create).toHaveBeenCalledWith({
      kind: "cherry_pick",
      proposerAgentId: "agent_1",
      targetBranch: "feature/a",
      sourceBranch: "main",
      commitSha: "abcdef123456",
      title: "Pick fix",
      summary: "Apply focused fix",
      reason: "Needed without merging all of main",
      files: ["src/a.ts", "src/b.ts"],
    });
  });

  it("creates a branch pull sync flow", async () => {
    const syncActions = actions();

    render(
      <SyncFlowDialog
        agents={agents}
        branches={branches}
        flows={[]}
        actions={syncActions}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("Pull branch"));
    fireEvent.change(screen.getByLabelText("Source branch"), { target: { value: "main" } });
    fireEvent.change(screen.getByLabelText("Strategy"), { target: { value: "rebase" } });
    fireEvent.change(screen.getByLabelText("Summary"), {
      target: { value: "Catch up with main" },
    });
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "Current branch is behind" },
    });
    fireEvent.change(screen.getByLabelText("Files"), { target: { value: "src/main.ts" } });
    fireEvent.click(screen.getByText("Start review"));

    await waitFor(() => expect(syncActions.create).toHaveBeenCalledOnce());
    expect(syncActions.create).toHaveBeenCalledWith({
      kind: "branch_pull",
      proposerAgentId: "agent_1",
      targetBranch: "feature/a",
      sourceBranch: "main",
      strategy: "rebase",
      title: undefined,
      summary: "Catch up with main",
      reason: "Current branch is behind",
      files: ["src/main.ts"],
    });
  });
});
