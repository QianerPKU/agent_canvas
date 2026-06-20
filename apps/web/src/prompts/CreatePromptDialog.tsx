import { useEffect, useState } from "react";
import { MessageSquarePlus, X } from "lucide-react";
import type {
  CanvasPromptKind,
  CreateCanvasPromptInput,
} from "@agent-canvas/shared";

export function CreatePromptDialog({
  onCreate,
  onClose,
}: {
  onCreate: (input: CreateCanvasPromptInput) => Promise<void>;
  onClose: () => void;
}): React.ReactElement {
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [kind, setKind] = useState<CanvasPromptKind>("normal");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      await onCreate({
        name: name.trim(),
        content,
        kind,
      });
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="file-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <form
        className="file-dialog prompt-dialog"
        onSubmit={submit}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <MessageSquarePlus size={17} />
          <strong>新建提示词节点</strong>
          <button type="button" className="icon-button" title="关闭" onClick={onClose}>
            <X size={16} />
          </button>
        </header>

        <label className="file-dialog__field">
          <span>名称</span>
          <input
            aria-label="提示词名称"
            value={name}
            autoFocus
            placeholder="工程规范"
            onChange={(event) => setName(event.target.value)}
          />
        </label>

        <label className="file-dialog__field">
          <span>提示词内容</span>
          <textarea
            aria-label="提示词内容"
            value={content}
            rows={8}
            placeholder="输入需要拼接进 Agent 上下文的纯文本..."
            onChange={(event) => setContent(event.target.value)}
          />
        </label>

        <fieldset>
          <legend>节点类型</legend>
          <div className="segmented-control">
            {([
              ["normal", "普通节点"],
              ["shared", "共享节点"],
            ] as Array<[CanvasPromptKind, string]>).map(([option, label]) => (
              <button
                key={option}
                type="button"
                className={option === kind ? "is-active" : ""}
                onClick={() => setKind(option)}
              >
                {label}
              </button>
            ))}
          </div>
        </fieldset>

        {error && <div className="file-dialog__error">{error}</div>}
        <footer>
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button
            type="submit"
            className="file-dialog__primary"
            disabled={!name.trim() || !content.trim() || submitting}
          >
            创建
          </button>
        </footer>
      </form>
    </div>
  );
}
