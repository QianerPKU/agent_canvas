import { useEffect } from "react";
import { GitPullRequest, X } from "lucide-react";
import type { PullRequestFlowSnapshot } from "@agent-canvas/shared";
import { statusMeta } from "./PullRequestNode.js";

export function PullRequestDetailsWindow({
  flow,
  onClose,
}: {
  flow: PullRequestFlowSnapshot;
  onClose: () => void;
}): React.ReactElement {
  const meta = statusMeta(flow.status);

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
        className="history-window pr-details-window"
        role="dialog"
        aria-modal="true"
        aria-label={`PR ${flow.id} 详情`}
      >
        <header className="history-window__header">
          <div>
            <strong>
              <GitPullRequest size={15} /> {flow.title || flow.id}
            </strong>
            <span>{flow.sourceBranch} → {flow.targetBranch}</span>
          </div>
          <button className="icon-button" title="关闭 PR 详情" onClick={onClose}>
            <X size={17} />
          </button>
        </header>
        <div className="pr-details-window__body">
          <section className="commit-details-window__summary">
            <h2>{flow.summary}</h2>
            <dl>
              <dt>状态</dt>
              <dd style={{ color: meta.color }}>{meta.label}</dd>
              <dt>flow id</dt>
              <dd>{flow.id}</dd>
              <dt>proposer</dt>
              <dd>{flow.proposerAgentId}</dd>
              <dt>PR</dt>
              <dd>{flow.pr?.prUrl ?? flow.pr?.prNumber ?? "(not created)"}</dd>
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
            {flow.reviewRequests.length === 0 ? (
              <p className="history-empty">暂无审查记录</p>
            ) : (
              flow.reviewRequests.map((request) => (
                <article key={request.id} className="pr-details-window__review">
                  <header>
                    <strong>{request.stage}</strong>
                    <span>
                      pending {request.pendingAgentIds.length} / {request.requestedAgentIds.length}
                    </span>
                  </header>
                  {request.responses.map((response) => (
                    <div key={`${response.stage}:${response.agentId}`}>
                      <strong>{response.agentId}</strong>
                      <span>{response.decision}</span>
                      <p>{response.summary}</p>
                      {response.requiredChanges.length > 0 && (
                        <small>{response.requiredChanges.join("; ")}</small>
                      )}
                    </div>
                  ))}
                </article>
              ))
            )}
          </section>
        </div>
      </section>
    </div>
  );
}
