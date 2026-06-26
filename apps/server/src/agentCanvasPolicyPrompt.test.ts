import { afterEach, describe, expect, it, vi } from "vitest";
import { agentCanvasPolicyPrompt } from "./agentCanvasPolicyPrompt.js";

describe("agentCanvasPolicyPrompt", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("injects tool-style workflow protocols for the current agent", () => {
    vi.stubEnv("AGENT_CANVAS_API", "");
    vi.stubEnv("PORT", "4317");

    const prompt = agentCanvasPolicyPrompt("agent_42");

    expect(prompt).toContain("Agent Canvas 后端工具协议");
    expect(prompt).toContain("下面的工具不是模型原生 tool");
    expect(prompt).toContain("tool: agent_canvas.create_pr_flow");
    expect(prompt).toContain("git diff --name-status <targetBranch>...HEAD");
    expect(prompt).toContain("POST http://127.0.0.1:4317/api/pr-flows");
    expect(prompt).toContain('"proposerAgentId": "agent_42"');
    expect(prompt).toContain('"targetBranch": "main"');
    expect(prompt).toContain('"files": ["src/example.ts"]');
    expect(prompt).toContain('proposerAgentId = "agent_42"');
    expect(prompt).toContain('curl -sS -X POST "http://127.0.0.1:4317/api/pr-flows"');
    expect(prompt).toContain("create_pr authorization");
    expect(prompt).toContain("merge_pr authorization");
    expect(prompt).toContain('"agentCanvasPrEvent": "pr_created"');
    expect(prompt).toContain('"fileChanges": [{ "status": "M", "path": "src/example.ts" }]');
    expect(prompt).toContain('"agentCanvasPrEvent": "merged"');
    expect(prompt).toContain("tool: agent_canvas.create_sync_flow");
    expect(prompt).toContain("POST http://127.0.0.1:4317/api/sync-flows");
    expect(prompt).toContain('"kind": "cherry_pick"');
    expect(prompt).toContain('"kind": "branch_pull"');
    expect(prompt).toContain('kind = "cherry_pick"');
    expect(prompt).toContain('kind = "branch_pull"');
    expect(prompt).toContain('curl -sS -X POST "http://127.0.0.1:4317/api/sync-flows"');
    expect(prompt).toContain("apply authorization");
    expect(prompt).toContain('"agentCanvasSyncEvent": "applied"');
    expect(prompt).toContain("tool: agent_canvas.report_commit");
    expect(prompt).toContain("POST http://127.0.0.1:4317/api/agents/agent_42/commits");
    expect(prompt).toContain('"commit": "HEAD"');
    expect(prompt).toContain('commit = "HEAD"');
    expect(prompt).toContain(
      'curl -sS -X POST "http://127.0.0.1:4317/api/agents/agent_42/commits"',
    );
    expect(prompt).toContain("tool: agent_canvas.report_result");
    expect(prompt).toContain("POST http://127.0.0.1:4317/api/agents/agent_42/report-result");
    expect(prompt).toContain('"resultKind": "image"');
    expect(prompt).toContain('"sourcePath": ".agent-tmp/agent_42/accuracy-curve.png"');
    expect(prompt).toContain('"content": "## Metrics');
  });

  it("uses AGENT_CANVAS_API when configured", () => {
    vi.stubEnv("AGENT_CANVAS_API", "http://127.0.0.1:9999/api");

    expect(agentCanvasPolicyPrompt("agent_1")).toContain(
      "POST http://127.0.0.1:9999/api/pr-flows",
    );
    expect(agentCanvasPolicyPrompt("agent_1")).toContain(
      "POST http://127.0.0.1:9999/api/sync-flows",
    );
    expect(agentCanvasPolicyPrompt("agent_1")).toContain(
      "POST http://127.0.0.1:9999/api/agents/agent_1/commits",
    );
    expect(agentCanvasPolicyPrompt("agent_1")).toContain(
      "POST http://127.0.0.1:9999/api/agents/agent_1/report-result",
    );
  });
});
