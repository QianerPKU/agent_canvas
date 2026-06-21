# @agent-canvas/server

后端控制层：拉起 / 监控 / 操纵 agent。支持 **Claude Agent SDK** 与 **Codex CLI app-server** 两种 provider，把底层原始消息归一成 `@agent-canvas/shared` 的统一事件，经 WebSocket 实时推给前端画布；命令（启动/停止/干预）走 REST。

## 模块

| 文件 | 职责 |
| --- | --- |
| `src/sdk/types.ts` | 对 Agent SDK 的**最小本地类型映射** + `QueryFn/QueryHandle`（含 interrupt/steer/terminate，便于单测注入假实现） |
| `src/sdk/realQuery.ts` | 把真实 SDK 的 `query` 适配成 `QueryFn`（仅运行时引入） |
| `src/sdk/codexAppServerQuery.ts` | 通过 `codex app-server --stdio` 驱动 Codex thread/turn/fork，并适配成 `QueryFn` |
| `src/sdk/codexAppServerMapper.ts` | **纯函数**：Codex app-server JSON-RPC 通知 → SDK-like 消息 |
| `src/eventMapper.ts` | **纯函数**：一条 SDK 消息 → 0..N 个统一 `AgentEvent`，保留 Claude thinking 与工具细节 |
| `src/util/AsyncMessageQueue.ts` | 可动态 push、可关闭的异步队列；作为流式输入源，实现"中途干预" |
| `src/AgentRunner.ts` | 单 agent 生命周期 + 状态机（`idle→starting→running↔waiting_input→done/stopped/error`） |
| `src/AgentManager.ts` | 多 agent 注册表：分配 id、维护单调 `seq`、包 `AgentEventEnvelope` 广播、内存事件历史 |
| `src/server.ts` | HTTP(REST) + WebSocket 装配 |
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
- **运行中引导**：`steer()` 仅在 `running` 可用，记录为 `user_input mode=steer`。Codex 走 app-server 原生 `turn/steer` 追加到当前 in-flight turn；Claude 使用同一条 SDK streaming input 通道承载运行中输入。
- **provider / model 选择**：`AgentStartConfig.provider` 可为 `claude` 或 `codex`，未指定时默认 `claude`。Codex UI 提供 `gpt-5.5`、`gpt-5.4`、`gpt-5.4-mini`，模型通过 app-server 的 `thread/start` / `thread/fork` / `turn/start` 参数传递。
- **手动 compact**：只允许在 `waiting_input` 执行。Claude 将内置 `/compact` 送入现有流式会话，并等待 manual `compact_boundary`；Codex 调用原生 `thread/compact/start`，等待 `contextCompaction` 完成。两者都投影成统一 `compact` 事件，前端把它记录为一轮完成的对话。
- **自动 compact**：provider 在业务轮中途触发的 `compact_boundary/contextCompaction` 会投影成 `compact trigger=auto`。它不结束当前业务轮，只记录为当前轮系统事件，并标记下一条业务输入重新注入可读提示词。
- **terminate**：调用 QueryHandle 的终止能力并关闭输入流。Claude adapter 会 interrupt 后结束 Query generator；Codex adapter 关闭并 kill 对应 app-server 子进程，状态进入 `terminated`。
- **完整历史**：`AgentRunner` 把每次 start/send/steer/compact 输入记录为 `user_input`；Claude thinking block 与 Codex reasoning delta/summary 统一映射为 `thinking`。`GET /api/agents/:id/history` 因而可回放用户输入、思考、答复、工具调用/结果与轮次结果。

## HTTP API

| 方法 路径 | 说明 |
| --- | --- |
| `GET /api/health` | 健康检查 |
| `GET /api/agents` | 列出全部 agent 快照 |
| `POST /api/agents` | 新建 agent，返回 `{ id }` |
| `GET /api/agents/:id` | 单个快照 |
| `GET /api/agents/:id/history` | 该 agent 的完整事件历史（用户输入、思考、工具、答复与结果） |
| `POST /api/agents/:id/start` | body=`AgentStartConfig`，启动；`provider` 可选 `claude/codex` |
| `POST /api/agents/:id/send` | body=`{ text }`，等待输入时开启下一轮；运行中则排队到当前轮完成后执行 |
| `POST /api/agents/:id/steer` | body=`{ text }`，尽快引导当前正在运行的一轮 |
| `POST /api/agents/:id/compact` | 手动 compact 当前上下文；仅 `waiting_input` 可用 |
| `POST /api/agents/:id/resume` | body=`{ sessionId, text }`，续接会话 |
| `POST /api/agents/:id/fork` | body=`{ anchorUuid, model? }`，从该 agent 某轮 fork 出新 agent，可为 Codex fork 指定模型，返回 `{ id, origin }` |
| `POST /api/agents/:id/stop` | 中止 |
| `POST /api/agents/:id/terminate` | 关闭底层 CLI / Query，进入 `terminated` |

## 多轮对话与 fork（对话历史分叉）

- **多轮**：同一 agent = 同一 provider 会话。每轮 = 一次用户输入 + 一次完整答复，以 `result` 事件收尾。每个 `result` 携带本轮最后一条 assistant 消息的 `anchorUuid`（fork UI 锚点）。
- **fork**：`POST /:id/fork { anchorUuid, model? }` 会创建独立新 agent 并继承父 provider。Codex 可覆盖目标模型，未指定则继承父启动配置。Claude 使用 `resume + resumeSessionAt + forkSession:true` 从指定 assistant uuid 分叉；Codex 使用 app-server `thread/fork` 从父 thread 分叉（Codex app-server 当前是 thread 级 fork，不是按某个 assistant uuid 回滚）。对话 fork 与 git 分支无关。

## WebSocket (`/ws`)

服务端 → 前端帧（`ServerFrame`）：
- `{ type: "hello", agents }`：连接即下发当前快照
- `{ type: "event", envelope }`：实时事件（带 `agentId/seq/at`）

## 测试（CLAUDE.md 原则 #1）

`vitest`，全部离线（不触达真实模型）：注入可手动驱动的假 `query`。

- `eventMapper.test.ts`：各类 SDK 消息 → 统一事件的映射
- `sdk/codexAppServerMapper.test.ts`：Codex app-server 通知 → SDK-like 消息，包括自动 `contextCompaction`
- `sdk/codexAppServerQuery.test.ts`：`/compact` → 原生 `thread/compact/start`、`steer` → 原生 `turn/steer`，以及 app-server 进程终止
- `AgentRunner.test.ts`：start/running/waiting_input/send/steer/stop/done/error 全状态流转 + 流式输入
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
- Agent 工作目录存储直接在所选工作区创建文件；隔离存储使用用户本地数据目录，并让每个文件节点独占目录。
- `GET/POST /api/files` 列出/创建；`PATCH /api/files/:id` 重命名或更新共享开关；`content/raw` 子路径提供预览与原始内容。
- `POST /api/files/:id/open` 使用 VS Code CLI 打开真实文件，并等待 CLI 返回实际退出状态。Windows 会检查标准安装位置和 PATH 中的 `code.cmd`；自定义位置可设置 `AGENT_CANVAS_VSCODE_PATH` 为 `code.cmd` 完整路径，也可传 `Code.exe` 并自动解析同目录下的 `bin\code.cmd`。
- `GET/POST /api/file-connections` 与 `DELETE /api/file-connections/:id` 管理普通节点连线。
- Codex 使用 app-server 原生 `mention/localImage` 和 `workspaceWrite.writableRoots`。
- Claude 使用 `@绝对路径`、`additionalDirectories`，并通过 `applyFlagSettings()` 在流式会话下一轮动态刷新写目录。
- `AgentRunner` 在首轮和每次 `send` 前重新解析文件权限；因此 Claude/Codex 的每个完整业务请求都会携带该轮最新的可读文件引用和可写目标。`compact` 是 CLI 控制指令，不附加业务文件引用。
- 写权限是 CLI 的目录粒度，而且可写目录天然也可读；隔离文件采用单节点目录来缩小授权范围。读连线负责显式引用和画布层授权，不等同于操作系统级读取隔离。

## 提示词节点

- `src/prompts/PromptManager.ts` 管理纯文本提示词节点、普通读写连线、共享读写开关和内部可写文本载体。
- `GET/POST /api/prompts` 列出/创建；`PATCH /api/prompts/:id` 编辑名称、文本或共享开关。
- `GET/POST /api/prompt-connections` 与 `DELETE /api/prompt-connections/:id` 管理普通节点连线；fork 自动复制父 Agent 的提示词连线。
- 可读提示词直接拼在用户输入之前，不传文件引用。顺序固定为共享优先、普通其次，同类按 UTF-8 字节序排列。
- 注入时机仅为新建 Agent 的首轮，以及手动或自动 compact 完成后的下一条业务输入；fork/resume 首轮继承已有上下文，不重复注入。
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
