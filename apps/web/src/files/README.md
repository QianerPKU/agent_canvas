# File Nodes

文件节点是 React Flow 的第二类节点。

- `CreateFileDialog` 选择文件名、后缀、普通/共享类型以及 Agent 工作目录/隔离目录。
- `FileNode` 展示文本、Markdown、CSV 和图片预览；其他格式只显示文件名。
- 普通节点左侧 `write` 是输入端，右侧 `read` 是输出端。
- 共享节点不使用连线，通过“全局读/全局写”开关授权全部 Agent。
- 文件节点标题栏使用 `.drag-handle`，可与对话节点一样在画布中拖动。
