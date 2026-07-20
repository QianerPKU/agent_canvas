import { describe, it, expect } from "vitest";
import { AgentManager } from "./AgentManager.js";
import type { QueryFn, QueryOptions } from "./sdk/types.js";
import { AsyncMessageQueue } from "./util/AsyncMessageQueue.js";
import type { SdkMessage } from "./sdk/types.js";

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
      terminate: async () => undefined,
    };
  };
  return { query, calls };
}

function makeWaitingQuery() {
  const out = new AsyncMessageQueue<SdkMessage>();
  let lastOptions: QueryOptions | undefined;
  const query: QueryFn = ({ options }) => {
    lastOptions = options;
    return {
      [Symbol.asyncIterator]: () => out[Symbol.asyncIterator](),
      terminate: async () => out.close(),
    };
  };
  return { query, out, getOptions: () => lastOptions };
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

  it("Codex fork 可选择模型并写入启动配置与快照", async () => {
    const codex = makeQuery("codex-thread");
    const mgr = new AgentManager({ query: codex.query, codexQuery: codex.query });

    const parent = mgr.create();
    mgr.startAgent(parent.id, {
      prompt: "p",
      provider: "codex",
      model: "gpt-5.4",
    });
    await flush();

    const forked = mgr.fork(parent.id, "turn-anchor", "gpt-5.4-mini");
    expect(forked).toBeDefined();
    expect(mgr.list().find((agent) => agent.id === forked!.id)?.config).toMatchObject({
      provider: "codex",
      model: "gpt-5.4-mini",
      prompt: "",
    });

    mgr.startAgent(forked!.id, { prompt: "go" });
    await flush();
    expect(codex.calls.at(-1)?.model).toBe("gpt-5.4-mini");
  });

  it("fork 子 agent 启动前可覆盖继承的模型", async () => {
    const codex = makeQuery("codex-thread");
    const mgr = new AgentManager({ query: codex.query, codexQuery: codex.query });

    const parent = mgr.create();
    mgr.startAgent(parent.id, {
      prompt: "p",
      provider: "codex",
      model: "gpt-5.4",
    });
    await flush();

    const forked = mgr.fork(parent.id, "turn-anchor");
    mgr.startAgent(forked!.id, { prompt: "go", model: "gpt-5.5" });
    await flush();
    expect(codex.calls.at(-1)?.model).toBe("gpt-5.5");
  });

  it("Codex start passes reasoning effort to the provider", async () => {
    const codex = makeQuery("codex-thread");
    const mgr = new AgentManager({ query: codex.query, codexQuery: codex.query });

    const agent = mgr.create();
    mgr.startAgent(agent.id, {
      prompt: "p",
      provider: "codex",
      reasoningEffort: "xhigh",
    });
    await flush();

    expect(codex.calls.at(-1)?.reasoningEffort).toBe("xhigh");
  });

  it("create stores provider, cwd and private system prompt settings", () => {
    const { query } = makeQuery();
    const mgr = new AgentManager({ query, defaultCwd: "/repo" });
    const agent = mgr.create({
      provider: "codex",
      model: "gpt-5.4-mini",
      cwd: "/work",
      systemPrompt: "private",
      allowSharedResourceWrites: true,
    });

    expect(mgr.snapshot(agent.id)?.config).toMatchObject({
      provider: "codex",
      model: "gpt-5.4-mini",
      cwd: "/work",
      systemPrompt: "private",
      allowSharedResourceWrites: true,
      prompt: "",
    });
  });

  it("persists shared resource write permission in agent snapshots", async () => {
    const { query } = makeQuery();
    const manager = new AgentManager({ query });
    const agent = manager.create({ allowSharedResourceWrites: true });

    const restored = new AgentManager({ query });
    await restored.importState(manager.exportState());

    expect(restored.snapshot(agent.id)?.config.allowSharedResourceWrites).toBe(true);

    const legacyState = manager.exportState();
    delete legacyState.agents[0]!.config.allowSharedResourceWrites;
    const legacyRestored = new AgentManager({ query });
    await legacyRestored.importState(legacyState);
    expect(legacyRestored.snapshot(agent.id)?.config.allowSharedResourceWrites ?? false).toBe(false);
  });

  it("updateSettings changes mutable agent settings", () => {
    const { query } = makeQuery();
    const mgr = new AgentManager({ query, defaultCwd: "/repo" });
    const agent = mgr.create({
      provider: "codex",
      model: "gpt-5.4",
      cwd: "/work",
      systemPrompt: "old",
      allowSharedResourceWrites: true,
    });

    const updated = mgr.updateSettings(agent.id, {
      systemPrompt: "new",
      allowSharedResourceWrites: false,
    });
    expect(updated.config).toMatchObject({
      provider: "codex",
      model: "gpt-5.4",
      cwd: "/work",
      systemPrompt: "new",
      allowSharedResourceWrites: false,
    });
  });

  it("rejects shared resource permission changes during an active turn", async () => {
    const control = makeWaitingQuery();
    const manager = new AgentManager({ query: control.query });
    const agent = manager.create({ allowSharedResourceWrites: false });
    manager.startAgent(agent.id, { prompt: "run" });
    control.out.push({
      type: "system",
      subtype: "init",
      session_id: "sess-running-permission",
      model: "m",
      cwd: "/repo",
      tools: [],
    });
    await flush();

    expect(() =>
      manager.updateSettings(agent.id, { allowSharedResourceWrites: true }),
    ).toThrow("暂时不能修改共享目录写权限");
    expect(manager.snapshot(agent.id)?.config.allowSharedResourceWrites).toBe(false);
  });

  it("updateSettings can switch and clear the agent model", () => {
    const { query } = makeQuery();
    const mgr = new AgentManager({ query, defaultCwd: "/repo" });
    const agent = mgr.create({
      provider: "claude",
      model: "sonnet",
      cwd: "/work",
    });

    const updated = mgr.updateSettings(agent.id, { model: "opus" });
    expect(updated.config.model).toBe("opus");

    const cleared = mgr.updateSettings(agent.id, { model: null });
    expect(cleared.config.model).toBeUndefined();
  });

  it("fork inherits cwd and private system prompt", async () => {
    const { query } = makeQuery("sess-parent");
    const mgr = new AgentManager({ query });

    const parent = mgr.create({
      cwd: "/parent-work",
      systemPrompt: "parent private prompt",
      allowSharedResourceWrites: true,
    });
    mgr.startAgent(parent.id, { prompt: "p" });
    await flush();

    const forked = mgr.fork(parent.id, "u-anchor");
    expect(forked).toBeDefined();
    expect(mgr.snapshot(forked!.id)?.config).toMatchObject({
      cwd: "/parent-work",
      systemPrompt: "parent private prompt",
      allowSharedResourceWrites: true,
    });

    const revoked = mgr.fork(parent.id, "u-revoked", {
      allowSharedResourceWrites: false,
    });
    expect(mgr.snapshot(revoked!.id)?.config.allowSharedResourceWrites).toBe(false);
  });

  it("fork can override the child branch workspace", async () => {
    const { query } = makeQuery("sess-parent");
    const mgr = new AgentManager({ query });

    const parent = mgr.create({
      cwd: "/repo/main",
      branchWorkspaceId: "branch_1",
      branch: "main",
    });
    mgr.startAgent(parent.id, { prompt: "p" });
    await flush();

    const forked = mgr.fork(parent.id, "u-anchor", {
      branchWorkspaceId: "branch_2",
      branch: "feature/a",
      cwd: "/repo/feature-a",
      scratchDirectory: "/repo/feature-a/.agent-tmp/agent_2",
    });

    expect(forked).toBeDefined();
    expect(mgr.snapshot(forked!.id)?.config).toMatchObject({
      branchWorkspaceId: "branch_2",
      branch: "feature/a",
      cwd: "/repo/feature-a",
      scratchDirectory: "/repo/feature-a/.agent-tmp/agent_2",
    });
  });

  it("开启完全权限模式会放行已挂起的授权请求", async () => {
    const ctl = makeWaitingQuery();
    const mgr = new AgentManager({ query: ctl.query });
    const runner = mgr.create();
    mgr.startAgent(runner.id, { prompt: "需要权限" });
    ctl.out.push({
      type: "system",
      subtype: "init",
      session_id: "sess-approval",
      model: "m",
      cwd: "/repo",
      tools: [],
    });
    await flush();

    const pending = ctl.getOptions()?.requestApproval?.({
      requestId: "approval-manager",
      kind: "command",
      title: "执行命令",
      command: "npm test",
    });
    await flush();

    expect(mgr.historyOf(runner.id).some((entry) => entry.event.kind === "user_approval")).toBe(
      true,
    );
    mgr.updateAppSettings({ fullPermissionMode: true });
    await expect(pending).resolves.toEqual({ action: "approve" });
    expect(mgr.appSettings().fullPermissionMode).toBe(true);
  });

  it("persists work documentation settings and defaults legacy state to disabled", async () => {
    const { query } = makeQuery();
    const manager = new AgentManager({ query });
    expect(manager.appSettings()).toEqual({
      fullPermissionMode: false,
      workDocumentationEnabled: false,
    });

    manager.updateAppSettings({ workDocumentationEnabled: true });
    const state = manager.exportState();
    const restored = new AgentManager({ query });
    await restored.importState(state);
    expect(restored.appSettings()).toEqual({
      fullPermissionMode: false,
      workDocumentationEnabled: true,
    });

    await restored.importState({
      ...state,
      appSettings: { fullPermissionMode: true } as typeof state.appSettings,
    });
    expect(restored.appSettings()).toEqual({
      fullPermissionMode: true,
      workDocumentationEnabled: false,
    });
  });

  it("waits for old runners to terminate while suppressing their final events", async () => {
    const output = new AsyncMessageQueue<SdkMessage>();
    let markTerminationStarted!: () => void;
    let releaseTermination!: () => void;
    const terminationStarted = new Promise<void>((resolve) => {
      markTerminationStarted = resolve;
    });
    const terminationRelease = new Promise<void>((resolve) => {
      releaseTermination = resolve;
    });
    const query: QueryFn = () => ({
      [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
      terminate: async () => {
        markTerminationStarted();
        await terminationRelease;
        output.close();
      },
    });
    const manager = new AgentManager({ query });
    const oldRunner = manager.create({ systemPrompt: "old project" });
    await manager.startAgent(oldRunner.id, { prompt: "keep running" });
    await flush();

    const replacement = new AgentManager({ query: makeQuery().query });
    replacement.create({ systemPrompt: "new project first" });
    replacement.create({ systemPrompt: "new project second" });
    const replacementState = replacement.exportState();
    const observed: SdkMessage[] = [];
    manager.onEvent((envelope) => observed.push(envelope.event as unknown as SdkMessage));

    const importing = manager.importState(replacementState);
    await terminationStarted;
    expect(manager.list()).toHaveLength(1);
    expect(manager.list()[0]?.config.systemPrompt).toBe("old project");
    expect(observed).toEqual([]);

    releaseTermination();
    await importing;
    expect(manager.list().map((agent) => agent.config.systemPrompt)).toEqual([
      "new project first",
      "new project second",
    ]);
    expect(observed).toEqual([]);
  });

  it("clear resets all application settings", async () => {
    const { query } = makeQuery();
    const manager = new AgentManager({ query });
    manager.updateAppSettings({
      fullPermissionMode: true,
      workDocumentationEnabled: true,
    });

    await manager.clear();

    expect(manager.appSettings()).toEqual({
      fullPermissionMode: false,
      workDocumentationEnabled: false,
    });
  });

  it("terminates every transport without clearing agents, history, config, or settings", async () => {
    const outputs: AsyncMessageQueue<SdkMessage>[] = [];
    let terminationCount = 0;
    let markAllTerminationsStarted!: () => void;
    let releaseTerminations!: () => void;
    const allTerminationsStarted = new Promise<void>((resolve) => {
      markAllTerminationsStarted = resolve;
    });
    const terminationRelease = new Promise<void>((resolve) => {
      releaseTerminations = resolve;
    });
    const query: QueryFn = () => {
      const output = new AsyncMessageQueue<SdkMessage>();
      outputs.push(output);
      return {
        [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
        terminate: async () => {
          terminationCount += 1;
          if (terminationCount === 2) markAllTerminationsStarted();
          await terminationRelease;
          output.close();
        },
      };
    };
    const manager = new AgentManager({ query });
    const first = manager.create({ systemPrompt: "first preserved config" });
    const second = manager.create({ systemPrompt: "second preserved config" });
    manager.updateAppSettings({
      fullPermissionMode: true,
      workDocumentationEnabled: true,
    });
    await Promise.all([
      manager.startAgent(first.id, { prompt: "first turn" }),
      manager.startAgent(second.id, { prompt: "second turn" }),
    ]);
    await flush();
    const historyBefore = new Map(
      manager.list().map((agent) => [agent.id, [...manager.historyOf(agent.id)]]),
    );
    let shutdownResolved = false;

    const shutdown = manager.terminateAll().then(() => {
      shutdownResolved = true;
    });
    await allTerminationsStarted;

    expect(shutdownResolved).toBe(false);
    expect(manager.list().map((agent) => agent.id)).toEqual([first.id, second.id]);
    expect(manager.list().map((agent) => agent.config.systemPrompt)).toEqual([
      "first preserved config",
      "second preserved config",
    ]);
    expect(manager.list().map((agent) => agent.status)).toEqual([
      "terminated",
      "terminated",
    ]);
    expect(manager.appSettings()).toEqual({
      fullPermissionMode: true,
      workDocumentationEnabled: true,
    });
    for (const agent of manager.list()) {
      expect(manager.historyOf(agent.id).slice(0, historyBefore.get(agent.id)!.length)).toEqual(
        historyBefore.get(agent.id),
      );
      expect(manager.historyOf(agent.id).at(-1)?.event).toEqual({
        kind: "status",
        status: "terminated",
      });
    }

    releaseTerminations();
    await shutdown;
    expect(shutdownResolved).toBe(true);
    const historyLengths = manager.list().map((agent) => manager.historyOf(agent.id).length);
    await expect(manager.terminateAll()).resolves.toBeUndefined();
    expect(manager.list().map((agent) => manager.historyOf(agent.id).length)).toEqual(
      historyLengths,
    );
  });

  it("currentTurnIndex follows completed result turns", async () => {
    const { query, out } = makeWaitingQuery();
    const mgr = new AgentManager({ query });
    const runner = mgr.create();
    mgr.startAgent(runner.id, { prompt: "第一轮" });
    out.push({
      type: "system",
      subtype: "init",
      session_id: "sess-turns",
      model: "m",
      cwd: "/repo",
      tools: [],
    });
    await flush();
    expect(mgr.currentTurnIndex(runner.id)).toBe(0);

    out.push({
      type: "result",
      subtype: "success",
      is_error: false,
    });
    await flush();
    expect(mgr.currentTurnIndex(runner.id)).toBe(1);
  });

  it("currentTurnIndex treats stopped and terminated turns as boundaries", async () => {
    const { query, out } = makeWaitingQuery();
    const mgr = new AgentManager({ query });
    const runner = mgr.create();
    mgr.startAgent(runner.id, { prompt: "第一轮" });
    out.push({
      type: "system",
      subtype: "init",
      session_id: "sess-turns",
      model: "test",
      cwd: "/repo",
      tools: [],
    });
    await flush();

    await runner.stop();
    expect(mgr.currentTurnIndex(runner.id)).toBe(1);

    runner.send("第二轮");
    await flush();
    await runner.terminate();
    expect(mgr.currentTurnIndex(runner.id)).toBe(2);
  });

  it("records branch and base commit context for a started turn", async () => {
    const { query } = makeWaitingQuery();
    const events: string[] = [];
    const mgr = new AgentManager({
      query,
      resolveTurnContext: async (config) => ({
        branch: config?.branch,
        cwd: config?.cwd,
        baseCommitSha: "abcdef1234567890",
        baseShortSha: "abcdef1",
      }),
    });
    mgr.onEvent((envelope) => events.push(envelope.event.kind));

    const runner = mgr.create({ branch: "feature/a", cwd: "/repo-a" });
    mgr.startAgent(runner.id, {
      prompt: "first",
      branch: "feature/a",
      cwd: "/repo-a",
    });
    await flush();
    await flush();

    expect(mgr.historyOf(runner.id).map((entry) => entry.event)).toContainEqual({
      kind: "turn_context",
      context: {
        turnIndex: 0,
        branch: "feature/a",
        cwd: "/repo-a",
        baseCommitSha: "abcdef1234567890",
        baseShortSha: "abcdef1",
      },
    });
    expect(events).toContain("user_input");
    expect(events).toContain("turn_context");
  });

  it("ignores late events from a runner replaced during state restoration", async () => {
    const { query, out } = makeWaitingQuery();
    const mgr = new AgentManager({ query });
    const forwarded: string[] = [];
    mgr.onEvent((envelope) => forwarded.push(envelope.event.kind));

    const original = mgr.create({ branch: "feature/reload" });
    mgr.startAgent(original.id, {
      prompt: "review before reload",
      branch: "feature/reload",
    });
    out.push({
      type: "system",
      subtype: "init",
      session_id: "session-before-reload",
      model: "test",
      cwd: "/repo",
      tools: [],
    });
    await flush();

    const persisted = mgr.exportState();
    await mgr.importState(persisted);
    const historyLengthAfterRestore = mgr.historyOf(original.id).length;
    const forwardedAfterRestore = forwarded.length;

    out.push({
      type: "assistant",
      message: {
        id: "late-message",
        role: "assistant",
        content: [{ type: "text", text: "late output from the replaced runner" }],
      },
    });
    out.push({ type: "result", subtype: "success", is_error: false });
    await flush();

    expect(mgr.historyOf(original.id)).toHaveLength(historyLengthAfterRestore);
    expect(forwarded).toHaveLength(forwardedAfterRestore);
    expect(mgr.get(original.id)).not.toBe(original);
    expect(mgr.get(original.id)?.getStatus()).toBe("stopped");
  });

  it("drops a delayed turn context after project state replaces the runner identity", async () => {
    let resolveOldContext!: (metadata: {
      branch?: string;
      cwd?: string;
      baseCommitSha?: string;
    }) => void;
    const oldContext = new Promise<{
      branch?: string;
      cwd?: string;
      baseCommitSha?: string;
    }>((resolve) => {
      resolveOldContext = resolve;
    });
    const { query } = makeQuery("old-session");
    const manager = new AgentManager({
      query,
      resolveTurnContext: async () => await oldContext,
    });
    const oldRunner = manager.create({ branch: "old", cwd: "/old" });
    await manager.startAgent(oldRunner.id, {
      prompt: "resolve metadata later",
      branch: "old",
      cwd: "/old",
    });

    const replacement = new AgentManager({ query: makeQuery("new-session").query });
    replacement.create({ branch: "new", cwd: "/new" });
    await manager.importState(replacement.exportState());

    resolveOldContext({
      branch: "old",
      cwd: "/old",
      baseCommitSha: "abcdef1234567890",
    });
    await flush();
    await flush();

    expect(manager.snapshot(oldRunner.id)?.config).toMatchObject({
      branch: "new",
      cwd: "/new",
    });
    expect(
      manager.historyOf(oldRunner.id).some((entry) => entry.event.kind === "turn_context"),
    ).toBe(false);
  });
});
