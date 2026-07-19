import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentMap } from "./agentStore.js";
import type { AgentActions, FileActions, PromptActions } from "./useAgentCanvas.js";
import {
  adoptDeletedCurrentProject,
  adoptOpenedProject,
  buildNodes,
  canvasInteractionForTool,
  canvasLayoutAutosaveReady,
  canvasLayoutFromNodes,
  centeredNodePosition,
  centeredNodePositionInViewport,
  computeCommitEdges,
  computeFileEdges,
  computeLayout,
  computePromptEdges,
  computePullRequestEdges,
  computeResultFileEdges,
  computeSyncFlowEdges,
  isCurrentWorkspaceUpdate,
  isSameBranchWorkspace,
  ownsProjectOperation,
  reconcileWorkspaceBranchOptions,
  resolveCurrentProjectOpenStep,
  staggeredNodePositions,
  workDocumentationMutationWarning,
} from "./App.js";
import { SelectionMode } from "@xyflow/react";

afterEach(() => {
  vi.useRealTimers();
});

describe("canvas layout autosave readiness", () => {
  it("stays closed beyond the debounce while the target layout and refresh are deferred", async () => {
    vi.useFakeTimers();
    let resolveTarget!: () => void;
    let readyProjectId: string | undefined;
    const targetLayoutAndRefresh = new Promise<void>((resolve) => {
      resolveTarget = resolve;
    }).then(() => {
      readyProjectId = "project_q";
    });
    let autosaved = false;

    setTimeout(() => {
      autosaved = canvasLayoutAutosaveReady(
        "project_q",
        "project_q",
        readyProjectId,
      );
    }, 400);
    await vi.advanceTimersByTimeAsync(401);

    expect(autosaved).toBe(false);
    resolveTarget();
    await targetLayoutAndRefresh;
    expect(
      canvasLayoutAutosaveReady("project_q", "project_q", readyProjectId),
    ).toBe(true);
  });
});

describe("canvasInteractionForTool", () => {
  it("select tool enables drag selection while keeping middle mouse panning", () => {
    expect(canvasInteractionForTool("select")).toEqual({
      panOnDrag: [1],
      selectionOnDrag: true,
      selectionMode: SelectionMode.Partial,
    });
  });

  it("hand tool pans with left or middle mouse and disables drag selection", () => {
    expect(canvasInteractionForTool("hand")).toEqual({
      panOnDrag: [0, 1],
      selectionOnDrag: false,
      selectionMode: SelectionMode.Partial,
    });
  });
});

describe("staggeredNodePositions", () => {
  it("keeps a multi-file drop anchored while offsetting each following node", () => {
    expect(staggeredNodePositions({ x: 320, y: 180 }, 3)).toEqual([
      { x: 320, y: 180 },
      { x: 348, y: 208 },
      { x: 376, y: 236 },
    ]);
  });
});

describe("workDocumentationMutationWarning", () => {
  it("surfaces a 207-style partial documentation failure", () => {
    expect(
      workDocumentationMutationWarning({
        partialSuccess: true,
        workDocumentation: { ready: false, error: "unsafe documentation link" },
      }),
    ).toBe("操作已完成，但工作文档初始化失败：unsafe documentation link");
  });

  it("does not warn for a complete operation", () => {
    expect(workDocumentationMutationWarning({})).toBeUndefined();
  });
});

describe("adoptOpenedProject", () => {
  it("synchronously adopts the target project and its documentation warning", () => {
    const updates: string[] = [];
    const target = {
      projectRoot: "/projects/target",
      canvasProject: {
        id: "project_target",
        name: "target",
        projectRoot: "/projects/target",
        createdAt: 1,
      },
      branches: [],
      sharedResources: [],
      partialSuccess: true,
      workDocumentation: { ready: false, error: "unsafe documentation link" },
    };

    adoptOpenedProject(target, {
      setWorkspace: (workspace) => updates.push(`workspace:${workspace.canvasProject?.id}`),
      setLayoutProjectId: (projectId) => updates.push(`layout:${projectId}`),
      setProjectError: (error) => updates.push(`warning:${error}`),
    });

    expect(updates.slice(0, 2)).toEqual([
      "workspace:project_target",
      "layout:project_target",
    ]);
    expect(updates[2]).toContain("unsafe documentation link");
  });
});

describe("resolveCurrentProjectOpenStep", () => {
  it("drops a deferred old-project result after a newer invocation takes ownership", async () => {
    let resolveOld!: (value: string) => void;
    let current = true;
    const oldResult = new Promise<string>((resolve) => {
      resolveOld = resolve;
    });
    const guarded = resolveCurrentProjectOpenStep(oldResult, () => current);

    current = false;
    resolveOld("old-project-layout");

    await expect(guarded).resolves.toBeUndefined();
  });
});

describe("project operation ownership", () => {
  const ownership = { token: 4, workspaceEventGeneration: 10 };

  it("keeps the current open response when its own workspace frame arrived first", () => {
    expect(
      ownsProjectOperation(
        ownership,
        4,
        11,
        "project:target",
        "project:target",
      ),
    ).toBe(true);
  });

  it("drops a late response after a different project or newer local operation takes ownership", () => {
    expect(
      ownsProjectOperation(
        ownership,
        4,
        11,
        "project:newer",
        "project:target",
      ),
    ).toBe(false);
    expect(
      ownsProjectOperation(
        ownership,
        5,
        10,
        "project:target",
        "project:target",
      ),
    ).toBe(false);
    expect(
      ownsProjectOperation(
        ownership,
        4,
        11,
        "project:target@2",
      ),
    ).toBe(false);
  });

  it("drops a late response from an older revision of the same project", () => {
    expect(
      ownsProjectOperation(
        ownership,
        4,
        11,
        "project:target@2",
        "project:target@1",
      ),
    ).toBe(false);
  });
});

describe("workspace update ownership", () => {
  it("drops an older same-project effect after the hook has accepted a newer frame", () => {
    expect(
      isCurrentWorkspaceUpdate(
        {
          canvasProject: {
            id: "project_a",
            name: "A",
            projectRoot: "/projects/a",
            createdAt: 1,
          },
          revision: 1,
          projectRoot: "/projects/a",
          branches: [],
          sharedResources: [],
        },
        "project:project_a@2",
      ),
    ).toBe(false);
  });
});

describe("adoptDeletedCurrentProject", () => {
  it("clears the active project from the REST result even without a workspace frame", () => {
    const updates: string[] = [];
    const cleared = adoptDeletedCurrentProject(
      "project_current",
      {
        projectRoot: "/projects/current",
        canvasProject: {
          id: "project_current",
          name: "current",
          projectRoot: "/projects/current",
          createdAt: 1,
        },
        branches: [],
        sharedResources: [],
      },
      {
        setWorkspace: (workspace) => updates.push(`workspace:${workspace ? "set" : "empty"}`),
        setLayoutProjectId: (projectId) => updates.push(`layout:${projectId ?? "empty"}`),
        setProjectError: (error) => updates.push(`error:${error ?? "empty"}`),
      },
    );

    expect(cleared).toBe(true);
    expect(updates).toEqual(["workspace:empty", "layout:empty", "error:empty"]);
  });

  it("does not clear another active project", () => {
    const setWorkspace = () => {
      throw new Error("must not clear");
    };
    expect(
      adoptDeletedCurrentProject(
        "project_other",
        {
          projectRoot: "/projects/current",
          canvasProject: {
            id: "project_current",
            name: "current",
            projectRoot: "/projects/current",
            createdAt: 1,
          },
          branches: [],
          sharedResources: [],
        },
        {
          setWorkspace,
          setLayoutProjectId: setWorkspace,
          setProjectError: setWorkspace,
        },
      ),
    ).toBe(false);
  });
});

describe("isSameBranchWorkspace", () => {
  const created = {
    id: "branch_2",
    repoId: "repo_1",
    branch: "feature/docs",
    baseBranch: "main",
    worktreePath: "C:/projects/a/worktrees/feature-docs",
    scratchRoot: "C:/projects/a/worktrees/feature-docs/.agent-tmp",
    isDefault: false,
    createdAt: 1,
  };

  it("rejects a same-named branch from a different current project", () => {
    expect(
      isSameBranchWorkspace(created, {
        ...created,
        worktreePath: "C:/projects/b/worktrees/feature-docs",
      }),
    ).toBe(false);
  });

  it("accepts the exact branch workspace returned by the mutation", () => {
    expect(isSameBranchWorkspace(created, { ...created })).toBe(true);
  });
});

describe("reconcileWorkspaceBranchOptions", () => {
  it("adopts authoritative workspaces without dropping remote-only branch options", () => {
    const reconciled = reconcileWorkspaceBranchOptions(
      [
        {
          branch: "feature/metadata",
          hasWorkspace: false,
          isDefault: false,
        },
        {
          branch: "feature/remote-only",
          hasWorkspace: false,
          isDefault: false,
        },
        {
          branch: "feature/removed-workspace",
          branchWorkspaceId: "branch_old",
          worktreePath: "/projects/a/worktrees/removed",
          hasWorkspace: true,
          isDefault: false,
        },
      ],
      {
        projectRoot: "/projects/a",
        branches: [
          {
            id: "branch_main",
            repoId: "repo_1",
            branch: "main",
            baseBranch: "main",
            worktreePath: "/projects/a/repo",
            scratchRoot: "/projects/a/repo/.agent-tmp",
            isDefault: true,
            createdAt: 1,
          },
          {
            id: "branch_feature",
            repoId: "repo_1",
            branch: "feature/metadata",
            baseBranch: "main",
            worktreePath: "/projects/a/worktrees/feature-metadata",
            scratchRoot: "/projects/a/worktrees/feature-metadata/.agent-tmp",
            isDefault: false,
            createdAt: 2,
          },
        ],
        sharedResources: [],
      },
    );

    expect(reconciled.map((option) => option.branch)).toEqual([
      "feature/metadata",
      "feature/remote-only",
      "feature/removed-workspace",
      "main",
    ]);
    expect(reconciled.find((option) => option.branch === "feature/metadata")).toMatchObject({
      branchWorkspaceId: "branch_feature",
      hasWorkspace: true,
    });
    expect(reconciled.find((option) => option.branch === "feature/remote-only")).toMatchObject({
      hasWorkspace: false,
    });
    expect(reconciled.find((option) => option.branch === "feature/removed-workspace")).toEqual({
      branch: "feature/removed-workspace",
      branchWorkspaceId: undefined,
      worktreePath: undefined,
      hasWorkspace: false,
      isDefault: false,
    });
    expect(reconciled.find((option) => option.branch === "main")).toMatchObject({
      branchWorkspaceId: "branch_main",
      hasWorkspace: true,
      isDefault: true,
    });
  });
});

describe("computeFileEdges", () => {
  it("centers an independent root override while keeping the next turn relative", () => {
    const agents: AgentMap = {
      agent_1: {
        id: "agent_1",
        status: "waiting_input",
        turns: [
          { index: 0, status: "done", lines: [] },
          { index: 1, status: "idle", lines: [] },
        ],
        lastSeq: 2,
      },
    };

    const rootPlacement = { x: 900, y: 700 };
    const rejectedDerivedPlacement = { x: -500, y: -400 };
    const nodes = buildNodes(
      agents,
      [],
      [],
      [],
      [],
      [],
      {} as AgentActions,
      {} as FileActions,
      {} as PromptActions,
      [],
      () => undefined,
      () => undefined,
      () => undefined,
      () => undefined,
      () => undefined,
      () => undefined,
      () => undefined,
      [],
      {
        "agent_1#0": rootPlacement,
        "agent_1#1": rejectedDerivedPlacement,
      },
    );

    const first = nodes.find((node) => node.id === "agent_1#0");
    const second = nodes.find((node) => node.id === "agent_1#1");

    expect(first).toMatchObject({
      position: rootPlacement,
      width: 400,
      height: 320,
      data: { windowState: undefined },
    });
    expect(second?.position).not.toEqual(rejectedDerivedPlacement);
    expect(second?.position.x).toBe(first?.position.x);
    expect(second?.position.y).toBe((first?.position.y ?? 0) + 344);
  });

  it("auto-minimizes turns only after they are older than the latest two turns", () => {
    const agents: AgentMap = {
      agent_1: {
        id: "agent_1",
        status: "waiting_input",
        turns: [
          { index: 0, status: "done", lines: [] },
          { index: 1, status: "done", lines: [] },
          { index: 2, status: "idle", lines: [] },
        ],
        lastSeq: 3,
      },
    };

    const nodes = buildNodes(
      agents,
      [],
      [],
      [],
      [],
      [],
      {} as AgentActions,
      {} as FileActions,
      {} as PromptActions,
      [],
      () => undefined,
      () => undefined,
      () => undefined,
      () => undefined,
      () => undefined,
      () => undefined,
      () => undefined,
    );

    const first = nodes.find((node) => node.id === "agent_1#0");
    const second = nodes.find((node) => node.id === "agent_1#1");
    const third = nodes.find((node) => node.id === "agent_1#2");

    expect(first).toMatchObject({
      width: 68,
      height: 48,
      data: { windowState: { minimized: true } },
    });
    expect(second).toMatchObject({
      width: 400,
      height: 320,
      data: { windowState: undefined },
    });
    expect(third).toMatchObject({
      width: 400,
      height: 320,
      data: { windowState: undefined },
    });
    expect(second?.position.y).toBe((first?.position.y ?? 0) + 72);
    expect(third?.position.y).toBe((second?.position.y ?? 0) + 344);
  });

  it("places same-source commit, PR, and sync nodes at one fixed relative position", () => {
    const agents: AgentMap = {
      agent_1: {
        id: "agent_1",
        status: "waiting_input",
        turns: [
          { index: 0, status: "done", lines: [] },
          { index: 1, status: "idle", lines: [] },
        ],
        lastSeq: 2,
      },
    };

    const nodes = buildNodes(
      agents,
      [],
      [],
      [
        {
          id: "commit_1",
          agentId: "agent_1",
          sourceTurnIndex: 0,
          commitSha: "abcdef123456",
          shortSha: "abcdef1",
          subject: "feat: add thing",
          summary: "add thing",
          files: [],
          createdAt: 1,
        },
        {
          id: "commit_2",
          agentId: "agent_1",
          sourceTurnIndex: 0,
          commitSha: "123456abcdef",
          shortSha: "123456a",
          subject: "fix: adjust thing",
          summary: "adjust thing",
          files: [],
          createdAt: 2,
        },
      ],
      [
        {
          id: "pr_flow_1",
          proposerAgentId: "agent_1",
          sourceTurnIndex: 0,
          sourceBranch: "feature/a",
          targetBranch: "main",
          summary: "merge feature a",
          files: [],
          fileChanges: [],
          status: "queued",
          createdAt: 1,
          updatedAt: 1,
          reviewRequests: [],
        },
      ],
      [
        {
          id: "sync_flow_1",
          kind: "branch_pull",
          proposerAgentId: "agent_1",
          sourceTurnIndex: 0,
          sourceBranch: "main",
          targetBranch: "feature/a",
          strategy: "merge",
          summary: "catch up with main",
          reason: "use shared changes",
          files: [],
          fileChanges: [],
          status: "review_collecting",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      {} as AgentActions,
      {} as FileActions,
      {} as PromptActions,
      [],
      () => undefined,
      () => undefined,
      () => undefined,
      () => undefined,
      () => undefined,
      () => undefined,
      () => undefined,
      [],
      {
        "commit:commit_1": { x: -100, y: -100 },
        "pr:pr_flow_1": { x: -200, y: -200 },
        "sync:sync_flow_1": { x: -300, y: -300 },
      },
    );

    const source = nodes.find((node) => node.id === "agent_1#0");
    const commit1 = nodes.find((node) => node.id === "commit:commit_1");
    const commit2 = nodes.find((node) => node.id === "commit:commit_2");
    const pullRequest = nodes.find((node) => node.id === "pr:pr_flow_1");
    const sync = nodes.find((node) => node.id === "sync:sync_flow_1");

    const expected = {
      x: (source?.position.x ?? 0) + (source?.width ?? 0) + 36,
      y: source?.position.y,
    };
    expect(commit1?.position).toEqual(expected);
    expect(commit2?.position).toEqual(expected);
    expect(pullRequest?.position).toEqual(expected);
    expect(sync?.position).toEqual(expected);
  });

  it("forked agent root node starts beside its parent anchor turn", () => {
    const agents: AgentMap = {
      agent_1: {
        id: "agent_1",
        status: "waiting_input",
        turns: [
          { index: 0, status: "done", lines: [], anchorUuid: "anchor-0" },
          { index: 1, status: "idle", lines: [] },
        ],
        lastSeq: 2,
      },
      agent_2: {
        id: "agent_2",
        status: "idle",
        turns: [{ index: 0, status: "idle", lines: [] }],
        forkOrigin: { parentAgentId: "agent_1", anchorUuid: "anchor-0" },
        lastSeq: 0,
      },
    };

    const nodes = buildNodes(
      agents,
      [],
      [],
      [],
      [],
      [],
      {} as AgentActions,
      {} as FileActions,
      {} as PromptActions,
      [],
      () => undefined,
      () => undefined,
      () => undefined,
      () => undefined,
      () => undefined,
      () => undefined,
      () => undefined,
      [],
      { "agent_2#0": { x: -500, y: -400 } },
    );

    const parent = nodes.find((node) => node.id === "agent_1#0");
    const forked = nodes.find((node) => node.id === "agent_2#0");

    expect(forked?.position).toEqual({
      x: (parent?.position.x ?? 0) + (parent?.width ?? 0) + 36,
      y: parent?.position.y,
    });
  });

  it("agent result files are placed beside and connected to the source turn", () => {
    const agents: AgentMap = {
      agent_1: {
        id: "agent_1",
        status: "waiting_input",
        turns: [
          { index: 0, status: "done", lines: [] },
          { index: 1, status: "idle", lines: [] },
        ],
        lastSeq: 2,
      },
    };
    const resultFile = {
      id: "file_1",
      name: "metrics",
      filename: "metrics.md",
      extension: "md",
      path: "/tmp/metrics.md",
      storage: "isolated" as const,
      availability: "available" as const,
      kind: "normal" as const,
      sharedRead: false,
      sharedWrite: false,
      previewKind: "markdown" as const,
      mimeType: "text/markdown",
      createdAt: 1,
      updatedAt: 1,
      origin: {
        kind: "agent_result" as const,
        agentId: "agent_1",
        sourceTurnIndex: 0,
        resultKind: "document" as const,
        summary: "experiment metrics",
      },
    };

    const nodes = buildNodes(
      agents,
      [resultFile],
      [],
      [],
      [],
      [],
      {} as AgentActions,
      {} as FileActions,
      {} as PromptActions,
      [],
      () => undefined,
      () => undefined,
      () => undefined,
      () => undefined,
      () => undefined,
      () => undefined,
      () => undefined,
      [],
      { "file:file_1": { x: -500, y: -400 } },
    );

    const source = nodes.find((node) => node.id === "agent_1#0");
    const file = nodes.find((node) => node.id === "file:file_1");
    expect(file?.position).toEqual({
      x: (source?.position.x ?? 0) + (source?.width ?? 0) + 36,
      y: source?.position.y,
    });

    expect(computeResultFileEdges(agents, [resultFile])[0]).toMatchObject({
      source: "agent_1#0",
      target: "file:file_1",
      label: "result",
    });
  });

  it("buildNodes 使用已保存的节点位置、尺寸和最小化状态", () => {
    const agents: AgentMap = {
      agent_1: {
        id: "agent_1",
        status: "idle",
        turns: [{ index: 0, status: "idle", lines: [] }],
        lastSeq: 0,
      },
    };

    const nodes = buildNodes(
      agents,
      [
        {
          id: "file_1",
          name: "brief",
          filename: "brief.md",
          extension: "md",
          path: "/tmp/brief.md",
          storage: "isolated",
          availability: "available",
          kind: "normal",
          sharedRead: false,
          sharedWrite: false,
          previewKind: "markdown",
          mimeType: "text/markdown",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      [],
      [],
      [],
      [],
      {} as AgentActions,
      {} as FileActions,
      {} as PromptActions,
      [],
      () => undefined,
      () => undefined,
      () => undefined,
      () => undefined,
      () => undefined,
      () => undefined,
      () => undefined,
      [
        {
          id: "agent_1#0",
          type: "turn",
          position: { x: 111, y: 222 },
          width: 444,
          height: 333,
        },
        {
          id: "file:file_1",
          type: "file",
          position: { x: 555, y: 666 },
          width: 68,
          height: 48,
          windowState: { minimized: true, restoreWidth: 280, restoreHeight: 240 },
        },
      ],
    );

    expect(nodes.find((node) => node.id === "agent_1#0")).toMatchObject({
      position: { x: 111, y: 222 },
      width: 444,
      height: 333,
    });
    expect(nodes.find((node) => node.id === "file:file_1")).toMatchObject({
      position: { x: 555, y: 666 },
      width: 68,
      height: 48,
      data: { windowState: { minimized: true, restoreWidth: 280, restoreHeight: 240 } },
    });
  });

  it("centeredNodePosition returns the top-left coordinate for a centered node", () => {
    expect(centeredNodePosition({ x: 500, y: 300 }, 360, 240)).toEqual({
      x: 320,
      y: 180,
    });
  });

  it("converts the visible viewport center into a centered flow position", () => {
    let receivedScreenPosition: { x: number; y: number } | undefined;
    const position = centeredNodePositionInViewport(
      { left: 100, top: 50, width: 1000, height: 600 },
      (screenPosition) => {
        receivedScreenPosition = screenPosition;
        return {
          x: (screenPosition.x - 100) / 2,
          y: (screenPosition.y - 50) / 2,
        };
      },
      400,
      320,
    );

    expect(receivedScreenPosition).toEqual({ x: 600, y: 350 });
    expect(position).toEqual({ x: 50, y: -10 });
  });

  it("centers newly created root nodes at one fixed point and allows overlap", () => {
    const agents: AgentMap = {
      agent_1: {
        id: "agent_1",
        status: "idle",
        turns: [{ index: 0, status: "idle", lines: [] }],
        lastSeq: 0,
      },
    };
    const center = { x: 1200, y: 800 };
    const placements = {
      "agent_1#0": centeredNodePosition(center, 400, 320),
      "file:file_1": centeredNodePosition(center, 320, 260),
      "prompt:prompt_1": centeredNodePosition(center, 340, 280),
    };

    const nodes = buildNodes(
      agents,
      [
        {
          id: "file_1",
          name: "brief",
          filename: "brief.md",
          extension: "md",
          path: "/tmp/brief.md",
          storage: "isolated",
          availability: "available",
          kind: "normal",
          sharedRead: false,
          sharedWrite: false,
          previewKind: "markdown",
          mimeType: "text/markdown",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      [
        {
          id: "prompt_1",
          name: "guide",
          content: "test first",
          kind: "normal",
          sharedRead: false,
          sharedWrite: false,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      [],
      [],
      [],
      {} as AgentActions,
      {} as FileActions,
      {} as PromptActions,
      [],
      () => undefined,
      () => undefined,
      () => undefined,
      () => undefined,
      () => undefined,
      () => undefined,
      () => undefined,
      [],
      placements,
    );

    expect(nodes.find((node) => node.id === "agent_1#0")).toMatchObject({
      position: placements["agent_1#0"],
      width: 400,
      height: 320,
    });
    expect(nodes.find((node) => node.id === "file:file_1")).toMatchObject({
      position: placements["file:file_1"],
      width: 320,
      height: 260,
    });
    expect(nodes.find((node) => node.id === "prompt:prompt_1")).toMatchObject({
      position: placements["prompt:prompt_1"],
      width: 340,
      height: 280,
    });
    for (const node of nodes) {
      expect(node.position.x + (node.width ?? 0) / 2).toBe(center.x);
      expect(node.position.y + (node.height ?? 0) / 2).toBe(center.y);
    }
  });

  it("applies a late placement override exactly after a root node already exists", () => {
    const agents: AgentMap = {
      agent_1: {
        id: "agent_1",
        status: "idle",
        turns: [{ index: 0, status: "idle", lines: [] }],
        lastSeq: 0,
      },
    };
    const file = {
      id: "file_1",
      name: "brief",
      filename: "brief.md",
      extension: "md",
      path: "/tmp/brief.md",
      storage: "isolated" as const,
      availability: "available" as const,
      kind: "normal" as const,
      sharedRead: false,
      sharedWrite: false,
      previewKind: "markdown" as const,
      mimeType: "text/markdown",
      createdAt: 1,
      updatedAt: 1,
    };
    const build = (
      current: ReturnType<typeof buildNodes> = [],
      placements: Record<string, { x: number; y: number }> = {},
    ) =>
      buildNodes(
        agents,
        [file],
        [],
        [],
        [],
        [],
        {} as AgentActions,
        {} as FileActions,
        {} as PromptActions,
        current,
        () => undefined,
        () => undefined,
        () => undefined,
        () => undefined,
        () => undefined,
        () => undefined,
        () => undefined,
        [],
        placements,
      );

    const initial = build();
    const agent = initial.find((node) => node.id === "agent_1#0");
    const initialFile = initial.find((node) => node.id === "file:file_1");
    expect(agent).toBeDefined();
    expect(initialFile).toBeDefined();
    expect(initialFile?.position).not.toEqual(agent?.position);
    const placement = agent!.position;
    const rebuilt = build(initial, { "file:file_1": placement });

    expect(rebuilt.find((node) => node.id === "file:file_1")?.position).toEqual(
      placement,
    );
  });

  it("keeps a fixed gap between enlarged prompt fallback positions", () => {
    const prompts = ["one", "two"].map((id, index) => ({
      id,
      name: id,
      content: `prompt ${index + 1}`,
      kind: "normal" as const,
      sharedRead: false,
      sharedWrite: false,
      createdAt: index + 1,
      updatedAt: index + 1,
    }));
    const nodes = buildNodes(
      {},
      [],
      prompts,
      [],
      [],
      [],
      {} as AgentActions,
      {} as FileActions,
      {} as PromptActions,
      [],
      () => undefined,
      () => undefined,
      () => undefined,
      () => undefined,
      () => undefined,
      () => undefined,
      () => undefined,
    );
    const first = nodes.find((node) => node.id === "prompt:one");
    const second = nodes.find((node) => node.id === "prompt:two");

    expect(first).toMatchObject({ width: 340, height: 280 });
    expect(second?.position.x).toBe(first?.position.x);
    expect((second?.position.y ?? 0) - (first?.position.y ?? 0)).toBe(300);
  });

  it("canvasLayoutFromNodes 序列化节点布局和窗口状态", () => {
    const layout = canvasLayoutFromNodes(
      [
        {
          id: "file:file_1",
          type: "file",
          position: { x: 10, y: 20 },
          width: 68,
          height: 48,
          data: {
            file: {} as never,
            actions: {} as never,
            onPreview: () => undefined,
            onOpenEditor: () => undefined,
            windowState: { minimized: true, restoreWidth: 280, restoreHeight: 240 },
          },
        },
      ],
      1234,
    );

    expect(layout).toEqual({
      updatedAt: 1234,
      nodes: [
        {
          id: "file:file_1",
          type: "file",
          position: { x: 10, y: 20 },
          width: 68,
          height: 48,
          windowState: { minimized: true, restoreWidth: 280, restoreHeight: 240 },
        },
      ],
    });
  });

  it("默认 agent 列距为右侧派生节点预留空间", () => {
    const positions = computeLayout({
      agent_1: {
        id: "agent_1",
        status: "idle",
        turns: [{ index: 0, status: "idle", lines: [] }],
        lastSeq: 0,
      },
      agent_2: {
        id: "agent_2",
        status: "idle",
        turns: [{ index: 0, status: "idle", lines: [] }],
        lastSeq: 0,
      },
    });

    expect(positions["agent_2#0"]!.x - positions["agent_1#0"]!.x).toBeGreaterThan(650);
  });

  it("把连接继承到 Agent 最新一轮，并保留读写方向", () => {
    const agents: AgentMap = {
      agent_1: {
        id: "agent_1",
        status: "waiting_input",
        turns: [
          { index: 0, status: "done", lines: [] },
          { index: 1, status: "idle", lines: [] },
        ],
        lastSeq: 1,
      },
    };
    const edges = computeFileEdges(agents, [
      { id: "file_connection_1", fileId: "file_1", agentId: "agent_1", access: "read" },
      { id: "file_connection_2", fileId: "file_1", agentId: "agent_1", access: "write" },
    ]);

    expect(edges).toEqual([
      expect.objectContaining({
        source: "file:file_1",
        sourceHandle: "read",
        target: "agent_1#1",
        targetHandle: "resource-read",
      }),
      expect.objectContaining({
        source: "agent_1#1",
        sourceHandle: "resource-write",
        target: "file:file_1",
        targetHandle: "write",
      }),
    ]);
  });

  it("stopped/terminated 后的 idle 尾节点仍继承文件连接", () => {
    const agents: AgentMap = {
      agent_1: {
        id: "agent_1",
        status: "terminated",
        turns: [
          { index: 0, status: "terminated", lines: [] },
          { index: 1, status: "idle", lines: [] },
        ],
        lastSeq: 2,
      },
    };
    const edges = computeFileEdges(agents, [
      { id: "file_connection_1", fileId: "file_1", agentId: "agent_1", access: "read" },
    ]);

    expect(edges[0]).toMatchObject({
      source: "file:file_1",
      target: "agent_1#1",
      targetHandle: "resource-read",
    });
  });

  it("提示词连接继承到 Agent 最新一轮", () => {
    const agents: AgentMap = {
      agent_1: {
        id: "agent_1",
        status: "waiting_input",
        turns: [
          { index: 0, status: "done", lines: [] },
          { index: 1, status: "idle", lines: [] },
        ],
        lastSeq: 1,
      },
    };
    const edges = computePromptEdges(agents, [
      {
        id: "prompt_connection_1",
        promptId: "prompt_1",
        agentId: "agent_1",
        access: "read",
      },
    ]);

    expect(edges[0]).toMatchObject({
      source: "prompt:prompt_1",
      sourceHandle: "read",
      target: "agent_1#1",
      targetHandle: "resource-read",
    });
  });

  it("stopped/terminated 后的 idle 尾节点仍继承提示词连接", () => {
    const agents: AgentMap = {
      agent_1: {
        id: "agent_1",
        status: "stopped",
        turns: [
          { index: 0, status: "stopped", lines: [] },
          { index: 1, status: "idle", lines: [] },
        ],
        lastSeq: 2,
      },
    };
    const edges = computePromptEdges(agents, [
      {
        id: "prompt_connection_1",
        promptId: "prompt_1",
        agentId: "agent_1",
        access: "read",
      },
    ]);

    expect(edges[0]).toMatchObject({
      source: "prompt:prompt_1",
      target: "agent_1#1",
      targetHandle: "resource-read",
    });
  });

  it("commit 和 PR 连线固定到记录中的历史轮次", () => {
    const agents: AgentMap = {
      agent_1: {
        id: "agent_1",
        status: "waiting_input",
        turns: [
          { index: 0, status: "done", lines: [] },
          { index: 1, status: "done", lines: [] },
          { index: 2, status: "idle", lines: [] },
        ],
        lastSeq: 4,
      },
    };

    expect(
      computeCommitEdges(agents, [
        {
          id: "commit_1",
          agentId: "agent_1",
          sourceTurnIndex: 1,
          commitSha: "abcdef123456",
          shortSha: "abcdef1",
          subject: "feat: add thing",
          summary: "add thing",
          files: [],
          createdAt: 1,
        },
      ])[0],
    ).toMatchObject({
      source: "agent_1#1",
      target: "commit:commit_1",
    });

    expect(
      computePullRequestEdges(agents, [
        {
          id: "pr_flow_1",
          proposerAgentId: "agent_1",
          sourceTurnIndex: 0,
          sourceBranch: "feature/a",
          targetBranch: "main",
          summary: "merge feature",
          files: ["src/a.ts"],
          fileChanges: [{ status: "M", path: "src/a.ts" }],
          status: "target_review_collecting",
          createdAt: 1,
          updatedAt: 2,
          reviewRequests: [],
        },
      ])[0],
    ).toMatchObject({
      source: "agent_1#0",
      target: "pr:pr_flow_1",
    });

    expect(
      computeSyncFlowEdges(agents, [
        {
          id: "sync_flow_1",
          kind: "cherry_pick",
          proposerAgentId: "agent_1",
          sourceTurnIndex: 1,
          sourceBranch: "main",
          targetBranch: "feature/a",
          commitSha: "abcdef123456",
          summary: "pick fix",
          reason: "need fix",
          files: ["src/a.ts"],
          fileChanges: [{ status: "M", path: "src/a.ts" }],
          status: "review_collecting",
          createdAt: 1,
          updatedAt: 2,
        },
      ])[0],
    ).toMatchObject({
      source: "agent_1#1",
      target: "sync:sync_flow_1",
    });
  });
});
