# Agent Canvas

Agent Canvas 是一个本地运行的多 agent 开发/实验画布。你可以在画布上创建多个 Claude Code 或 Codex agent，实时查看输出、工具调用、授权请求和对话历史，并把不同 agent 放到不同 git branch workspace 中并行工作。

## 主要功能

- 多 agent 对话画布：每个 agent 的每一轮对话都是一个可拖拽、缩放、最小化的节点。
- 支持 Claude Code 和 Codex：创建 agent 时选择运行器和模型，后续也可在设置里切换模型。
- Branch workspace：一个 branch 对应一个本地 worktree；新建 branch 可选择继承自哪个已有 branch。
- 文件与提示词节点：把文件或提示词连到 agent，控制读写权限。
- Git 流程节点：agent commit、PR pipeline、cherry-pick / branch pull 会在画布上生成可查看详情的节点。
- 运行中交互：支持排队输入、引导当前轮、回答 CLI/SDK 提问、处理授权请求。

## 安装

需要 Node.js 20 或更高版本。

```bash
npm install
```

## 一键启动

Windows 下双击根目录的：

```text
start-agent-canvas.cmd
```

它会启动后端和前端，并自动打开：

```text
http://127.0.0.1:5317/
```

也可以用命令行启动：

```bash
npm run start:app
```

如需换端口：

```powershell
.\start-agent-canvas.ps1 -ServerPort 4318 -WebPort 5318
```

## 配置 Claude / Codex

Claude Code：

- 推荐先在本机 Claude Code / Claude CLI 中登录；Agent Canvas 会复用本机凭据。
- 也可以设置 `ANTHROPIC_API_KEY`。
- 新建 agent 时选择 `Claude Code`，Claude 模型输入框可留空使用默认模型。

Codex：

- 先安装并登录 Codex CLI，确认命令行可执行 `codex`。
- 执行一次 `codex login`。
- Agent Canvas 通过 `codex app-server --stdio` 驱动 Codex。
- 新建 agent 时选择 `Codex`，再选择 Codex 模型。

## 基本使用

1. 打开页面后，新建或打开一个 Canvas 项目。
2. 连接一个 GitHub repo 或本地 git repo。
3. 新建 agent，选择 Claude Code / Codex、模型、branch 和私有系统提示词。
4. 在 agent 节点输入任务并启动。
5. 运行中可排队下一轮输入，也可用“引导”尽快影响当前轮。
6. 需要文件上下文时，新建文件节点或提示词节点并连到 agent。
7. agent 完成 commit / PR / 同步流程后，画布会保留对应节点和连线。

## 数据位置

Canvas 项目、branch worktree、文件节点、提示词节点和共享资源默认保存在用户本地数据目录：

```text
%LOCALAPPDATA%/agent_canvas/projects/
```

不要把凭据、Claude 本地状态、模型权重或大型数据集提交进 git。大型共享数据建议用项目共享资源映射。

## 开发命令

```bash
npm test
npm run build
npm run typecheck --workspace apps/server
npm run typecheck --workspace apps/web
npm run dev:server
npm run dev --workspace apps/web
```

项目结构：

```text
apps/server      后端 REST / WebSocket / agent orchestration
apps/web         React + Vite + React Flow 前端画布
packages/shared  前后端共享类型
```
