// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CreatePromptDialog } from "./CreatePromptDialog.js";

afterEach(cleanup);

describe("CreatePromptDialog", () => {
  it("创建共享纯文本提示词节点", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<CreatePromptDialog onCreate={onCreate} onClose={onClose} />);

    fireEvent.change(screen.getByLabelText("提示词名称"), {
      target: { value: "工程规范" },
    });
    fireEvent.change(screen.getByLabelText("提示词内容"), {
      target: { value: "先写测试" },
    });
    fireEvent.click(screen.getByText("共享节点"));
    fireEvent.click(screen.getByText("创建"));

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith({
        name: "工程规范",
        content: "先写测试",
        kind: "shared",
      }),
    );
    expect(onClose).toHaveBeenCalled();
  });
});
