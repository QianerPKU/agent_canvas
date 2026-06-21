import { useEffect, useState } from "react";
import { ChevronRight, GitCommitHorizontal, X } from "lucide-react";
import type { AgentCommitSnapshot, CommitChangedFile } from "@agent-canvas/shared";

export function CommitDetailsWindow({
  commit,
  onClose,
}: {
  commit: AgentCommitSnapshot;
  onClose: () => void;
}): React.ReactElement {
  const [openFiles, setOpenFiles] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const toggleFile = (path: string) => {
    setOpenFiles((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <div
      className="history-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="history-window commit-details-window"
        role="dialog"
        aria-modal="true"
        aria-label={`commit ${commit.shortSha} 详情`}
      >
        <header className="history-window__header">
          <div>
            <strong>
              <GitCommitHorizontal size={15} /> {commit.shortSha}
            </strong>
            <span title={commit.commitSha}>{commit.subject}</span>
          </div>
          <button className="icon-button" title="关闭 commit 详情" onClick={onClose}>
            <X size={17} />
          </button>
        </header>

        <div className="commit-details-window__body">
          <section className="commit-details-window__summary">
            <h2>{commit.summary}</h2>
            <dl>
              <dt>完整 hash</dt>
              <dd>{commit.commitSha}</dd>
              <dt>branch</dt>
              <dd>{commit.branch ?? "(unknown)"}</dd>
              <dt>author</dt>
              <dd>
                {[commit.authorName, commit.authorEmail].filter(Boolean).join(" ") || "(unknown)"}
              </dd>
              <dt>time</dt>
              <dd>{commit.committedAt ?? commit.authoredAt ?? "(unknown)"}</dd>
              <dt>agent</dt>
              <dd>{commit.agentId}</dd>
            </dl>
            {commit.body && <pre>{commit.body}</pre>}
          </section>

          <section className="commit-details-window__files">
            <h3>Changed Files</h3>
            {commit.files.length === 0 ? (
              <p className="history-empty">没有文件 diff</p>
            ) : (
              commit.files.map((file) => (
                <CommitFileRow
                  key={`${file.status}:${file.path}`}
                  file={file}
                  open={openFiles.has(file.path)}
                  onToggle={() => toggleFile(file.path)}
                />
              ))
            )}
          </section>
        </div>
      </section>
    </div>
  );
}

function CommitFileRow({
  file,
  open,
  onToggle,
}: {
  file: CommitChangedFile;
  open: boolean;
  onToggle: () => void;
}): React.ReactElement {
  return (
    <article className="commit-file-row">
      <button onClick={onToggle} aria-expanded={open}>
        <ChevronRight className={open ? "is-open" : undefined} size={15} />
        <span>{file.status}</span>
        <strong>{file.path}</strong>
        <small>
          +{file.additions} -{file.deletions}
        </small>
      </button>
      {open && <pre>{file.diff || "(empty diff)"}</pre>}
    </article>
  );
}
