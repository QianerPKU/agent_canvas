// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CreateFileDialog } from "./CreateFileDialog.js";

afterEach(cleanup);

describe("CreateFileDialog", () => {
  it("默认在工作目录中创建共享 Markdown 文件", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    const defaultDirectory = "E:\\work";
    render(
      <CreateFileDialog
        defaultDirectory={defaultDirectory}
        onBrowseDirectory={vi.fn()}
        onCreate={onCreate}
        onClose={onClose}
      />,
    );

    fireEvent.change(screen.getByLabelText("新文件名"), { target: { value: "brief" } });
    fireEvent.change(screen.getByLabelText("新文件后缀"), {
      target: { value: "markdown" },
    });
    fireEvent.click(screen.getByText("共享节点"));
    fireEvent.click(screen.getByText("创建"));

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith({
        name: "brief",
        extension: "markdown",
        kind: "shared",
        storage: "agent",
        directory: defaultDirectory,
      }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("支持浏览并替换工作目录", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    const defaultDirectory = "E:\\work";
    const selectedDirectory = "D:\\target";
    render(
      <CreateFileDialog
        defaultDirectory={defaultDirectory}
        onBrowseDirectory={vi.fn().mockResolvedValue(selectedDirectory)}
        onCreate={onCreate}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTitle("浏览目录"));

    await waitFor(() => {
      expect((screen.getByLabelText("文件工作目录") as HTMLInputElement).value).toBe(
        selectedDirectory,
      );
    });
  });
});
