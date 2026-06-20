// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CanvasFileNode } from "@agent-canvas/shared";
import { FileContentWindow } from "./FileContentWindow.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function file(partial: Partial<CanvasFileNode> = {}): CanvasFileNode {
  return {
    id: "file_1",
    name: "notes",
    extension: "txt",
    filename: "notes.txt",
    path: "C:/files/notes.txt",
    storage: "isolated",
    kind: "normal",
    sharedRead: false,
    sharedWrite: false,
    previewKind: "text",
    mimeType: "text/plain; charset=utf-8",
    createdAt: 1,
    updatedAt: 2,
    ...partial,
  };
}

describe("FileContentWindow", () => {
  it("读取不截断的完整文本并支持关闭", async () => {
    const fullContent = `第一行\n${"完整内容".repeat(1000)}`;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ content: fullContent, truncated: false }),
      text: async () => "",
    });
    vi.stubGlobal("fetch", fetchMock);
    const onClose = vi.fn();

    const { container } = render(
      <FileContentWindow file={file()} onClose={onClose} onOpenEditor={vi.fn()} />,
    );

    await screen.findByTitle("关闭文件窗口");
    await vi.waitFor(() => {
      expect(container.querySelector(".file-content-window__body pre")?.textContent).toBe(
        fullContent,
      );
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/files/file_1/content?full=1",
      expect.any(Object),
    );

    fireEvent.click(screen.getByTitle("关闭文件窗口"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("图片使用原始文件地址显示", () => {
    render(
      <FileContentWindow
        file={file({
          extension: "png",
          filename: "shot.png",
          previewKind: "image",
          mimeType: "image/png",
        })}
        onClose={vi.fn()}
        onOpenEditor={vi.fn()}
      />,
    );

    expect(screen.getByAltText("shot.png").getAttribute("src")).toBe(
      "/api/files/file_1/raw?v=2",
    );
  });
});
