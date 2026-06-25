# @agent-canvas/shared

前后端共享的**类型契约**。当前只含类型与少量纯函数（无运行时依赖），编译为 ESM 供 `apps/server` 与 `apps/web` 引用。

## 内容

### 统一事件模型 (`src/events.ts`)

把 Claude Agent SDK 的原始消息归一成与 SDK 解耦的语义事件，是整个系统的核心契约。

| 导出 | 说明 |
| --- | --- |
| `AgentStatus` | agent 运行状态机：`idle / starting / running / waiting_input / done / stopped / terminated / error` |
| `isTerminalStatus()` / `TERMINAL_STATUSES` | 判断/列举终态（`done/stopped/terminated/error`） |
| `AgentProvider` | 底层 agent 驱动：`claude / codex` |
| `CODEX_MODELS` / `DEFAULT_CODEX_MODEL` | Codex UI 可选模型与默认模型 |
| `CompactTrigger` | compact 来源：`manual` 表示用户触发并独立成轮，`auto` 表示 provider 自动压缩且保留在当前业务轮 |
| `UserInputMode` | 运行中输入模式：`queued` 表示排到下一轮，`steer` 表示引导当前 in-flight turn；未设置表示普通轮次输入 |
| `AgentQuestionRequest` / `AgentQuestionResponse` | 底层 CLI/SDK 在执行中主动询问用户时的统一问题与回答载体，覆盖 Claude `AskUserQuestion`、Codex `requestUserInput` 和 MCP elicitation |
| `AgentApprovalRequest` / `AgentApprovalResponse` | 底层 CLI/SDK 在执行中请求授权时的统一审批载体，覆盖命令执行、文件变更、权限扩展和 Claude 工具审批 |
| `AgentCanvasSettings` | 程序级运行时设置；当前包含 `fullPermissionMode` 完全权限模式 |
| `AgentEvent` | 归一化事件的可辨识联合（判别字段 `kind`）：`status / user_input / user_question / user_question_result / user_approval / user_approval_result / compact / system_init / thinking / assistant_text / tool_use / tool_result / result / error` |
| `AgentEventEnvelope` | 传输信封：`{ agentId, seq, at, event }`，带单调序号便于回放/补齐 |
| `AgentStartConfig` | 启动 agent 的配置（provider、prompt、branch workspace/cwd、model、权限模式、`zoneId` 占位等） |
| `ClientCommand` | 客户端→服务端命令：`start / stop / compact / terminate / send / steer / resume` |
| `AgentSnapshot` | agent 当前快照（REST 列表、重连补齐） |

`stopped` and `terminated` remain terminal provider lifecycle states, but the canvas treats their
status events as turn boundaries and may accept a later `send` to continue the same agent chain.

### Commit 模型 (`src/commits.ts`)

`AgentCommitSnapshot` 记录 agent 上报的一次 git commit：agent id、`sourceTurnIndex`、完整/短 hash、branch、作者、message、变更文件和每文件 diff。`ReportAgentCommitInput` 是 agent 调用 commit report 接口时的输入，默认记录当前工作区 `HEAD`。

## 设计约定

- **事件单向、命令单向**：后端→前端只发 `AgentEvent`（包在 `AgentEventEnvelope` 里）；前端→后端只发 `ClientCommand`。
- **seq 单调递增**：每个 agent 的事件带连续 `seq`，前端可据此判断丢包/排序，未来支持断线重连补齐。
- **与 provider 解耦**：前端不依赖 Claude SDK 或 Codex app-server 的任何原始类型；provider→统一事件的映射只发生在 `apps/server`。

## 开发

```bash
npm run build --workspace packages/shared   # tsc 编译到 dist/
npm test --workspace packages/shared        # vitest
```

## 文件节点模型

`src/files.ts` 定义 `CanvasFileNode`、`CanvasFileConnection`、创建/更新输入，以及服务端解析后的 `AgentFileAccess`。普通节点通过 `read/write` 连线授权，共享节点通过全局读写开关授权。

文件节点固定使用 `isolated` 存储，由后端放在用户本地数据目录的单节点隔离目录中。`CanvasFileKind="shared"` 只表示画布级全局文件引用授权，不等同于 `SharedResourceMount` 的跨 branch 共享资源映射。

## Agent 设置模型

`src/events.ts` 定义 `AgentSettings`、`CreateAgentInput`、`UpdateAgentSettingsInput` 和 `ForkAgentInput`。创建 Agent 可带 provider、模型、`branchWorkspaceId`/`branch` 和私有系统提示词；新工作流中 branch workspace 决定实际工作目录，`cwd` 保留兼容与快照展示。更新已创建 Agent 时可调整私有系统提示词和模型，并可在后端允许的活跃状态切换 branch。`UpdateAgentSettingsInput.model` 为字符串时表示切换后续响应模型，为 `null` 时表示清回 provider 默认模型。`ForkAgentInput` 必须携带 `anchorUuid`，并可覆盖 fork 子 agent 的模型和目标 branch。`AgentStartConfig.systemPrompt` 只表示画布私有提示词，会按提示词节点方式拼接到业务输入中。

## Workspace 模型

`src/workspaces.ts` 定义 canvas 项目索引、GitHub/repo 连接、`BranchOption`、`BranchWorkspace`、`SharedResourceMount` 和创建输入。`CreateBranchWorkspaceInput.baseBranch` 表示新 branch 的继承来源；未提供时使用 repo 默认 branch。三类文件约定为：仓库文件在 branch worktree 内并默认需要 commit；共享资源位于项目级共享目录并映射进各 branch；Agent 临时文件位于 `.agent-tmp/<agent-id>/` 且不提交。

`BranchOption.hasWorkspace=false` 表示远端已有但本地尚未创建专属 worktree；后端在创建 Agent 或切换 Agent branch 时才懒创建该 workspace。

`AgentFileAccess` 额外包含 `readableDirectories` 和 `sharedResources`。`readOnly` 共享资源只进入可读目录和上下文说明；`readWrite` 共享资源才加入 `writableDirectories`。

## PR 流程模型

`src/pullRequests.ts` 定义 PR 审查与授权流程的共享类型：`CreatePullRequestFlowInput`、`PullRequestFlowSnapshot`、`PullRequestReviewRequest`、`PullRequestReviewResponse` 和 `PullRequestFlowStatus`。

流程状态只表达程序控制的审查/授权边界：源 branch preflight、提 PR 授权、目标 branch merge 审查、合并授权、失败、超时或取消。它不限制 agent 自行 commit，也不描述具体 `git`/`gh` 命令。

`PullRequestFlowSnapshot.fileChanges` 使用 `PullRequestChangedFile` 记录这次 PR 的具体文件变化（`git diff --name-status` 的 `status + path`）。后端发给审查 agent 的 source/target review 提示必须包含该列表；`files` 保留为路径范围的简化列表。`sourceTurnIndex` 固定 PR 节点连回的对话轮次，避免 agent 继续运行后连线漂移到最新轮。

`ServerFrame` 的 `hello` 帧可携带 `prFlows`、`syncFlows` 和 `commits` 快照，后续 `pr_flow` 帧推送单个 PR 流程更新，`sync_flow` 帧推送单个同步流程更新，`commit` 帧推送单个 commit 上报。

## Sync Flow Model

`src/syncFlows.ts` defines the one-step review model for importing code into the current branch.
It intentionally separates two operations:

- `cherry_pick`: review a single commit before the proposer agent runs `git cherry-pick`.
- `branch_pull`: review another branch before the proposer agent runs a merge/rebase/pull.

`CreateSyncFlowInput` always includes `proposerAgentId`, `summary`, `reason`, and a concrete file
scope either provided by the caller or resolved by the server. `SyncFlowSnapshot.sourceTurnIndex`
pins the canvas node edge to the exact agent turn that started the flow.

## 提示词节点模型

`src/prompts.ts` 定义纯文本 `CanvasPromptNode`、普通节点连线、共享读写开关，以及服务端解析后的 `AgentPromptAccess`。读权限把文本直接拼接进 Agent 上下文，写权限授权 Agent 修改节点的内部文本载体；可读提示词已由服务端按稳定顺序排列。
