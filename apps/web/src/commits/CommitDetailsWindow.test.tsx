// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AgentCommitSnapshot } from "@agent-canvas/shared";
import { CommitDetailsWindow } from "./CommitDetailsWindow.js";

afterEach(cleanup);

function commit(partial: Partial<AgentCommitSnapshot> = {}): AgentCommitSnapshot {
  return {
    id: "commit_1",
    agentId: "agent_1",
    sourceTurnIndex: 0,
    commitSha: "abcdef1234567890",
    shortSha: "abcdef1",
    branch: "feature/a",
    subject: "feat: add app",
    summary: "add app",
    files: [
      {
        status: "M",
        path: "src/app.ts",
        additions: 1,
        deletions: 1,
        diff: [
          "diff --git a/src/app.ts b/src/app.ts",
          "index 1111111..2222222 100644",
          "--- a/src/app.ts",
          "+++ b/src/app.ts",
          "@@ -1,2 +1,2 @@",
          " const keep = true;",
          "-const oldName = 1;",
          "+const newName = 1;",
        ].join("\n"),
      },
    ],
    createdAt: 1,
    ...partial,
  };
}

describe("CommitDetailsWindow", () => {
  it("renders changed file diffs with addition and deletion rows", () => {
    const { container } = render(
      <CommitDetailsWindow commit={commit()} onClose={vi.fn()} />,
    );

    fireEvent.click(screen.getByText("src/app.ts"));

    expect(screen.getByText("const oldName = 1;")).toBeTruthy();
    expect(screen.getByText("const newName = 1;")).toBeTruthy();
    expect(container.querySelector(".commit-diff__row--deletion")).toBeTruthy();
    expect(container.querySelector(".commit-diff__row--addition")).toBeTruthy();
    expect(container.querySelector(".commit-diff__row--hunk")).toBeTruthy();
  });
});
