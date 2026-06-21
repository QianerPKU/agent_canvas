// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ReactFlowProvider, type NodeProps } from "@xyflow/react";
import type { SyncFlowSnapshot } from "@agent-canvas/shared";
import { SyncFlowNode, toggleSyncFlowNodeWindow, type SyncFlowNodeType } from "./SyncFlowNode.js";

afterEach(cleanup);

function flow(partial: Partial<SyncFlowSnapshot> = {}): SyncFlowSnapshot {
  return {
    id: "sync_flow_1",
    kind: "cherry_pick",
    proposerAgentId: "agent_1",
    sourceTurnIndex: 1,
    sourceBranch: "main",
    targetBranch: "feature/a",
    commitSha: "abcdef123456",
    title: "Pick fix",
    summary: "apply focused fix",
    reason: "needed on feature branch",
    files: ["src/a.ts"],
    fileChanges: [{ status: "M", path: "src/a.ts" }],
    status: "review_collecting",
    createdAt: 1,
    updatedAt: 2,
    ...partial,
  };
}

describe("SyncFlowNode", () => {
  it("supports minimize/restore sizing and keeps its input handle", () => {
    const node: SyncFlowNodeType = {
      id: "sync:sync_flow_1",
      type: "syncFlow",
      position: { x: 0, y: 0 },
      width: 320,
      height: 220,
      data: { flow: flow(), onOpenDetails: vi.fn() },
    };

    const minimized = { ...node, ...toggleSyncFlowNodeWindow(node) } as SyncFlowNodeType;
    expect(minimized).toMatchObject({
      width: 76,
      height: 50,
      data: {
        windowState: {
          minimized: true,
          restoreWidth: 320,
          restoreHeight: 220,
        },
      },
    });

    const { container } = render(
      <ReactFlowProvider>
        <SyncFlowNode
          {...({ id: minimized.id, data: minimized.data } as unknown as NodeProps<SyncFlowNodeType>)}
        />
      </ReactFlowProvider>,
    );
    expect(container.querySelectorAll(".react-flow__handle")).toHaveLength(1);
    expect(screen.getByTitle("Restore sync node sync_flow_1")).toBeTruthy();
  });

  it("opens details when the node body is clicked", () => {
    const onOpenDetails = vi.fn();
    render(
      <ReactFlowProvider>
        <SyncFlowNode
          {...({
            id: "sync:sync_flow_1",
            data: { flow: flow(), onOpenDetails },
          } as unknown as NodeProps<SyncFlowNodeType>)}
        />
      </ReactFlowProvider>,
    );

    fireEvent.click(screen.getByText("apply focused fix"));
    expect(onOpenDetails).toHaveBeenCalledWith("sync_flow_1");
  });
});
