import { describe, it, expect } from "vitest";
import { AgentManager } from "./AgentManager.js";
import type { QueryFn, QueryOptions } from "./sdk/types.js";

const flush = () => new Promise((r) => setTimeout(r, 0));

/** query：记录每次调用的 options，并吐一个 system init 让 agent 拿到 sessionId。 */
function makeQuery(sessionId = "sess-1") {
  const calls: QueryOptions[] = [];
  const query: QueryFn = ({ options }) => {
    calls.push(options ?? {});
    return {
      async *[Symbol.asyncIterator]() {
        yield {
          type: "system",
          subtype: "init",
          session_id: sessionId,
          model: "m",
          cwd: "/",
          tools: [],
        };
      },
    };
  };
  return { query, calls };
}

describe("AgentManager fork", () => {
  it("fork 记录来源，并在 startAgent 时合并 fork 配置", async () => {
    const { query, calls } = makeQuery("sess-parent");
    const mgr = new AgentManager({ query });

    const parent = mgr.create();
    mgr.startAgent(parent.id, { prompt: "p" });
    await flush();
    expect(parent.snapshot().sessionId).toBe("sess-parent");

    const forked = mgr.fork(parent.id, "u-anchor");
    expect(forked).toBeDefined();

    // 来源写入快照，供前端画 fork 连线
    const snap = mgr.list().find((a) => a.id === forked!.id);
    expect(snap?.forkOrigin).toEqual({ parentAgentId: parent.id, anchorUuid: "u-anchor" });

    // 启动 fork 出来的 agent → 合并 resume/resumeSessionAt/forkSession
    mgr.startAgent(forked!.id, { prompt: "go" });
    await flush();
    const forkCall = calls.find((o) => o.forkSession === true);
    expect(forkCall).toBeDefined();
    expect(forkCall?.resume).toBe("sess-parent");
    expect(forkCall?.resumeSessionAt).toBe("u-anchor");
  });

  it("父会话未建立时 fork 返回 undefined", () => {
    const { query } = makeQuery();
    const mgr = new AgentManager({ query });
    const parent = mgr.create(); // 未 start，无 sessionId
    expect(mgr.fork(parent.id, "u")).toBeUndefined();
  });

  it("fork 未知父 agent 返回 undefined", () => {
    const { query } = makeQuery();
    const mgr = new AgentManager({ query });
    expect(mgr.fork("nope", "u")).toBeUndefined();
  });

  it("fork 出来的 agent 继承父 provider", async () => {
    const claude = makeQuery("claude-session");
    const codex = makeQuery("codex-thread");
    const mgr = new AgentManager({ query: claude.query, codexQuery: codex.query });

    const parent = mgr.create();
    mgr.startAgent(parent.id, { prompt: "p", provider: "codex" });
    await flush();

    const forked = mgr.fork(parent.id, "turn-anchor");
    expect(forked).toBeDefined();

    mgr.startAgent(forked!.id, { prompt: "go" });
    await flush();

    expect(claude.calls).toHaveLength(0);
    expect(codex.calls).toHaveLength(2);
  });
});
