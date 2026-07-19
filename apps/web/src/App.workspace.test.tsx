// @vitest-environment jsdom
import type { PropsWithChildren, ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchOption, BranchWorkspace, ServerFrame } from "@agent-canvas/shared";
import { api } from "./api.js";
import App from "./App.js";

vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...actual,
    ReactFlow: ({
      nodes,
      children,
    }: PropsWithChildren<{ nodes: Array<{ id: string }> }>) => (
      <div data-testid="react-flow">
        {nodes.map((node) => (
          <span key={node.id} data-testid={`node:${node.id}`} />
        ))}
        {children as ReactNode}
      </div>
    ),
    Background: () => null,
    Controls: () => null,
    MiniMap: () => null,
  };
});

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

const mainWorkspace: BranchWorkspace = {
  id: "branch_main",
  repoId: "repo_1",
  branch: "main",
  baseBranch: "main",
  worktreePath: "/projects/a/repo",
  scratchRoot: "/projects/a/repo/.agent-tmp",
  isDefault: true,
  createdAt: 1,
};

const featureWorkspace: BranchWorkspace = {
  id: "branch_feature",
  repoId: "repo_1",
  branch: "feature/metadata",
  baseBranch: "main",
  worktreePath: "/projects/a/worktrees/feature-metadata",
  scratchRoot: "/projects/a/worktrees/feature-metadata/.agent-tmp",
  isDefault: false,
  createdAt: 2,
};

const mainOption: BranchOption = {
  branch: "main",
  branchWorkspaceId: mainWorkspace.id,
  worktreePath: mainWorkspace.worktreePath,
  hasWorkspace: true,
  isDefault: true,
};

const featureOption: BranchOption = {
  branch: featureWorkspace.branch,
  branchWorkspaceId: featureWorkspace.id,
  worktreePath: featureWorkspace.worktreePath,
  hasWorkspace: true,
  isDefault: false,
};

const remoteOnlyOption: BranchOption = {
  branch: "remote/only",
  hasWorkspace: false,
  isDefault: false,
};

function send(socket: FakeWebSocket, frame: ServerFrame): void {
  socket.onmessage?.call(
    socket as unknown as WebSocket,
    { data: JSON.stringify(frame) } as MessageEvent,
  );
}

function workspaceFrame(
  branches: BranchWorkspace[],
): Extract<ServerFrame, { type: "workspace" }> {
  return {
    type: "workspace",
    workspace: {
      canvasProject: {
        id: "project_a",
        name: "A",
        projectRoot: "/projects/a",
        createdAt: 1,
      },
      revision: 1,
      projectRoot: "/projects/a",
      repo: {
        id: "repo_1",
        remoteUrl: "git@github.com:acme/repo.git",
        defaultBranch: "main",
        localRepoPath: "/projects/a/repo",
        connectedAt: 1,
      },
      branches,
      sharedResources: [],
    },
    workDocumentation: { ready: true },
  };
}

beforeEach(() => {
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.spyOn(api, "list").mockResolvedValue([
    {
      id: "agent_1",
      status: "idle",
      config: { prompt: "" },
      createdAt: 1,
      lastEventSeq: 0,
    },
  ]);
  vi.spyOn(api, "history").mockResolvedValue([]);
  vi.spyOn(api, "listFiles").mockResolvedValue([]);
  vi.spyOn(api, "listFileConnections").mockResolvedValue([]);
  vi.spyOn(api, "listPrompts").mockResolvedValue([]);
  vi.spyOn(api, "listPromptConnections").mockResolvedValue([]);
  vi.spyOn(api, "listPullRequestFlows").mockResolvedValue([]);
  vi.spyOn(api, "listSyncFlows").mockResolvedValue([]);
  vi.spyOn(api, "listCommits").mockResolvedValue([]);
  vi.spyOn(api, "canvasLayout").mockResolvedValue({ nodes: [], updatedAt: 0 });
  vi.spyOn(api, "saveCanvasLayout").mockResolvedValue({ nodes: [], updatedAt: 0 });
  vi.spyOn(api, "settings").mockResolvedValue({
    fullPermissionMode: false,
    workDocumentationEnabled: false,
  });
  vi.spyOn(api, "listCanvasProjects").mockResolvedValue([
    {
      id: "project_a",
      name: "A",
      projectRoot: "/projects/a",
      createdAt: 1,
    },
  ]);
  vi.spyOn(api, "listBranchOptions").mockResolvedValue([mainOption]);
  vi.spyOn(api, "config").mockResolvedValue({
    defaultCwd: "/projects/a/repo",
    projectRoot: "/projects/a",
    codexModels: ["gpt-5.4-mini"],
    defaultCodexModel: "gpt-5.4-mini",
    codexReasoningEfforts: ["medium"],
    codexModelCapabilities: [],
  });
});

afterEach(() => {
  cleanup();
  api.setWorkspaceContext(undefined);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  FakeWebSocket.instances = [];
});

describe("App workspace metadata updates", () => {
  it("merges remote-only response options with newer workspace metadata", async () => {
    let resolveStaleOptions!: (options: BranchOption[]) => void;
    const staleOptions = new Promise<BranchOption[]>((resolve) => {
      resolveStaleOptions = resolve;
    });
    vi.mocked(api.listBranchOptions).mockReturnValueOnce(staleOptions);

    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => {
      send(socket, {
        type: "hello",
        agents: [
          {
            id: "agent_1",
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
      });
      send(socket, workspaceFrame([]));
    });
    await waitFor(() => expect(api.listBranchOptions).toHaveBeenCalledTimes(1));

    act(() => send(socket, workspaceFrame([featureWorkspace])));
    fireEvent.click(screen.getByText("新建 Agent"));
    const branchValues = () =>
      Array.from(
        (screen.getByLabelText("Agent branch") as HTMLSelectElement).options,
        (option) => option.value,
      );
    await waitFor(() => expect(branchValues()).toContain(featureWorkspace.branch));

    await act(async () => {
      resolveStaleOptions([remoteOnlyOption]);
      await staleOptions;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    expect(branchValues()).toContain(featureWorkspace.branch);
    expect(branchValues()).toContain(remoteOnlyOption.branch);
  });

  it("keeps the graph and Agent dialog mounted when a branch broadcast precedes HTTP 201", async () => {
    let resolveBranch!: (branch: BranchWorkspace) => void;
    vi.spyOn(api, "createBranch").mockReturnValue(
      new Promise((resolve) => {
        resolveBranch = resolve;
      }),
    );

    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => {
      send(socket, {
        type: "hello",
        agents: [
          {
            id: "agent_1",
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
      });
      send(socket, workspaceFrame([mainWorkspace]));
    });

    expect(await screen.findByTestId("node:agent_1#0")).toBeTruthy();
    await waitFor(() => expect(api.listBranchOptions).toHaveBeenCalled());
    fireEvent.click(screen.getByText("新建 Agent"));
    fireEvent.change(screen.getByLabelText("新建 branch"), {
      target: { value: featureWorkspace.branch },
    });
    fireEvent.click(screen.getByTitle("创建 branch"));
    await waitFor(() =>
      expect(api.createBranch).toHaveBeenCalledWith({
        branch: featureWorkspace.branch,
        baseBranch: "main",
      }),
    );

    const listCallsBeforeMetadata = vi.mocked(api.list).mock.calls.length;
    act(() => send(socket, workspaceFrame([mainWorkspace, featureWorkspace])));

    expect(screen.getByTestId("node:agent_1#0")).toBeTruthy();
    expect(screen.getByLabelText("新建 branch")).toBeTruthy();
    expect(vi.mocked(api.list).mock.calls.length).toBe(listCallsBeforeMetadata);
    expect(screen.queryByText(/项目已切换/)).toBeNull();

    vi.mocked(api.listBranchOptions).mockResolvedValue([mainOption, featureOption]);
    await act(async () => {
      resolveBranch(featureWorkspace);
      await Promise.resolve();
    });
    await waitFor(() =>
      expect((screen.getByLabelText("Agent branch") as HTMLSelectElement).value).toBe(
        featureWorkspace.branch,
      ),
    );
    expect(screen.getByTestId("node:agent_1#0")).toBeTruthy();
    expect(screen.queryByText(/项目已切换/)).toBeNull();
  });
});
