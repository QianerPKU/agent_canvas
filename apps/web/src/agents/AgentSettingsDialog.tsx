import { useEffect, useState } from "react";
import { FolderOpen, Settings, X } from "lucide-react";
import {
  CODEX_MODELS,
  DEFAULT_CODEX_MODEL,
  isCodexModel,
  type AgentProvider,
  type AgentSettings,
  type CodexModel,
} from "@agent-canvas/shared";
import type { AgentView } from "../agentStore.js";

type AgentSettingsDialogProps =
  | {
      mode: "create";
      defaultCwd: string;
      onCreate: (settings: AgentSettings) => Promise<void>;
      onClose: () => void;
      onPickDirectory: (initialDirectory?: string) => Promise<string | undefined>;
    }
  | {
      mode: "edit";
      agent: AgentView;
      defaultCwd: string;
      onUpdate: (agentId: string, settings: Pick<AgentSettings, "systemPrompt">) => Promise<void>;
      onClose: () => void;
      onPickDirectory: (initialDirectory?: string) => Promise<string | undefined>;
    };

export function AgentSettingsDialog(props: AgentSettingsDialogProps): React.ReactElement {
  const isCreate = props.mode === "create";
  const agent = props.mode === "edit" ? props.agent : undefined;
  const [provider, setProvider] = useState<AgentProvider>(agent?.provider ?? "claude");
  const [model, setModel] = useState<CodexModel>(codexModel(agent?.model));
  const [cwd, setCwd] = useState(agent?.cwd ?? props.defaultCwd);
  const [systemPrompt, setSystemPrompt] = useState(agent?.systemPrompt ?? "");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [browsing, setBrowsing] = useState(false);

  useEffect(() => {
    if (!isCreate && agent) {
      setProvider(agent.provider ?? "claude");
      setModel(codexModel(agent.model));
      setCwd(agent.cwd ?? props.defaultCwd);
      setSystemPrompt(agent.systemPrompt ?? "");
    }
  }, [agent, isCreate, props.defaultCwd]);

  useEffect(() => {
    if (isCreate && !cwd && props.defaultCwd) {
      setCwd(props.defaultCwd);
    }
  }, [cwd, isCreate, props.defaultCwd]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [props]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      if (props.mode === "create") {
        await props.onCreate({
          provider,
          model: provider === "codex" ? model : undefined,
          cwd: cwd.trim(),
          systemPrompt,
        });
      } else {
        await props.onUpdate(props.agent.id, { systemPrompt });
      }
      props.onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSubmitting(false);
    }
  };

  const pickDirectory = async () => {
    setBrowsing(true);
    setError("");
    try {
      const selected = await props.onPickDirectory(cwd || props.defaultCwd);
      if (selected) setCwd(selected);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBrowsing(false);
    }
  };

  return (
    <div className="file-dialog-backdrop" role="presentation" onMouseDown={props.onClose}>
      <form
        className="file-dialog agent-dialog"
        onSubmit={submit}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <Settings size={17} />
          <strong>{isCreate ? "新建 Agent" : `Agent 设置 ${agent?.id ?? ""}`}</strong>
          <button type="button" className="icon-button" title="关闭" onClick={props.onClose}>
            <X size={16} />
          </button>
        </header>

        <fieldset>
          <legend>运行器</legend>
          <Segmented
            value={provider}
            disabled={!isCreate}
            options={[
              ["claude", "Claude Code"],
              ["codex", "Codex"],
            ]}
            onChange={(value) => setProvider(value as AgentProvider)}
          />
        </fieldset>

        {provider === "codex" && (
          <label className="file-dialog__field">
            <span>Codex 模型</span>
            <select
              aria-label="Codex 模型"
              value={model}
              disabled={!isCreate}
              onChange={(event) => setModel(event.target.value as CodexModel)}
            >
              {CODEX_MODELS.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {candidate}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="file-dialog__field">
          <span>工作目录</span>
          <div className="file-dialog__path">
            <input
              aria-label="Agent 工作目录"
              value={cwd}
              readOnly={!isCreate}
              onChange={(event) => setCwd(event.target.value)}
            />
            {isCreate && (
              <button
                type="button"
                className="icon-button"
                title="浏览目录"
                disabled={browsing}
                onClick={() => void pickDirectory()}
              >
                <FolderOpen size={15} />
              </button>
            )}
          </div>
        </label>

        <label className="file-dialog__field">
          <span>私有系统提示词</span>
          <textarea
            aria-label="Agent 私有系统提示词"
            value={systemPrompt}
            rows={8}
            placeholder="会像提示词节点一样拼接进这个 Agent 的业务输入"
            onChange={(event) => setSystemPrompt(event.target.value)}
          />
        </label>

        {error && <div className="file-dialog__error">{error}</div>}
        <footer>
          <button type="button" onClick={props.onClose}>
            取消
          </button>
          <button
            type="submit"
            className="file-dialog__primary"
            disabled={submitting || (isCreate && !cwd.trim())}
          >
            {isCreate ? "创建" : "保存"}
          </button>
        </footer>
      </form>
    </div>
  );
}

function Segmented({
  value,
  options,
  disabled = false,
  onChange,
}: {
  value: string;
  options: Array<[string, string]>;
  disabled?: boolean;
  onChange: (value: string) => void;
}): React.ReactElement {
  return (
    <div className="segmented-control">
      {options.map(([option, label]) => (
        <button
          key={option}
          type="button"
          className={option === value ? "is-active" : ""}
          disabled={disabled}
          onClick={() => onChange(option)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function codexModel(model: string | undefined): CodexModel {
  return isCodexModel(model) ? model : DEFAULT_CODEX_MODEL;
}
