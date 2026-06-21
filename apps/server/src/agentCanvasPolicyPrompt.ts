export const AGENT_CANVAS_POLICY_PROMPT_ID = "agent-canvas:workspace-policy";
export const AGENT_CANVAS_POLICY_PROMPT_NAME = "Agent Canvas 内置工作区规则";

export function agentCanvasPolicyPrompt(agentId: string): string {
  const scratchDirectory = `.agent-tmp/${agentId}`;
  const configuredApiBase = process.env.AGENT_CANVAS_API?.trim();
  const port = process.env.PORT?.trim() || "4317";
  const apiBase = configuredApiBase || `http://127.0.0.1:${port}/api`;
  return `# Agent Canvas 内置工作区规则

你在 Agent Canvas 管理的 branch/workspace 中工作。请严格按以下三类文件处理：

1. 需要 commit 的仓库文件
- 普通代码、配置、测试、文档等都属于当前 branch 的仓库文件。
- 除临时目录和共享资源外，你创建或修改的任何文件都默认是需要进入 git diff / git commit 的正式产物。
- 不要把临时脚本、草稿、日志或中间产物留在正式仓库路径里。

2. 不需要 commit 的共享文件/目录
- 共享文件/目录是 Agent Canvas 标记、挂载或映射到当前工作区的外部资源，例如数据集、模型权重、缓存和其他大体积核心资料。
- 它们看起来可能像在当前文件夹内，但真实内容会被多个 branch/agent 共用，不属于当前 branch 的独立产物。
- 除非用户明确授权你修改某个共享资源，否则只能读取，不能写入、删除、移动、重命名、格式化或覆盖。
- 不要为了提交或加工而复制整份共享资源到仓库路径或临时目录；确实需要抽样时，只复制最小必要片段并说明原因。

3. 不需要 commit 的当前 agent 临时文件
- 当前 agent 的临时文件夹是 ${scratchDirectory}/。
- 临时脚本、草稿、日志、实验输出和中间产物只能放进这个目录；目录不存在时可以创建。
- 不要从这个目录提交文件。任务完成时，正式修改应落在仓库文件里，临时文件只作为可丢弃辅助产物存在。

4. PR pipeline 规则
- 当前 agent id 是 ${agentId}。
- 当用户在对话中要求你提 PR、创建 PR、发起 PR、把当前 branch 合到某个目标 branch，或表达同等意图时，必须先走 Agent Canvas PR pipeline；不要直接绕过流程运行 gh pr create、gh pr merge 或其他合并命令。
- Agent Canvas API base 是 ${apiBase}。如果环境变量 AGENT_CANVAS_API 存在，以该变量为准。
- 发起流程时调用 POST ${apiBase}/pr-flows，请求体至少包含 proposerAgentId、targetBranch、summary；可选包含 title、sourceBranch、files。proposerAgentId 必须使用当前 agent id：${agentId}。
- 如果目标 branch 不明确，先向用户确认；如果用户已经明确目标 branch，可以直接发起流程。
- PowerShell 示例：
~~~powershell
Invoke-RestMethod -Method Post -Uri "${apiBase}/pr-flows" -ContentType "application/json" -Body (@{
  proposerAgentId = "${agentId}"
  targetBranch = "main"
  title = "简短 PR 标题"
  summary = "这次 PR 的概括"
  files = @("src/example.ts")
} | ConvertTo-Json -Depth 6)
~~~
- 发起流程后等待 Agent Canvas 审查与授权。只有收到 create_pr 授权后，才可以自由处理冲突、更新源 branch、运行测试、push、执行 gh pr create 等实际创建 PR 的操作。
- 创建 PR 完成后，在对话中只输出一个 JSON 对象登记结果：
~~~json
{
  "agentCanvasPrEvent": "pr_created",
  "flowId": "pr_flow_x",
  "prNumber": 0,
  "prUrl": "https://github.com/OWNER/REPO/pull/0"
}
~~~
- 只有收到 merge_pr 授权后，才可以执行合并。合并完成后，在对话中只输出一个 JSON 对象登记结果：
~~~json
{
  "agentCanvasPrEvent": "merged",
  "flowId": "pr_flow_x"
}
~~~

提交规则：
- 不在 ${scratchDirectory}/ 内、也不是共享资源的所有新增或修改文件，都应被视为需要 commit 的正式改动。
- 当用户要求提交时，只提交正式仓库文件；不要提交共享资源或 agent 临时文件。
- 如果某个文件应属于哪一类不清楚，先按正式仓库文件谨慎处理，并在答复中说明不确定点。`;
}
