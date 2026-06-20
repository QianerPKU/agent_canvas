# @agent-canvas/web

前端画布：把后端的实时事件流"画"成可监控、可操纵的**对话树**。
基于 **Vite + React + React Flow**。

## 核心模型：节点 = 一轮对话

- 一个 agent = 一条**轮次链**。普通轮次 = 一次用户输入 + 一次完整答复，以 `result` 收尾；手动 compact 也单独记为一轮。
- 一轮完成后**自动延伸出一个 idle 轮**（"待输入"节点）；在它里面输入下一轮指令即续接。
- 首轮 idle 节点可选择 provider：`Claude` 或 `Codex`。Codex 可选择 `gpt-5.5`、`gpt-5.4`、`gpt-5.4-mini`，默认 `gpt-5.5`。
- 每个**完成**轮上有 **⑂ fork 按钮** → 从该轮的对话状态分叉出一个独立新 agent（连一条 fork 线），形成对话树。Codex fork 可在分叉时选择模型，子节点继承 provider 与所选模型；fork 不绑定 git。

## 模块

| 文件 | 职责 |
| --- | --- |
| `src/agentStore.ts` | **纯函数**：把事件流折叠成对话树（`AgentView.turns: Turn[]`）。result 收尾本轮并延伸新 idle 轮；记录每轮 `anchorUuid`（fork 锚点）、provider 与 model；合并同一消息的流式文本片段。无 React 依赖，单测主对象。 |
| `src/api.ts` | REST 命令客户端（create/start/send/stop/compact/terminate/fork/resume） |
| `src/useAgentCanvas.ts` | React hook：订阅 `/ws`、折叠出 `agents` 表、暴露动作（create/submit/stop/compact/terminate/fork）、断线自动重连 |
| `src/nodes/TurnNode.tsx` | 自定义节点（一轮）：状态徽标 + provider/model 选择 + 输出滚动区；支持边缘缩放、最小化/恢复，最新节点提供 Compact/Terminate |
| `src/history/` | 点击节点后打开的累计历史窗口；按目标轮截断并展示用户输入、provider 思考、答复、完整工具调用/结果与状态 |
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
- Codex 的 `agentMessage` 流式 delta 按消息 UUID 合并到同一输出段落，避免每个小片段被渲染成独立短行。
- 每个 agent 的最新节点显示 `Compact` 和 `Terminate`。Compact 仅在等待输入时启用，完成后当前 idle 节点定格为 `/compact` 完成轮并延伸新 idle 节点；Terminate 关闭底层 CLI 并进入 `terminated`。
- 点击任意非最小化节点主体会打开独立历史窗口，内容累计到该轮为止；历史来自后端 `/history`，包括 provider 实际发出的 thinking/reasoning 与完整工具参数/结果。
- 节点四边和四角可拖拽缩放。标题栏最小化按钮会保存当前宽高并把节点缩成 `68×48` 的小节点；小节点本身仍是拖动句柄，单击恢复。节点 id 与 Handle 始终不变，因此轮次线和 fork 线保持连接。
- WebSocket 首次连接延迟到下一轮事件循环，兼容 React StrictMode 的开发期双重 effect 检查，避免 Vite 代理记录无害的 `ECONNABORTED`。
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
- `useAgentCanvas.test.tsx`：StrictMode 下只建立一次 WebSocket
- `history/*.test.ts(x)`：按轮截断、流式片段合并与完整历史窗口渲染
- `nodes/TurnNode.test.tsx`：各状态徽标、模型选择、Compact/Terminate、历史点击、尺寸保存/恢复与 fork 控件交互

## 文件节点

- 顶栏“新建文件”选择文件名、后缀、普通/共享类型以及 Agent 工作目录/隔离目录。
- 普通文件右侧“读”输出连接 Agent 左侧“读入”；Agent 右侧“写出”连接文件左侧“写”输入。
- 文件连接绑定 Agent 而非单轮，完成一轮后自动指向最新轮次；fork 时复制父 Agent 的连接。
- 共享文件不画连线，使用节点底部的“全局读/全局写”开关。
- 文本、Markdown、CSV、常见源码和图片显示预览；其他格式只显示文件名。预览定时刷新以反映 Agent 修改。
- `src/files/README.md` 记录组件边界与 Handle 语义。
