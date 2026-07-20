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
    expect(prompt).toContain("在调用 POST http://127.0.0.1:4317/api/pr-flows 前");
    expect(prompt).toContain("使用 merge 或 rebase 完成同步");
    expect(prompt).toContain("POST http://127.0.0.1:4317/api/pr-flows");
    expect(prompt).toContain('"proposerAgentId": "agent_42"');
    expect(prompt).toContain('"targetBranch": "main"');
    expect(prompt).toContain('"files": ["src/example.ts"]');
    expect(prompt).toContain('proposerAgentId = "agent_42"');
    const powershellRequests = prompt
      .split("\n")
      .filter((line) => line.startsWith("Invoke-RestMethod"));
    expect(powershellRequests).toHaveLength(8);
    expect(
      powershellRequests.every((line) =>
        line.includes('-ContentType "application/json; charset=utf-8"'),
      ),
    ).toBe(true);
    expect(prompt).toContain("PowerShell 5.1 会在请求发出前把中文替换成问号");
    expect(prompt).toContain('curl -sS -X POST "http://127.0.0.1:4317/api/pr-flows"');
    expect(prompt).toContain("create_pr authorization");
    expect(prompt).toContain("merge_pr authorization");
    expect(prompt).toContain(
      'Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:4317/api/pr-flows/pr_flow_x/pr-created"',
    );
    expect(prompt).toContain(
      'curl -sS -X POST "http://127.0.0.1:4317/api/pr-flows/pr_flow_x/pr-created"',
    );
    expect(prompt).toContain('completionToken = "<copy exactly from create_pr authorization>"');
    expect(prompt).toContain(
      '"completionToken": "<copy exactly from create_pr authorization>"',
    );
    expect(prompt).toContain('"fileChanges": [{ "status": "M", "path": "src/example.ts" }]');
    expect(prompt).toContain(
      'Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:4317/api/pr-flows/pr_flow_x/merged"',
    );
    expect(prompt).toContain(
      'curl -sS -X POST "http://127.0.0.1:4317/api/pr-flows/pr_flow_x/merged"',
    );
    expect(prompt).toContain('completionToken = "<copy exactly from merge_pr authorization>"');
    expect(prompt).toContain(
      '"completionToken": "<copy exactly from merge_pr authorization>"',
    );
    expect(prompt).not.toContain('"agentCanvasPrEvent": "pr_created"');
    expect(prompt).not.toContain('"agentCanvasPrEvent": "merged"');
    expect(prompt).toContain("tool: agent_canvas.create_sync_flow");
    expect(prompt).toContain("POST http://127.0.0.1:4317/api/sync-flows");
    expect(prompt).toContain('"kind": "cherry_pick"');
    expect(prompt).toContain('"kind": "branch_pull"');
    expect(prompt).toContain('kind = "cherry_pick"');
    expect(prompt).toContain('kind = "branch_pull"');
    expect(prompt).toContain('curl -sS -X POST "http://127.0.0.1:4317/api/sync-flows"');
    expect(prompt).toContain("apply authorization");
    expect(prompt).toContain(
      'Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:4317/api/sync-flows/sync_flow_x/applied"',
    );
    expect(prompt).toContain(
      'curl -sS -X POST "http://127.0.0.1:4317/api/sync-flows/sync_flow_x/applied"',
    );
    expect(prompt).toContain('callbackToken = "<copy exactly from apply authorization>"');
    expect(prompt).toContain(
      '"callbackToken": "<copy exactly from apply authorization>"',
    );
    expect(prompt).not.toContain('"agentCanvasSyncEvent": "applied"');
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
    expect(prompt).not.toContain("工作文档维护（已开启）");
    expect(prompt).not.toContain(".agent-docs/index.md");
  });

  it("keeps PR and sync reporting as intermediate calls with strict authorization freezes", () => {
    const prompt = agentCanvasPolicyPrompt("agent_policy");

    expect(prompt).toContain("全部是当前工作过程中的中间工具调用，不是面向用户的最终答复");
    expect(prompt).toContain("不得为了登记事件而结束回复");
    expect(prompt).toContain("创建 flow 的 HTTP 响应只表示后端已接收流程，不代表已经授权");
    expect(prompt).toContain("登记时必须逐字复制该 token");
    expect(prompt).toContain(
      "POST 创建 PR flow 返回后，直到收到 create_pr authorization 或该 flow 明确失败、取消、超时之前，严禁修改文件、commit、push、创建或更新 PR",
    );
    expect(prompt).toContain(
      "PR created 登记请求返回后，直到收到 merge_pr authorization 或该 flow 明确失败、取消、超时之前，同样严禁修改文件、commit、push、创建或更新 PR",
    );
    expect(prompt).toContain(
      "POST 创建 sync flow 返回后，直到收到 apply authorization 或该 flow 明确失败、取消、超时之前，严禁修改文件、commit、push、创建或更新 PR",
    );
    expect(prompt).toContain("收到 create_pr authorization 后，只执行该授权允许的 PR 创建动作");
    expect(prompt).toContain("收到 merge_pr authorization 后，只执行该授权允许的当前 PR 合并动作");
    expect(prompt).toContain("不要借此修改文件、产生额外 commit、push、同步或改写 branch");
    expect(prompt).toContain("不要修改文件、产生新的源 branch/workspace commit、push");
    expect(prompt).toContain(
      "收到 apply authorization 后，只执行该 flow 已授权的 cherry-pick 或 branch pull",
    );
    expect(prompt).toContain("测试、commit 和 push，不要混入无关修改");
    expect(prompt).toContain("PR created 登记是中间动作；调用后继续原任务");
    expect(prompt).toContain("merged 登记是中间动作；调用后继续完成原任务");
    expect(prompt).toContain("sync applied 登记是中间动作；调用后继续完成原任务");
  });

  it("conditionally injects the work documentation policy and git exceptions", () => {
    const prompt = agentCanvasPolicyPrompt("agent_docs", {
      workDocumentationEnabled: true,
    });

    expect(prompt).toContain("工作文档维护（已开启）");
    expect(prompt).toContain(".agent-docs/index.md");
    expect(prompt).toContain(".agent-shared-docs/index.md");
    expect(prompt).toContain("不要等到任务结束才补写");
    expect(prompt).toContain("任务信息不充分");
    expect(prompt).toContain("已废弃");
    expect(prompt).toContain("共享索引中的 branch 条目和链接由 Agent Canvas 后端维护");
    expect(prompt).toContain("写入当前 branch 概要前重新读取最新内容");
    expect(prompt).toContain("属于不提交的明确例外");
    expect(prompt).toContain("即代表用户明确授权");
    expect(prompt).toContain("必须排除在提交范围外");
    expect(prompt).toContain("如果当前处于只读或 plan 模式");
  });

  it("uses AGENT_CANVAS_API when configured", () => {
    vi.stubEnv("AGENT_CANVAS_API", "http://127.0.0.1:9999/api");

    expect(agentCanvasPolicyPrompt("agent_1")).toContain(
      "POST http://127.0.0.1:9999/api/pr-flows",
    );
    expect(agentCanvasPolicyPrompt("agent_1")).toContain(
      "POST http://127.0.0.1:9999/api/pr-flows/<flowId>/pr-created",
    );
    expect(agentCanvasPolicyPrompt("agent_1")).toContain(
      "POST http://127.0.0.1:9999/api/pr-flows/<flowId>/merged",
    );
    expect(agentCanvasPolicyPrompt("agent_1")).toContain(
      "POST http://127.0.0.1:9999/api/sync-flows",
    );
    expect(agentCanvasPolicyPrompt("agent_1")).toContain(
      "POST http://127.0.0.1:9999/api/sync-flows/<flowId>/applied",
    );
    expect(agentCanvasPolicyPrompt("agent_1")).toContain(
      "POST http://127.0.0.1:9999/api/agents/agent_1/commits",
    );
    expect(agentCanvasPolicyPrompt("agent_1")).toContain(
      "POST http://127.0.0.1:9999/api/agents/agent_1/report-result",
    );
  });
});
