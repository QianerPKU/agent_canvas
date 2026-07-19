# Workspace Manager

`WorkspaceManager` 管理 Agent Canvas 项目的本地 GitHub/repo 连接、branch workspace、共享资源映射和 agent 临时目录。

## 目录布局

项目索引和项目根目录位于用户本地数据目录。正常启动时不会自动打开或连接仓库，前端需要先选择已有项目或新建项目：

```text
Windows: %LOCALAPPDATA%/agent_canvas/projects/index.json
Linux:   ~/.local/share/agent_canvas/projects/index.json

<projects-root>/<project-id>/
  workspace.json                 # 带 schema/version 的项目元数据及 repo/branch/shared resource 状态
  canvas-state.json              # 当前画布节点、agent histories、commit/PR/sync 和布局状态
  files/                         # 当前 canvas 项目的文件节点隔离目录
  prompts/                       # 当前 canvas 项目的提示词节点载体
  repos/<repo-id>/repo/          # 默认 branch 的 AppData clone
  worktrees/<repo-id>/<branch>/  # 其他 branch 的 git worktree
  shared/<repo-id>/<resource>/   # 项目级共享资源真实目录
  shared/_agent-canvas/<repo-hash>/work-documentation/ # 内置跨 branch 工作文档
```

新建项目时可传 `projectRoot`，直接把这个 Canvas 项目放进用户指定文件夹。项目文件夹必须为空，避免覆盖已有数据。项目自身的名称、id 和创建/打开时间保存在 `workspace.json`，文件必须声明 `schema: "agent-canvas/workspace"` 和受支持的 `version`。默认项目根目录会扫描其中的项目以修复丢失的索引，自定义位置的项目则可通过项目文件夹手动加载并重新登记。移动或复制项目时，repo/worktree/scratch/内部共享资源路径会相对旧项目根目录重定位；外部共享资源必须按绝对路径重新授权。`AGENT_CANVAS_PROJECTS_ROOT` 可覆盖默认项目列表根目录；`AGENT_CANVAS_PROJECT_ROOT` 可覆盖并自动打开单个项目根目录，主要用于测试、调试或固定部署。

## 四类文件

- 仓库文件：普通代码、配置、测试、文档等，保存在各 branch workspace 中，默认属于需要 commit 的正式改动。
- 共享资源：数据集、模型权重等不提交但核心的大文件，真实内容位于 `shared/`，并通过 junction/symlink 映射到每个 branch workspace 的固定相对路径。
- Agent 临时文件：每个 Agent 使用 `<worktree>/.agent-tmp/<agent-id>/`，该路径写入本地 git exclude，不提交。
- 内置工作文档：项目设置开启后，branch 详细文档位于 `<worktree>/.agent-docs/`，共享概要通过 `<worktree>/.agent-shared-docs/` 映射到项目级保留目录。两者都写入本地 git exclude，不提交。

## 工作文档维护

- `workDocumentationEnabled` 是随当前 Canvas 项目保存的开关，默认关闭；旧项目缺少该字段时按关闭处理。
- 后端硬编码两个导航入口：`.agent-docs/index.md` 保存当前 branch 的详细状态、活动记录和文档索引；`.agent-shared-docs/index.md` 由后端维护同一仓库所有 branch 的只读导航条目，并链接由 Agent 实时维护的各 branch 共享概要页。
- 两个索引只在不存在时初始化，不覆盖 Agent 已维护的内容。WorkspaceManager 会串行执行初始化；共享导航发生后端更新时使用同目录、已验证的临时文件原子替换，不会原地截断既有索引。
- 初始化先执行无副作用的 tracked-path、marker、mount 与路径边界预检，再先安装 Git exclude，最后创建文件；成功的 project/repo/branch 上下文会在进程内缓存，避免 Agent 已获得概要写权后后端重复触碰文档路径。
- `.agent-docs/` 与内置共享源目录都使用 `.agent-canvas-managed` 标记。启用前会通过 `git ls-files` 检查仓库路径，并拒绝未托管目录、symlink/junction、硬链接数不为 1 的托管文件、非普通索引文件或越出项目真实路径边界的共享源，避免复用、覆盖业务文件或扩大写入范围。
- 导入、打开和每次 Agent 输入准备都会重新验证 repo/worktree/scratch 与内部共享源的真实路径；项目根目录本身可以是用户明确选择的映射，但其后代 repo/worktree 映射不得逃逸到项目真实根之外。
- 开启后，两份索引通过 `AgentFileAccess.readableFiles` 随每次业务输入作为文件引用传给 provider；索引内容不会作为提示词节点全文拼接。`sandboxWritableDirectories` 只开放 branch 隔离文档目录和当前 branch 的共享概要子目录，不开放共享总索引或其他 branch 概要；这些文件不是 `CanvasFileNode`，不会出现在画布文件节点中。
- `sandboxWritableDirectories` 不会像用户明确授权的文件/提示词写目标那样把 Codex `approvalPolicy` 改为 `never`；文档开关不会顺带取消普通代码修改的审批。
- `.agent-shared-docs/` 的真实目录使用仓库 remote URL 哈希隔离，避免用户共享资源同名冲突，也避免同一 Canvas 重新连接其他仓库时复用旧概要；Git exclude 使用根锚定且无尾斜杠的条目，POSIX symlink 和 Windows junction 本身都不会进入状态列表。
- 关闭后，后端移除索引引用和额外写目录，并向已有会话注入一次撤销说明；物理文档会保留，方便以后重新开启。

## Git 与 GitHub

- `GET/POST /api/canvas-projects` 管理 canvas 项目；`POST /api/canvas-projects/inspect` 在不登记、不改写的前提下校验待导入目录并列出外部共享资源；`POST /api/canvas-projects/open` 可按已登记 id 或任意项目文件夹打开项目；`DELETE /api/canvas-projects/:id` 会永久删除项目目录。删除要求受信任 Origin 与 `X-Agent-Canvas-Intent: delete-project`，当前项目仍有非终态 agent 时返回 409；删除前会清空 agent、文件、提示词、commit、PR/sync 和布局内存状态。打开项目不会自动连接 GitHub repo。
- 项目打开采用 begin/load/commit 三段式事务：外部授权暂存后必须等完整 `canvas-state.json` 导入成功才提交；失败使用实际 index 提交前后 snapshot 的 content+identity CAS 恢复，并恢复前一项目选择和内存授权。CAS 冲突只报告 rollback incomplete，不覆盖并发 writer。授权索引以精确 canonical project root 和 bigint `dev/ino` 十进制身份区分项目根，避免大小写敏感 Windows 目录或同路径根替换继承旧授权。
- 项目根、托管文件、提示词、共享资源与工作文档的本地路径键和 containment 使用精确 resolved/canonical casing 与目录分段前缀，不采用 Win32 全局大小写折叠；普通大小写不敏感卷由 `realpath` 自然收敛，大小写敏感 NTFS 中的 case-twin 目录保持不同安全边界。
- 后端固定监听 `127.0.0.1`。浏览器写请求和 WebSocket 只接受 `AGENT_CANVAS_ALLOWED_ORIGINS` 中的本机 Origin；启动脚本会按实际 Web 端口设置该变量，非浏览器的本机 CLI/API 调用可不带 Origin。
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
