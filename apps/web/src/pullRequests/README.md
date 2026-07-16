# Pull Request Dialog

`PullRequestDialog` 是画布顶栏的 PR 流程入口。它负责发起 PR 审查流程、展示流程状态，并提供人工兜底按钮登记 PR 已创建或已合并。`PullRequestNode` 则是画布上的 PR 节点，用来展示单个 flow 的状态并打开详情。

## 交互边界

- 发起流程时只能选择活跃 agent：`running` 或 `waiting_input`，且该 agent 必须已经绑定 branch。
- 表单提交 `proposerAgentId`、源 branch、目标 branch、标题、概括和可选文件范围到 `POST /api/pr-flows`。
- 正常情况下，提 PR agent 在收到授权后通过固定 JSON 自动推进 `pr_created` / `merged` 状态。
- 前端的“PR 已创建”和“已合并”按钮只是兜底入口，不替代 agent 自己执行 `git`/`gh` 命令。

## 状态同步

`useAgentCanvas` 在 WebSocket `hello` 帧中读取 `prFlows`，并通过 `pr_flow` 帧实时更新流程列表。REST 返回值也会立即 upsert 到本地状态，避免等待下一条 WS。

画布 PR 节点使用后端记录的 `sourceTurnIndex` 连回发起 flow 的对话轮，因此 agent 进入下一轮后，旧对话节点成为历史节点，PR 连线仍保留在原始轮次上。新 PR 节点固定出现在源对话轮右侧；允许与其他派生节点重叠，不做位置避让。

## 测试

`PullRequestDialog.test.tsx` 覆盖活跃 proposer 过滤和发起流程时的参数组装。

`PullRequestNode.test.tsx` 覆盖 PR 节点最小化、Handle 保留和详情入口。
