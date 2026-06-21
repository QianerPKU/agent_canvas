// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ReactFlowProvider, type NodeProps } from "@xyflow/react";
import type { AgentCommitSnapshot } from "@agent-canvas/shared";
import { CommitNode, toggleCommitNodeWindow, type CommitNodeType } from "./CommitNode.js";

afterEach(cleanup);

function commit(partial: Partial<AgentCommitSnapshot> = {}): AgentCommitSnapshot {
  return {
    id: "commit_1",
    agentId: "agent_1",
    sourceTurnIndex: 1,
    commitSha: "abcdef1234567890",
    shortSha: "abcdef1",
    branch: "feature/a",
    subject: "feat: add app",
    summary: "add app",
    files: [],
    createdAt: 1,
    ...partial,
  };
}

describe("CommitNode", () => {
  it("supports minimize/restore sizing and keeps its input handle", () => {
    const node: CommitNodeType = {
      id: "commit:commit_1",
      type: "commit",
      position: { x: 0, y: 0 },
      width: 300,
      height: 200,
      data: { commit: commit(), onOpenDetails: vi.fn() },
    };

    const minimized = { ...node, ...toggleCommitNodeWindow(node) } as CommitNodeType;
    expect(minimized).toMatchObject({
      width: 76,
      height: 50,
      data: {
        windowState: {
          minimized: true,
          restoreWidth: 300,
          restoreHeight: 200,
        },
      },
    });

    const { container } = render(
      <ReactFlowProvider>
        <CommitNode
          {...({ id: minimized.id, data: minimized.data } as unknown as NodeProps<CommitNodeType>)}
        />
      </ReactFlowProvider>,
    );
    expect(container.querySelectorAll(".react-flow__handle")).toHaveLength(1);
    expect(screen.getByTitle("恢复 commit abcdef1")).toBeTruthy();
  });

  it("opens details when the node body is clicked", () => {
    const onOpenDetails = vi.fn();
    render(
      <ReactFlowProvider>
        <CommitNode
          {...({
            id: "commit:commit_1",
            data: { commit: commit(), onOpenDetails },
          } as unknown as NodeProps<CommitNodeType>)}
        />
      </ReactFlowProvider>,
    );

    fireEvent.click(screen.getByText("add app"));
    expect(onOpenDetails).toHaveBeenCalledWith("commit_1");
  });
});
