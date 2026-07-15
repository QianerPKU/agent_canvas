# @agent-canvas/server

后端控制层：拉起 / 监控 / 操纵 agent。支持 **Claude Agent SDK** 与 **Codex CLI app-server** 两种 provider，把底层原始消息归一成 `@agent-canvas/shared` 的统一事件，经 WebSocket 实时推给前端画布；命令（启动/停止/干预）走 REST。

## 模块

| 文件 | 职责 |
| --- | --- |
| `src/sdk/types.ts` | 对 Agent SDK 的**最小本地类型映射** + `QueryFn/QueryHandle`（含 interrupt/steer/terminate，便于单测注入假实现） |
| `src/sdk/realQuery.ts` | 把真实 SDK 的 `query` 适配成 `QueryFn`（仅运行时引入），并通过 `canUseTool` 接入 Claude `AskUserQuestion` 与工具授权审批 |
| `src/sdk/codexAppServerQuery.ts` | 通过 `codex app-server --stdio` 驱动 Codex thread/turn/fork，并接入 app-server 反向 `requestUserInput`、MCP elicitation 和授权审批 |
| `src/sdk/codexAppServerMapper.ts` | **纯函数**：Codex app-server JSON-RPC 通知 → SDK-like 消息 |
| `src/eventMapper.ts` | **纯函数**：一条 SDK 消息 → 0..N 个统一 `AgentEvent`，保留 Claude thinking 与工具细节 |
| `src/util/AsyncMessageQueue.ts` | 可动态 push、可关闭的异步队列；作为流式输入源，实现"中途干预" |
| `src/AgentRunner.ts` | 单 agent 生命周期 + 状态机（`idle→starting→running↔waiting_input→done/stopped/error`） |
| `src/AgentManager.ts` | 多 agent 注册表：分配 id、维护单调 `seq`、包 `AgentEventEnvelope` 广播、内存事件历史 |
| `src/workspaces/WorkspaceManager.ts` | AppData 项目根、GitHub/repo clone、branch worktree、共享资源映射和 Agent 临时目录 |
| `src/pullRequests/PullRequestFlowManager.ts` | PR 审查与授权状态机：活跃 agent 审查、JSON 校验/重试、超时、授权信号 |
| `src/sync/SyncFlowManager.ts` | cherry-pick / branch pull 的一步审查与授权状态机 |
| `src/commits/CommitManager.ts` | Agent commit 上报记录：从 git 读取 commit 元信息、变更文件和每文件 diff，并推送给前端 |
| `src/files/FileManager.ts` | 画布文件节点、隔离文件存储、读写连线，以及 agent 结果汇报文件 |
| `src/server.ts` | HTTP(REST) + WebSocket 装配；读写项目级 `canvas-state.json` |
| `src/index.ts` | 入口：实例化 manager（注入 Claude/Codex query）并监听端口 |

## 状态机

```
idle ──start──▶ starting ──system_init──▶ running ──result──▶ waiting_input
                                            ▲                      │
                                            └──────── send ────────┘
                                            │
                                            ├──────── steer ───────▶ running
  running/waiting_input ──stop──▶ stopped
  starting/running/waiting_input ──terminate──▶ terminated
  waiting_input ──compact──▶ running ──compact_boundary──▶ waiting_input
  running ──(消息流结束/抛错)──▶ done / error
```

- **流式输入干预**：`AgentRunner` 用 `AsyncMessageQueue` 作为 `prompt` 源；首条任务入队即启动。`waiting_input` 下的 `send()` 立即开启下一轮；`running` 下的 `send()` 作为 `user_input mode=queued` 记录，等当前 result 后再成为下一轮输入。Claude SDK 原生消费流式输入；Codex app-server 按 thread 连续启动 turn。
- **Stop/terminate continuation**: `stop()` marks the current turn `stopped` and calls provider
  `interrupt` without using `terminate`; if the stream stays alive, the next `send()` reuses it,
  otherwise it restarts with the saved session id. `terminate()` closes the provider handle and the
  next `send()` always starts a new handle with `resume`. Both `stopped` and `terminated` are turn
  boundaries for `currentTurnIndex`.
- **运行中引导**：`steer()` 仅在 `running` 可用，记录为 `user_input mode=steer`。Codex 走 app-server 原生 `turn/steer` 追加到当前 in-flight turn；Claude 使用同一条 SDK streaming input 通道承载运行中输入。
- **执行中提问**：底层 provider 主动要求用户回答时不会被自动空答。Codex app-server 的 `item/tool/requestUserInput` 与 `mcpServer/elicitation/request`、Claude SDK 的 `AskUserQuestion` 都会映射成统一 `user_question` 事件；前端通过 `POST /api/agents/:id/questions/:requestId` 回答后，adapter 再翻译回各自原生协议。Agent 状态仍保持 `running`。
- **执行中授权**：Codex app-server 的命令执行、文件变更、权限扩展审批，以及 Claude SDK 的非 `AskUserQuestion` 工具审批都会映射成统一 `user_approval` 事件；前端通过 `POST /api/agents/:id/approvals/:requestId` 允许、拒绝或取消后，adapter 再翻译回各自原生协议。后端不再默认拒绝授权请求。
- **完全权限模式**：`AgentManager` 维护程序级 `fullPermissionMode`。开启后新授权请求直接返回允许，并立即允许所有已挂起授权；它不自动回答普通 `AskUserQuestion` / MCP elicitation 问题。
- **provider / model 选择**：`AgentStartConfig.provider` 可为 `claude` 或 `codex`，未指定时默认 `claude`。Codex UI 从后端 `/api/config` 获取本机 Codex CLI 版本对应的模型列表；模型通过 app-server 的 `thread/start` / `thread/fork` / `turn/start` 参数传递。
- **runtime model update**: `PATCH /api/agents/:id/settings` may include `model`. Claude forwards the change to the active SDK handle's `setModel()` for later responses. Codex app-server does not expose a standalone set-model RPC, so the adapter stores the new value and sends it on later `turn/start` requests. The change is not retroactive to an already-running generation.
- **手动 compact**：只允许在 `waiting_input` 执行。Claude 将内置 `/compact` 送入现有流式会话，并等待 manual `compact_boundary`；Codex 调用原生 `thread/compact/start`，等待 `contextCompaction` 完成。两者都投影成统一 `compact` 事件，前端把它记录为一轮完成的对话。
- **自动 compact**：provider 在业务轮中途触发的 `compact_boundary/contextCompaction` 会投影成 `compact trigger=auto`。它不结束当前业务轮，只记录为当前轮系统事件，并标记下一条业务输入重新注入可读提示词。
- **terminate**：调用 QueryHandle 的终止能力并关闭输入流。Claude adapter 会 interrupt 后结束 Query generator；Codex adapter 关闭并 kill 对应 app-server 子进程，状态进入 `terminated`。
- **完整历史**：`AgentRunner` 把每次 start/send/steer/compact 输入记录为 `user_input`；Claude thinking block 与 Codex reasoning delta/summary 统一映射为 `thinking`。`GET /api/agents/:id/history` 因而可回放用户输入、思考、答复、工具调用/结果与轮次结果。
- **commit 上报**：Agent Canvas 不替 agent 执行 `git commit`，但内置工作区规则要求每次 commit 成功后调用 `POST /api/agents/:id/commits`。后端用该 agent 的 branch workspace 读取 commit hash、message、文件列表和 diff，并记录当时的 `sourceTurnIndex`，让前端 commit 节点始终连回触发它的那一轮对话。
- **结果汇报**：agent 可以调用 `POST /api/agents/:id/report-result` 把 Markdown/CSV/图片等结果复制成隔离文件节点。记录会带来源 agent 与 `sourceTurnIndex`，前端把它放到对应对话轮旁边并保留连线。
- **VS Code 工作区入口**：`POST /api/agents/:id/open-workspace` 会用 VS Code CLI 打开该 agent 当前配置中的 branch worktree 目录，供前端节点标题栏的文件夹按钮调用。

## Canvas Project State

- `WorkspaceManager` 的 `workspace.json` 只保存 repo 连接、branch worktree 和共享资源；画布自身状态保存到当前 canvas 项目根目录的 `canvas-state.json`。
- `canvas-state.json` 包含 agent 快照和 histories、文件/提示词节点及连线、commit/PR/sync 节点快照，以及 `layout.nodes` 中的节点位置、尺寸和最小化状态。
- 打开或新建 canvas 项目时，服务端先保存当前项目状态，再加载目标项目的 `canvas-state.json`，并向前端广播新的 `hello` 快照。原先处于 `starting/running` 的 agent 恢复时会变成 `stopped`，避免显示不存在的底层进程仍在运行。
- 文件节点和提示词节点的物理根目录会跟随 canvas 项目切换到该项目根目录下的 `files/` 和 `prompts/`，避免不同项目里相同节点 id 发生路径冲突。

## HTTP API

| 方法 路径 | 说明 |
| --- | --- |
| `GET /api/health` | 健康检查 |
| `GET /api/settings` | 获取程序级运行时设置 |
| `PATCH /api/settings` | 更新程序级运行时设置；当前支持 `{ fullPermissionMode }` |
| `GET /api/canvas-layout` | 获取当前 canvas 项目的节点布局快照 |
| `PATCH /api/canvas-layout` | 保存当前 canvas 项目的节点位置、尺寸和最小化状态 |
| `GET /api/canvas-projects` | 列出可打开的 canvas 项目 |
| `POST /api/canvas-projects` | body=`{ name, projectRoot? }`，新建并打开 canvas 项目；`projectRoot` 可把该项目固定到自定义文件夹 |
| `POST /api/canvas-projects/open` | body=`{ id }`，打开已有 canvas 项目 |
| `GET /api/workspace` | 当前 AppData 项目、GitHub/repo 连接、branch workspace 与共享资源快照 |
| `POST /api/workspace/connect` | body=`{ remoteUrl?, localPath?, defaultBranch? }`，把 GitHub/本地 repo clone 到 AppData 项目目录 |
| `GET /api/workspace/branches` | 列出 branch workspaces |
| `GET /api/workspace/branch-options` | 列出远端 branch 与已创建 workspace 的合并选项，`hasWorkspace=false` 表示尚未拉取 |
| `POST /api/workspace/branches` | body=`{ branch, baseBranch? }`，创建 branch workspace；`baseBranch` 为新 branch 的继承来源 |
| `GET /api/workspace/shared-resources` | 列出项目级共享资源 |
| `POST /api/workspace/shared-resources` | body=`{ name, mountPath, access?, sourcePath? }`，创建共享资源并映射到所有 branch workspace |
| `GET /api/agents` | 列出全部 agent 快照 |
| `POST /api/agents` | 新建 agent，返回 `{ id }` |
| `GET /api/agents/:id` | 单个快照 |
| `GET /api/agents/:id/history` | 该 agent 的完整事件历史（用户输入、思考、工具、答复与结果） |
| `POST /api/agents/:id/open-workspace` | 用 VS Code 打开该 agent 当前 branch workspace 目录 |
| `POST /api/agents/:id/start` | body=`AgentStartConfig`，启动；`provider` 可选 `claude/codex` |
| `POST /api/agents/:id/send` | body=`{ text }`，等待输入时开启下一轮；运行中则排队到当前轮完成后执行 |
| `POST /api/agents/:id/steer` | body=`{ text }`，尽快引导当前正在运行的一轮 |
| `POST /api/agents/:id/questions/:requestId` | body=`AgentQuestionResponse`，回答或拒绝底层 CLI/SDK 发出的交互问题 |
| `POST /api/agents/:id/approvals/:requestId` | body=`AgentApprovalResponse`，允许、拒绝或取消底层 CLI/SDK 发出的授权请求 |
| `POST /api/agents/:id/commits` | body=`{ commit?, summary? }`，记录该 agent 已完成一次 commit；默认读取当前工作区 `HEAD` |
| `POST /api/agents/:id/report-result` | body=`{ name, extension?, resultKind?, title?, summary?, content? | sourcePath?, encoding? }`，创建一个结果文件节点；`sourcePath` 只能指向该 agent workspace 内文件 |
| `POST /api/agents/:id/compact` | 手动 compact 当前上下文；仅 `waiting_input` 可用 |
| `POST /api/agents/:id/resume` | body=`{ sessionId, text }`，续接会话 |
| `POST /api/agents/:id/fork` | body=`{ anchorUuid, model?, branchWorkspaceId?, branch?, cwd? }`，从该 agent 某轮 fork 出新 agent，可覆盖模型与目标 branch，返回 `{ id, origin }` |
| `POST /api/agents/:id/stop` | 中止 |
| `POST /api/agents/:id/terminate` | 关闭底层 CLI / Query，进入 `terminated` |
| `GET /api/commits` | 列出已上报 commit 节点快照 |
| `GET /api/sync-flows` | 列出 cherry-pick / branch pull 同步流程 |
| `POST /api/sync-flows` | body=`CreateSyncFlowInput`，发起同步前的一步审查 |
| `POST /api/sync-flows/:id/applied` | 兜底登记同步已经由 proposer agent 执行完成 |
| `POST /api/sync-flows/:id/cancel` | 取消尚未关闭的同步流程 |

## PR 流程

- `PullRequestFlowManager` 只控制流程状态：按 source/target branch 预留和 FIFO 排队、找出源/目标 branch 上的活跃 agent、发送审查请求、校验固定 JSON、重试、2 小时超时、聚合意见和发放授权信号。
- 程序不限制 commit，也不执行具体 `git`/`gh` 命令。提 PR 的 agent 在收到 `create_pr` 授权后可自由处理冲突、更新源 branch 并创建 PR；目标审查通过后再收到 `merge_pr` 授权并自行合并。
- Agent Canvas 内置工作区规则会注入 tool-style PR pipeline 使用协议，明确 `agent_canvas.create_pr_flow` 的触发条件、请求体、禁止事项和授权后的 JSON 回报；用户可以直接在某个 agent 的对话框里要求它提 PR，agent 应先 `POST /api/pr-flows` 发起流程，并在收到 `create_pr` / `merge_pr` 授权后再执行实际 `git`/`gh` 操作。
- 发起 PR flow 时必须有具体变更文件列表。默认 server 会通过 `WorkspaceManager.diffPullRequestFiles()` 计算 `git diff --name-status <target>...<source>`，并把 `changedFiles` 写入发给审查 agent 的提示词；如果用户或 agent 指定了 `files`，则按该文件范围审查并补齐状态。
- PR flow 创建时也会记录 `sourceTurnIndex`，因此前端 PR 节点会固定连回发起 PR pipeline 的那一轮对话；后续 agent 继续对话、旧节点成为历史轮也不会断线或漂移。
- `GET /api/pr-flows` 列出流程；`POST /api/pr-flows` 发起源 branch preflight；`POST /api/pr-flows/:id/pr-created` 可兜底登记 PR 已创建并进入目标 branch 审查；`POST /api/pr-flows/:id/merged` 可兜底登记已合并；`POST /api/pr-flows/:id/cancel` 取消流程。
- WebSocket `hello` 帧会带上 `prFlows`、`syncFlows` 和 `commits` 快照，后续 PR 状态变化通过 `pr_flow` 帧推送，同步流程变化通过 `sync_flow` 帧推送，commit 上报通过 `commit` 帧推送。

## Sync 流程

- `SyncFlowManager` 用于两类“把别处代码带入当前 branch”的操作：`cherry_pick` 表示拉取某个 commit，`branch_pull` 表示拉取/合并/变基某个 branch。
- 流程只有一步审查：目标 branch 上所有活跃 agent 收到审查请求，运行中的 agent 通过 steer 插入，等待输入的 agent 通过 send 发送。审查目标是判断这次同步是否会影响 reviewer 自己当前正在进行的工作、实验或验证。
- 全部审查通过后，proposer agent 收到 apply authorization；程序只发授权信号，不执行 git 命令。后续 fetch、cherry-pick、merge/rebase/pull、冲突处理、测试和 commit 都由 proposer agent 自己完成。
- proposer agent 完成后可输出 `agentCanvasSyncEvent="applied"` JSON 自动关闭流程；前端 Sync 面板也提供 `Mark applied` 兜底按钮。
- 同步流程创建时必须有具体文件范围。`cherry_pick` 默认通过 `git show --name-status` 解析 commit 文件；`branch_pull` 默认复用 `git diff --name-status <target>...<source>`。调用方显式传入 `files` 时，按该范围审查。
- 内置 `agentCanvasPolicyPrompt` 已注入 tool-style sync pipeline 使用协议，明确 `agent_canvas.create_sync_flow` 的两类请求：`cherry_pick` 和 `branch_pull`。用户可以直接在 agent 对话框里要求“cherry-pick 某个 commit”或“pull main”，agent 应先调用 `/api/sync-flows`，收到授权后再实际执行 git 操作。

## 多轮对话与 fork（对话历史分叉）

- **多轮**：同一 agent = 同一 provider 会话。每轮 = 一次用户输入 + 一次完整答复，以 `result` 事件收尾。每个 `result` 携带本轮最后一条 assistant 消息的 `anchorUuid`（fork UI 锚点）。
- **引导**：`POST /api/agents/:id/steer` 优先调用 provider 原生 steer（Codex app-server 的 `turn/steer`）。provider 没有原生 steer 时，AgentRunner 会把引导文本插到普通排队输入前面，并 interrupt 当前轮，让下一轮尽快以该引导开始。
- **fork**：`POST /:id/fork { anchorUuid, model?, branchWorkspaceId?, branch? }` 会创建独立新 agent 并继承父 provider。Codex 可覆盖目标模型，未指定则继承父启动配置；也可覆盖目标 branch workspace，未指定则继承父 branch。Claude 使用 `resume + resumeSessionAt + forkSession:true` 从指定 assistant uuid 分叉；Codex 使用 app-server `thread/fork` 从父 thread 分叉（Codex app-server 当前是 thread 级 fork，不是按某个 assistant uuid 回滚）。对话 fork 和 git branch 仍是两套概念，但 fork 子 agent 可以被放到任意已有或新建 branch 上。

## WebSocket (`/ws`)

服务端 → 前端帧（`ServerFrame`）：
- `{ type: "hello", agents, histories, prFlows, syncFlows, commits }`：连接即下发当前快照和 agent 历史，用于恢复多轮对话节点
- `{ type: "event", envelope }`：实时事件（带 `agentId/seq/at`）
- `{ type: "pr_flow", flow }`：PR flow 快照更新
- `{ type: "sync_flow", flow }`：cherry-pick / branch pull flow 快照更新
- `{ type: "commit", commit }`：Agent 上报 commit 后的 commit 快照
- `{ type: "file", file }`：Agent 上报结果后创建或更新的文件节点快照

## 测试（CLAUDE.md 原则 #1）

`vitest`，全部离线（不触达真实模型）：注入可手动驱动的假 `query`。

- `eventMapper.test.ts`：各类 SDK 消息 → 统一事件的映射
- `sdk/codexAppServerMapper.test.ts`：Codex app-server 通知 → SDK-like 消息，包括自动 `contextCompaction`
- `sdk/codexAppServerQuery.test.ts`：`/compact` → 原生 `thread/compact/start`、`steer` → 原生 `turn/steer`、`requestUserInput`/授权审批回写，以及 app-server 进程终止
- `sdk/realQuery.test.ts`：Claude 每轮文件上下文刷新，以及 `AskUserQuestion`/工具授权 → 统一处理器
- `AgentRunner.test.ts`：start/running/waiting_input/send/steer/stop/done/error 全状态流转 + 流式输入 + provider 交互问题/授权挂起与回答 + 完全权限模式
- `commits/CommitManager.test.ts`：真实临时 git repo 中读取 commit 元信息、文件列表和每文件 diff
- `util/AsyncMessageQueue.test.ts`：队列的 push/wait/close 语义

```bash
npm test --workspace apps/server
npm run dev --workspace apps/server      # tsx watch，监听 :4317
```

## 真机冒烟（会真实调用模型）

`scripts/smoke.ts`：走真实后端链路（AgentManager→AgentRunner→realQuery→真 SDK），
用安全参数（临时目录 + haiku + acceptEdits + maxTurns）跑通一次并打印事件流与产物。

```bash
npm run smoke --workspace apps/server
```

> 鉴权：Claude SDK **自动复用本机已登录的 Claude 订阅凭据**（`~/.claude/.credentials.json` 的 `claudeAiOauth`），
> 无需设置 `ANTHROPIC_API_KEY`；若想改走 API 计费再设该环境变量。Codex provider 复用本机 Codex CLI 登录状态（`codex login`）。
>
> ⚠️ 安全：实测发现 `allowedTools` 并不能阻止 agent 调用其他工具（如 PowerShell）。
> 要"只读/禁止执行命令"，需用 `permissionMode='plan'` 或其他机制，不能依赖 `allowedTools`。

## 文件节点

- `src/files/FileManager.ts` 管理节点元数据、真实文件、共享权限和普通读写连线。
- 文件节点固定使用用户本地数据目录中的隔离存储，并让每个文件节点独占目录；不再创建到 Agent/branch 工作目录中。
- `GET/POST /api/files` 列出/创建；`PATCH /api/files/:id` 重命名或更新共享开关；`content/raw` 子路径提供预览与原始内容。
- `POST /api/files/:id/open` 使用 VS Code CLI 打开真实文件，`POST /api/agents/:id/open-workspace` 复用同一 opener 打开 agent branch worktree 目录，并等待 CLI 返回实际退出状态。Windows 会检查标准安装位置和 PATH 中的 `code.cmd`；自定义位置可设置 `AGENT_CANVAS_VSCODE_PATH` 为 `code.cmd` 完整路径，也可传 `Code.exe` 并自动解析同目录下的 `bin\code.cmd`。
- `GET/POST /api/file-connections` 与 `DELETE /api/file-connections/:id` 管理普通节点连线。
- Codex 使用 app-server 原生 `mention/localImage` 和 `workspaceWrite.writableRoots`。
- Claude 使用 `@绝对路径`、`additionalDirectories`，并通过 `applyFlagSettings()` 在流式会话下一轮动态刷新写目录。
- `AgentRunner` 在首轮和每次 `send` 前重新解析文件权限；因此 Claude/Codex 的每个完整业务请求都会携带该轮最新的可读文件引用和可写目标。`compact` 是 CLI 控制指令，不附加业务文件引用。
- 写权限是 CLI 的目录粒度，而且可写目录天然也可读；隔离文件采用单节点目录来缩小授权范围。读连线负责显式引用和画布层授权，不等同于操作系统级读取隔离。
- 文件节点的“共享”是画布级全局读写授权，不做 branch 间重映射；跨 branch 的数据集/权重共享资源由 `WorkspaceManager` 管理。

## GitHub / Branch Workspace / 三类文件

- Agent Canvas 项目根默认位于用户本地数据目录 `agent_canvas/projects/<project-id>/`。正常启动先由前端选择或新建 canvas 项目，再手动连接 GitHub repo；新建项目可传 `projectRoot` 直接指定该项目文件夹。`AGENT_CANVAS_PROJECTS_ROOT` 可覆盖默认项目列表根目录，`AGENT_CANVAS_PROJECT_ROOT` 可覆盖并自动打开单个项目根目录。
- 连接 repo 只 clone 默认 branch，不会把远端所有 branch 全部拉成 worktree。新建 Agent 或切换 Agent branch 选中某个未创建 workspace 的 branch 时，后端才 fetch 该 branch 并创建专属 `git worktree`。
- 新建 Agent 推荐传 `branchWorkspaceId` 或 `branch`；后端据此懒创建/解析为对应 branch workspace，并把 `cwd` 写成 worktree 路径。旧的裸 `cwd` 仅保留兼容。
- 三类文件分开管理：仓库文件在各 branch workspace 中并默认需要 commit；共享资源真实目录在项目根的 `shared/` 中，通过 junction/symlink 映射进每个 branch；临时文件在 `<worktree>/.agent-tmp/<agent-id>/`，写入本地 git exclude。
- 共享资源有 `readOnly/readWrite`。`readOnly` 只进入可读目录和上下文说明；`readWrite` 才加入 provider 可写目录。junction/symlink 不是跨平台强只读边界，因此内置工作区规则提示词也会要求 Agent 未经明确授权不得修改只读共享资源。

## 提示词节点

- `src/prompts/PromptManager.ts` 管理纯文本提示词节点、普通读写连线、共享读写开关和内部可写文本载体。
- `GET/POST /api/prompts` 列出/创建；`PATCH /api/prompts/:id` 编辑名称、文本或共享开关。
- `GET/POST /api/prompt-connections` 与 `DELETE /api/prompt-connections/:id` 管理普通节点连线；fork 自动复制父 Agent 的提示词连线。
- 可读提示词直接拼在用户输入之前，不传文件引用。顺序固定为共享优先、普通其次，同类按 UTF-8 字节序排列。
- 用户/节点可读提示词的注入时机为新建 Agent 的首轮，以及手动或自动 compact 完成后的下一条业务输入；fork/resume 首轮继承已有上下文，不重复注入用户/节点提示词。
- `AgentRunner` 会在所有 Agent start（含 fork/resume）和 compact 后下一条业务输入中额外注入一段硬编码的 Agent Canvas 工作区规则，位于所有可读提示词之前。规则说明三类文件：需要 commit 的仓库文件、默认只读的共享映射资源，以及 `.agent-tmp/<agent-id>/` 下不可提交的当前 Agent 临时文件。
- 写权限与文件节点一致，会授权 provider 修改提示词节点的内部文本文件；前端周期读取最新文本。

官方参考：

- https://developers.openai.com/codex/guides/agents-md
- https://developers.openai.com/codex/cli/features
- https://developers.openai.com/codex/app-server
- https://developers.openai.com/codex/cli/slash-commands
- https://developers.openai.com/codex/cli/reference
- https://code.claude.com/docs/en/memory
- https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode
- https://code.claude.com/docs/en/agent-sdk/user-input
- https://docs.anthropic.com/en/docs/claude-code/common-workflows
- https://docs.anthropic.com/en/docs/claude-code/cli-reference

## Agent 设置与 Branch

- 进程入口用 `AGENT_CANVAS_WORKSPACE_ROOT ?? INIT_CWD ?? process.cwd()` 解析默认源仓库目录；WorkspaceManager 会把实际 branch workspace 放到 AppData 项目根。`GET /api/config` 返回 `defaultCwd` 和 `projectRoot`。
- `POST /api/agents` 支持 `provider/model/branchWorkspaceId/cwd/systemPrompt`。新工作流中 `branchWorkspaceId` 决定 `cwd`；`cwd` 只保留兼容和快照展示。fork 默认复制父 Agent 的 provider、模型、branch/cwd 和私有系统提示词，但 fork 请求可覆盖模型和 branch。
- `PATCH /api/agents/:id/settings` 可更新 `systemPrompt` 和 `model`，也可在 `idle` / `waiting_input` 状态切换到已有或新建 branch。切换后下一次业务输入会注入 branch 切换说明和 `git diff --name-status <old> <new>` 文件列表；`waiting_input` 下会脱开旧空闲会话，下次输入按新 `cwd` resume。
- `systemPrompt` 是当前 Agent 私有提示词，不传给 Claude/Codex 原生 system prompt，而是在 `AgentRunner` 中按提示词节点同样的可读提示词机制拼接到业务输入。新 Agent 首轮、手动 compact 后、自动 compact 后、以及运行中更新设置后的下一条业务输入会重新注入。
- Agent Canvas 内置工作区规则不属于用户可编辑的 `systemPrompt`，即使用户没有设置私有系统提示词也会注入；它约束共享文件默认只读、临时文件只写 `.agent-tmp/<agent-id>/`、其余非共享非临时修改都视为需要 commit 的仓库文件，并以 tool-style 协议内置 `agent_canvas.create_pr_flow`、`agent_canvas.create_sync_flow` 和 `agent_canvas.report_commit`，指导 agent 在用户要求提 PR 时调用 `/api/pr-flows`，在用户要求 cherry-pick/pull branch 时调用 `/api/sync-flows`，在每次 `git commit` 成功后调用 `/api/agents/:id/commits`。
- `POST /api/directories/pick` 通过本机目录选择器返回用户选中的目录；Windows 使用 PowerShell + `System.Windows.Forms.FolderBrowserDialog`，其他平台暂返回明确错误并允许前端继续手动输入路径。
