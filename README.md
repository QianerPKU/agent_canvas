# agent_canvas

多 agent 并行开发 / 并行实验时的**可视化监控与操纵画布**。把不同 agent 做成画布上的模块，模块化管理各类 agent 的提示词，并支持提示词的 fork 与版本分支控制。底层支持 **Claude Agent SDK** 与 **Codex CLI app-server** 两种 agent 驱动。

## 核心理念

- **画布即控制台**：可实时监控（输出流 / 工具调用 / token 与花费 / 状态）并可干预（追加指令 / 停止）。
- **节点 = 一轮对话（对话树）**：一个 agent = 一条轮次链；每轮 = 一次用户输入 + 一次完整答复，完成后**自动延伸出待输入的新节点**。从任意完成轮可 **fork** 出一个独立新 agent：Claude 走 `forkSession + resumeSessionAt`，Codex 走 app-server 的 `thread/fork`。fork 不绑定 git。
- **Branch workspace = 分支工作目录**：每个 branch 对应 AppData 项目根下的一个工作目录（默认分支为 clone，其他分支为 git worktree）。新建 agent 时选择 branch；后续画布区域会复用同一模型。
- **三类文件**：仓库文件正常随 branch commit；数据集/模型权重等共享资源放在项目级共享目录并映射进各 branch；agent 临时文件只放 `.agent-tmp/<agent-id>/` 且不提交。
- **提示词模块化 + fork/版本**：提示词按 agent 类型模块化管理，支持 fork 与版本分支。*(里程碑 2 实现)*

## 技术栈

| 层 | 选型 |
| --- | --- |
| 产品形态 | 本地 Web 应用（Node 本地服务 + 浏览器画布） |
| 前端 | React + Vite + React Flow (`@xyflow/react`) |
| 后端 | Node + TypeScript，WebSocket 推实时流 + REST |
| 驱动 agent | `@anthropic-ai/claude-agent-sdk`（TS）/ `codex app-server --stdio` |
| 并行隔离 | git worktree（区域=分支） |
| 持久化 | SQLite（里程碑 2 引入） |
| 测试 | vitest |

## 仓库结构（npm workspaces）

```
agent_canvas/
├─ apps/
│  ├─ server/   后端控制层：拉起/管理 agent 会话，WS/REST   →见 apps/server/README.md
│  └─ web/      前端画布（里程碑 1 后段）                  →见 apps/web/README.md
└─ packages/
   └─ shared/   前后端共享类型（统一事件模型）              →见 packages/shared/README.md
```

## 里程碑

- **M1（进行中）单 agent 端到端**：画布拉起 1 个 agent → 实时监控输出/状态 → 可停止 / 续跑 / 中途追加指令。先打通"拉起—监控—干预"主链路。
- **M2 提示词模块 + fork/版本**：提示词模块化管理与分支；引入 SQLite 持久化。
- **M3 多 agent 并行编排**：区域=分支的可视化隔离、并行调度与产出汇总对比。

## 开发

```bash
npm install              # 安装全部 workspace 依赖
npm test                 # 跑所有 workspace 测试
npm run dev:server       # 启动后端开发服务
```

> 鉴权：Claude 驱动复用本机已登录的 Claude 凭据（或环境变量 `ANTHROPIC_API_KEY`）；Codex 驱动复用 `codex login` / Codex CLI 的本机登录状态。
