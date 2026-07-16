# Workspace Manager

`WorkspaceManager` 管理 Agent Canvas 项目的本地 GitHub/repo 连接、branch workspace、共享资源映射和 agent 临时目录。

## 目录布局

项目索引和项目根目录位于用户本地数据目录。正常启动时不会自动打开或连接仓库，前端需要先选择已有项目或新建项目：

```text
Windows: %LOCALAPPDATA%/agent_canvas/projects/index.json
Linux:   ~/.local/share/agent_canvas/projects/index.json

<projects-root>/<project-id>/
  workspace.json                 # 项目元数据及当前 repo/branch/shared resource 状态
  canvas-state.json              # 当前画布节点、agent histories、commit/PR/sync 和布局状态
  files/                         # 当前 canvas 项目的文件节点隔离目录
  prompts/                       # 当前 canvas 项目的提示词节点载体
  repos/<repo-id>/repo/          # 默认 branch 的 AppData clone
  worktrees/<repo-id>/<branch>/  # 其他 branch 的 git worktree
  shared/<repo-id>/<resource>/   # 项目级共享资源真实目录
```

新建项目时可传 `projectRoot`，直接把这个 Canvas 项目放进用户指定文件夹。项目文件夹必须为空，避免覆盖已有数据。项目自身的名称、id 和创建/打开时间保存在 `workspace.json`；默认项目根目录会扫描其中的项目以修复丢失的索引，自定义位置的项目则可通过项目文件夹手动加载并重新登记。`AGENT_CANVAS_PROJECTS_ROOT` 可覆盖默认项目列表根目录；`AGENT_CANVAS_PROJECT_ROOT` 可覆盖并自动打开单个项目根目录，主要用于测试、调试或固定部署。

## 三类文件

- 仓库文件：普通代码、配置、测试、文档等，保存在各 branch workspace 中，默认属于需要 commit 的正式改动。
- 共享资源：数据集、模型权重等不提交但核心的大文件，真实内容位于 `shared/`，并通过 junction/symlink 映射到每个 branch workspace 的固定相对路径。
- Agent 临时文件：每个 Agent 使用 `<worktree>/.agent-tmp/<agent-id>/`，该路径写入本地 git exclude，不提交。

## Git 与 GitHub

- `GET/POST /api/canvas-projects` 管理 canvas 项目；`POST /api/canvas-projects` 支持 `projectRoot` 自定义项目文件夹；`POST /api/canvas-projects/open` 可按已登记 id 或任意项目文件夹打开项目；`DELETE /api/canvas-projects/:id` 会永久删除项目目录。打开项目不会自动连接 GitHub repo。
- `POST /api/workspace/connect` 使用远端 URL 或本地路径 clone 到 AppData 项目目录。
- 默认 branch 直接使用 AppData clone；其他 branch 不会在连接时全部拉取。只有创建 Agent 或切换 Agent branch 选中了某个尚未创建 workspace 的 branch 时，才会 `fetch` 该 branch 并执行 `git worktree add -B <branch> <path> <startPoint>`。
- `POST /api/workspace/branches` 支持 `baseBranch`。当目标 branch 不是已有远端 branch 时，新 worktree 会优先从 `origin/<baseBranch>` 创建；如果该远端 ref 不存在，则退回本地已有的 `<baseBranch>`。
- `GET /api/workspace/branch-options` 会合并远端 branch 与已创建的本地 branch workspace；`hasWorkspace=false` 表示还没有专属 worktree。
- GitHub 连接当前保存 remote URL、owner/repo 和默认 branch；PR/status 同步后续再加。

## Agent Branch 切换

- `PATCH /api/agents/:id/settings` 可以在 `idle` 或 `waiting_input` 状态切换 branch；`running`、`done`、`stopped`、`terminated`、`error` 不允许切换。
- 切换到尚未创建 workspace 的 branch 时，会先懒创建对应 worktree。
- 切换后下一次业务输入会注入一条 Agent Canvas 系统提示，说明从哪个 branch 切到哪个 branch，并附带 `git diff --name-status <old> <new>` 文件列表。
- 如果 agent 正在 `waiting_input`，切换 branch 会脱开当前空闲会话；下一次输入会用新 branch 的 `cwd` 重新启动并 resume 原 session，避免在旧 worktree 的 CLI 进程里假装切换目录。

## 共享资源权限

- `readOnly` 共享资源只进入 `readableDirectories` 和上下文说明，不加入 provider 的可写目录。
- `readWrite` 共享资源会额外加入 `writableDirectories`，Codex 的 `workspaceWrite.writableRoots` 和 Claude 的额外目录授权会据此放行。
- junction/symlink 本身不是跨平台硬只读边界；因此内置工作区规则提示词会要求 Agent 未经用户明确授权不得修改 `readOnly` 资源。
- 这里的共享资源不同于文件节点的共享开关。文件节点始终位于画布隔离文件夹，`sharedRead/sharedWrite` 只是把该隔离文件引用授权给全部 Agent，不做 branch 间重映射。

## 测试覆盖

- `WorkspaceManager.test.ts` 包含一个 fake git 单测，用来快速验证路径、权限和 API 返回结构。
- 同文件还包含一个真实 git 集成测试：在系统临时目录创建 source repo 与 bare remote，clone 后创建多个 branch worktree，再把一个 `readWrite` 共享资源映射到每个 worktree，验证每个 branch 都能通过挂载路径读写同一份源目录。
- 真实 `git worktree` 的 `.git` 通常是指向实际 gitdir 的文件；测试和实现都应通过 `git rev-parse --git-path info/exclude` 找到本地 exclude 文件。
