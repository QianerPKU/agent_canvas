import { useEffect, useState } from "react";
import { GitBranch, Plus, Settings, X } from "lucide-react";
import {
  CODEX_MODELS,
  DEFAULT_CODEX_MODEL,
  isCodexModel,
  type AgentProvider,
  type AgentSettings,
  type BranchOption,
  type BranchWorkspace,
  type CodexModel,
  type UpdateAgentSettingsInput,
} from "@agent-canvas/shared";
import type { AgentView } from "../agentStore.js";

type AgentSettingsDialogProps =
  | {
      mode: "create";
      branches: BranchOption[];
      onCreate: (settings: AgentSettings) => Promise<void>;
      onCreateBranch: (branch: string) => Promise<BranchWorkspace>;
      onClose: () => void;
    }
  | {
      mode: "edit";
      agent: AgentView;
      branches: BranchOption[];
      canChangeBranch: boolean;
      onCreateBranch: (branch: string) => Promise<BranchWorkspace>;
      onUpdate: (
        agentId: string,
        settings: UpdateAgentSettingsInput,
      ) => Promise<void>;
      onClose: () => void;
    };

export function AgentSettingsDialog(props: AgentSettingsDialogProps): React.ReactElement {
  const isCreate = props.mode === "create";
  const agent = props.mode === "edit" ? props.agent : undefined;
  const [provider, setProvider] = useState<AgentProvider>(agent?.provider ?? "claude");
  const [codexModelValue, setCodexModelValue] = useState<CodexModel>(codexModel(agent?.model));
  const [claudeModel, setClaudeModel] = useState(
    agent?.provider === "claude" ? agent.model ?? "" : "",
  );
  const [branchName, setBranchName] = useState(
    agent?.branch ?? (props.mode === "create" ? props.branches[0]?.branch ?? "" : ""),
  );
  const [extraBranches, setExtraBranches] = useState<BranchOption[]>([]);
  const [newBranch, setNewBranch] = useState("");
  const [systemPrompt, setSystemPrompt] = useState(agent?.systemPrompt ?? "");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [creatingBranch, setCreatingBranch] = useState(false);
  const canChangeBranch = props.mode === "create" || props.canChangeBranch;
  const branches = mergeBranchOptions(props.branches, extraBranches);
  const selectedBranch = branches.find((branch) => branch.branch === branchName);

  useEffect(() => {
    if (!isCreate && agent) {
      setProvider(agent.provider ?? "claude");
      setCodexModelValue(codexModel(agent.model));
      setClaudeModel(agent.provider === "claude" ? agent.model ?? "" : "");
      setBranchName(agent.branch ?? "");
      setSystemPrompt(agent.systemPrompt ?? "");
    }
  }, [agent, isCreate]);

  useEffect(() => {
    if (props.mode === "create" && !branchName && props.branches[0]) {
      setBranchName(props.branches[0].branch);
    }
  }, [branchName, props]);

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
          model: selectedModel(provider, codexModelValue, claudeModel) ?? undefined,
          branchWorkspaceId: selectedBranch?.branchWorkspaceId,
          branch: selectedBranch?.branch,
          cwd: selectedBranch?.worktreePath,
          systemPrompt,
        });
      } else {
        await props.onUpdate(props.agent.id, {
          systemPrompt,
          model: selectedModel(provider, codexModelValue, claudeModel),
          ...(canChangeBranch
            ? {
                branchWorkspaceId: selectedBranch?.branchWorkspaceId,
                branch: selectedBranch?.branch ?? branchName,
                cwd: selectedBranch?.worktreePath,
              }
            : {}),
        });
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
    if (!branch || !canChangeBranch) return;
    setCreatingBranch(true);
    setError("");
    try {
      const created = await props.onCreateBranch(branch);
      const option: BranchOption = {
        branch: created.branch,
        branchWorkspaceId: created.id,
        worktreePath: created.worktreePath,
        hasWorkspace: true,
        isDefault: created.isDefault,
      };
      setExtraBranches((current) =>
        current.some((candidate) => candidate.branch === option.branch)
          ? current
          : [...current, option],
      );
      setBranchName(option.branch);
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

        {provider === "codex" ? (
          <label className="file-dialog__field">
            <span>Codex 模型</span>
            <select
              aria-label="Codex 模型"
              value={codexModelValue}
              onChange={(event) => setCodexModelValue(event.target.value as CodexModel)}
            >
              {CODEX_MODELS.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {candidate}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label className="file-dialog__field">
            <span>Claude Code 模型</span>
            <input
              aria-label="Claude Code 模型"
              value={claudeModel}
              placeholder="留空使用 CLI 默认模型"
              onChange={(event) => setClaudeModel(event.target.value)}
            />
          </label>
        )}

        <fieldset>
          <legend>Branch</legend>
          <div className="file-dialog__path">
            <select
              aria-label="Agent branch"
              value={branchName}
              disabled={!canChangeBranch}
              onChange={(event) => setBranchName(event.target.value)}
            >
              {branches.map((branch) => (
                <option key={branch.branch} value={branch.branch}>
                  {branch.branch}
                  {branch.hasWorkspace ? "" : "（未拉取）"}
                </option>
              ))}
            </select>
            <span className="agent-dialog__branch-icon">
              <GitBranch size={15} />
            </span>
          </div>
          <div className="agent-dialog__branch-create">
            <input
              aria-label="新建 branch"
              value={newBranch}
              placeholder="feature/name"
              disabled={!canChangeBranch}
              onChange={(event) => setNewBranch(event.target.value)}
            />
            <button
              type="button"
              className="icon-button"
              title="创建 branch"
              disabled={creatingBranch || !newBranch.trim() || !canChangeBranch}
              onClick={() => void createBranch()}
            >
              <Plus size={15} />
            </button>
          </div>
        </fieldset>

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
            disabled={submitting || (isCreate && !branchName)}
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

function selectedModel(
  provider: AgentProvider,
  codexModelValue: CodexModel,
  claudeModel: string,
): string | null {
  return provider === "codex" ? codexModelValue : claudeModel.trim() || null;
}

function mergeBranchOptions(
  primary: BranchOption[],
  extra: BranchOption[],
): BranchOption[] {
  const byBranch = new Map<string, BranchOption>();
  for (const option of [...primary, ...extra]) {
    const current = byBranch.get(option.branch);
    if (!current || shouldPreferBranchOption(option, current)) {
      byBranch.set(option.branch, option);
    }
  }
  return [...byBranch.values()];
}

function shouldPreferBranchOption(
  candidate: BranchOption,
  current: BranchOption,
): boolean {
  if (candidate.hasWorkspace !== current.hasWorkspace) return candidate.hasWorkspace;
  if (!!candidate.branchWorkspaceId !== !!current.branchWorkspaceId) {
    return !!candidate.branchWorkspaceId;
  }
  return false;
}
