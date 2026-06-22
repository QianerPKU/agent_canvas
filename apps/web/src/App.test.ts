import { describe, expect, it } from "vitest";
import type { AgentMap } from "./agentStore.js";
import type { AgentActions, FileActions, PromptActions } from "./useAgentCanvas.js";
import {
  buildNodes,
  canvasLayoutFromNodes,
  centeredNodePosition,
  computeCommitEdges,
  computeFileEdges,
  computeLayout,
  computePromptEdges,
  computePullRequestEdges,
  computeSyncFlowEdges,
} from "./App.js";

describe("computeFileEdges", () => {
  it("新一轮节点位于自动最小化的上一轮正下方", () => {
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

    expect(first).toMatchObject({
      width: 68,
      height: 48,
      data: { windowState: { minimized: true } },
    });
    expect(second?.position.x).toBe(first?.position.x);
    expect(second?.position.y).toBe((first?.position.y ?? 0) + 72);
  });

  it("commit 节点创建在源对话轮右侧，并避让同源 commit", () => {
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

    const source = nodes.find((node) => node.id === "agent_1#0");
    const commit1 = nodes.find((node) => node.id === "commit:commit_1");
    const commit2 = nodes.find((node) => node.id === "commit:commit_2");

    expect(commit1?.position.x).toBeGreaterThan(source?.position.x ?? 0);
    expect(commit1?.position.y).toBe(source?.position.y);
    expect(commit2?.position).not.toEqual(commit1?.position);
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

  it("buildNodes uses viewport placement overrides for newly created root nodes", () => {
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
      {
        "agent_1#0": { x: 1000, y: 800 },
        "file:file_1": { x: 1500, y: 850 },
        "prompt:prompt_1": { x: 1900, y: 900 },
      },
    );

    expect(nodes.find((node) => node.id === "agent_1#0")?.position).toEqual({
      x: 1000,
      y: 800,
    });
    expect(nodes.find((node) => node.id === "file:file_1")?.position).toEqual({
      x: 1500,
      y: 850,
    });
    expect(nodes.find((node) => node.id === "prompt:prompt_1")?.position).toEqual({
      x: 1900,
      y: 900,
    });
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
