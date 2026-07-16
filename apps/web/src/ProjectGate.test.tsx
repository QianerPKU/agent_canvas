// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectGate } from "./App.js";

describe("ProjectGate", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("creates a canvas project in a custom folder", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(
      <ProjectGate
        connected
        projects={[]}
        onOpen={vi.fn()}
        onLoad={vi.fn()}
        onCreate={onCreate}
        onDelete={vi.fn()}
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

  it("loads a canvas project from an existing folder", async () => {
    const onLoad = vi.fn().mockResolvedValue(undefined);
    render(
      <ProjectGate
        connected
        projects={[]}
        onOpen={vi.fn()}
        onLoad={onLoad}
        onCreate={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("要加载的 Canvas 项目文件夹"), {
      target: { value: "/data/agent-canvas/existing" },
    });
    fireEvent.click(screen.getByText("加载"));

    await waitFor(() => {
      expect(onLoad).toHaveBeenCalledWith("/data/agent-canvas/existing");
    });
  });

  it("confirms before permanently deleting a project", async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(
      <ProjectGate
        connected
        projects={[
          {
            id: "project-1",
            name: "Disposable",
            projectRoot: "/data/agent-canvas/disposable",
            createdAt: 1,
          },
        ]}
        onOpen={vi.fn()}
        onLoad={vi.fn()}
        onCreate={vi.fn()}
        onDelete={onDelete}
      />,
    );

    fireEvent.click(screen.getByLabelText("删除项目 Disposable"));

    await waitFor(() => {
      expect(confirm).toHaveBeenCalledWith(expect.stringContaining("/data/agent-canvas/disposable"));
      expect(onDelete).toHaveBeenCalledWith("project-1");
    });
  });
});
