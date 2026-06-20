// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CreateFileDialog } from "./CreateFileDialog.js";
import { newAgentView } from "../agentStore.js";

afterEach(cleanup);

describe("CreateFileDialog", () => {
  it("创建 Agent 工作目录中的共享 Markdown 文件", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(
      <CreateFileDialog
        agents={{ agent_1: newAgentView("agent_1") }}
        onCreate={onCreate}
        onClose={onClose}
      />,
    );

    fireEvent.change(screen.getByLabelText("新文件名"), { target: { value: "brief" } });
    fireEvent.change(screen.getByLabelText("新文件后缀"), {
      target: { value: "markdown" },
    });
    fireEvent.click(screen.getByText("共享节点"));
    fireEvent.click(screen.getByText("Agent 工作目录"));
    fireEvent.click(screen.getByText("创建"));

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith({
        name: "brief",
        extension: "markdown",
        kind: "shared",
        storage: "agent",
        agentId: "agent_1",
      }),
    );
    expect(onClose).toHaveBeenCalled();
  });
});
