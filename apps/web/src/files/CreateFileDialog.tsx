import { useEffect, useState } from "react";
import { FilePlus2, X } from "lucide-react";
import type {
  CanvasFileKind,
  CanvasFileStorage,
  CreateCanvasFileInput,
} from "@agent-canvas/shared";
import type { AgentMap } from "../agentStore.js";

export function CreateFileDialog({
  agents,
  onCreate,
  onClose,
}: {
  agents: AgentMap;
  onCreate: (input: CreateCanvasFileInput) => Promise<void>;
  onClose: () => void;
}): React.ReactElement {
  const agentIds = Object.keys(agents);
  const [name, setName] = useState("");
  const [extension, setExtension] = useState("txt");
  const [kind, setKind] = useState<CanvasFileKind>("normal");
  const [storage, setStorage] = useState<CanvasFileStorage>("isolated");
  const [agentId, setAgentId] = useState(agentIds[0] ?? "");
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
        extension,
        kind,
        storage,
        agentId: storage === "agent" ? agentId : undefined,
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
      <form className="file-dialog" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <FilePlus2 size={17} />
          <strong>新建文件节点</strong>
          <button type="button" className="icon-button" title="关闭" onClick={onClose}>
            <X size={16} />
          </button>
        </header>

        <label className="file-dialog__field">
          <span>文件名</span>
          <div className="file-dialog__filename">
            <input
              aria-label="新文件名"
              value={name}
              autoFocus
              placeholder="notes"
              onChange={(event) => setName(event.target.value)}
            />
            <input
              aria-label="新文件后缀"
              value={extension}
              placeholder="txt"
              onChange={(event) => setExtension(event.target.value)}
            />
          </div>
        </label>

        <fieldset>
          <legend>节点类型</legend>
          <Segmented
            value={kind}
            options={[
              ["normal", "普通节点"],
              ["shared", "共享节点"],
            ]}
            onChange={(value) => setKind(value as CanvasFileKind)}
          />
        </fieldset>

        <fieldset>
          <legend>存放位置</legend>
          <Segmented
            value={storage}
            options={[
              ["isolated", "隔离目录"],
              ["agent", "Agent 工作目录"],
            ]}
            onChange={(value) => setStorage(value as CanvasFileStorage)}
          />
        </fieldset>

        {storage === "agent" && (
          <label className="file-dialog__field">
            <span>选择 Agent</span>
            <select
              aria-label="文件所属 agent"
              value={agentId}
              disabled={agentIds.length === 0}
              onChange={(event) => setAgentId(event.target.value)}
            >
              {agentIds.length === 0 ? (
                <option value="">请先新建 Agent</option>
              ) : (
                agentIds.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))
              )}
            </select>
          </label>
        )}

        {error && <div className="file-dialog__error">{error}</div>}
        <footer>
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button
            type="submit"
            className="file-dialog__primary"
            disabled={!name.trim() || submitting || (storage === "agent" && !agentId)}
          >
            创建
          </button>
        </footer>
      </form>
    </div>
  );
}

function Segmented({
  value,
  options,
  onChange,
}: {
  value: string;
  options: Array<[string, string]>;
  onChange: (value: string) => void;
}): React.ReactElement {
  return (
    <div className="segmented-control">
      {options.map(([option, label]) => (
        <button
          key={option}
          type="button"
          className={option === value ? "is-active" : ""}
          onClick={() => onChange(option)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
