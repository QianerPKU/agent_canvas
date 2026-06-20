# @agent-canvas/server

后端控制层：拉起 / 监控 / 操纵 agent。支持 **Claude Agent SDK** 与 **Codex CLI app-server** 两种 provider，把底层原始消息归一成 `@agent-canvas/shared` 的统一事件，经 WebSocket 实时推给前端画布；命令（启动/停止/干预）走 REST。

## 模块

| 文件 | 职责 |
| --- | --- |
| `src/sdk/types.ts` | 对 Agent SDK 的**最小本地类型映射** + `QueryFn/QueryHandle`（含 interrupt/terminate，便于单测注入假实现） |
| `src/sdk/realQuery.ts` | 把真实 SDK 的 `query` 适配成 `QueryFn`（仅运行时引入） |
| `src/sdk/codexAppServerQuery.ts` | 通过 `codex app-server --stdio` 驱动 Codex thread/turn/fork，并适配成 `QueryFn` |
| `src/sdk/codexAppServerMapper.ts` | **纯函数**：Codex app-server JSON-RPC 通知 → SDK-like 消息 |
| `src/eventMapper.ts` | **纯函数**：一条 SDK 消息 → 0..N 个统一 `AgentEvent` |
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
  running/waiting_input ──stop──▶ stopped
  starting/running/waiting_input ──terminate──▶ terminated
  waiting_input ──compact──▶ running ──compact_boundary──▶ waiting_input
  running ──(消息流结束/抛错)──▶ done / error
```

- **流式输入干预**：`AgentRunner` 用 `AsyncMessageQueue` 作为 `prompt` 源；首条任务入队即启动，运行中 `send()` 继续入队。Claude SDK 原生消费流式输入；Codex app-server 按 thread 连续启动 turn，并用 `turn/interrupt` 尽力中止当前 turn。
- **provider / model 选择**：`AgentStartConfig.provider` 可为 `claude` 或 `codex`，未指定时默认 `claude`。Codex UI 提供 `gpt-5.5`、`gpt-5.4`、`gpt-5.4-mini`，模型通过 app-server 的 `thread/start` / `thread/fork` / `turn/start` 参数传递。
- **手动 compact**：只允许在 `waiting_input` 执行。Claude 将内置 `/compact` 送入现有流式会话，并等待 manual `compact_boundary`；Codex 调用原生 `thread/compact/start`，等待 `contextCompaction` 完成。两者都投影成统一 `compact` 事件，前端把它记录为一轮完成的对话。
- **terminate**：调用 QueryHandle 的终止能力并关闭输入流。Claude adapter 会 interrupt 后结束 Query generator；Codex adapter 关闭并 kill 对应 app-server 子进程，状态进入 `terminated`。

## HTTP API

| 方法 路径 | 说明 |
| --- | --- |
| `GET /api/health` | 健康检查 |
| `GET /api/agents` | 列出全部 agent 快照 |
| `POST /api/agents` | 新建 agent，返回 `{ id }` |
| `GET /api/agents/:id` | 单个快照 |
| `GET /api/agents/:id/history` | 该 agent 的事件历史（重连补齐） |
| `POST /api/agents/:id/start` | body=`AgentStartConfig`，启动；`provider` 可选 `claude/codex` |
| `POST /api/agents/:id/send` | body=`{ text }`，中途追加指令 |
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
- `sdk/codexAppServerMapper.test.ts`：Codex app-server 通知 → SDK-like 消息
- `sdk/codexAppServerQuery.test.ts`：`/compact` → 原生 `thread/compact/start`，以及 app-server 进程终止
- `AgentRunner.test.ts`：start/running/waiting_input/send/stop/done/error 全状态流转 + 流式输入
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
