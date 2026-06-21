# Pull Request Flow Manager

`PullRequestFlowManager` 管理 Agent Canvas 内的 PR 审查与授权流程。它只控制流程状态、超时、审查 JSON 校验、重试和授权信号；具体 `git`/`gh` 命令、冲突处理、提交和合并操作都交给提 PR 的 agent 自行执行。

流程可以由前端 PR 面板发起，也可以由提 PR 的 agent 自己发起。`agentCanvasPolicyPrompt` 会把 `POST /api/pr-flows` 的使用协议注入给每个 agent，因此用户在 agent 对话框里直接要求“提 PR”时，agent 应先调用该接口进入 Agent Canvas 审查流程。

每次审查请求都会包含具体变更文件。默认 server 通过 `WorkspaceManager.diffPullRequestFiles()` 计算 `git diff --name-status <target>...<source>` 并写入 `changedFiles`；如果发起流程时显式传入 `files`，则按这次 PR 的文件范围审查并补齐对应状态。无法确定任何变更文件时，后端会拒绝创建 PR flow。

## 流程

1. 用户通过 `POST /api/pr-flows` 发起流程，指定提 PR 的 agent、目标 branch、概括和可选文件范围。
2. 后端找到源 branch 上所有活跃 agent（`running` 或 `waiting_input`），发送 source preflight 审查请求。
3. 审查 agent 必须输出固定 JSON。非法 JSON 会触发一次重试；重试后仍非法则记为 `blocked`。
4. 全部源审查通过后，后端给提 PR agent 发出 `create_pr` 授权信号。该 agent 可自由处理冲突、更新源 branch、运行 `gh pr create` 等命令。
5. 提 PR agent 创建 PR 后输出 `agentCanvasPrEvent: "pr_created"` JSON，或前端兜底调用 `POST /api/pr-flows/:id/pr-created`。
6. 后端找到目标 branch 上所有活跃 agent，发送 target merge 审查请求。
7. 全部目标审查通过后，后端给提 PR agent 发出 `merge_pr` 授权信号。该 agent 自行执行合并。

任一审查阶段默认 10 分钟超时。超时后流程进入 `timed_out`，不再继续授权。

## Agent 输出协议

审查输出：

```json
{
  "agentCanvasPrReview": true,
  "flowId": "pr_flow_1",
  "stage": "source_preflight",
  "decision": "approve",
  "summary": "review summary",
  "risks": [],
  "filesReviewed": [],
  "requiredChanges": []
}
```

PR 创建输出：

```json
{
  "agentCanvasPrEvent": "pr_created",
  "flowId": "pr_flow_1",
  "prNumber": 12,
  "prUrl": "https://github.com/OWNER/REPO/pull/12",
  "files": ["src/example.ts"],
  "fileChanges": [{ "status": "M", "path": "src/example.ts" }]
}
```

合并完成输出：

```json
{
  "agentCanvasPrEvent": "merged",
  "flowId": "pr_flow_1"
}
```

## 测试

`PullRequestFlowManager.test.ts` 使用 fake agent host 覆盖源审查通过、PR 创建、目标审查通过、合并授权、非法 JSON 重试失败和超时。

`PullRequestFlowManager.integration.test.ts` 会创建真实临时 git repo 和 bare remote，经 `WorkspaceManager` clone 出 `main`、`feature/pr-flow`、`feature/other` 三个 branch workspace，再启动多个 fake agent。测试覆盖：

- 源 branch 多个活跃 agent 同时审查，`running` agent 走 steer，`waiting_input` agent 走 send。
- 目标 branch 多个活跃 agent 在 PR 创建后审查。
- 非相关 branch 的活跃 agent 不收到审查请求。
- 目标审查中的非法 JSON 会触发重试，重试通过后才发合并授权。
- 提 PR agent 输出 `pr_created` / `merged` JSON 后流程自动推进和闭合。
