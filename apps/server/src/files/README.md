# File Nodes

`FileManager` 管理画布文件节点、真实文件和 Agent 读写连线。

- 复制和上传的文件使用 `isolated` 存储：每个节点放在当前 Canvas 项目的 `files/<file-id>/` 独占目录中，不写入任何 branch workspace，也不与仓库文件混放。通过系统文件选择器导入时也可选择 `referenced`，只保存原文件的规范绝对路径，不复制内容。
- 文件选择结果先暂存为不可预测、默认 5 分钟失效的一次性 selection；导入成功、显式释放、切换文件根或加载项目状态后即失效，避免旧选择跨项目复用。失败的校验不会提前消耗 selection。`pickedSelectionPaths` 可在引用导入前读取其中已规范化的路径，供项目状态先持久化用户授权，再创建节点。
- 原生选择和重新链接都只接受普通非符号链接文件，并以设备号、inode、大小和修改时间核对文件在选择后是否被替换或改写。复制导入默认限制单文件 100 MiB、整批 500 MiB，逐个限量读取；整批发布前任一文件失败都会回滚本批已创建的隔离文件，不留下隐藏节点。
- 从原生文件选择或上传得到的安全 basename 会原样保留大小写、Unicode 和任意安全扩展名；手工新建文件仍使用原有的严格扩展名规则。
- `referenced` 节点始终只读：允许普通节点读连线或共享节点 `sharedRead`，拒绝写连线和 `sharedWrite`，避免把原文件的整个父目录开放为 Agent 可写目录。引用缺失时节点以 `availability="missing"` 保留、不会进入 Agent 文件授权，可通过重新链接恢复。
- 引用路径在暂存、恢复和信任比较前都会规范化；可用性刷新在状态和文件身份都不变时复用原节点对象。若父目录被 junction/symlink 换到另一个规范目标，刷新会拒绝跟随，必须由用户重新链接。
- 文件节点的“共享”只表示画布级全局授权：通过 `sharedRead/sharedWrite` 对全部 Agent 生效；其中 `sharedWrite` 只适用于隔离文件。它和 `WorkspaceManager` 的跨 branch 共享资源映射不是同一个概念。
- 普通文件通过 `CanvasFileConnection` 按 Agent 授予 `read/write`。
- Agent 汇报结果同样创建为隔离文件节点，但会带 `origin.kind="agent_result"`、来源 agent 和来源 turn；它只用于画布展示/预览，不进入 branch workspace，也不需要 git commit。
- `POST /api/agents/:id/report-result` 支持直接写入 `content`，也支持从该 agent 当前 workspace 内的 `sourcePath` 复制真实文件，适合实验图片、CSV 表格和说明文档。
- 读权限会生成显式文件引用；写权限会生成 CLI 的额外可写目录。
- 权限在每个 Agent 业务 turn 入队时重新解析，因此新增、删除连线或切换共享开关会从下一次完整请求开始生效。
- `readPreview` 为画布节点提供最多 256 KiB 的快速预览；`readContent` 为独立窗口读取完整文本。
- `VscodeFileOpener` 通过 VS Code CLI 打开任意格式的真实文件或目录；文件节点复用当前窗口打开真实文件，agent 工作区快捷入口在新窗口打开对应 branch worktree 目录，避免替换用户已有的工作区。Windows 使用 `code.cmd`，并通过隐藏的 `cmd.exe` 进行参数转发；等待 CLI 退出后才向前端报告成功，非零退出码和 stderr 会返回为接口错误。
- Windows 支持标准安装路径、PATH 中的 `bin` 目录以及 `AGENT_CANVAS_VSCODE_PATH` 覆盖。覆盖值可以是 `code.cmd`，也可以是能解析到同目录 `bin\code.cmd` 的 `Code.exe`。
- `DirectoryPicker` 在 Windows 使用 PowerShell Forms，在 Linux 有图形会话时尝试 `zenity`/`kdialog`；远程无 GUI 环境会提示手动输入路径。

当前与其他 M1 状态一致，节点元数据保存在内存中；真实文件保留在磁盘。
