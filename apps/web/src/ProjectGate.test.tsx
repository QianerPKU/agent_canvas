// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectGate } from "./App.js";

describe("ProjectGate", () => {
  afterEach(() => {
    cleanup();
  });

  it("creates a canvas project in a custom folder", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(
      <ProjectGate
        connected
        projects={[]}
        onOpen={vi.fn()}
        onCreate={onCreate}
      />,
    );

    fireEvent.change(screen.getByLabelText("Canvas 项目名称"), {
      target: { value: "Remote Canvas" },
    });
    fireEvent.change(screen.getByLabelText("Canvas 项目文件夹"), {
      target: { value: "/data/agent-canvas/remote" },
    });
    fireEvent.click(screen.getByText("新建"));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith("Remote Canvas", "/data/agent-canvas/remote");
    });
  });
});
