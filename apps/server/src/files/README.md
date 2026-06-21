# File Nodes

`FileManager` 管理画布文件节点、真实文件和 Agent 读写连线。

- 文件节点固定使用 `isolated` 存储：每个节点放在用户本地数据目录的 `agent_canvas/files/<workspace-key>/<file-id>/`，不写入任何 branch workspace，也不与项目文件混放。
- 文件节点的“共享”只表示画布级全局读写授权：通过 `sharedRead/sharedWrite` 对全部 Agent 生效，仍然是把隔离目录里的真实文件引用传给 Agent。它和 `WorkspaceManager` 的跨 branch 共享资源映射不是同一个概念。
- 普通文件通过 `CanvasFileConnection` 按 Agent 授予 `read/write`。
- 读权限会生成显式文件引用；写权限会生成 CLI 的额外可写目录。
- 权限在每个 Agent 业务 turn 入队时重新解析，因此新增、删除连线或切换共享开关会从下一次完整请求开始生效。
- `readPreview` 为画布节点提供最多 256 KiB 的快速预览；`readContent` 为独立窗口读取完整文本。
- `VscodeFileOpener` 通过 VS Code CLI 打开任意格式的真实文件。Windows 使用 `code.cmd`，并通过隐藏的 `cmd.exe` 进行参数转发；等待 CLI 退出后才向前端报告成功，非零退出码和 stderr 会返回为接口错误。
- Windows 支持标准安装路径、PATH 中的 `bin` 目录以及 `AGENT_CANVAS_VSCODE_PATH` 覆盖。覆盖值可以是 `code.cmd`，也可以是能解析到同目录 `bin\code.cmd` 的 `Code.exe`。

当前与其他 M1 状态一致，节点元数据保存在内存中；真实文件保留在磁盘。
