import { describe, expect, it } from "vitest";
import {
  toggleCommitNodeWindow,
  type CommitNodeType,
} from "./commits/CommitNode.js";
import { toggleFileNodeWindow, type FileNodeType } from "./files/FileNode.js";
import { toggleTurnNodeWindow, type TurnNodeType } from "./nodes/TurnNode.js";
import {
  togglePromptNodeWindow,
  type PromptNodeType,
} from "./prompts/PromptNode.js";
import {
  togglePullRequestNodeWindow,
  type PullRequestNodeType,
} from "./pullRequests/PullRequestNode.js";
import {
  toggleSyncFlowNodeWindow,
  type SyncFlowNodeType,
} from "./sync/SyncFlowNode.js";

describe("canvas node default dimensions", () => {
  it("restores minimized nodes without saved dimensions to the enlarged defaults", () => {
    expect(
      toggleTurnNodeWindow({
        data: { windowState: { minimized: true } },
      } as unknown as TurnNodeType),
    ).toMatchObject({ width: 400, height: 320 });
    expect(
      toggleFileNodeWindow({
        data: { windowState: { minimized: true } },
      } as unknown as FileNodeType),
    ).toMatchObject({ width: 320, height: 260 });
    expect(
      togglePromptNodeWindow({
        data: { windowState: { minimized: true } },
      } as unknown as PromptNodeType),
    ).toMatchObject({ width: 340, height: 280 });
    expect(
      toggleCommitNodeWindow({
        data: { windowState: { minimized: true } },
      } as unknown as CommitNodeType),
    ).toMatchObject({ width: 300, height: 190 });
    expect(
      togglePullRequestNodeWindow({
        data: { windowState: { minimized: true } },
      } as unknown as PullRequestNodeType),
    ).toMatchObject({ width: 320, height: 200 });
    expect(
      toggleSyncFlowNodeWindow({
        data: { windowState: { minimized: true } },
      } as unknown as SyncFlowNodeType),
    ).toMatchObject({ width: 320, height: 200 });
  });
});
