import { useEffect, useState } from "react";
import { ExternalLink, File, X } from "lucide-react";
import type { CanvasFileNode } from "@agent-canvas/shared";
import { api } from "../api.js";

export function FileContentWindow({
  file,
  onClose,
  onOpenEditor,
}: {
  file: CanvasFileNode;
  onClose: () => void;
  onOpenEditor: (fileId: string) => void;
}): React.ReactElement {
  const [content, setContent] = useState("");
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(file.previewKind !== "image" && file.previewKind !== "none");

  useEffect(() => {
    if (file.previewKind === "image" || file.previewKind === "none") {
      setLoading(false);
      setError(undefined);
      return;
    }
    let active = true;
    setLoading(true);
    setError(undefined);
    void api
      .fileFullContent(file.id)
      .then((result) => {
        if (active) setContent(result.content);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [file.id, file.previewKind, file.updatedAt]);

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
        className="history-window file-content-window"
        role="dialog"
        aria-modal="true"
        aria-label={`${file.filename} 完整内容`}
      >
        <header className="history-window__header">
          <div>
            <strong>{file.filename}</strong>
            <span title={file.path}>{file.path}</span>
          </div>
          <button
            className="icon-button"
            title="用 VS Code 打开"
            onClick={() => onOpenEditor(file.id)}
          >
            <ExternalLink size={16} />
          </button>
          <button className="icon-button" title="关闭文件窗口" onClick={onClose}>
            <X size={17} />
          </button>
        </header>

        <div className="file-content-window__body">
          {loading && <div className="history-empty">正在读取完整文件...</div>}
          {error && <div className="history-error">{error}</div>}
          {!loading && !error && file.previewKind === "image" && (
            <img
              src={api.fileRawUrl(file.id, file.updatedAt)}
              alt={file.filename}
            />
          )}
          {!loading && !error && file.previewKind === "none" && (
            <div className="file-content-window__unsupported">
              <File size={40} />
              <strong>{file.filename}</strong>
              <span>此格式不支持内嵌查看，可以使用右上角按钮在 VS Code 中打开。</span>
            </div>
          )}
          {!loading &&
            !error &&
            file.previewKind !== "image" &&
            file.previewKind !== "none" && <pre>{content || "空文件"}</pre>}
        </div>
      </section>
    </div>
  );
}
