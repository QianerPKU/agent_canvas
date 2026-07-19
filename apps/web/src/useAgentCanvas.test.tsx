// @vitest-environment jsdom
import { StrictMode, type PropsWithChildren } from "react";
import { act, renderHook } from "@testing-library/react";
import type {
  AgentCommitSnapshot,
  AgentEventEnvelope,
  BranchWorkspace,
  PullRequestFlowSnapshot,
} from "@agent-canvas/shared";
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
  branches: BranchWorkspace[] = [],
  projectRoot = `/projects/${projectId}`,
): void {
  socket.onmessage?.call(
    socket as unknown as WebSocket,
    {
      data: JSON.stringify({
        type: "workspace",
        workspace: {
          projectRoot,
          revision,
          canvasProject: {
            id: projectId,
            name: projectId,
            projectRoot,
            createdAt: 1,
          },
          branches,
          sharedResources: [],
        },
        workDocumentation,
      }),
    } as MessageEvent,
  );
}

function sendHelloFrame(
  socket: FakeWebSocket,
  agentId: string,
  config: Record<string, unknown> = {},
): void {
  socket.onmessage?.call(
    socket as unknown as WebSocket,
    {
      data: JSON.stringify({
        type: "hello",
        agents: [
          {
            id: agentId,
            status: "idle",
            config: { prompt: "", ...config },
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

function sendAgentEvent(
  socket: FakeWebSocket,
  agentId: string,
  seq: number,
  event: Record<string, unknown>,
): void {
  socket.onmessage?.call(
    socket as unknown as WebSocket,
    {
      data: JSON.stringify({
        type: "event",
        envelope: { agentId, seq, at: seq, event },
      }),
    } as MessageEvent,
  );
}

function pullRequestFlow(
  status: PullRequestFlowSnapshot["status"],
  updatedAt: number,
): PullRequestFlowSnapshot {
  return {
    id: "pr_flow_1",
    proposerAgentId: "agent_1",
    sourceBranch: "feature/a",
    targetBranch: "main",
    summary: "merge feature a",
    files: ["src/a.ts"],
    fileChanges: [{ status: "M", path: "src/a.ts" }],
    status,
    createdAt: 1,
    updatedAt,
    currentStage: "source_preflight",
    reviewRequests: [],
  };
}

function agentCommit(
  id: string,
  createdAt: number,
  summary: string,
): AgentCommitSnapshot {
  return {
    id,
    agentId: "agent_1",
    sourceTurnIndex: 0,
    commitSha: `${id}-sha`,
    shortSha: id,
    subject: summary,
    summary,
    files: [],
    createdAt,
  };
}

afterEach(() => {
  api.setWorkspaceContext(undefined);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  FakeWebSocket.instances = [];
});

describe("useAgentCanvas", () => {
  it("keeps newer websocket/create state when an older refresh and create response finish later", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    mockEmptyRefresh();
    let resolveCreate!: (id: string) => void;
    vi.spyOn(api, "create").mockReturnValue(
      new Promise<string>((resolve) => {
        resolveCreate = resolve;
      }),
    );

    const { result, unmount } = renderHook(() => useAgentCanvas());
    act(() => vi.advanceTimersByTime(0));
    await act(async () => {
      await result.current.refresh();
    });
    const socket = FakeWebSocket.instances[0]!;
    act(() => sendHelloFrame(socket, "agent_9"));
    let resolveOldAgents!: (agents: Awaited<ReturnType<typeof api.list>>) => void;
    vi.mocked(api.list).mockReturnValueOnce(
      new Promise<Awaited<ReturnType<typeof api.list>>>((resolve) => {
        resolveOldAgents = resolve;
      }),
    );
    let pendingRefresh!: Promise<void>;
    act(() => {
      pendingRefresh = result.current.refresh();
    });
    const settings = {
      provider: "codex" as const,
      model: undefined,
      branchWorkspaceId: "branch_main",
      branch: "main",
      cwd: "C:\\repo\\main",
      systemPrompt: "review main",
    };
    let pending!: Promise<string>;
    act(() => {
      pending = result.current.actions.create(settings);
    });
    act(() => {
      socket.onmessage?.call(
        socket as unknown as WebSocket,
        {
          data: JSON.stringify({
            type: "event",
            envelope: {
              agentId: "agent_9",
              seq: 1,
              at: 1,
              event: { kind: "status", status: "starting" },
            },
          }),
        } as MessageEvent,
      );
      socket.onmessage?.call(
        socket as unknown as WebSocket,
        {
          data: JSON.stringify({
            type: "event",
            envelope: {
              agentId: "agent_9",
              seq: 2,
              at: 2,
              event: {
                kind: "system_init",
                sessionId: "session_9",
                model: "gpt-5.3-codex",
                cwd: "C:\\repo\\main",
                tools: [],
              },
            },
          }),
        } as MessageEvent,
      );
      socket.onmessage?.call(
        socket as unknown as WebSocket,
        {
          data: JSON.stringify({
            type: "event",
            envelope: {
              agentId: "agent_9",
              seq: 3,
              at: 3,
              event: { kind: "status", status: "running" },
            },
          }),
        } as MessageEvent,
      );
    });

    await act(async () => {
      resolveCreate("agent_9");
      await pending;
    });
    await act(async () => {
      resolveOldAgents([
        {
          id: "agent_9",
          status: "idle",
          config: { prompt: "" },
          createdAt: 1,
          lastEventSeq: 10,
        },
      ]);
      await pendingRefresh;
    });

    expect(result.current.agents.agent_9).toMatchObject({
      status: "running",
      provider: "codex",
      model: "gpt-5.3-codex",
      sessionId: "session_9",
      branchWorkspaceId: "branch_main",
      branch: "main",
      cwd: "C:\\repo\\main",
      systemPrompt: "review main",
      lastSeq: 3,
    });
    unmount();
  });

  it("keeps auto-start websocket state when a branch update response arrives later", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    mockEmptyRefresh();
    let resolveUpdate!: (snapshot: Awaited<ReturnType<typeof api.updateAgentSettings>>) => void;
    vi.spyOn(api, "updateAgentSettings").mockReturnValue(
      new Promise<Awaited<ReturnType<typeof api.updateAgentSettings>>>((resolve) => {
        resolveUpdate = resolve;
      }),
    );

    const { result, unmount } = renderHook(() => useAgentCanvas());
    act(() => vi.advanceTimersByTime(0));
    await act(async () => {
      await result.current.refresh();
    });
    const socket = FakeWebSocket.instances[0]!;
    act(() =>
      sendHelloFrame(socket, "agent_1", {
        provider: "codex",
        model: "stale-model",
        branchWorkspaceId: "branch_source",
        branch: "feature/source",
        cwd: "C:\\repo\\source",
        scratchDirectory: "C:\\repo\\source\\.agent-tmp\\agent_1",
        systemPrompt: "keep this policy",
      }),
    );
    const update = {
      model: "stale-model",
      branchWorkspaceId: "branch_main",
      branch: "main",
      cwd: "C:\\repo\\main",
      scratchDirectory: "C:\\repo\\main\\.agent-tmp\\agent_1",
    };
    let pendingUpdate!: Promise<void>;
    act(() => {
      pendingUpdate = result.current.actions.updateSettings("agent_1", update);
    });

    act(() => {
      sendAgentEvent(socket, "agent_1", 1, { kind: "status", status: "starting" });
      sendAgentEvent(socket, "agent_1", 2, {
        kind: "system_init",
        sessionId: "session-main",
        model: "runtime-model",
        cwd: "C:\\repo\\main",
        tools: [],
      });
      sendAgentEvent(socket, "agent_1", 3, { kind: "status", status: "running" });
    });

    await act(async () => {
      resolveUpdate({
        id: "agent_1",
        status: "idle",
        sessionId: "stale-session",
        config: {
          prompt: "",
          provider: "codex",
          ...update,
          systemPrompt: "keep this policy",
        },
        createdAt: 1,
        lastEventSeq: 0,
      });
      await pendingUpdate;
    });

    expect(result.current.agents.agent_1).toMatchObject({
      status: "running",
      sessionId: "session-main",
      model: "runtime-model",
      lastSeq: 3,
      provider: "codex",
      branchWorkspaceId: "branch_main",
      branch: "main",
      cwd: "C:\\repo\\main",
      scratchDirectory: "C:\\repo\\main\\.agent-tmp\\agent_1",
      systemPrompt: "keep this policy",
    });
    expect(result.current.agents.agent_1?.turns[0]?.lines).toContainEqual({
      kind: "system",
      text: "会话建立 · runtime-model",
    });
    unmount();
  });

  it("applies an explicit model update when only ordinary websocket events arrive first", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    mockEmptyRefresh();
    let resolveUpdate!: (snapshot: Awaited<ReturnType<typeof api.updateAgentSettings>>) => void;
    vi.spyOn(api, "updateAgentSettings").mockReturnValue(
      new Promise<Awaited<ReturnType<typeof api.updateAgentSettings>>>((resolve) => {
        resolveUpdate = resolve;
      }),
    );

    const { result, unmount } = renderHook(() => useAgentCanvas());
    act(() => vi.advanceTimersByTime(0));
    await act(async () => {
      await result.current.refresh();
    });
    const socket = FakeWebSocket.instances[0]!;
    act(() =>
      sendHelloFrame(socket, "agent_1", {
        provider: "codex",
        model: "old-model",
        branchWorkspaceId: "branch_main",
        branch: "main",
        cwd: "C:\\repo\\main",
      }),
    );
    let pendingUpdate!: Promise<void>;
    act(() => {
      pendingUpdate = result.current.actions.updateSettings("agent_1", {
        model: "new-model",
      });
    });

    act(() => {
      sendAgentEvent(socket, "agent_1", 1, { kind: "status", status: "starting" });
      sendAgentEvent(socket, "agent_1", 2, {
        kind: "assistant_text",
        text: "ordinary live output",
        messageUuid: "message-1",
      });
    });

    await act(async () => {
      resolveUpdate({
        id: "agent_1",
        status: "idle",
        config: {
          prompt: "",
          provider: "codex",
          model: "new-model",
          branchWorkspaceId: "branch_main",
          branch: "main",
          cwd: "C:\\repo\\main",
        },
        createdAt: 1,
        lastEventSeq: 0,
      });
      await pendingUpdate;
    });

    expect(result.current.agents.agent_1).toMatchObject({
      status: "starting",
      model: "new-model",
      lastSeq: 2,
    });
    expect(result.current.agents.agent_1?.turns[0]?.lines).toContainEqual({
      kind: "assistant",
      text: "ordinary live output",
      messageUuid: "message-1",
    });
    unmount();
  });

  it("does not let a delayed refresh replace a newer hello agent collection", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    mockEmptyRefresh();

    const { result, unmount } = renderHook(() => useAgentCanvas());
    act(() => vi.advanceTimersByTime(0));
    await act(async () => {
      await result.current.refresh();
    });
    const socket = FakeWebSocket.instances[0]!;
    let resolveOldAgents!: (agents: Awaited<ReturnType<typeof api.list>>) => void;
    vi.mocked(api.list).mockReturnValueOnce(
      new Promise<Awaited<ReturnType<typeof api.list>>>((resolve) => {
        resolveOldAgents = resolve;
      }),
    );
    vi.mocked(api.listPullRequestFlows).mockResolvedValueOnce([
      pullRequestFlow("queued", 1),
    ]);
    let pendingRefresh!: Promise<void>;
    act(() => {
      pendingRefresh = result.current.refresh();
    });

    act(() => sendHelloFrame(socket, "agent_new"));
    await act(async () => {
      resolveOldAgents([
        {
          id: "agent_stale",
          status: "idle",
          config: { prompt: "" },
          createdAt: 1,
          lastEventSeq: 0,
        },
      ]);
      await pendingRefresh;
    });

    expect(Object.keys(result.current.agents)).toEqual(["agent_new"]);
    expect(result.current.prFlows).toEqual([]);
    unmount();
  });

  it("merges fork metadata into a child that starts before the fork response", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    mockEmptyRefresh();
    let resolveFork!: (forked: Awaited<ReturnType<typeof api.fork>>) => void;
    vi.spyOn(api, "fork").mockReturnValue(
      new Promise<Awaited<ReturnType<typeof api.fork>>>((resolve) => {
        resolveFork = resolve;
      }),
    );

    const { result, unmount } = renderHook(() => useAgentCanvas());
    act(() => vi.advanceTimersByTime(0));
    await act(async () => {
      await result.current.refresh();
    });
    const socket = FakeWebSocket.instances[0]!;
    act(() => {
      sendHelloFrame(socket, "agent_parent", {
        provider: "codex",
        model: "parent-model",
        reasoningEffort: "high",
        branchWorkspaceId: "branch_source",
        branch: "feature/source",
        cwd: "C:\\repo\\source",
        scratchDirectory: "C:\\repo\\source\\.agent-tmp\\agent_parent",
        systemPrompt: "parent policy",
      });
      sendAgentEvent(socket, "agent_parent", 1, {
        kind: "user_input",
        text: "parent turn",
      });
      sendAgentEvent(socket, "agent_parent", 2, {
        kind: "usage",
        usage: { contextTokens: 2048, contextWindow: 128000 },
      });
      sendAgentEvent(socket, "agent_parent", 3, {
        kind: "assistant_text",
        text: "parent answer",
        messageUuid: "anchor-1",
      });
      sendAgentEvent(socket, "agent_parent", 4, {
        kind: "result",
        subtype: "success",
        isError: false,
        anchorUuid: "anchor-1",
      });
    });
    const options = {
      reasoningEffort: "medium",
      branchWorkspaceId: "branch_main",
      branch: "main",
      cwd: "C:\\repo\\main",
      scratchDirectory: "C:\\repo\\main\\.agent-tmp\\agent_child",
    };
    let pendingFork!: Promise<void>;
    act(() => {
      pendingFork = result.current.actions.fork("agent_parent", "anchor-1", options);
    });

    act(() => {
      sendAgentEvent(socket, "agent_child", 1, { kind: "status", status: "starting" });
      sendAgentEvent(socket, "agent_child", 2, {
        kind: "system_init",
        sessionId: "session-child",
        model: "runtime-model",
        cwd: "C:\\repo\\main",
        tools: [],
      });
      sendAgentEvent(socket, "agent_child", 3, { kind: "status", status: "running" });
    });

    await act(async () => {
      resolveFork({
        id: "agent_child",
        origin: { parentAgentId: "agent_parent", anchorUuid: "anchor-1" },
      });
      await pendingFork;
    });

    expect(result.current.agents.agent_child).toMatchObject({
      status: "running",
      sessionId: "session-child",
      model: "runtime-model",
      lastSeq: 3,
      provider: "codex",
      reasoningEffort: "medium",
      branchWorkspaceId: "branch_main",
      branch: "main",
      cwd: "C:\\repo\\main",
      scratchDirectory: "C:\\repo\\main\\.agent-tmp\\agent_child",
      systemPrompt: "parent policy",
      latestUsage: { contextTokens: 2048, contextWindow: 128000 },
      forkOrigin: { parentAgentId: "agent_parent", anchorUuid: "anchor-1" },
    });
    expect(result.current.agents.agent_child?.turns[0]?.usage).toEqual({
      contextTokens: 2048,
      contextWindow: 128000,
    });
    expect(result.current.agents.agent_child?.turns[0]?.lines).toContainEqual({
      kind: "system",
      text: "会话建立 · runtime-model",
    });
    unmount();
  });

  it("does not let a delayed refresh roll a newer PR websocket state back to queued", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    mockEmptyRefresh();

    const { result, unmount } = renderHook(() => useAgentCanvas());
    act(() => vi.advanceTimersByTime(0));
    await act(async () => {
      await result.current.refresh();
    });
    const socket = FakeWebSocket.instances[0]!;
    let resolveOldFlows!: (flows: PullRequestFlowSnapshot[]) => void;
    vi.mocked(api.listPullRequestFlows).mockReturnValueOnce(
      new Promise<PullRequestFlowSnapshot[]>((resolve) => {
        resolveOldFlows = resolve;
      }),
    );
    let pendingRefresh!: Promise<void>;
    act(() => {
      pendingRefresh = result.current.refresh();
    });

    act(() => {
      socket.onmessage?.call(
        socket as unknown as WebSocket,
        {
          data: JSON.stringify({
            type: "pr_flow",
            flow: pullRequestFlow("source_review_collecting", 2),
          }),
        } as MessageEvent,
      );
    });
    expect(result.current.prFlows[0]).toMatchObject({
      status: "source_review_collecting",
      updatedAt: 2,
    });

    await act(async () => {
      resolveOldFlows([pullRequestFlow("queued", 1)]);
      await pendingRefresh;
    });

    expect(result.current.prFlows[0]).toMatchObject({
      status: "source_review_collecting",
      updatedAt: 2,
    });
    unmount();
  });

  it("keeps a websocket commit that arrives during a delayed commit refresh", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    mockEmptyRefresh();

    const { result, unmount } = renderHook(() => useAgentCanvas());
    act(() => vi.advanceTimersByTime(0));
    await act(async () => {
      await result.current.refresh();
    });
    const socket = FakeWebSocket.instances[0]!;
    let resolveOldCommits!: (commits: AgentCommitSnapshot[]) => void;
    vi.mocked(api.listCommits).mockReturnValueOnce(
      new Promise<AgentCommitSnapshot[]>((resolve) => {
        resolveOldCommits = resolve;
      }),
    );
    let pendingRefresh!: Promise<void>;
    act(() => {
      pendingRefresh = result.current.refresh();
    });

    const liveCommit = agentCommit("commit_2", 2, "new websocket commit");
    act(() => {
      socket.onmessage?.call(
        socket as unknown as WebSocket,
        {
          data: JSON.stringify({ type: "commit", commit: liveCommit }),
        } as MessageEvent,
      );
    });
    expect(result.current.commits).toEqual([liveCommit]);

    await act(async () => {
      resolveOldCommits([
        agentCommit("commit_1", 1, "older REST commit"),
      ]);
      await pendingRefresh;
    });

    expect(result.current.commits.map((commit) => commit.id)).toEqual([
      "commit_2",
      "commit_1",
    ]);
    expect(result.current.commits[0]?.summary).toBe("new websocket commit");
    unmount();
  });

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

  it("keeps project state for same-identity metadata and replaces it on revision changes", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    mockEmptyRefresh();

    const { result, unmount } = renderHook(() => useAgentCanvas());
    await act(async () => {
      vi.advanceTimersByTime(0);
      await Promise.resolve();
      await Promise.resolve();
    });
    const socket = FakeWebSocket.instances[0]!;
    act(() => {
      sendHelloFrame(socket, "agent_existing");
      sendWorkspaceFrame(socket, "project_old");
    });
    const firstGeneration = result.current.currentWorkspaceEventGeneration();
    const firstSnapshotGeneration = result.current.currentWorkspaceSnapshotGeneration();
    const replacementUpdate = result.current.workspaceUpdate;
    const createdBranch: BranchWorkspace = {
      id: "branch_2",
      repoId: "repo_1",
      branch: "feature/metadata",
      baseBranch: "main",
      worktreePath: "/projects/project_old/worktrees/feature-metadata",
      scratchRoot: "/projects/project_old/worktrees/feature-metadata/.agent-tmp",
      isDefault: false,
      createdAt: 2,
    };

    act(() =>
      sendWorkspaceFrame(
        socket,
        "project_old",
        { ready: false, error: "documentation status changed" },
        1,
        [createdBranch],
      ),
    );

    expect(result.current.currentWorkspaceEventGeneration()).toBe(firstGeneration);
    expect(result.current.currentWorkspaceSnapshotGeneration()).toBe(
      firstSnapshotGeneration + 1,
    );
    expect(result.current.workspaceUpdate).toBe(replacementUpdate);
    expect(result.current.workspaceMetadataUpdate).toMatchObject({
      workspace: { branches: [createdBranch] },
      workDocumentation: { ready: false, error: "documentation status changed" },
    });
    expect(result.current.currentWorkspaceSnapshot()?.branches).toEqual([createdBranch]);
    expect(Object.keys(result.current.agents)).toEqual(["agent_existing"]);

    act(() =>
      sendWorkspaceFrame(socket, "project_old", {
        ready: true,
      }, 2),
    );
    expect(result.current.currentWorkspaceEventGeneration()).toBe(firstGeneration + 1);
    expect(result.current.currentWorkspaceSnapshotGeneration()).toBe(
      firstSnapshotGeneration + 2,
    );
    expect(result.current.currentWorkspaceEventIdentity()).toBe("project:project_old@2");
    expect(result.current.currentWorkspaceSnapshot()?.revision).toBe(2);
    const highRevisionGeneration = result.current.currentWorkspaceEventGeneration();
    const highRevisionSnapshotGeneration =
      result.current.currentWorkspaceSnapshotGeneration();
    const highRevisionUpdate = result.current.workspaceUpdate;
    expect(result.current.workspaceMetadataUpdate).toBeUndefined();
    expect(result.current.agents).toEqual({});

    act(() =>
      sendWorkspaceFrame(socket, "project_old", {
        ready: false,
        error: "stale lower revision",
      }, 1),
    );
    expect(result.current.currentWorkspaceEventGeneration()).toBe(highRevisionGeneration);
    expect(result.current.currentWorkspaceSnapshotGeneration()).toBe(
      highRevisionSnapshotGeneration,
    );
    expect(result.current.workspaceUpdate).toBe(highRevisionUpdate);
    expect(result.current.currentWorkspaceEventIdentity()).toBe("project:project_old@2");
    expect(result.current.currentWorkspaceSnapshot()?.revision).toBe(2);
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
    const firstSnapshotGeneration = result.current.currentWorkspaceSnapshotGeneration();
    const firstUpdate = result.current.workspaceUpdate;

    act(() => {
      firstSocket.onclose?.call(firstSocket as unknown as WebSocket, {} as CloseEvent);
    });
    expect(result.current.currentWorkspaceSnapshot()).toBeUndefined();
    expect(result.current.currentWorkspaceSnapshotGeneration()).toBe(
      firstSnapshotGeneration + 1,
    );
    act(() => vi.advanceTimersByTime(1_000));
    const reconnectedSocket = FakeWebSocket.instances[1]!;
    act(() => sendWorkspaceFrame(reconnectedSocket, "project_same"));

    expect(result.current.currentWorkspaceEventGeneration()).toBe(firstGeneration + 1);
    expect(result.current.workspaceUpdate).not.toBe(firstUpdate);
    expect(result.current.workspaceUpdate).toMatchObject({
      workspace: { canvasProject: { id: "project_same" } },
    });
    expect(result.current.workspaceMetadataUpdate).toBeUndefined();
    expect(result.current.currentWorkspaceSnapshotGeneration()).toBe(
      firstSnapshotGeneration + 2,
    );
    const reconnectGeneration = result.current.currentWorkspaceEventGeneration();
    act(() => sendWorkspaceFrame(reconnectedSocket, "project_same"));
    expect(result.current.currentWorkspaceEventGeneration()).toBe(reconnectGeneration);
    expect(result.current.workspaceMetadataUpdate).toMatchObject({
      workspace: { canvasProject: { id: "project_same" } },
    });
    unmount();
  });

  it("lets an in-flight project refresh complete across same-identity metadata", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    mockEmptyRefresh();

    const { result, unmount } = renderHook(() => useAgentCanvas());
    await act(async () => {
      vi.advanceTimersByTime(0);
      await Promise.resolve();
      await Promise.resolve();
    });
    const socket = FakeWebSocket.instances[0]!;
    act(() => sendWorkspaceFrame(socket, "project_same"));

    let resolveAgents!: (agents: Awaited<ReturnType<typeof api.list>>) => void;
    vi.mocked(api.list).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveAgents = resolve;
      }),
    );
    let pendingRefresh!: Promise<void>;
    act(() => {
      pendingRefresh = result.current.refresh();
    });
    const generation = result.current.currentWorkspaceEventGeneration();
    act(() =>
      sendWorkspaceFrame(
        socket,
        "project_same",
        { ready: false, error: "metadata only" },
      ),
    );
    expect(result.current.currentWorkspaceEventGeneration()).toBe(generation);

    await act(async () => {
      resolveAgents([
        {
          id: "agent_from_refresh",
          status: "idle",
          config: { prompt: "" },
          createdAt: 1,
          lastEventSeq: 0,
        },
      ]);
      await pendingRefresh;
    });

    expect(Object.keys(result.current.agents)).toEqual(["agent_from_refresh"]);
    expect(result.current.workspaceMetadataUpdate).toMatchObject({
      workDocumentation: { ready: false, error: "metadata only" },
    });
    unmount();
  });

  it("fails safe when the same project and revision arrive from a different root", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    mockEmptyRefresh();

    const { result, unmount } = renderHook(() => useAgentCanvas());
    await act(async () => {
      vi.advanceTimersByTime(0);
      await Promise.resolve();
      await Promise.resolve();
    });
    const socket = FakeWebSocket.instances[0]!;
    act(() => {
      sendHelloFrame(socket, "agent_existing");
      sendWorkspaceFrame(socket, "project_same");
    });
    const generation = result.current.currentWorkspaceEventGeneration();

    act(() =>
      sendWorkspaceFrame(
        socket,
        "project_same",
        { ready: true },
        1,
        [],
        "/relocated/project_same",
      ),
    );

    expect(result.current.currentWorkspaceEventGeneration()).toBe(generation + 1);
    expect(result.current.workspaceMetadataUpdate).toBeUndefined();
    expect(result.current.agents).toEqual({});
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

  it("uses newer REST history when a delayed refresh started from a stale snapshot", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    mockEmptyRefresh();

    const history: AgentEventEnvelope[] = [
      {
        agentId: "a1",
        seq: 1,
        at: 1,
        event: { kind: "user_input", text: "old session" },
      },
      {
        agentId: "a1",
        seq: 2,
        at: 2,
        event: {
          kind: "system_init",
          sessionId: "s1",
          model: "old-history-model",
          cwd: "/tmp",
          tools: [],
        },
      },
      {
        agentId: "a1",
        seq: 3,
        at: 3,
        event: {
          kind: "usage",
          usage: { contextTokens: 4096, contextWindow: 128000 },
        },
      },
      {
        agentId: "a1",
        seq: 4,
        at: 4,
        event: { kind: "result", subtype: "success", isError: false },
      },
      {
        agentId: "a1",
        seq: 5,
        at: 5,
        event: { kind: "user_input", text: "new session" },
      },
      {
        agentId: "a1",
        seq: 6,
        at: 6,
        event: {
          kind: "system_init",
          sessionId: "s2",
          model: "runtime-model",
          cwd: "/tmp",
          tools: [],
        },
      },
      {
        agentId: "a1",
        seq: 7,
        at: 7,
        event: {
          kind: "usage",
          usage: { contextTokens: 8192, contextWindow: 128000 },
        },
      },
      {
        agentId: "a1",
        seq: 8,
        at: 8,
        event: { kind: "status", status: "running" },
      },
    ];
    let resolveHistory!: (history: AgentEventEnvelope[]) => void;
    const delayedHistory = new Promise<AgentEventEnvelope[]>((resolve) => {
      resolveHistory = resolve;
    });
    vi.mocked(api.list)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "a1",
          status: "waiting_input",
          sessionId: "s1",
          config: { prompt: "", provider: "codex", model: "stale-model" },
          createdAt: 1,
          lastEventSeq: 4,
          usage: { contextTokens: 4096, contextWindow: 128000 },
        },
      ]);
    vi.mocked(api.history).mockReturnValueOnce(delayedHistory);

    const { result, unmount } = renderHook(() => useAgentCanvas());
    await act(async () => {
      vi.advanceTimersByTime(0);
      await Promise.resolve();
      await Promise.resolve();
    });
    let pendingRefresh!: Promise<void>;
    act(() => {
      pendingRefresh = result.current.refresh();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.history).toHaveBeenCalledWith("a1");

    await act(async () => {
      resolveHistory(history);
      await pendingRefresh;
    });

    expect(result.current.agents.a1).toMatchObject({
      status: "running",
      sessionId: "s2",
      model: "runtime-model",
      lastInitializedSessionId: "s2",
      latestUsage: { contextTokens: 8192, contextWindow: 128000 },
      lastSeq: 8,
    });
    expect(result.current.agents.a1!.turns.at(-1)!.usage).toEqual({
      contextTokens: 8192,
      contextWindow: 128000,
    });
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
