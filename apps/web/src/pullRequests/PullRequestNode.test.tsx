// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ReactFlowProvider, type NodeProps } from "@xyflow/react";
import type { PullRequestFlowSnapshot } from "@agent-canvas/shared";
import {
  PullRequestNode,
  togglePullRequestNodeWindow,
  type PullRequestNodeType,
} from "./PullRequestNode.js";

afterEach(cleanup);

function flow(partial: Partial<PullRequestFlowSnapshot> = {}): PullRequestFlowSnapshot {
  return {
    id: "pr_flow_1",
    proposerAgentId: "agent_1",
    sourceTurnIndex: 1,
    sourceBranch: "feature/a",
    targetBranch: "main",
    title: "Feature A",
    summary: "merge feature a",
    files: ["src/a.ts"],
    fileChanges: [{ status: "M", path: "src/a.ts" }],
    status: "target_review_collecting",
    createdAt: 1,
    updatedAt: 2,
    reviewRequests: [],
    ...partial,
  };
}

describe("PullRequestNode", () => {
  it("supports minimize/restore sizing and keeps its input handle", () => {
    const node: PullRequestNodeType = {
      id: "pr:pr_flow_1",
      type: "pullRequest",
      position: { x: 0, y: 0 },
      width: 320,
      height: 220,
      data: { flow: flow(), onOpenDetails: vi.fn() },
    };

    const minimized = { ...node, ...togglePullRequestNodeWindow(node) } as PullRequestNodeType;
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
        <PullRequestNode
          {...({ id: minimized.id, data: minimized.data } as unknown as NodeProps<PullRequestNodeType>)}
        />
      </ReactFlowProvider>,
    );
    expect(container.querySelectorAll(".react-flow__handle")).toHaveLength(1);
    expect(screen.getByTitle("恢复 PR 节点 pr_flow_1")).toBeTruthy();
  });

  it("opens details when the node body is clicked", () => {
    const onOpenDetails = vi.fn();
    render(
      <ReactFlowProvider>
        <PullRequestNode
          {...({
            id: "pr:pr_flow_1",
            data: { flow: flow(), onOpenDetails },
          } as unknown as NodeProps<PullRequestNodeType>)}
        />
      </ReactFlowProvider>,
    );

    fireEvent.click(screen.getByText("merge feature a"));
    expect(onOpenDetails).toHaveBeenCalledWith("pr_flow_1");
  });

  it("uses PR metadata when the submitted flow text is encoding-damaged", () => {
    render(
      <ReactFlowProvider>
        <PullRequestNode
          {...({
            id: "pr:pr_flow_1",
            data: {
              flow: flow({
                title: "????????",
                summary: "????????????",
                pr: {
                  title: "修复节点乱码",
                  summary: "确保 PR 节点正常显示中文",
                  files: [],
                  fileChanges: [],
                  createdAt: 3,
                },
              }),
              onOpenDetails: vi.fn(),
            },
          } as unknown as NodeProps<PullRequestNodeType>)}
        />
      </ReactFlowProvider>,
    );

    expect(screen.getByText("修复节点乱码")).toBeTruthy();
    expect(screen.getByText("确保 PR 节点正常显示中文")).toBeTruthy();
    expect(screen.queryByText("????????????")).toBeNull();
  });
});
