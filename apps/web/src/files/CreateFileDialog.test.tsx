// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiError } from "../api.js";
import { CreateFileDialog } from "./CreateFileDialog.js";

afterEach(cleanup);

describe("CreateFileDialog", () => {
  it("固定在隔离目录中创建共享 Markdown 文件", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(
      <CreateFileDialog
        onCreate={onCreate}
        onPick={vi.fn().mockResolvedValue(null)}
        onImportPicked={vi.fn()}
        onImportDropped={vi.fn()}
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
        storage: "isolated",
      }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("浏览多个文件后只选择节点范围和复制或引用", async () => {
    const onImportPicked = vi.fn().mockResolvedValue(undefined);
    render(
      <CreateFileDialog
        onCreate={vi.fn()}
        onPick={vi.fn().mockResolvedValue({
          id: "selection_1",
          files: [
            { name: "brief", extension: "md", filename: "brief.md", size: 120 },
            { name: "photo", extension: "png", filename: "photo.png", size: 2048 },
          ],
        })}
        onImportPicked={onImportPicked}
        onImportDropped={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("浏览"));
    expect(await screen.findByText("brief.md")).toBeTruthy();
    expect(screen.getByText("photo.png")).toBeTruthy();
    expect(screen.queryByLabelText("新文件后缀")).toBeNull();
    fireEvent.click(screen.getByText("共享节点"));
    fireEvent.click(screen.getByText("仅引用原文件"));
    fireEvent.click(screen.getByText("创建 2 个节点"));

    await waitFor(() =>
      expect(onImportPicked).toHaveBeenCalledWith({
        selectionId: "selection_1",
        mode: "reference",
        kind: "shared",
      }),
    );
  });

  it("拖入多个文件时固定复制并保留原文件名", async () => {
    const dropped = [
      new File(["hello"], "notes.txt", { type: "text/plain" }),
      new File([new Uint8Array([1, 2])], "image.png", { type: "image/png" }),
    ];
    const onImportDropped = vi.fn().mockResolvedValue({ imported: [], failures: [] });
    render(
      <CreateFileDialog
        droppedFiles={dropped}
        onCreate={vi.fn()}
        onPick={vi.fn()}
        onImportPicked={vi.fn()}
        onImportDropped={onImportDropped}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("notes.txt")).toBeTruthy();
    expect(screen.getByText("image.png")).toBeTruthy();
    expect(screen.getByText("复制到项目")).toBeTruthy();
    expect(screen.queryByText("仅引用原文件")).toBeNull();
    fireEvent.click(screen.getByText("创建 2 个节点"));

    await waitFor(() =>
      expect(onImportDropped).toHaveBeenCalledWith(dropped, "normal", [0, 1]),
    );
  });

  it("批量部分失败后只保留失败文件供重试", async () => {
    const first = new File(["ok"], "ok.txt", { type: "text/plain" });
    const second = new File(["bad"], "bad.txt", { type: "text/plain" });
    const onImportDropped = vi
      .fn()
      .mockResolvedValueOnce({
        imported: [{}],
        failures: [{ file: second, reason: "413 too large" }],
      })
      .mockResolvedValueOnce({ imported: [{}], failures: [] });
    const onClose = vi.fn();
    render(
      <CreateFileDialog
        droppedFiles={[first, second]}
        onCreate={vi.fn()}
        onPick={vi.fn()}
        onImportPicked={vi.fn()}
        onImportDropped={onImportDropped}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByText("创建 2 个节点"));
    expect(await screen.findByText("创建 1 个节点")).toBeTruthy();
    expect(screen.queryByText("ok.txt")).toBeNull();
    expect(screen.getByText("bad.txt")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("1 个文件已创建");
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("创建 1 个节点"));
    await waitFor(() =>
      expect(onImportDropped).toHaveBeenLastCalledWith([second], "normal", [1]),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("导入进行中禁止关闭弹窗", async () => {
    let finish!: (result: { imported: []; failures: [] }) => void;
    const importing = new Promise<{ imported: []; failures: [] }>((resolve) => {
      finish = resolve;
    });
    const onClose = vi.fn();
    render(
      <CreateFileDialog
        droppedFiles={[new File(["hello"], "notes.txt")]}
        onCreate={vi.fn()}
        onPick={vi.fn()}
        onImportPicked={vi.fn()}
        onImportDropped={vi.fn().mockReturnValue(importing)}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByText("创建 1 个节点"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByText("取消")).toHaveProperty("disabled", true);
    expect(screen.getByTitle("关闭")).toHaveProperty("disabled", true);
    expect(onClose).not.toHaveBeenCalled();

    finish({ imported: [], failures: [] });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("选择凭据失败后要求重新浏览并释放旧凭据", async () => {
    const onRelease = vi.fn().mockResolvedValue(undefined);
    const view = render(
      <CreateFileDialog
        onCreate={vi.fn()}
        onPick={vi.fn().mockResolvedValue({
          id: "selection_expiring",
          files: [{ name: "brief", extension: "md", filename: "brief.md", size: 20 }],
        })}
        onReleasePickedSelection={onRelease}
        onImportPicked={vi
          .fn()
          .mockRejectedValue(
            new ApiError(
              410,
              '{"code":"picked_selection_expired","error":"expired"}',
              "picked_selection_expired",
            ),
          )}
        onImportDropped={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("浏览"));
    fireEvent.click(await screen.findByText("创建 1 个节点"));
    expect((await screen.findByRole("alert")).textContent).toContain("请重新浏览");
    expect(screen.queryByText("brief.md")).toBeNull();
    expect(screen.getByRole("button", { name: "创建" })).toHaveProperty("disabled", true);
    expect(onRelease).toHaveBeenCalledWith("selection_expiring");
    view.unmount();
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  it("普通导入失败时保留选择凭据并允许原选择重试", async () => {
    const onRelease = vi.fn().mockResolvedValue(undefined);
    const onImportPicked = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(400, '{"error":"disk full"}'))
      .mockResolvedValueOnce(undefined);
    const onClose = vi.fn();
    render(
      <CreateFileDialog
        onCreate={vi.fn()}
        onPick={vi.fn().mockResolvedValue({
          id: "selection_retryable",
          files: [{ name: "brief", extension: "md", filename: "brief.md", size: 20 }],
        })}
        onReleasePickedSelection={onRelease}
        onImportPicked={onImportPicked}
        onImportDropped={vi.fn()}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByText("浏览"));
    fireEvent.click(await screen.findByText("创建 1 个节点"));
    expect((await screen.findByRole("alert")).textContent).toContain("disk full");
    expect(screen.getByText("brief.md")).toBeTruthy();
    expect(screen.getByRole("button", { name: "创建 1 个节点" })).toHaveProperty(
      "disabled",
      false,
    );
    expect(onRelease).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "创建 1 个节点" }));
    await waitFor(() => expect(onImportPicked).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(onRelease).not.toHaveBeenCalled();
  });

  it("提供模态框和分段选项的可访问状态", () => {
    render(
      <CreateFileDialog
        droppedFiles={[new File(["hello"], "notes.txt")]}
        onCreate={vi.fn()}
        onPick={vi.fn()}
        onImportPicked={vi.fn()}
        onImportDropped={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "导入文件节点" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByRole("button", { name: "隔离节点" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByRole("button", { name: "共享节点" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "隔离节点" }));

    screen.getByRole("button", { name: "关闭" }).focus();
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "创建 1 个节点" }));
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "关闭" }));
  });

  it("弹窗在系统选择器返回前卸载时释放迟到的选择凭据", async () => {
    let finishPick!: (selection: {
      id: string;
      files: Array<{ name: string; extension: string; filename: string; size: number }>;
    }) => void;
    const picking = new Promise<Parameters<typeof finishPick>[0]>((resolve) => {
      finishPick = resolve;
    });
    const onRelease = vi.fn().mockResolvedValue(undefined);
    const view = render(
      <CreateFileDialog
        onCreate={vi.fn()}
        onPick={vi.fn().mockReturnValue(picking)}
        onReleasePickedSelection={onRelease}
        onImportPicked={vi.fn()}
        onImportDropped={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("浏览"));
    view.unmount();
    await act(async () => {
      finishPick({
        id: "selection_late",
        files: [{ name: "late", extension: "txt", filename: "late.txt", size: 4 }],
      });
      await picking;
    });

    await waitFor(() => expect(onRelease).toHaveBeenCalledWith("selection_late"));
  });
});
