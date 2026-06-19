# @agent-canvas/web

前端画布：把后端的实时事件流"画"成可监控、可操纵的 agent 节点图。
基于 **Vite + React + React Flow**。

## 模块

| 文件 | 职责 |
| --- | --- |
| `src/agentStore.ts` | **纯函数**：把统一事件流折叠成每个 agent 的视图状态（`AgentView`：状态/输出行/花费/session）。无 React 依赖，是单测主对象。 |
| `src/api.ts` | REST 命令客户端（create/start/stop/send/resume） |
| `src/useAgentCanvas.ts` | React hook：订阅 `/ws`、用 agentStore 折叠出 `agents` 表、暴露动作、断线自动重连 |
| `src/nodes/AgentNode.tsx` | 自定义 React Flow 节点：状态徽标 + 实时输出滚动区 + 控制区（启动/停止/追加指令） |
| `src/App.tsx` | 画布装配：顶栏（连接状态 + 新建 agent）+ ReactFlow（节点/小地图/缩放） |

## 数据流

```
后端 WS ──ServerFrame──▶ useAgentCanvas ──折叠(agentStore)──▶ agents 表
                                                              │
                                              App 同步进 ReactFlow 节点
                                                              │
用户操作 ──▶ AgentNode 控件 ──▶ actions(REST) ──▶ 后端 ──▶ 事件回流(WS)
```

- **命令走 REST，事件走 WS**，单向清晰。
- 新建 agent 后后端不发事件，前端**乐观插入**一个 idle 节点。
- 节点只有头部可拖动（`.drag-handle`），控制区 `.nodrag`、日志区 `.nowheel`，避免拖拽/滚动冲突。

## 开发

前端 dev 服务把 `/api` 和 `/ws` 代理到后端 `:4317`，所以要**先起后端**：

```bash
npm run dev --workspace apps/server     # 终端 1：后端 :4317
npm run dev --workspace apps/web        # 终端 2：前端 :5317
```

打开 http://localhost:5317 → 顶栏「＋ 新建 agent」→ 节点里输入任务 → ▶ 启动 → 实时看输出，可停止/追加指令。

## 测试（CLAUDE.md 原则 #1）

```bash
npm test --workspace apps/web
```

- `agentStore.test.ts`：事件折叠、不可变更新、旧 seq 去重、行数封顶（node 环境）
- `nodes/AgentNode.test.tsx`：各状态徽标与控件交互（jsdom + Testing Library）
