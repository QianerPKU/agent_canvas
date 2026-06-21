import { useEffect, useState } from "react";
import { GitBranch, Plus, Settings, X } from "lucide-react";
import {
  CODEX_MODELS,
  DEFAULT_CODEX_MODEL,
  isCodexModel,
  type AgentProvider,
  type AgentSettings,
  type BranchWorkspace,
  type CodexModel,
} from "@agent-canvas/shared";
import type { AgentView } from "../agentStore.js";

type AgentSettingsDialogProps =
  | {
      mode: "create";
      branches: BranchWorkspace[];
      onCreate: (settings: AgentSettings) => Promise<void>;
      onCreateBranch: (branch: string) => Promise<BranchWorkspace>;
      onClose: () => void;
    }
  | {
      mode: "edit";
      agent: AgentView;
      onUpdate: (agentId: string, settings: Pick<AgentSettings, "systemPrompt">) => Promise<void>;
      onClose: () => void;
    };

export function AgentSettingsDialog(props: AgentSettingsDialogProps): React.ReactElement {
  const isCreate = props.mode === "create";
  const agent = props.mode === "edit" ? props.agent : undefined;
  const [provider, setProvider] = useState<AgentProvider>(agent?.provider ?? "claude");
  const [model, setModel] = useState<CodexModel>(codexModel(agent?.model));
  const [branchWorkspaceId, setBranchWorkspaceId] = useState(
    agent?.branchWorkspaceId ?? (props.mode === "create" ? props.branches[0]?.id ?? "" : ""),
  );
  const [extraBranches, setExtraBranches] = useState<BranchWorkspace[]>([]);
  const [newBranch, setNewBranch] = useState("");
  const [systemPrompt, setSystemPrompt] = useState(agent?.systemPrompt ?? "");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [creatingBranch, setCreatingBranch] = useState(false);
  const branches =
    props.mode === "create" ? [...props.branches, ...extraBranches] : [];
  const selectedBranch = branches.find((branch) => branch.id === branchWorkspaceId);

  useEffect(() => {
    if (!isCreate && agent) {
      setProvider(agent.provider ?? "claude");
      setModel(codexModel(agent.model));
      setBranchWorkspaceId(agent.branchWorkspaceId ?? "");
      setSystemPrompt(agent.systemPrompt ?? "");
    }
  }, [agent, isCreate]);

  useEffect(() => {
    if (props.mode === "create" && !branchWorkspaceId && props.branches[0]) {
      setBranchWorkspaceId(props.branches[0].id);
    }
  }, [branchWorkspaceId, props]);

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
          branchWorkspaceId,
          branch: selectedBranch?.branch,
          cwd: selectedBranch?.worktreePath,
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

  const createBranch = async () => {
    const branch = newBranch.trim();
    if (!branch || props.mode !== "create") return;
    setCreatingBranch(true);
    setError("");
    try {
      const created = await props.onCreateBranch(branch);
      setExtraBranches((current) =>
        current.some((candidate) => candidate.id === created.id)
          ? current
          : [...current, created],
      );
      setBranchWorkspaceId(created.id);
      setNewBranch("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setCreatingBranch(false);
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

        {isCreate ? (
          <fieldset>
            <legend>Branch</legend>
            <select
              aria-label="Agent branch"
              value={branchWorkspaceId}
              onChange={(event) => setBranchWorkspaceId(event.target.value)}
            >
              {branches.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.branch}
                </option>
              ))}
            </select>
            <div className="agent-dialog__branch-create">
              <input
                aria-label="新建 branch"
                value={newBranch}
                placeholder="feature/name"
                onChange={(event) => setNewBranch(event.target.value)}
              />
              <button
                type="button"
                className="icon-button"
                title="创建 branch"
                disabled={creatingBranch || !newBranch.trim()}
                onClick={() => void createBranch()}
              >
                <Plus size={15} />
              </button>
            </div>
          </fieldset>
        ) : (
          <label className="file-dialog__field">
            <span>Branch</span>
            <div className="file-dialog__path">
              <input
                aria-label="Agent branch"
                value={agent?.branch ?? agent?.cwd ?? ""}
                readOnly
              />
              <span className="agent-dialog__branch-icon">
                <GitBranch size={15} />
              </span>
            </div>
          </label>
        )}

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
            disabled={submitting || (isCreate && !branchWorkspaceId)}
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
