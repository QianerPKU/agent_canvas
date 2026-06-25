# @agent-canvas/web

前端画布：把后端的实时事件流"画"成可监控、可操纵的**对话树**。
基于 **Vite + React + React Flow**。

## 核心模型：节点 = 一轮对话

- 一个 agent = 一条**轮次链**。普通轮次 = 一次用户输入 + 一次完整答复，以 `result` 收尾；手动 compact 也单独记为一轮，自动 compact 只作为当前运行轮中的系统记录。
- 一轮完成后**自动延伸出一个 idle 轮**（"待输入"节点）；在它里面输入下一轮指令即续接。
- 首轮 idle 节点可选择 provider：`Claude` 或 `Codex`。Codex 可选择 `gpt-5.5`、`gpt-5.4`、`gpt-5.4-mini`，默认 `gpt-5.5`。
- 每个**完成**轮上有 **⑂ fork 按钮** → 从该轮的对话状态分叉出一个独立新 agent（连一条 fork 线），形成对话树。Codex fork 可在分叉时选择模型，子节点继承 provider 与所选模型；fork 不绑定 git。

## 模块

| 文件 | 职责 |
| --- | --- |
| `src/agentStore.ts` | **纯函数**：把事件流折叠成对话树（`AgentView.turns: Turn[]`）。result 收尾本轮并延伸新 idle 轮；记录每轮 `anchorUuid`（fork 锚点）、provider 与 model；合并同一消息的流式文本片段。无 React 依赖，单测主对象。 |
| `src/api.ts` | REST 命令客户端（settings、create/start/send/steer/answerQuestion/answerApproval/stop/compact/terminate/fork/resume） |
| `src/useAgentCanvas.ts` | React hook：订阅 `/ws`、折叠出 `agents` 表、暴露动作（create/submit/steer/answerQuestion/answerApproval/stop/compact/terminate/fork）、断线自动重连 |
| `src/nodes/TurnNode.tsx` | 自定义节点（一轮）：状态徽标 + provider/model 选择 + 输出滚动区；支持边缘缩放、最小化/恢复，最新节点提供运行中排队/引导、CLI/SDK 提问回答面板、授权审批面板、Compact/Terminate |
| `src/history/` | 点击节点后打开的累计历史窗口；按目标轮截断并展示用户输入、provider 思考、答复、完整工具调用/结果与状态 |
| `src/pullRequests/` | PR 流程面板：发起审查、展示流程状态，并兜底登记 PR 已创建/已合并 |
| `src/sync/` | cherry-pick / branch pull 同步流程面板、节点和详情窗口 |
| `src/commits/` | commit 节点与详情窗口：展示 agent 上报的 commit hash、摘要、文件列表和每文件 diff |
| `src/App.tsx` | 画布装配：对话树布局（每 agent 一列、轮次向下、fork 另起列对齐锚点轮）+ 轮链边 + fork 边 |

## 数据流

```
后端 WS ──ServerFrame──▶ useAgentCanvas ──折叠(agentStore)──▶ agents 表(含 turns)
                                                              │
                                          App 同步进 ReactFlow 节点(每轮一节点)+边
                                                              │
用户操作 ──▶ TurnNode 控件 ──▶ actions(REST) ──▶ 后端 ──▶ 事件回流(WS)
```

- **命令走 REST，事件走 WS**，单向清晰。`submit` 自动判断首轮 start / 续轮 send；运行中 submit 默认排队到下一轮，`steer` 按钮引导当前 in-flight turn。
- `stopped` and `terminated` status events also end the current visual turn and extend a new idle
  tail node. Submitting from that idle tail still uses `/send`: stopped agents reuse the interrupted
  stream when available, while terminated agents restart from the saved session. File and prompt
  connections move to that idle tail so resource access stays attached to the next turn.
- PR 流程也走同一套 REST + WS：`useAgentCanvas` 读取 `hello.prFlows` 并监听 `pr_flow` 帧；顶栏 PR 面板调用 `/api/pr-flows` 发起流程。具体 `git`/`gh`/冲突处理仍由提 PR 的 agent 自己执行。
- Sync 流程同样走 REST + WS：`useAgentCanvas` 读取 `hello.syncFlows` 并监听 `sync_flow` 帧；顶栏 Sync 面板可发起 `cherry_pick` 或 `branch_pull`，授权后实际 `git cherry-pick` / merge / rebase / pull 仍由 proposer agent 自己执行。
- commit 节点来自后端 commit report：agent 在 `git commit` 后调用 `/api/agents/:id/commits`，`useAgentCanvas` 读取 `hello.commits` 并监听 `commit` 帧。commit 线使用后端记录的 `sourceTurnIndex`，所以旧对话框完成后变成历史轮，commit 线仍连在原来的那一轮上。
- PR 节点来自 `prFlows`，同样使用 flow 的 `sourceTurnIndex` 连接到发起 PR pipeline 的原始对话轮。节点显示当前状态，点击可看完整流程、审查结果和变更文件。
- Sync 节点来自 `syncFlows`，使用 flow 的 `sourceTurnIndex` 连接到发起同步 pipeline 的原始对话轮。节点显示 cherry-pick / pull 状态，点击可看 summary、reason、文件范围、审查意见和 applied 结果。
- 项目打开/新建后，`useAgentCanvas.refresh()` 会重新拉取当前项目的 agents/files/prompts/commits/PR/sync 快照；WebSocket `hello.histories` 用来恢复多轮 agent 对话节点。
- React Flow 节点布局通过 `GET/PATCH /api/canvas-layout` 保存到当前 canvas 项目的 `canvas-state.json`。前端会 debounce 保存每个节点的位置、尺寸和最小化状态；项目切换期间暂停保存，避免空布局覆盖旧项目。
- 左侧 canvas toolbar 提供选择工具和手型工具。选择工具下左键拖拽框选多个节点，选中后可一起拖动；手型工具下左键拖动画布。鼠标中键在两种工具下都保持拖动画布。
- 新建 / fork 后后端不发事件，前端**乐观插入**节点（fork 带 `forkOrigin` 以画连线）。
- Codex 的 `agentMessage` 流式 delta 按消息 UUID 合并到同一输出段落，避免每个小片段被渲染成独立短行。
- 每个 agent 的最新运行节点显示输入框：`排队` 会把提示词排到当前轮 result 后执行，`引导` 会尽快追加到当前运行轮，`停止` 保留中止能力。
- Codex app-server 或 Claude SDK 在运行中主动提问时，当前运行轮会出现问题面板；选项题可直接点选，多选题可多选，MCP elicitation 可提交 JSON content 或拒绝。回答后面板保留在日志中并标记状态，不新开轮次。
- Provider 请求命令、文件变更、权限扩展或工具使用授权时，当前运行轮会出现授权面板；可允许、拒绝或取消。存在待回答问题或待授权审批时，节点右上角显示红点提示，最小化节点也保留红点。
- 顶栏“设置”打开程序设置；“完全权限模式”开启后，后端直接允许所有授权请求，并放行已挂起授权，防止对话卡在审批上。它不会自动回答普通问题。
- 每个 agent 的最新节点显示 `Compact` 和 `Terminate`。Compact 仅在等待输入时启用，完成后当前 idle 节点定格为 `/compact` 完成轮并延伸新 idle 节点；自动 compact 完成事件在当前运行轮中显示为系统记录，不延伸新 idle 轮；Terminate 关闭底层 CLI 并进入 `terminated`。
- 点击任意非最小化节点主体会打开独立历史窗口，内容累计到该轮为止；历史来自后端 `/history`，包括 provider 实际发出的 thinking/reasoning 与完整工具参数/结果。
- 对话节点、文件节点、提示词节点、commit 节点、PR 节点和 Sync 节点四边/四角可拖拽缩放，也都支持最小化/恢复。最小化按钮会保存当前宽高并把节点缩成小节点；小节点本身仍是拖动句柄，单击恢复。节点 id 与 Handle 始终不变，因此轮次线、fork 线、资源线、commit/PR/Sync 线保持连接。
- commit 节点预览短 hash、摘要、branch 和文件数量；点击打开详情窗口，可查看完整 hash、message、作者、时间、文件列表，并逐个展开 diff。
- PR 节点预览状态、摘要和 source→target branch；点击打开详情窗口，可查看流程状态、PR 链接/编号、失败原因、变更文件和每轮审查意见。
- Sync 节点预览状态、摘要和 source/commit→target branch；点击打开详情窗口，可查看流程状态、同步类型、理由、变更文件、审查意见和 applied 回报。
- 文件和提示词节点标题栏用于拖动；重命名只通过铅笔按钮进入输入态，避免点击标题边缘时误触。
- WebSocket 首次连接延迟到下一轮事件循环，兼容 React StrictMode 的开发期双重 effect 检查，避免 Vite 代理记录无害的 `ECONNABORTED`。
- 节点只有头部可拖动（`.drag-handle`），控制区 `.nodrag`、日志区 `.nowheel`。

## 开发

前端 dev 服务把 `/api` 和 `/ws` 代理到后端 `:4317`，所以要**先起后端**：

```bash
npm run dev --workspace apps/server     # 终端 1：后端 :4317
npm run dev --workspace apps/web        # 终端 2：前端 :5317
```

打开 http://localhost:5317 → 选择/新建 canvas 项目 → 连接 GitHub repo → 顶栏「＋ 新建 Agent」→ 节点里输入任务 → ▶ 启动 → 实时看输出，可停止、排队下一轮或引导当前轮。

## 测试（CLAUDE.md 原则 #1）

```bash
npm test --workspace apps/web
```

- `agentStore.test.ts`：事件折叠、交互问题/授权行状态、不可变更新、旧 seq 去重、行数封顶（node 环境）
- `App.test.ts`：自动布局、派生节点锚定、保存布局恢复和 layout 序列化
- `useAgentCanvas.test.tsx`：StrictMode 下只建立一次 WebSocket
- `history/*.test.ts(x)`：按轮截断、流式片段合并与完整历史窗口渲染
- `nodes/TurnNode.test.tsx`：各状态徽标、模型选择、运行中排队/引导/停止、交互问题回答、授权审批红点、Compact/Terminate、历史点击、尺寸保存/恢复与 fork 控件交互
- `commits/CommitNode.test.tsx`、`pullRequests/PullRequestNode.test.tsx`、`sync/SyncFlowNode.test.tsx`：commit/PR/Sync 节点的最小化、Handle 保留和详情入口
- `sync/SyncFlowDialog.test.tsx`：创建 cherry-pick 与 branch pull 两种同步流程

## 文件节点

- 顶栏“新建文件”选择文件名、后缀和普通/共享类型；文件节点固定创建在后端隔离文件夹中，不进入任何 branch workspace。
- 普通文件右侧“读”输出连接 Agent 左侧“读入”；Agent 右侧“写出”连接文件左侧“写”输入。
- 文件连接绑定 Agent 而非单轮，完成一轮后自动指向最新轮次；fork 时复制父 Agent 的连接。
- 共享文件不画连线，使用节点底部的“全局读/全局写”开关。这里的共享是画布级全局文件引用授权，不是跨 branch 共享资源映射。
- 文本、Markdown、CSV、常见源码和图片显示预览；其他格式只显示文件名。预览定时刷新以反映 Agent 修改。
- `src/files/README.md` 记录组件边界、Handle、重命名、缩放和最小化语义。

## Agent 设置

- 顶栏“新建 Agent”先打开设置窗口，再创建空闲 Agent。窗口中可选择 Claude Code/Codex、Codex 模型、branch 和当前 Agent 私有系统提示词。
- Branch 列表来自后端 `GET /api/workspace/branch-options`，会展示远端已有但尚未创建 worktree 的 branch；选择这类 branch 创建 Agent 时，后端才 fetch 并创建专属 workspace。弹窗里也可新建 branch。
- 已创建 Agent 的最新节点头部显示齿轮按钮，打开后可修改私有系统提示词和后续响应使用的模型；当 Agent 处于 `idle` 或 `waiting_input` 时也可切换 branch。切换后的下一次对话由后端注入 branch 切换说明和 diff 文件列表。
- `terminated` 和历史轮次不能切换 branch；运行中或已结束状态的 branch 控件禁用。
- 首轮对话节点不再提供 provider/model 选择，启动时直接使用 Agent 创建时保存的设置。
- 新建文件节点固定放在隔离目录；项目内需要 commit 的文件应由 Agent 在所选 branch workspace 中直接创建。
