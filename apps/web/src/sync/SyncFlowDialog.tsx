import { useMemo, useState } from "react";
import { GitBranch, GitCommitHorizontal, X } from "lucide-react";
import type {
  BranchOption,
  BranchPullStrategy,
  CreateSyncFlowInput,
  SyncFlowAppliedInput,
  SyncFlowSnapshot,
} from "@agent-canvas/shared";
import type { AgentMap } from "../agentStore.js";
import { flowDisplayText } from "../displayText.js";
import type { SyncFlowActions } from "../useAgentCanvas.js";
import { syncStatusMeta } from "./SyncFlowNode.js";

export interface SyncFlowDialogProps {
  agents: AgentMap;
  branches: BranchOption[];
  flows: SyncFlowSnapshot[];
  actions: SyncFlowActions;
  onClose: () => void;
}

export function SyncFlowDialog({
  agents,
  branches,
  flows,
  actions,
  onClose,
}: SyncFlowDialogProps): React.ReactElement {
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
  const [kind, setKind] = useState<"cherry_pick" | "branch_pull">("cherry_pick");
  const [proposerAgentId, setProposerAgentId] = useState(activeAgents[0]?.id ?? "");
  const proposer = activeAgents.find((agent) => agent.id === proposerAgentId);
  const targetBranch = proposer?.branch ?? "";
  const [sourceBranch, setSourceBranch] = useState(branchNames[0] ?? "");
  const [commitSha, setCommitSha] = useState("");
  const [strategy, setStrategy] = useState<BranchPullStrategy>("merge");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [reason, setReason] = useState("");
  const [filesText, setFilesText] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const create = async () => {
    const files = splitFiles(filesText);
    const base = {
      proposerAgentId,
      targetBranch,
      title: title.trim() || undefined,
      summary: summary.trim(),
      reason: reason.trim(),
      files,
    };
    const input: CreateSyncFlowInput =
      kind === "cherry_pick"
        ? {
            ...base,
            kind,
            sourceBranch: sourceBranch.trim() || undefined,
            commitSha: commitSha.trim(),
          }
        : {
            ...base,
            kind,
            sourceBranch: sourceBranch.trim(),
            strategy,
          };
    if (
      !input.proposerAgentId ||
      !input.targetBranch ||
      !input.summary ||
      !input.reason ||
      (input.kind === "cherry_pick" && !input.commitSha) ||
      (input.kind === "branch_pull" && !input.sourceBranch)
    ) {
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await actions.create(input);
      setTitle("");
      setSummary("");
      setReason("");
      setFilesText("");
      setCommitSha("");
    } catch (reasonValue) {
      setError(reasonValue instanceof Error ? reasonValue.message : String(reasonValue));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="file-dialog-backdrop">
      <section className="file-dialog pr-dialog sync-dialog" role="dialog" aria-modal="true">
        <header>
          {kind === "cherry_pick" ? <GitCommitHorizontal size={17} /> : <GitBranch size={17} />}
          <strong>Sync pipeline</strong>
          <button className="icon-button" title="Close" onClick={onClose}>
            <X size={15} />
          </button>
        </header>

        <div className="pr-dialog__body">
          <section className="pr-dialog__section">
            <div className="file-dialog__field">
              <div className="segmented-control">
                <button
                  type="button"
                  className={kind === "cherry_pick" ? "is-active" : undefined}
                  onClick={() => setKind("cherry_pick")}
                >
                  Cherry-pick
                </button>
                <button
                  type="button"
                  className={kind === "branch_pull" ? "is-active" : undefined}
                  onClick={() => setKind("branch_pull")}
                >
                  Pull branch
                </button>
              </div>
            </div>

            <div className="pr-dialog__grid">
              <label className="file-dialog__field">
                <span>Proposer agent</span>
                <select
                  aria-label="Proposer agent"
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
                <span>Target branch</span>
                <input aria-label="Target branch" value={targetBranch} readOnly />
              </label>
            </div>

            <div className="pr-dialog__grid">
              <label className="file-dialog__field">
                <span>Source branch</span>
                <input
                  aria-label="Source branch"
                  list="sync-branches"
                  value={sourceBranch}
                  onChange={(event) => setSourceBranch(event.target.value)}
                />
              </label>
              {kind === "cherry_pick" ? (
                <label className="file-dialog__field">
                  <span>Commit SHA</span>
                  <input
                    aria-label="Commit SHA"
                    value={commitSha}
                    onChange={(event) => setCommitSha(event.target.value)}
                  />
                </label>
              ) : (
                <label className="file-dialog__field">
                  <span>Strategy</span>
                  <select
                    aria-label="Strategy"
                    value={strategy}
                    onChange={(event) => setStrategy(event.target.value as BranchPullStrategy)}
                  >
                    <option value="merge">merge</option>
                    <option value="rebase">rebase</option>
                    <option value="pull">pull</option>
                  </select>
                </label>
              )}
            </div>
            <datalist id="sync-branches">
              {branchNames.map((branch) => (
                <option key={branch} value={branch} />
              ))}
            </datalist>

            <label className="file-dialog__field">
              <span>Title</span>
              <input
                aria-label="Title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <label className="file-dialog__field">
              <span>Summary</span>
              <textarea
                aria-label="Summary"
                value={summary}
                onChange={(event) => setSummary(event.target.value)}
              />
            </label>
            <label className="file-dialog__field">
              <span>Reason</span>
              <textarea
                aria-label="Reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
            <label className="file-dialog__field">
              <span>Files</span>
              <textarea
                aria-label="Files"
                value={filesText}
                onChange={(event) => setFilesText(event.target.value)}
              />
            </label>
            {error && <div className="file-dialog__error">{error}</div>}
            <footer className="pr-dialog__footer">
              <button
                className="file-dialog__primary"
                disabled={
                  busy ||
                  !proposerAgentId ||
                  !targetBranch ||
                  !summary.trim() ||
                  !reason.trim() ||
                  (kind === "cherry_pick" && !commitSha.trim()) ||
                  (kind === "branch_pull" && !sourceBranch.trim())
                }
                onClick={() => void create()}
              >
                Start review
              </button>
            </footer>
          </section>

          <section className="pr-dialog__section pr-dialog__section--flows">
            {flows.length === 0 ? (
              <p className="pr-dialog__empty">No sync flows</p>
            ) : (
              flows.map((flow) => (
                <SyncFlowRow key={flow.id} flow={flow} actions={actions} />
              ))
            )}
          </section>
        </div>
      </section>
    </div>
  );
}

function SyncFlowRow({
  flow,
  actions,
}: {
  flow: SyncFlowSnapshot;
  actions: SyncFlowActions;
}): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const meta = syncStatusMeta(flow.status);
  const display = flowDisplayText(flow);

  const recordApplied = async () => {
    const input: SyncFlowAppliedInput = {
      summary: flow.summary,
      files: flow.files,
      fileChanges: flow.fileChanges,
    };
    setBusy(true);
    try {
      await actions.recordApplied(flow.id, input);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="pr-flow-row">
      <header>
        <strong>{display.title}</strong>
        <span style={{ color: meta.color }}>{meta.label}</span>
      </header>
      <div className="pr-flow-row__meta">
        {flow.kind} - {flow.sourceBranch ?? flow.commitSha ?? "source"} -&gt;{" "}
        {flow.targetBranch}
      </div>
      <p>{display.summary}</p>
      {flow.reviewRequest?.responses.map((response) => (
        <div key={response.agentId} className="pr-flow-row__review">
          <strong>{response.agentId}</strong>
          <span>{response.decision}</span>
          <small>{response.summary}</small>
        </div>
      ))}
      <footer>
        {flow.status === "apply_authorized" && (
          <button disabled={busy} onClick={() => void recordApplied()}>
            Mark applied
          </button>
        )}
        {!isClosed(flow.status) && (
          <button disabled={busy} onClick={() => void actions.cancel(flow.id)}>
            Cancel
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

function isClosed(status: SyncFlowSnapshot["status"]): boolean {
  return ["review_failed", "applied", "timed_out", "cancelled", "blocked"].includes(status);
}
