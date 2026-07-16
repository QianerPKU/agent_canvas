import { api } from "./api.js";

describe("workspace partial-success responses", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preserves documentation failure metadata from a 207 connect response", async () => {
    const payload = {
      projectRoot: "/project",
      branches: [],
      partialSuccess: true,
      workDocumentation: { ready: false, error: "tracked index" },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(payload), {
          status: 207,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(api.connectWorkspace({ localPath: "/repo" })).resolves.toMatchObject({
      partialSuccess: true,
      workDocumentation: { ready: false, error: "tracked index" },
    });
  });

  it("preserves documentation failure metadata when unwrapping a created branch", async () => {
    const payload = {
      branch: { id: "branch_1", branch: "feature/docs", worktreePath: "/worktree" },
      partialSuccess: true,
      workDocumentation: { ready: false, error: "link changed" },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(payload), {
          status: 207,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(api.createBranch({ branch: "feature/docs" })).resolves.toMatchObject({
      branch: "feature/docs",
      partialSuccess: true,
      workDocumentation: { ready: false, error: "link changed" },
    });
  });
});
