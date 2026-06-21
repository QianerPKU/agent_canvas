import { afterEach, describe, expect, it, vi } from "vitest";
import { agentCanvasPolicyPrompt } from "./agentCanvasPolicyPrompt.js";

describe("agentCanvasPolicyPrompt", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("injects the PR pipeline protocol for the current agent", () => {
    vi.stubEnv("AGENT_CANVAS_API", "");
    vi.stubEnv("PORT", "4317");

    const prompt = agentCanvasPolicyPrompt("agent_42");

    expect(prompt).toContain("PR pipeline 规则");
    expect(prompt).toContain("git diff --name-status <targetBranch>...HEAD");
    expect(prompt).toContain("POST http://127.0.0.1:4317/api/pr-flows");
    expect(prompt).toContain("summary、files");
    expect(prompt).toContain('proposerAgentId = "agent_42"');
    expect(prompt).toContain("create_pr 授权");
    expect(prompt).toContain("merge_pr 授权");
    expect(prompt).toContain('"agentCanvasPrEvent": "pr_created"');
    expect(prompt).toContain('"fileChanges": [{ "status": "M", "path": "src/example.ts" }]');
    expect(prompt).toContain('"agentCanvasPrEvent": "merged"');
    expect(prompt).toContain("commit report 工具");
    expect(prompt).toContain("POST http://127.0.0.1:4317/api/agents/agent_42/commits");
    expect(prompt).toContain('commit = "HEAD"');
    expect(prompt).toContain("Sync pipeline rules for cherry-pick and branch pull");
    expect(prompt).toContain("POST http://127.0.0.1:4317/api/sync-flows");
    expect(prompt).toContain('kind = "cherry_pick"');
    expect(prompt).toContain('kind = "branch_pull"');
    expect(prompt).toContain('"agentCanvasSyncEvent": "applied"');
  });

  it("uses AGENT_CANVAS_API when configured", () => {
    vi.stubEnv("AGENT_CANVAS_API", "http://127.0.0.1:9999/api");

    expect(agentCanvasPolicyPrompt("agent_1")).toContain(
      "POST http://127.0.0.1:9999/api/pr-flows",
    );
    expect(agentCanvasPolicyPrompt("agent_1")).toContain(
      "POST http://127.0.0.1:9999/api/sync-flows",
    );
  });
});
