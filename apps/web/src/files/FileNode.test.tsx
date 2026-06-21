// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ReactFlowProvider, type NodeProps } from "@xyflow/react";
import type { CanvasFileNode } from "@agent-canvas/shared";
import { FileNode, toggleFileNodeWindow, type FileNodeType } from "./FileNode.js";
import type { FileActions } from "../useAgentCanvas.js";

afterEach(cleanup);

function file(partial: Partial<CanvasFileNode> = {}): CanvasFileNode {
  return {
    id: "file_1",
    name: "archive",
    extension: "bin",
    filename: "archive.bin",
    path: "C:/files/archive.bin",
    storage: "isolated",
    kind: "normal",
    sharedRead: false,
    sharedWrite: false,
    previewKind: "none",
    mimeType: "application/octet-stream",
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  };
}

function actions(): FileActions {
  return {
    create: vi.fn(),
    update: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
}

function renderFile(
  fileData: CanvasFileNode,
  fileActions: FileActions,
  onPreview = vi.fn(),
  onOpenEditor = vi.fn(),
) {
  return render(
    <ReactFlowProvider>
      <FileNode
        {...({
          id: `file:${fileData.id}`,
          data: { file: fileData, actions: fileActions, onPreview, onOpenEditor },
        } as unknown as NodeProps<FileNodeType>)}
      />
    </ReactFlowProvider>,
  );
}

describe("FileNode", () => {
  it("最小化保存尺寸，并在最小化后保留读写 Handle", () => {
    const fileData = file();
    const fileActions = actions();
    const node: FileNodeType = {
      id: "file:file_1",
      type: "file",
      position: { x: 0, y: 0 },
      width: 320,
      height: 260,
      data: {
        file: fileData,
        actions: fileActions,
        onPreview: vi.fn(),
        onOpenEditor: vi.fn(),
      },
    };

    const minimized = { ...node, ...toggleFileNodeWindow(node) } as FileNodeType;
    expect(minimized).toMatchObject({
      width: 68,
      height: 48,
      data: {
        windowState: {
          minimized: true,
          restoreWidth: 320,
          restoreHeight: 260,
        },
      },
    });

    const { container } = render(
      <ReactFlowProvider>
        <FileNode {...({ id: minimized.id, data: minimized.data } as unknown as NodeProps<FileNodeType>)} />
      </ReactFlowProvider>,
    );
    expect(container.querySelectorAll(".react-flow__handle")).toHaveLength(2);
    const restoreButton = screen.getByTitle("恢复文件节点 archive.bin");
    expect(restoreButton.classList.contains("drag-handle")).toBe(true);
    expect(restoreButton.classList.contains("nodrag")).toBe(false);
  });

  it("普通节点显示读写 Handle，并支持重命名和后缀选择", async () => {
    const fileActions = actions();
    const { container } = renderFile(file(), fileActions);
    expect(container.querySelectorAll(".react-flow__handle")).toHaveLength(2);
    expect(container.querySelector(".react-flow__resize-control")).toBeTruthy();

    fireEvent.click(screen.getByTitle("重命名文件"));
    fireEvent.change(screen.getByLabelText("文件名"), { target: { value: "report" } });
    fireEvent.change(screen.getByLabelText("文件后缀"), { target: { value: "md" } });
    fireEvent.click(screen.getByTitle("确认重命名"));

    await waitFor(() =>
      expect(fileActions.update).toHaveBeenCalledWith("file_1", {
        name: "report",
        extension: "md",
      }),
    );
  });

  it("共享节点不显示 Handle，并提供全局读写开关", () => {
    const fileActions = actions();
    const { container } = renderFile(
      file({ kind: "shared", sharedRead: true, sharedWrite: false }),
      fileActions,
    );
    expect(container.querySelectorAll(".react-flow__handle")).toHaveLength(0);

    const read = screen.getByLabelText("全局读");
    const write = screen.getByLabelText("全局写");
    expect((read as HTMLInputElement).checked).toBe(true);
    fireEvent.click(write);
    expect(fileActions.update).toHaveBeenCalledWith("file_1", { sharedWrite: true });
  });

  it("点击预览区默认用 VS Code 打开，查看按钮打开画布内窗口", () => {
    const onPreview = vi.fn();
    const onOpenEditor = vi.fn();
    renderFile(file(), actions(), onPreview, onOpenEditor);

    fireEvent.click(screen.getByRole("button", { name: "用 VS Code 打开 archive.bin" }));
    fireEvent.click(screen.getByTitle("用 VS Code 打开"));
    fireEvent.click(screen.getByTitle("查看完整内容"));

    expect(onOpenEditor).toHaveBeenCalledTimes(2);
    expect(onOpenEditor).toHaveBeenLastCalledWith("file_1");
    expect(onPreview).toHaveBeenCalledWith("file_1");
  });
});
