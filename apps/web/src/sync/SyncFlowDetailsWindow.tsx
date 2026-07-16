import { useEffect } from "react";
import { GitBranch, GitCommitHorizontal, X } from "lucide-react";
import type { SyncFlowSnapshot } from "@agent-canvas/shared";
import { flowDisplayText, readableCanvasText } from "../displayText.js";
import { syncStatusMeta } from "./SyncFlowNode.js";

export function SyncFlowDetailsWindow({
  flow,
  onClose,
}: {
  flow: SyncFlowSnapshot;
  onClose: () => void;
}): React.ReactElement {
  const meta = syncStatusMeta(flow.status);
  const Icon = flow.kind === "cherry_pick" ? GitCommitHorizontal : GitBranch;
  const display = flowDisplayText(flow);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="history-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="history-window sync-details-window"
        role="dialog"
        aria-modal="true"
        aria-label={`sync ${flow.id} details`}
      >
        <header className="history-window__header">
          <div>
            <strong>
              <Icon size={15} /> {display.title}
            </strong>
            <span>
              {flow.kind === "cherry_pick" ? flow.commitSha : flow.sourceBranch} -&gt;{" "}
              {flow.targetBranch}
            </span>
          </div>
          <button className="icon-button" title="Close sync details" onClick={onClose}>
            <X size={17} />
          </button>
        </header>
        <div className="pr-details-window__body">
          <section className="commit-details-window__summary">
            <h2>{display.summary}</h2>
            <dl>
              <dt>status</dt>
              <dd style={{ color: meta.color }}>{meta.label}</dd>
              <dt>flow id</dt>
              <dd>{flow.id}</dd>
              <dt>kind</dt>
              <dd>{flow.kind}</dd>
              <dt>proposer</dt>
              <dd>{flow.proposerAgentId}</dd>
              <dt>source</dt>
              <dd>{flow.sourceBranch ?? flow.commitSha ?? "(none)"}</dd>
              <dt>target</dt>
              <dd>{flow.targetBranch}</dd>
              <dt>strategy</dt>
              <dd>{flow.strategy ?? "(none)"}</dd>
              <dt>reason</dt>
              <dd>{readableCanvasText(flow.reason, "(unavailable)")}</dd>
              <dt>failure</dt>
              <dd>{flow.failureReason ?? "(none)"}</dd>
            </dl>
          </section>

          <section className="commit-details-window__files">
            <h3>Changed Files</h3>
            {flow.fileChanges.map((file) => (
              <div key={`${file.status}:${file.path}`} className="pr-details-window__file">
                <span>{file.status}</span>
                <strong>{file.path}</strong>
              </div>
            ))}
          </section>

          <section className="commit-details-window__files">
            <h3>Reviews</h3>
            {!flow.reviewRequest ? (
              <p className="history-empty">No reviews yet</p>
            ) : (
              <article className="pr-details-window__review">
                <header>
                  <strong>sync_review</strong>
                  <span>
                    pending {flow.reviewRequest.pendingAgentIds.length} /{" "}
                    {flow.reviewRequest.requestedAgentIds.length}
                  </span>
                </header>
                {flow.reviewRequest.responses.map((response) => (
                  <div key={response.agentId}>
                    <strong>{response.agentId}</strong>
                    <span>{response.decision}</span>
                    <p>{response.summary}</p>
                    {response.requiredChanges.length > 0 && (
                      <small>{response.requiredChanges.join("; ")}</small>
                    )}
                  </div>
                ))}
              </article>
            )}
          </section>

          {flow.applied && (
            <section className="commit-details-window__files">
              <h3>Applied</h3>
              <div className="pr-flow-row">
                <p>{readableCanvasText(flow.applied.summary, display.summary)}</p>
                <small>
                  {flow.applied.commitSha ?? "(no commit)"} -{" "}
                  {flow.applied.reportedByAgentId ?? flow.proposerAgentId}
                </small>
              </div>
            </section>
          )}
        </div>
      </section>
    </div>
  );
}
