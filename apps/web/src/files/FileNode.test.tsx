// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ReactFlowProvider, type NodeProps } from "@xyflow/react";
import type { CanvasFileNode } from "@agent-canvas/shared";
import { FileNode, toggleFileNodeWindow, type FileNodeType } from "./FileNode.js";
import { api } from "../api.js";
import type { FileActions } from "../useAgentCanvas.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function file(partial: Partial<CanvasFileNode> = {}): CanvasFileNode {
  return {
    id: "file_1",
    name: "archive",
    extension: "bin",
    filename: "archive.bin",
    path: "C:/files/archive.bin",
    storage: "isolated",
    availability: "available",
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
    pick: vi.fn(),
    releasePickedSelection: vi.fn().mockResolvedValue(undefined),
    importPicked: vi.fn(),
    importDropped: vi.fn(),
    relink: vi.fn().mockResolvedValue(null),
    refresh: vi.fn().mockResolvedValue(null),
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

  it("外部引用只保留读 Handle，重命名时不能修改后缀", async () => {
    const fileActions = actions();
    const { container } = renderFile(
      file({ storage: "referenced", extension: "csv", filename: "archive.csv" }),
      fileActions,
    );

    expect(container.querySelectorAll(".react-flow__handle")).toHaveLength(1);
    expect(screen.getByText("外部引用 · 只读")).toBeTruthy();
    fireEvent.click(screen.getByTitle("重命名文件"));
    expect(screen.queryByLabelText("文件后缀")).toBeNull();
    fireEvent.change(screen.getByLabelText("文件名"), { target: { value: "source" } });
    fireEvent.click(screen.getByTitle("确认重命名"));

    await waitFor(() =>
      expect(fileActions.update).toHaveBeenCalledWith("file_1", { name: "source" }),
    );
  });

  it("失效引用显示重新定位入口，且共享引用隐藏全局写", async () => {
    const fileActions = actions();
    const onOpenEditor = vi.fn();
    const { container } = renderFile(
      file({
        storage: "referenced",
        availability: "missing",
        kind: "shared",
        sharedRead: true,
      }),
      fileActions,
      vi.fn(),
      onOpenEditor,
    );

    expect(screen.getByText("外部引用失效")).toBeTruthy();
    expect(screen.queryByLabelText("全局写")).toBeNull();
    const preview = container.querySelector<HTMLElement>(".file-node__preview")!;
    expect(preview.getAttribute("role")).toBeNull();
    expect(preview.tabIndex).toBe(-1);
    fireEvent.keyDown(preview, { key: "Enter" });
    expect(onOpenEditor).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("重新定位"));
    await waitFor(() => expect(fileActions.relink).toHaveBeenCalledWith("file_1"));
  });

  it("可用引用的文本预览错误不会伪装成引用失效", async () => {
    vi.spyOn(api, "fileContent").mockRejectedValue(new Error("preview unavailable"));
    const fileActions = actions();
    renderFile(
      file({
        storage: "referenced",
        availability: "available",
        previewKind: "text",
      }),
      fileActions,
    );

    expect(await screen.findByText("preview unavailable")).toBeTruthy();
    expect(screen.queryByText("外部引用失效")).toBeNull();
    expect(screen.queryByText("重新定位")).toBeNull();
    await waitFor(() => expect(fileActions.refresh).toHaveBeenCalledWith("file_1"));
  });

  it("可用引用的图片预览错误单独展示且仍可打开原文件", async () => {
    const fileActions = actions();
    const onOpenEditor = vi.fn();
    renderFile(
      file({
        storage: "referenced",
        availability: "available",
        previewKind: "image",
        mimeType: "image/png",
      }),
      fileActions,
      vi.fn(),
      onOpenEditor,
    );

    fireEvent.error(screen.getByRole("img", { name: "archive.bin" }));
    expect(await screen.findByText("图片预览失败")).toBeTruthy();
    expect(screen.queryByText("外部引用失效")).toBeNull();
    expect(screen.queryByText("重新定位")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "用 VS Code 打开 archive.bin" }));
    expect(onOpenEditor).toHaveBeenCalledWith("file_1");
    await waitFor(() => expect(fileActions.refresh).toHaveBeenCalledWith("file_1"));
  });

  it("有自身预览轮询的可用引用不额外轮询 availability", async () => {
    vi.spyOn(api, "fileContent").mockResolvedValue({ content: "live", truncated: false });
    const fileActions = actions();
    renderFile(
      file({
        storage: "referenced",
        availability: "available",
        previewKind: "text",
      }),
      fileActions,
    );

    expect(await screen.findByText("live")).toBeTruthy();
    expect(fileActions.refresh).not.toHaveBeenCalled();
  });

  it("无内嵌预览的外部引用也会刷新可用状态", async () => {
    const fileActions = actions();
    renderFile(
      file({ storage: "referenced", previewKind: "none", availability: "available" }),
      fileActions,
    );

    await waitFor(() => expect(fileActions.refresh).toHaveBeenCalledWith("file_1"));
  });
});
