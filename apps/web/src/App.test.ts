import { describe, expect, it } from "vitest";
import type { AgentMap } from "./agentStore.js";
import { computeFileEdges } from "./App.js";

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
        targetHandle: "file-read",
      }),
      expect.objectContaining({
        source: "agent_1#1",
        sourceHandle: "file-write",
        target: "file:file_1",
        targetHandle: "write",
      }),
    ]);
  });
});
