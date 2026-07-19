import { ApiError, api, isPickedFileSelectionExpiredError } from "./api.js";

describe("workspace partial-success responses", () => {
  afterEach(() => {
    api.setWorkspaceContext(undefined);
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

  it("adopts the authoritative workspace from a 207 project-open response", async () => {
    const payload = {
      workspace: {
        projectRoot: "/projects/target",
        canvasProject: { id: "project_target", name: "target" },
        branches: [],
      },
      partialSuccess: true,
      workDocumentation: { ready: false, error: "unsafe documentation link" },
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

    await expect(api.openCanvasProject({ id: "project_target" })).resolves.toMatchObject({
      projectRoot: "/projects/target",
      canvasProject: { id: "project_target" },
      partialSuccess: true,
      workDocumentation: { ready: false, error: "unsafe documentation link" },
    });
  });

  it("preserves authoritative partial state from a 207 project-create response", async () => {
    const payload = {
      project: { id: "project_created", name: "created", projectRoot: "/projects/created" },
      workspace: {
        projectRoot: "/projects/created",
        canvasProject: { id: "project_created", name: "created" },
        branches: [],
      },
      partialSuccess: true,
      workDocumentation: { ready: false, error: "unsafe persisted state" },
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

    await expect(
      api.createCanvasProject({ name: "created", projectRoot: "/projects/created" }),
    ).resolves.toMatchObject({
      project: { id: "project_created" },
      workspace: { canvasProject: { id: "project_created" } },
      partialSuccess: true,
      workDocumentation: { ready: false, error: "unsafe persisted state" },
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

  it("returns the deleted project identity for offline local cleanup", async () => {
    const payload = {
      project: {
        id: "project_deleted",
        name: "deleted",
        projectRoot: "/projects/deleted",
        createdAt: 1,
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(api.deleteCanvasProject("project_deleted")).resolves.toMatchObject({
      id: "project_deleted",
    });
  });

  it("sends the expected project identity with canvas layout saves", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ nodes: [], updatedAt: 1 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.saveCanvasLayout({ nodes: [], updatedAt: 1 }, "project_a");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      canvasProjectId: "project_a",
      nodes: [],
      updatedAt: 1,
    });
  });

  it("sends the expected project identity with permission settings", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ fullPermissionMode: true, workDocumentationEnabled: false }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.updateSettings({ fullPermissionMode: true }, "project_a");

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      fullPermissionMode: true,
      canvasProjectId: "project_a",
    });
  });

  it("sends the active project revision with project-local mutations", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          file: { id: "file_1", name: "notes", extension: "txt", kind: "normal" },
        }),
        {
          status: 201,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    api.setWorkspaceContext({
      canvasProject: {
        id: "project_a",
        name: "A",
        projectRoot: "/projects/a",
        createdAt: 1,
      },
      revision: 17,
      projectRoot: "/projects/a",
      branches: [],
      sharedResources: [],
    });

    await api.createFile({ name: "notes", extension: "txt", kind: "normal" });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get("X-Agent-Canvas-Project-Id")).toBe("project_a");
    expect(headers.get("X-Agent-Canvas-Project-Revision")).toBe("17");
  });

  it("does not downgrade the active context for an older frame from the same project", async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      new Response(
        JSON.stringify({
          file: { id: "file_1", name: "notes", extension: "txt", kind: "normal" },
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const workspace = (id: string, revision: number) => ({
      canvasProject: {
        id,
        name: id,
        projectRoot: `/projects/${id}`,
        createdAt: 1,
      },
      revision,
      projectRoot: `/projects/${id}`,
      branches: [],
      sharedResources: [],
    });

    api.setWorkspaceContext(workspace("project_a", 3));
    api.setWorkspaceContext(workspace("project_a", 2));
    await api.createFile({ name: "notes", extension: "txt", kind: "normal" });

    let headers = new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers);
    expect(headers.get("X-Agent-Canvas-Project-Id")).toBe("project_a");
    expect(headers.get("X-Agent-Canvas-Project-Revision")).toBe("3");

    api.setWorkspaceContext(workspace("project_b", 1));
    await api.createFile({ name: "notes", extension: "txt", kind: "normal" });
    headers = new Headers((fetchMock.mock.calls[1]?.[1] as RequestInit).headers);
    expect(headers.get("X-Agent-Canvas-Project-Id")).toBe("project_b");
    expect(headers.get("X-Agent-Canvas-Project-Revision")).toBe("1");
  });
});

describe("file import API", () => {
  afterEach(() => {
    api.setWorkspaceContext(undefined);
    vi.unstubAllGlobals();
  });

  it("sends dropped file bytes as an octet stream while preserving the filename", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ file: { id: "file_1" } }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const upload = new Blob(["hello"], { type: "text/plain" }) as File;
    Object.defineProperty(upload, "name", { value: "my notes.txt" });

    await api.importUploadedFile(upload, "shared");

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/files/import-upload?filename=my%20notes.txt&kind=shared",
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.body).toBe(upload);
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/octet-stream");
  });

  it("passes the staged selection, import mode and node range", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ files: [] }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.importPickedFiles({
      selectionId: "file_selection_1",
      mode: "reference",
      kind: "normal",
    });

    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual({
      selectionId: "file_selection_1",
      mode: "reference",
      kind: "normal",
    });
  });

  it("exposes a structured expired-selection response without parsing its message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            code: "picked_selection_expired",
            error: "localized server detail can change",
          }),
          {
            status: 410,
            headers: { "Content-Type": "application/json" },
          },
        ),
      ),
    );

    let caught: unknown;
    try {
      await api.importPickedFiles({
        selectionId: "file_selection_expired",
        mode: "copy",
        kind: "normal",
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect(caught).toMatchObject({ status: 410, code: "picked_selection_expired" });
    expect(isPickedFileSelectionExpiredError(caught)).toBe(true);
  });

  it("keeps an upload on its captured workspace after the active project changes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ file: { id: "file_1" } }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const workspace = (id: string, revision: number) => ({
      canvasProject: {
        id,
        name: id,
        projectRoot: `/projects/${id}`,
        createdAt: 1,
      },
      revision,
      projectRoot: `/projects/${id}`,
      branches: [],
      sharedResources: [],
    });
    api.setWorkspaceContext(workspace("project_a", 4));
    const captured = api.captureWorkspaceContext();
    api.setWorkspaceContext(workspace("project_b", 1));

    await api.importUploadedFile(new File(["hello"], "notes.txt"), "normal", captured);

    const headers = new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers);
    expect(headers.get("X-Agent-Canvas-Project-Id")).toBe("project_a");
    expect(headers.get("X-Agent-Canvas-Project-Revision")).toBe("4");
  });
});
