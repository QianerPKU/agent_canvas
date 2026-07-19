// @vitest-environment jsdom
import { StrictMode, type PropsWithChildren } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api.js";
import { useAgentCanvas } from "./useAgentCanvas.js";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  onopen: WebSocket["onopen"] = null;
  onclose: WebSocket["onclose"] = null;
  onerror: WebSocket["onerror"] = null;
  onmessage: WebSocket["onmessage"] = null;
  close = vi.fn();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
}

function StrictWrapper({ children }: PropsWithChildren) {
  return <StrictMode>{children}</StrictMode>;
}

function mockEmptyRefresh(): void {
  vi.spyOn(api, "list").mockResolvedValue([]);
  vi.spyOn(api, "listFiles").mockResolvedValue([]);
  vi.spyOn(api, "listFileConnections").mockResolvedValue([]);
  vi.spyOn(api, "listPrompts").mockResolvedValue([]);
  vi.spyOn(api, "listPromptConnections").mockResolvedValue([]);
  vi.spyOn(api, "listPullRequestFlows").mockResolvedValue([]);
  vi.spyOn(api, "listSyncFlows").mockResolvedValue([]);
  vi.spyOn(api, "listCommits").mockResolvedValue([]);
  vi.spyOn(api, "history").mockResolvedValue([]);
}

function sendWorkspaceFrame(
  socket: FakeWebSocket,
  projectId: string,
  workDocumentation: { ready: boolean; error?: string } = { ready: true },
  revision = 1,
): void {
  socket.onmessage?.call(
    socket as unknown as WebSocket,
    {
      data: JSON.stringify({
        type: "workspace",
        workspace: {
          projectRoot: `/projects/${projectId}`,
          revision,
          canvasProject: {
            id: projectId,
            name: projectId,
            projectRoot: `/projects/${projectId}`,
            createdAt: 1,
          },
          branches: [],
          sharedResources: [],
        },
        workDocumentation,
      }),
    } as MessageEvent,
  );
}

function sendHelloFrame(socket: FakeWebSocket, agentId: string): void {
  socket.onmessage?.call(
    socket as unknown as WebSocket,
    {
      data: JSON.stringify({
        type: "hello",
        agents: [
          {
            id: agentId,
            status: "idle",
            config: { prompt: "" },
            createdAt: 1,
            lastEventSeq: 0,
          },
        ],
        histories: {},
        prFlows: [],
        syncFlows: [],
        commits: [],
      }),
    } as MessageEvent,
  );
}

afterEach(() => {
  api.setWorkspaceContext(undefined);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  FakeWebSocket.instances = [];
});

describe("useAgentCanvas", () => {
  it("React StrictMode 下只建立一个 WebSocket", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const { unmount } = renderHook(() => useAgentCanvas(), {
      wrapper: StrictWrapper,
    });

    expect(FakeWebSocket.instances).toHaveLength(0);
    act(() => vi.runOnlyPendingTimers());
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0]!.url).toBe("ws://localhost:3000/ws");

    unmount();
    expect(FakeWebSocket.instances[0]!.close).toHaveBeenCalledOnce();
  });

  it("publishes an authoritative workspace switch frame to the app", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const { result, unmount } = renderHook(() => useAgentCanvas());
    act(() => vi.runOnlyPendingTimers());
    const socket = FakeWebSocket.instances[0]!;
    act(() => {
      socket.onmessage?.call(
        socket as unknown as WebSocket,
        {
          data: JSON.stringify({
            type: "workspace",
            workspace: {
              projectRoot: "/projects/target",
              canvasProject: {
                id: "project_target",
                name: "target",
                projectRoot: "/projects/target",
                createdAt: 1,
              },
              branches: [],
              sharedResources: [],
            },
            partialSuccess: true,
            workDocumentation: { ready: false, error: "unsafe documentation link" },
          }),
        } as MessageEvent,
      );
    });

    expect(result.current.workspaceUpdate).toMatchObject({
      workspace: { canvasProject: { id: "project_target" } },
      partialSuccess: true,
      workDocumentation: { ready: false, error: "unsafe documentation link" },
    });
    unmount();
  });

  it("treats every workspace frame and higher same-project revision as authoritative", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    mockEmptyRefresh();

    const { result, unmount } = renderHook(() => useAgentCanvas());
    act(() => vi.runOnlyPendingTimers());
    const socket = FakeWebSocket.instances[0]!;
    act(() => sendWorkspaceFrame(socket, "project_old"));
    const firstGeneration = result.current.currentWorkspaceEventGeneration();
    const firstUpdate = result.current.workspaceUpdate;

    act(() => sendWorkspaceFrame(socket, "project_old"));

    expect(result.current.currentWorkspaceEventGeneration()).toBe(firstGeneration + 1);
    expect(result.current.workspaceUpdate).not.toBe(firstUpdate);

    act(() =>
      sendWorkspaceFrame(socket, "project_old", {
        ready: false,
        error: "documentation status changed",
      }, 2),
    );
    expect(result.current.currentWorkspaceEventGeneration()).toBe(firstGeneration + 2);
    expect(result.current.currentWorkspaceEventIdentity()).toBe("project:project_old@2");
    const highRevisionGeneration = result.current.currentWorkspaceEventGeneration();
    const highRevisionUpdate = result.current.workspaceUpdate;

    act(() =>
      sendWorkspaceFrame(socket, "project_old", {
        ready: false,
        error: "stale lower revision",
      }, 1),
    );
    expect(result.current.currentWorkspaceEventGeneration()).toBe(highRevisionGeneration);
    expect(result.current.workspaceUpdate).toBe(highRevisionUpdate);
    expect(result.current.currentWorkspaceEventIdentity()).toBe("project:project_old@2");
    unmount();
  });

  it("treats an identical workspace frame as authoritative after reconnect", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    mockEmptyRefresh();

    const { result, unmount } = renderHook(() => useAgentCanvas());
    act(() => vi.advanceTimersByTime(0));
    const firstSocket = FakeWebSocket.instances[0]!;
    act(() => sendWorkspaceFrame(firstSocket, "project_same"));
    const firstGeneration = result.current.currentWorkspaceEventGeneration();
    const firstUpdate = result.current.workspaceUpdate;

    act(() => {
      firstSocket.onclose?.call(firstSocket as unknown as WebSocket, {} as CloseEvent);
    });
    act(() => vi.advanceTimersByTime(1_000));
    const reconnectedSocket = FakeWebSocket.instances[1]!;
    act(() => sendWorkspaceFrame(reconnectedSocket, "project_same"));

    expect(result.current.currentWorkspaceEventGeneration()).toBe(firstGeneration + 1);
    expect(result.current.workspaceUpdate).not.toBe(firstUpdate);
    expect(result.current.workspaceUpdate).toMatchObject({
      workspace: { canvasProject: { id: "project_same" } },
    });
    unmount();
  });

  it("ignores messages and close events from a superseded socket", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    mockEmptyRefresh();

    const { result, unmount } = renderHook(() => useAgentCanvas());
    act(() => vi.advanceTimersByTime(0));
    const firstSocket = FakeWebSocket.instances[0]!;
    act(() => {
      firstSocket.onopen?.call(firstSocket as unknown as WebSocket, {} as Event);
      sendWorkspaceFrame(firstSocket, "project_old");
      firstSocket.onclose?.call(firstSocket as unknown as WebSocket, {} as CloseEvent);
    });
    act(() => vi.advanceTimersByTime(1_000));

    const currentSocket = FakeWebSocket.instances[1]!;
    act(() => {
      currentSocket.onopen?.call(currentSocket as unknown as WebSocket, {} as Event);
      sendWorkspaceFrame(currentSocket, "project_current");
    });
    const currentGeneration = result.current.currentWorkspaceEventGeneration();

    act(() => {
      sendWorkspaceFrame(firstSocket, "project_stale");
      firstSocket.onclose?.call(firstSocket as unknown as WebSocket, {} as CloseEvent);
    });

    expect(result.current.connected).toBe(true);
    expect(result.current.currentWorkspaceEventGeneration()).toBe(currentGeneration);
    expect(result.current.workspaceUpdate).toMatchObject({
      workspace: { canvasProject: { id: "project_current" } },
    });
    act(() => vi.advanceTimersByTime(1_000));
    expect(FakeWebSocket.instances).toHaveLength(2);
    unmount();
  });

  it("does not mix reconnect hello state with resources from the previous project", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    mockEmptyRefresh();

    const { result, unmount } = renderHook(() => useAgentCanvas());
    await act(async () => {
      vi.advanceTimersByTime(0);
      await Promise.resolve();
      await Promise.resolve();
    });
    const firstSocket = FakeWebSocket.instances[0]!;
    act(() => {
      sendWorkspaceFrame(firstSocket, "project_old");
      firstSocket.onmessage?.call(
        firstSocket as unknown as WebSocket,
        {
          data: JSON.stringify({
            type: "file",
            file: {
              id: "file_old",
              name: "old",
              extension: "txt",
              filename: "old.txt",
              path: "/old/file.txt",
              storage: "isolated",
              availability: "available",
              kind: "normal",
              sharedRead: false,
              sharedWrite: false,
              previewKind: "text",
              mimeType: "text/plain",
              createdAt: 1,
              updatedAt: 1,
            },
          }),
        } as MessageEvent,
      );
    });
    expect(result.current.files.map((file) => file.id)).toEqual(["file_old"]);

    act(() => {
      firstSocket.onclose?.call(firstSocket as unknown as WebSocket, {} as CloseEvent);
    });
    act(() => vi.advanceTimersByTime(1_000));
    const reconnectedSocket = FakeWebSocket.instances[1]!;

    // The reconnect epoch is cleared before the server's hello -> workspace ordering begins.
    act(() => sendHelloFrame(reconnectedSocket, "agent_new"));
    expect(Object.keys(result.current.agents)).toEqual(["agent_new"]);
    expect(result.current.files).toEqual([]);

    let resolveFiles!: (files: Awaited<ReturnType<typeof api.listFiles>>) => void;
    vi.mocked(api.listFiles).mockReturnValueOnce(
      new Promise<Awaited<ReturnType<typeof api.listFiles>>>((resolve) => {
        resolveFiles = resolve;
      }),
    );
    let pendingRefresh!: Promise<void>;
    act(() => {
      sendWorkspaceFrame(reconnectedSocket, "project_new");
      pendingRefresh = result.current.refresh();
    });

    // The first workspace frame retains its same-epoch hello, but no old resource can reappear
    // while the new project's REST refresh is delayed.
    expect(Object.keys(result.current.agents)).toEqual(["agent_new"]);
    expect(result.current.files).toEqual([]);

    await act(async () => {
      resolveFiles([]);
      await pendingRefresh;
    });
    expect(Object.keys(result.current.agents)).toEqual([]);
    expect(result.current.files).toEqual([]);
    unmount();
  });

  it("drops a late file mutation response after a workspace switch", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    mockEmptyRefresh();
    let resolveFile!: (file: Awaited<ReturnType<typeof api.createFile>>) => void;
    const lateFile = new Promise<Awaited<ReturnType<typeof api.createFile>>>((resolve) => {
      resolveFile = resolve;
    });
    vi.spyOn(api, "createFile").mockReturnValue(lateFile);

    const { result, unmount } = renderHook(() => useAgentCanvas());
    act(() => vi.runOnlyPendingTimers());
    const pending = result.current.fileActions.create({ name: "old", kind: "normal" });
    act(() => sendWorkspaceFrame(FakeWebSocket.instances[0]!, "project_new"));
    await act(async () => {
      resolveFile({
        id: "file_old",
        name: "old",
        extension: "txt",
        filename: "old.txt",
        path: "/old/file.txt",
        storage: "isolated",
        availability: "available",
        kind: "normal",
        sharedRead: false,
        sharedWrite: false,
        previewKind: "text",
        mimeType: "text/plain",
        createdAt: 1,
        updatedAt: 1,
      });
      await pending;
    });

    expect(result.current.files).toEqual([]);
    unmount();
  });

  it("adds every file returned by a picked-file import", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    mockEmptyRefresh();
    const imported = ["brief.md", "photo.png"].map((filename, index) => ({
      id: `file_${index + 1}`,
      name: filename.slice(0, filename.lastIndexOf(".")),
      extension: filename.slice(filename.lastIndexOf(".") + 1),
      filename,
      path: `/files/${filename}`,
      storage: "isolated" as const,
      availability: "available" as const,
      kind: "normal" as const,
      sharedRead: false,
      sharedWrite: false,
      previewKind: "none" as const,
      mimeType: "application/octet-stream",
      createdAt: index + 1,
      updatedAt: index + 1,
    }));
    vi.spyOn(api, "importPickedFiles").mockResolvedValue(imported);

    const { result, unmount } = renderHook(() => useAgentCanvas());
    act(() => vi.runOnlyPendingTimers());
    await act(async () => {
      await result.current.fileActions.importPicked({
        selectionId: "file_selection_1",
        mode: "copy",
        kind: "normal",
      });
    });

    expect(result.current.files.map((file) => file.filename)).toEqual([
      "brief.md",
      "photo.png",
    ]);
    unmount();
  });

  it("keeps successful dropped files when a later upload fails", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    mockEmptyRefresh();
    const dropped = [new File(["ok"], "ok.txt"), new File(["bad"], "bad.txt")];
    const created = {
      id: "file_1",
      name: "ok",
      extension: "txt",
      filename: "ok.txt",
      path: "/files/ok.txt",
      storage: "isolated" as const,
      availability: "available" as const,
      kind: "normal" as const,
      sharedRead: false,
      sharedWrite: false,
      previewKind: "text" as const,
      mimeType: "text/plain",
      createdAt: 1,
      updatedAt: 1,
    };
    const upload = vi
      .spyOn(api, "importUploadedFile")
      .mockResolvedValueOnce(created)
      .mockRejectedValueOnce(new Error("413 too large"));
    const onImported = vi.fn();

    const { result, unmount } = renderHook(() => useAgentCanvas());
    act(() => vi.runOnlyPendingTimers());
    act(() => sendWorkspaceFrame(FakeWebSocket.instances[0]!, "project_a", undefined, 7));
    let outcome!: Awaited<ReturnType<typeof result.current.fileActions.importDropped>>;
    await act(async () => {
      outcome = await result.current.fileActions.importDropped(
        dropped,
        "normal",
        onImported,
      );
    });

    expect(result.current.files.map((file) => file.id)).toEqual(["file_1"]);
    expect(onImported).toHaveBeenCalledWith(created, 0);
    expect(outcome.imported).toEqual([created]);
    expect(outcome.failures).toMatchObject([{ file: dropped[1], reason: "413 too large" }]);
    expect(upload.mock.calls[0]?.[2]).toEqual({ canvasProjectId: "project_a", revision: 7 });
    expect(upload.mock.calls[1]?.[2]).toEqual({ canvasProjectId: "project_a", revision: 7 });
    unmount();
  });

  it("stops a dropped-file batch after a project switch", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    mockEmptyRefresh();
    const dropped = [new File(["one"], "one.txt"), new File(["two"], "two.txt")];
    const created = {
      id: "file_1",
      name: "one",
      extension: "txt",
      filename: "one.txt",
      path: "/files/one.txt",
      storage: "isolated" as const,
      availability: "available" as const,
      kind: "normal" as const,
      sharedRead: false,
      sharedWrite: false,
      previewKind: "text" as const,
      mimeType: "text/plain",
      createdAt: 1,
      updatedAt: 1,
    };
    let resolveFirst!: (file: typeof created) => void;
    const upload = vi.spyOn(api, "importUploadedFile").mockReturnValue(
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
    );
    const onImported = vi.fn();

    const { result, unmount } = renderHook(() => useAgentCanvas());
    act(() => vi.runOnlyPendingTimers());
    const socket = FakeWebSocket.instances[0]!;
    act(() => sendWorkspaceFrame(socket, "project_a", undefined, 3));
    let pending!: ReturnType<typeof result.current.fileActions.importDropped>;
    act(() => {
      pending = result.current.fileActions.importDropped(dropped, "normal", onImported);
    });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0]?.[2]).toEqual({ canvasProjectId: "project_a", revision: 3 });

    act(() => sendWorkspaceFrame(socket, "project_b", undefined, 1));
    let outcome!: Awaited<typeof pending>;
    await act(async () => {
      resolveFirst(created);
      outcome = await pending;
    });

    expect(upload).toHaveBeenCalledTimes(1);
    expect(onImported).not.toHaveBeenCalled();
    expect(result.current.files).toEqual([]);
    expect(outcome.failures.map((failure) => failure.file.name)).toEqual(["two.txt"]);
    unmount();
  });

  it("drops a late prompt polling result from the previous workspace", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    mockEmptyRefresh();
    let resolveOldPrompts!: (prompts: Awaited<ReturnType<typeof api.listPrompts>>) => void;
    const oldPrompts = new Promise<Awaited<ReturnType<typeof api.listPrompts>>>((resolve) => {
      resolveOldPrompts = resolve;
    });
    vi.mocked(api.listPrompts)
      .mockResolvedValueOnce([])
      .mockReturnValueOnce(oldPrompts)
      .mockResolvedValue([]);

    const { result, unmount } = renderHook(() => useAgentCanvas());
    await act(async () => {
      await Promise.resolve();
    });
    act(() => vi.runOnlyPendingTimers());
    expect(api.listPrompts).toHaveBeenCalledTimes(2);
    act(() => sendWorkspaceFrame(FakeWebSocket.instances[0]!, "project_new"));

    await act(async () => {
      resolveOldPrompts([
        {
          id: "prompt_old",
          name: "old",
          content: "old project",
          kind: "normal",
          sharedRead: false,
          sharedWrite: false,
          createdAt: 1,
          updatedAt: 1,
        },
      ]);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.prompts).toEqual([]);
    unmount();
  });

  it("invalidates an in-flight old-project refresh as soon as a workspace frame arrives", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    let resolveOldAgents!: (agents: any[]) => void;
    const oldAgents = new Promise<any[]>((resolve) => {
      resolveOldAgents = resolve;
    });
    vi.spyOn(api, "list")
      .mockReturnValueOnce(oldAgents)
      .mockResolvedValueOnce([]);
    vi.spyOn(api, "listFiles").mockResolvedValue([]);
    vi.spyOn(api, "listFileConnections").mockResolvedValue([]);
    vi.spyOn(api, "listPrompts").mockResolvedValue([]);
    vi.spyOn(api, "listPromptConnections").mockResolvedValue([]);
    vi.spyOn(api, "listPullRequestFlows").mockResolvedValue([]);
    vi.spyOn(api, "listSyncFlows").mockResolvedValue([]);
    vi.spyOn(api, "listCommits").mockResolvedValue([]);
    vi.spyOn(api, "history").mockResolvedValue([]);

    const { result, unmount } = renderHook(() => useAgentCanvas());
    act(() => vi.runOnlyPendingTimers());
    const socket = FakeWebSocket.instances[0]!;
    act(() => {
      socket.onmessage?.call(
        socket as unknown as WebSocket,
        {
          data: JSON.stringify({
            type: "workspace",
            workspace: {
              projectRoot: "/projects/new",
              canvasProject: {
                id: "project_new",
                name: "new",
                projectRoot: "/projects/new",
                createdAt: 2,
              },
              branches: [],
              sharedResources: [],
            },
            workDocumentation: { ready: true },
          }),
        } as MessageEvent,
      );
    });
    await act(async () => {
      await result.current.refresh();
    });
    await act(async () => {
      resolveOldAgents([
        {
          id: "agent_from_old_project",
          status: "idle",
          config: { prompt: "" },
          createdAt: 1,
          lastEventSeq: 0,
        },
      ]);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.agents).toEqual({});
    unmount();
  });
});
