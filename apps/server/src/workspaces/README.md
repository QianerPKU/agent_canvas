# Workspace Manager

`WorkspaceManager` 管理 Agent Canvas 项目的本地 GitHub/repo 连接、branch workspace、共享资源映射和 agent 临时目录。

## 目录布局

默认项目根目录位于用户本地数据目录：

```text
%LOCALAPPDATA%/agent_canvas/projects/<workspace-key>/
  repos/<repo-id>/repo/          # 默认 branch 的 AppData clone
  worktrees/<repo-id>/<branch>/  # 其他 branch 的 git worktree
  shared/<repo-id>/<resource>/   # 项目级共享资源真实目录
```

`AGENT_CANVAS_PROJECT_ROOT` 可覆盖项目根目录，主要用于测试或调试。

## 三类文件

- 仓库文件：普通代码、配置、测试、文档等，保存在各 branch workspace 中，默认属于需要 commit 的正式改动。
- 共享资源：数据集、模型权重等不提交但核心的大文件，真实内容位于 `shared/`，并通过 junction/symlink 映射到每个 branch workspace 的固定相对路径。
- Agent 临时文件：每个 Agent 使用 `<worktree>/.agent-tmp/<agent-id>/`，该路径写入本地 git exclude，不提交。

## Git 与 GitHub

- `POST /api/workspace/connect` 使用远端 URL 或本地路径 clone 到 AppData 项目目录。
- 默认 branch 直接使用 AppData clone；其他 branch 使用 `git worktree add -B <branch> <path> <baseBranch>`。
- GitHub 连接当前保存 remote URL、owner/repo 和默认 branch；PR/status 同步后续再加。

## 共享资源权限

- `readOnly` 共享资源只进入 `readableDirectories` 和上下文说明，不加入 provider 的可写目录。
- `readWrite` 共享资源会额外加入 `writableDirectories`，Codex 的 `workspaceWrite.writableRoots` 和 Claude 的额外目录授权会据此放行。
- junction/symlink 本身不是跨平台硬只读边界；因此内置工作区规则提示词会要求 Agent 未经用户明确授权不得修改 `readOnly` 资源。
