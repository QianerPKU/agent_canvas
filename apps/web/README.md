# @agent-canvas/web

前端画布：把后端的实时事件流"画"成可监控、可操纵的**对话树**。
基于 **Vite + React + React Flow**。

## 核心模型：节点 = 一轮对话

- 一个 agent = 一条**轮次链**。每轮 = 一次用户输入 + 一次完整答复，以 `result` 收尾。
- 一轮完成后**自动延伸出一个 idle 轮**（"待输入"节点）；在它里面输入下一轮指令即续接。
- 每个**完成**轮上有 **⑂ fork 按钮** → 从该轮的对话状态分叉出一个独立新 agent（连一条 fork 线），形成对话树。fork 不绑定 git。

## 模块

| 文件 | 职责 |
| --- | --- |
| `src/agentStore.ts` | **纯函数**：把事件流折叠成对话树（`AgentView.turns: Turn[]`）。result 收尾本轮并延伸新 idle 轮；记录每轮 `anchorUuid`（fork 锚点）。无 React 依赖，单测主对象。 |
| `src/api.ts` | REST 命令客户端（create/start/send/stop/fork/resume） |
| `src/useAgentCanvas.ts` | React hook：订阅 `/ws`、折叠出 `agents` 表、暴露动作（create/submit/stop/fork）、断线自动重连 |
| `src/nodes/TurnNode.tsx` | 自定义节点（一轮）：状态徽标 + 该轮用户输入 + 输出滚动区 + 控制区（idle→输入框；running→停止；done→fork） |
| `src/App.tsx` | 画布装配：对话树布局（每 agent 一列、轮次向下、fork 另起列对齐锚点轮）+ 轮链边 + fork 边 |

## 数据流

```
后端 WS ──ServerFrame──▶ useAgentCanvas ──折叠(agentStore)──▶ agents 表(含 turns)
                                                              │
                                          App 同步进 ReactFlow 节点(每轮一节点)+边
                                                              │
用户操作 ──▶ TurnNode 控件 ──▶ actions(REST) ──▶ 后端 ──▶ 事件回流(WS)
```

- **命令走 REST，事件走 WS**，单向清晰。`submit` 自动判断首轮 start / 续轮 send。
- 新建 / fork 后后端不发事件，前端**乐观插入**节点（fork 带 `forkOrigin` 以画连线）。
- 节点只有头部可拖动（`.drag-handle`），控制区 `.nodrag`、日志区 `.nowheel`。

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
