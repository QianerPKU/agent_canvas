import { describe, expect, it } from "vitest";
import type { AgentMap } from "./agentStore.js";
import {
  computeCommitEdges,
  computeFileEdges,
  computePromptEdges,
  computePullRequestEdges,
  computeSyncFlowEdges,
} from "./App.js";

describe("computeFileEdges", () => {
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
