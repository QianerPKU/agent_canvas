# @agent-canvas/server

后端控制层：拉起 / 监控 / 操纵 agent。通过 **Claude Agent SDK** 驱动每个 agent 会话，把 SDK 的原始消息归一成 `@agent-canvas/shared` 的统一事件，经 WebSocket 实时推给前端画布；命令（启动/停止/干预）走 REST。

## 模块

| 文件 | 职责 |
| --- | --- |
| `src/sdk/types.ts` | 对 Agent SDK 的**最小本地类型映射** + `QueryFn`（依赖注入点，便于单测注入假实现） |
| `src/sdk/realQuery.ts` | 把真实 SDK 的 `query` 适配成 `QueryFn`（仅运行时引入） |
| `src/eventMapper.ts` | **纯函数**：一条 SDK 消息 → 0..N 个统一 `AgentEvent` |
| `src/util/AsyncMessageQueue.ts` | 可动态 push、可关闭的异步队列；作为流式输入源，实现"中途干预" |
| `src/AgentRunner.ts` | 单 agent 生命周期 + 状态机（`idle→starting→running↔waiting_input→done/stopped/error`） |
| `src/AgentManager.ts` | 多 agent 注册表：分配 id、维护单调 `seq`、包 `AgentEventEnvelope` 广播、内存事件历史 |
| `src/server.ts` | HTTP(REST) + WebSocket 装配 |
| `src/index.ts` | 入口：实例化 manager（注入 realQuery）并监听端口 |

## 状态机

```
idle ──start──▶ starting ──system_init──▶ running ──result──▶ waiting_input
                                            ▲                      │
                                            └──────── send ────────┘
  running/waiting_input ──stop──▶ stopped
  running ──(消息流结束/抛错)──▶ done / error
```

- **流式输入干预**：`AgentRunner` 用 `AsyncMessageQueue` 作为 SDK 的 `prompt` 源；首条任务入队即启动，运行中 `send()` 继续入队 = 中途追加指令；`stop()` 关闭队列 + abort + 尽力 `interrupt()`。

## HTTP API

| 方法 路径 | 说明 |
| --- | --- |
| `GET /api/health` | 健康检查 |
| `GET /api/agents` | 列出全部 agent 快照 |
| `POST /api/agents` | 新建 agent，返回 `{ id }` |
| `GET /api/agents/:id` | 单个快照 |
| `GET /api/agents/:id/history` | 该 agent 的事件历史（重连补齐） |
| `POST /api/agents/:id/start` | body=`AgentStartConfig`，启动 |
| `POST /api/agents/:id/send` | body=`{ text }`，中途追加指令 |
| `POST /api/agents/:id/resume` | body=`{ sessionId, text }`，续接会话 |
| `POST /api/agents/:id/stop` | 中止 |

## WebSocket (`/ws`)

服务端 → 前端帧（`ServerFrame`）：
- `{ type: "hello", agents }`：连接即下发当前快照
- `{ type: "event", envelope }`：实时事件（带 `agentId/seq/at`）

## 测试（CLAUDE.md 原则 #1）

`vitest`，全部离线（不触达真实模型）：注入可手动驱动的假 `query`。

- `eventMapper.test.ts`：各类 SDK 消息 → 统一事件的映射
- `AgentRunner.test.ts`：start/running/waiting_input/send/stop/done/error 全状态流转 + 流式输入
- `util/AsyncMessageQueue.test.ts`：队列的 push/wait/close 语义

```bash
npm test --workspace apps/server
npm run dev --workspace apps/server      # tsx watch，监听 :4317
```

> 鉴权：SDK 复用本机已登录 Claude 凭据或环境变量 `ANTHROPIC_API_KEY`。
