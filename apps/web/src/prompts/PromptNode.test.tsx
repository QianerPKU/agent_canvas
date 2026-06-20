// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ReactFlowProvider, type NodeProps } from "@xyflow/react";
import type { CanvasPromptNode } from "@agent-canvas/shared";
import { PromptNode, type PromptNodeType } from "./PromptNode.js";
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
  it("普通节点显示读写 Handle，并可编辑保存文本", async () => {
    const promptActions = actions();
    const { container } = renderPrompt(prompt(), promptActions);
    expect(container.querySelectorAll(".react-flow__handle")).toHaveLength(2);

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
