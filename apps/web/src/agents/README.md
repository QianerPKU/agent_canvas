# Agent Settings

`AgentSettingsDialog` 管理 Agent 创建前和创建后的可调设置。

- 新建 Agent 时先打开设置窗口，选择 `Claude Code` 或 `Codex`，Codex 可选模型，并选择 branch workspace 与当前 Agent 私有系统提示词。
- Branch 列表来自后端 `GET /api/workspace/branches`；弹窗内可通过 `POST /api/workspace/branches` 创建新 branch。实际 `cwd` 由后端根据 `branchWorkspaceId` 解析，不再让用户直接选择 Agent 工作目录。
- 私有系统提示词不是 provider 原生 system prompt，而是由后端按提示词节点同样的方式拼接进业务输入；fork 时直接复制到子 Agent。
- 已创建 Agent 的设置窗口只允许修改私有系统提示词，provider、模型和 branch 保持锁定，避免运行中会话配置漂移。
- 最新对话节点头部的齿轮按钮打开该 Agent 的设置窗口；历史轮次不重复显示设置入口。
