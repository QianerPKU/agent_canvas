// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ReactFlowProvider, type NodeProps } from "@xyflow/react";
import type { CanvasPromptNode } from "@agent-canvas/shared";
import { PromptNode, togglePromptNodeWindow, type PromptNodeType } from "./PromptNode.js";
import type { PromptActions } from "../useAgentCanvas.js";

afterEach(cleanup);

function prompt(partial: Partial<CanvasPromptNode> = {}): CanvasPromptNode {
  return {
    id: "prompt_1",
    name: "工程规范",
    content: "先写测试",
    kind: "normal",
    sharedRead: false,
    sharedWrite: false,
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  };
}

function actions(): PromptActions {
  return {
    create: vi.fn(),
    update: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
}

function renderPrompt(promptData: CanvasPromptNode, promptActions: PromptActions) {
  return render(
    <ReactFlowProvider>
      <PromptNode
        {...({
          id: `prompt:${promptData.id}`,
          data: { prompt: promptData, actions: promptActions },
        } as unknown as NodeProps<PromptNodeType>)}
      />
    </ReactFlowProvider>,
  );
}

describe("PromptNode", () => {
  it("最小化保存尺寸，并在最小化后保留读写 Handle", () => {
    const promptData = prompt();
    const promptActions = actions();
    const node: PromptNodeType = {
      id: "prompt:prompt_1",
      type: "prompt",
      position: { x: 0, y: 0 },
      width: 340,
      height: 280,
      data: {
        prompt: promptData,
        actions: promptActions,
      },
    };

    const minimized = { ...node, ...togglePromptNodeWindow(node) } as PromptNodeType;
    expect(minimized).toMatchObject({
      width: 68,
      height: 48,
      data: {
        windowState: {
          minimized: true,
          restoreWidth: 340,
          restoreHeight: 280,
        },
      },
    });

    const { container } = render(
      <ReactFlowProvider>
        <PromptNode {...({ id: minimized.id, data: minimized.data } as unknown as NodeProps<PromptNodeType>)} />
      </ReactFlowProvider>,
    );
    expect(container.querySelectorAll(".react-flow__handle")).toHaveLength(2);
    const restoreButton = screen.getByTitle("恢复提示词节点 工程规范");
    expect(restoreButton.classList.contains("drag-handle")).toBe(true);
    expect(restoreButton.classList.contains("nodrag")).toBe(false);
  });

  it("普通节点显示读写 Handle，并可编辑保存文本", async () => {
    const promptActions = actions();
    const { container } = renderPrompt(prompt(), promptActions);
    expect(container.querySelectorAll(".react-flow__handle")).toHaveLength(2);
    expect(container.querySelector(".react-flow__resize-control")).toBeTruthy();
    expect(screen.queryByLabelText("提示词节点名称")).toBeNull();

    fireEvent.change(screen.getByLabelText("工程规范 内容"), {
      target: { value: "先测试，再实现" },
    });
    fireEvent.click(screen.getByTitle("保存提示词"));
    await waitFor(() =>
      expect(promptActions.update).toHaveBeenCalledWith("prompt_1", {
        name: "工程规范",
        content: "先测试，再实现",
      }),
    );
  });

  it("名称只通过重命名按钮进入输入态，避免标题栏误触", async () => {
    const promptActions = actions();
    renderPrompt(prompt(), promptActions);
    expect(screen.getByText("工程规范")).toBeTruthy();
    expect(screen.queryByLabelText("提示词节点名称")).toBeNull();

    fireEvent.click(screen.getByTitle("重命名提示词"));
    fireEvent.change(screen.getByLabelText("提示词节点名称"), {
      target: { value: "新规范" },
    });
    fireEvent.click(screen.getByTitle("确认重命名"));

    await waitFor(() =>
      expect(promptActions.update).toHaveBeenCalledWith("prompt_1", {
        name: "新规范",
      }),
    );
  });

  it("共享节点不显示 Handle，并提供全局读写开关", () => {
    const promptActions = actions();
    const { container } = renderPrompt(
      prompt({ kind: "shared", sharedRead: true }),
      promptActions,
    );
    expect(container.querySelectorAll(".react-flow__handle")).toHaveLength(0);
    fireEvent.click(screen.getByLabelText("全局写"));
    expect(promptActions.update).toHaveBeenCalledWith("prompt_1", {
      sharedWrite: true,
    });
  });
});
