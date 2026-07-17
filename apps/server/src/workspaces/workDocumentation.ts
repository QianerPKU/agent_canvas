import { createHash } from "node:crypto";

export const WORK_DOCUMENTATION_PATHS = {
  isolatedDirectory: ".agent-docs",
  isolatedIndex: ".agent-docs/index.md",
  sharedMountDirectory: ".agent-shared-docs",
  sharedIndex: ".agent-shared-docs/index.md",
  sharedSourceDirectory: "work-documentation",
} as const;

export const WORK_DOCUMENTATION_DISABLED_PROMPT_ID =
  "agent-canvas:work-documentation-disabled";
export const WORK_DOCUMENTATION_MANAGED_MARKER = ".agent-canvas-managed";

const BRANCH_LIST_END = "<!-- agent-canvas:branch-list:end -->";

export function isolatedDocumentationIndex(branch: string): string {
  return `# Branch 工作文档索引

> 本目录记录 \`${escapeInlineCode(branch)}\` 的详细工作过程，由 Agent Canvas agent 持续维护，不进入 Git。

## 当前状态

- Branch：\`${escapeInlineCode(branch)}\`
- 状态：开发中
- 最近更新：待补充
- 当前目标：待补充

## 文档索引

| 文档 | 内容 | 最近更新 |
| --- | --- | --- |
| [index.md](index.md) | 状态、索引与工作记录入口 | 待补充 |

## 工作记录

| 时间 | 类型 | 摘要 | 相关文档 |
| --- | --- | --- | --- |
| 待补充 | 初始化 | Agent Canvas 创建了 branch 隔离文档索引 | [index.md](index.md) |

## 待办与风险

- 待补充
`;
}

export function sharedDocumentationIndex(): string {
  return `# Agent Canvas 共享 Branch 文档索引

> 本目录在同一仓库的所有 branch workspace 间共享，不进入 Git。这里只保留各 branch 的概要、状态和入口；详细过程留在各 branch 的隔离文档中。

## Branch 概要

| Branch | 概要文档 | 状态 | 最近更新 |
| --- | --- | --- | --- |
${BRANCH_LIST_END}

## 共享文档索引

| 文档 | 用途 | 最近更新 |
| --- | --- | --- |
| [index.md](index.md) | 所有 branch 的概要入口 | 待补充 |

## 维护约定

- Branch 条目和链接由 Agent Canvas 后端维护；agent 把实时状态写入自己链接的概要文档，不直接修改本索引。
- 保留索引中的 \`agent-canvas:*\` HTML 注释；Agent Canvas 用它们避免重复创建 branch 条目。
- 状态使用“开发中”“已完成”“已废弃”或更明确的短语。
- 概要应说明 branch 用途、已实现内容、分析或实验结论、当前状态和下一步。
`;
}

export function sharedBranchOverview(branch: string): string {
  return `# \`${escapeInlineCode(branch)}\` Branch 概要

- 状态：开发中
- 用途：待补充
- 最近更新：待补充

## 已实现

- 待补充

## 分析与实验结论

- 待补充

## 当前状态与下一步

- 待补充

## 详细文档

- 详细过程位于该 branch workspace 的 \`${WORK_DOCUMENTATION_PATHS.isolatedIndex}\`。
`;
}

export function sharedBranchDirectory(branch: string): string {
  const readable = branch.replace(/[^a-zA-Z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  const hash = createHash("sha256").update(branch).digest("hex").slice(0, 8);
  return `${readable || "branch"}-${hash}`;
}

export function ensureSharedBranchIndexEntry(
  content: string,
  branch: string,
  branchDirectory: string,
): string {
  const marker = `agent-canvas:branch:${createHash("sha256")
    .update(branch)
    .digest("hex")
    .slice(0, 12)}`;
  const overviewLink = `branches/${branchDirectory}/overview.md`;
  if (content.includes(marker) || content.includes(overviewLink)) return content;
  const row = `| \`${escapeTableCell(branch)}\` <!-- ${marker} --> | [概要](${overviewLink}) | 见概要 | 见概要 |`;
  if (content.includes(BRANCH_LIST_END)) {
    return content.replace(BRANCH_LIST_END, `${row}\n${BRANCH_LIST_END}`);
  }
  const separator = content.endsWith("\n") ? "" : "\n";
  return `${content}${separator}\n${row}\n`;
}

export function workDocumentationPolicyPrompt(): string {
  return `## 工作文档维护（已开启）

本节是用户通过“工作文档维护”开关授予的系统级写入规则，是上方通用文件分类规则的明确例外：branch 隔离目录和当前 branch 的共享概要子目录可读写，共享总索引只读；它们永远不属于应提交的仓库文件。

你必须在工作的同时实时维护两套不进入 Git 的文档；不要等到任务结束才补写：

1. Branch 隔离详细文档
- 固定根目录：\`${WORK_DOCUMENTATION_PATHS.isolatedDirectory}/\`。
- 固定索引：\`${WORK_DOCUMENTATION_PATHS.isolatedIndex}\`。
- 无论进行代码或配置修改、实验、评估、分析、调研、设计决策、故障排查，还是得到失败结论，都要留下对应记录，并写明目标、过程、结果、证据、影响、下一步和相关文件。
- 新增或移动文档时必须同步更新索引；不要留下索引无法发现的孤立文档。
- 保留根目录中的 \`${WORK_DOCUMENTATION_MANAGED_MARKER}\` 标记文件；Agent Canvas 用它确认该目录不是仓库原有业务目录。

2. 跨 Branch 共享概要文档
- 固定根目录：\`${WORK_DOCUMENTATION_PATHS.sharedMountDirectory}/\`。
- 固定索引：\`${WORK_DOCUMENTATION_PATHS.sharedIndex}\`。
- 共享索引中的 branch 条目和链接由 Agent Canvas 后端维护，是只读导航；不要修改该索引。沿当前 branch 的链接维护概要，简洁说明 branch 用途、已实现内容、关键分析或实验结论、当前状态（如开发中、已完成、已废弃）和下一步。
- 写入当前 branch 概要前重新读取最新内容并合并修改，避免覆盖同 branch 其他 agent 刚写入的信息。
- 保留共享根目录中的 \`${WORK_DOCUMENTATION_MANAGED_MARKER}\` 标记文件；不要把目录或索引替换成 symlink/junction。
- 共享目录对同一仓库的其他 agent 可见。只修改当前 branch 的概要，保留其他 branch 的内容；不要放入密钥、隐私数据、大型原始产物或可由详细文档替代的冗长过程。

3. 读取与版本控制规则
- 两个固定索引会作为参考文件随每次业务输入提供。它们是导航入口，不代表其链接的所有文档都已读入上下文。
- 当任务信息不充分、历史决策不明确或工作可能重复时，先读取两个索引，再按链接选择相关文档；不要凭猜测继续。
- 每次实质进展后立即更新相应详细文档和概要状态，保持索引、文档内容与实际 workspace 一致。
- 如果当前处于只读或 plan 模式，不得绕过权限写文档；先整理应记录的内容，并在恢复写权限后的第一个机会补入两套文档。
- \`${WORK_DOCUMENTATION_PATHS.isolatedDirectory}/\` 和 \`${WORK_DOCUMENTATION_PATHS.sharedMountDirectory}/\` 均由 Agent Canvas 排除在 Git 跟踪之外；不要 git add、commit 或复制它们到仓库文件中。`;
}

export function workDocumentationDisabledPrompt(): string {
  return `Agent Canvas 的“工作文档维护”开关现已关闭。此前会话中要求维护 \`${WORK_DOCUMENTATION_PATHS.isolatedDirectory}/\` 与 \`${WORK_DOCUMENTATION_PATHS.sharedMountDirectory}/\` 的指令从现在起撤销；后续不要再为该机制读取或修改文档，固定索引引用和额外写入授权也已移除。已有文档保留但仍不得提交到 Git。`;
}

function escapeInlineCode(value: string): string {
  return value.replace(/`/gu, "\\`");
}

function escapeTableCell(value: string): string {
  return escapeInlineCode(value).replace(/\|/gu, "\\|");
}
