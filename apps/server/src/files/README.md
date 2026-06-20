# File Nodes

`FileManager` 管理画布文件节点、真实文件和 Agent 读写连线。

- `agent` 存储把文件建在所选 Agent 的工作目录。
- `isolated` 存储把每个节点放在用户本地数据目录的 `agent_canvas/files/<workspace-key>/<file-id>/`，位置在 Agent 工作目录之外，并且每个节点独占目录。
- 共享文件通过 `sharedRead/sharedWrite` 对全部 Agent 生效。
- 普通文件通过 `CanvasFileConnection` 按 Agent 授予 `read/write`。
- 读权限会生成显式文件引用；写权限会生成 CLI 的额外可写目录。

当前与其他 M1 状态一致，节点元数据保存在内存中；真实文件保留在磁盘。
