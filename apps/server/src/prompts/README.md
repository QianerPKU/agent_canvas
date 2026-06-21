# Prompt Nodes

`PromptManager` 管理画布提示词节点、内部 UTF-8 文本载体和 Agent 读写授权。

- 节点表面是纯文本，不向 Agent 传引用；读权限把文本直接放在用户输入之前。
- 普通节点通过 `CanvasPromptConnection` 按 Agent 授权，语义与文件节点一致：提示词输出到 Agent 输入为读，Agent 输出到提示词输入为写。
- 共享节点通过 `sharedRead/sharedWrite` 对全部 Agent 生效。
- 多个可读节点固定按共享节点、普通节点分组；同组使用 UTF-8 字节序排列，最后以节点 id 消除相同文本的排序歧义。
- 新建 Agent 的首轮注入可读提示词。fork/resume 首轮不重复注入；手动或自动 compact 完成后，在下一条业务输入中重新注入最新内容。
- 写权限把内部 `prompt.txt` 所在目录加入 provider 的可写目录，并在输入中列出明确写目标。Agent 写入后，`list/get/accessFor` 会重新读取磁盘内容。

当前节点元数据与连线保存在内存中，内部文本载体保留在用户本地数据目录。
