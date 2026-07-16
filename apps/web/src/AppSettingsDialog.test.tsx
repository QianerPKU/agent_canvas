// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { AppSettingsDialog } from "./App.js";

afterEach(cleanup);

describe("AppSettingsDialog", () => {
  it("updates work documentation mode and disables both toggles while saving", async () => {
    let finish!: () => void;
    const onUpdate = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    render(
      <AppSettingsDialog
        settings={{
          fullPermissionMode: false,
          workDocumentationEnabled: false,
        }}
        onUpdate={onUpdate}
        onRefreshCodexUsage={vi.fn().mockResolvedValue(undefined)}
        onClose={vi.fn()}
      />,
    );

    const documentationToggle = screen.getByRole("checkbox", {
      name: /工作文档维护/u,
    });
    const permissionToggle = screen.getByRole("checkbox", {
      name: /完全权限模式/u,
    });
    expect(documentationToggle).not.toBeChecked();

    fireEvent.click(documentationToggle);
    expect(onUpdate).toHaveBeenCalledWith({ workDocumentationEnabled: true });
    await waitFor(() => {
      expect(documentationToggle).toBeDisabled();
      expect(permissionToggle).toBeDisabled();
    });

    finish();
    await waitFor(() => expect(documentationToggle).not.toBeDisabled());
  });

  it("shows a settings update error without closing the dialog", async () => {
    render(
      <AppSettingsDialog
        settings={{
          fullPermissionMode: false,
          workDocumentationEnabled: true,
        }}
        onUpdate={vi.fn().mockRejectedValue(new Error("save failed"))}
        onRefreshCodexUsage={vi.fn().mockResolvedValue(undefined)}
        onClose={vi.fn()}
      />,
    );

    const documentationToggle = screen.getByRole("checkbox", {
      name: /工作文档维护/u,
    });
    expect(documentationToggle).toBeChecked();
    fireEvent.click(documentationToggle);

    expect(await screen.findByText("save failed")).toBeInTheDocument();
    expect(documentationToggle).toBeChecked();
  });
});
