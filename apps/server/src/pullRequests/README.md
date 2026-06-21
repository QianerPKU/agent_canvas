# Pull Request Flow Manager

`PullRequestFlowManager` 管理 Agent Canvas 内的 PR 审查与授权流程。它只控制流程状态、超时、审查 JSON 校验、重试和授权信号；具体 `git`/`gh` 命令、冲突处理、提交和合并操作都交给提 PR 的 agent 自行执行。

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
  "prUrl": "https://github.com/OWNER/REPO/pull/12"
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
