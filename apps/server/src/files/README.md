# File Nodes

`FileManager` 管理画布文件节点、真实文件和 Agent 读写连线。

- `agent` 存储把文件建在所选 Agent 的工作目录。
- `isolated` 存储把每个节点放在用户本地数据目录的 `agent_canvas/files/<workspace-key>/<file-id>/`，位置在 Agent 工作目录之外，并且每个节点独占目录。
- 共享文件通过 `sharedRead/sharedWrite` 对全部 Agent 生效。
- 普通文件通过 `CanvasFileConnection` 按 Agent 授予 `read/write`。
- 读权限会生成显式文件引用；写权限会生成 CLI 的额外可写目录。
- 权限在每个 Agent 业务 turn 入队时重新解析，因此新增、删除连线或切换共享开关会从下一次完整请求开始生效。
- `readPreview` 为画布节点提供最多 256 KiB 的快速预览；`readContent` 为独立窗口读取完整文本。
- `VscodeFileOpener` 启动 VS Code 打开任意格式的真实文件。Windows 支持标准安装路径、PATH 中的 `bin` 目录以及 `AGENT_CANVAS_VSCODE_PATH` 覆盖。

当前与其他 M1 状态一致，节点元数据保存在内存中；真实文件保留在磁盘。
