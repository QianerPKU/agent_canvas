# Agent Settings

`AgentSettingsDialog` 管理 Agent 创建前和创建后的可调设置。

- 新建 Agent 时先打开设置窗口，选择 `Claude Code` 或 `Codex`，Codex 可选模型，并选择 branch 与当前 Agent 私有系统提示词。
- Branch 列表来自后端 `GET /api/workspace/branch-options`；其中 `hasWorkspace=false` 的远端 branch 仅作为选项展示，创建 Agent 或切换 Agent 后才由后端懒创建专属 worktree。弹窗内也可通过 `POST /api/workspace/branches` 新建 branch。
- 私有系统提示词不是 provider 原生 system prompt，而是由后端按提示词节点同样的方式拼接进业务输入；fork 时直接复制到子 Agent。
- 已创建 Agent 的设置窗口允许修改私有系统提示词；当 Agent 处于 `idle` 或 `waiting_input` 时，还可切换到已有 branch 或新建 branch。切换后下一次对话会收到后端注入的 branch 切换说明与 diff 文件列表。
- `running`、`done`、`stopped`、`terminated`、`error` 状态下 branch 控件禁用；历史轮次不显示设置入口。
- 最新对话节点头部的齿轮按钮打开该 Agent 的设置窗口；历史轮次不重复显示设置入口。
