import { useMemo, useState } from "react";
import { GitPullRequest, X } from "lucide-react";
import type {
  BranchOption,
  CreatePullRequestFlowInput,
  PullRequestCreatedInput,
  PullRequestFlowSnapshot,
} from "@agent-canvas/shared";
import type { AgentMap } from "../agentStore.js";
import type { PullRequestActions } from "../useAgentCanvas.js";

export interface PullRequestDialogProps {
  agents: AgentMap;
  branches: BranchOption[];
  flows: PullRequestFlowSnapshot[];
  actions: PullRequestActions;
  onClose: () => void;
}

export function PullRequestDialog({
  agents,
  branches,
  flows,
  actions,
  onClose,
}: PullRequestDialogProps): React.ReactElement {
  const activeAgents = useMemo(
    () =>
      Object.values(agents).filter(
        (agent) =>
          (agent.status === "running" || agent.status === "waiting_input") && agent.branch,
      ),
    [agents],
  );
  const branchNames = useMemo(
    () => [...new Set(branches.map((branch) => branch.branch).filter(Boolean))],
    [branches],
  );
  const [proposerAgentId, setProposerAgentId] = useState(activeAgents[0]?.id ?? "");
  const proposer = activeAgents.find((agent) => agent.id === proposerAgentId);
  const [targetBranch, setTargetBranch] = useState(branchNames[0] ?? "");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [filesText, setFilesText] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const create = async () => {
    const input: CreatePullRequestFlowInput = {
      proposerAgentId,
      sourceBranch: proposer?.branch,
      targetBranch: targetBranch.trim(),
      title: title.trim() || undefined,
      summary: summary.trim(),
      files: splitFiles(filesText),
    };
    if (!input.proposerAgentId || !input.targetBranch || !input.summary) return;
    setBusy(true);
    setError(undefined);
    try {
      await actions.create(input);
      setTitle("");
      setSummary("");
      setFilesText("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="file-dialog-backdrop">
      <section className="file-dialog pr-dialog" role="dialog" aria-modal="true">
        <header>
          <GitPullRequest size={17} />
          <strong>PR 流程</strong>
          <button className="icon-button" title="关闭" onClick={onClose}>
            <X size={15} />
          </button>
        </header>

        <div className="pr-dialog__body">
          <section className="pr-dialog__section">
            <div className="pr-dialog__grid">
              <label className="file-dialog__field">
                <span>提 PR Agent</span>
                <select
                  value={proposerAgentId}
                  onChange={(event) => setProposerAgentId(event.target.value)}
                >
                  {activeAgents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.id} / {agent.branch}
                    </option>
                  ))}
                </select>
              </label>
              <label className="file-dialog__field">
                <span>目标 branch</span>
                <select
                  value={targetBranch}
                  onChange={(event) => setTargetBranch(event.target.value)}
                >
                  {branchNames.map((branch) => (
                    <option key={branch} value={branch}>
                      {branch}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="file-dialog__field">
              <span>标题</span>
              <input value={title} onChange={(event) => setTitle(event.target.value)} />
            </label>
            <label className="file-dialog__field">
              <span>概括</span>
              <textarea
                value={summary}
                onChange={(event) => setSummary(event.target.value)}
              />
            </label>
            <label className="file-dialog__field">
              <span>文件范围</span>
              <textarea
                value={filesText}
                onChange={(event) => setFilesText(event.target.value)}
              />
            </label>
            {error && <div className="file-dialog__error">{error}</div>}
            <footer className="pr-dialog__footer">
              <button
                className="file-dialog__primary"
                disabled={busy || !proposerAgentId || !targetBranch.trim() || !summary.trim()}
                onClick={() => void create()}
              >
                发起审查
              </button>
            </footer>
          </section>

          <section className="pr-dialog__section pr-dialog__section--flows">
            {flows.length === 0 ? (
              <p className="pr-dialog__empty">暂无 PR 流程</p>
            ) : (
              flows.map((flow) => (
                <PullRequestFlowRow key={flow.id} flow={flow} actions={actions} />
              ))
            )}
          </section>
        </div>
      </section>
    </div>
  );
}

function PullRequestFlowRow({
  flow,
  actions,
}: {
  flow: PullRequestFlowSnapshot;
  actions: PullRequestActions;
}): React.ReactElement {
  const [prUrl, setPrUrl] = useState(flow.pr?.prUrl ?? "");
  const [prNumber, setPrNumber] = useState(flow.pr?.prNumber?.toString() ?? "");
  const [busy, setBusy] = useState(false);

  const recordCreated = async () => {
    const input: PullRequestCreatedInput = {
      prUrl: prUrl.trim() || undefined,
      prNumber: prNumber.trim() ? Number(prNumber.trim()) : undefined,
    };
    setBusy(true);
    try {
      await actions.recordCreated(flow.id, input);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="pr-flow-row">
      <header>
        <strong>{flow.title || flow.id}</strong>
        <span>{statusLabel(flow.status)}</span>
      </header>
      <div className="pr-flow-row__meta">
        {flow.sourceBranch} → {flow.targetBranch}
      </div>
      <p>{flow.summary}</p>
      {flow.reviewRequests.at(-1)?.responses.map((response) => (
        <div key={`${response.stage}:${response.agentId}`} className="pr-flow-row__review">
          <strong>{response.agentId}</strong>
          <span>{response.decision}</span>
          <small>{response.summary}</small>
        </div>
      ))}
      {flow.status === "create_pr_authorized" && (
        <div className="pr-flow-row__inline">
          <input
            aria-label="PR URL"
            value={prUrl}
            placeholder="PR URL"
            onChange={(event) => setPrUrl(event.target.value)}
          />
          <input
            aria-label="PR number"
            value={prNumber}
            placeholder="#"
            onChange={(event) => setPrNumber(event.target.value)}
          />
          <button disabled={busy} onClick={() => void recordCreated()}>
            PR 已创建
          </button>
        </div>
      )}
      <footer>
        {flow.status === "merge_authorized" && (
          <button disabled={busy} onClick={() => void actions.recordMerged(flow.id)}>
            已合并
          </button>
        )}
        {!isClosed(flow.status) && (
          <button disabled={busy} onClick={() => void actions.cancel(flow.id)}>
            取消
          </button>
        )}
      </footer>
    </article>
  );
}

function splitFiles(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function isClosed(status: PullRequestFlowSnapshot["status"]): boolean {
  return [
    "source_review_failed",
    "target_review_failed",
    "merged",
    "timed_out",
    "cancelled",
    "blocked",
  ].includes(status);
}

function statusLabel(status: PullRequestFlowSnapshot["status"]): string {
  const labels: Record<PullRequestFlowSnapshot["status"], string> = {
    source_review_collecting: "源审查",
    source_review_failed: "源拒绝",
    create_pr_authorized: "可提 PR",
    target_review_collecting: "目标审查",
    target_review_failed: "目标拒绝",
    merge_authorized: "可合并",
    merged: "已合并",
    timed_out: "超时",
    cancelled: "已取消",
    blocked: "阻塞",
  };
  return labels[status];
}
