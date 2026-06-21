import { useCallback, useEffect, useState } from "react";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
} from "@xyflow/react";
import {
  FilePlus2,
  FolderOpen,
  GitPullRequest,
  Link,
  MessageSquarePlus,
  Plus,
  Settings,
  X,
} from "lucide-react";
import { api } from "./api.js";
import type {
  AgentCanvasSettings,
  BranchOption,
  BranchWorkspace,
  CanvasProjectSummary,
  CanvasFileConnection,
  CanvasFileNode,
  CanvasPromptConnection,
  CanvasPromptNode,
  WorkspaceProject,
} from "@agent-canvas/shared";
import "@xyflow/react/dist/style.css";
import { useAgentCanvas, type AgentActions, type FileActions } from "./useAgentCanvas.js";
import { TurnNode, type TurnNodeType } from "./nodes/TurnNode.js";
import type { AgentMap } from "./agentStore.js";
import {
  ConversationHistoryWindow,
  type HistoryTarget,
} from "./history/ConversationHistoryWindow.js";
import { CreateFileDialog } from "./files/CreateFileDialog.js";
import { FileNode, type FileNodeType } from "./files/FileNode.js";
import { FileContentWindow } from "./files/FileContentWindow.js";
import { AgentSettingsDialog } from "./agents/AgentSettingsDialog.js";
import { CreatePromptDialog } from "./prompts/CreatePromptDialog.js";
import { PromptNode, type PromptNodeType } from "./prompts/PromptNode.js";
import { PullRequestDialog } from "./pullRequests/PullRequestDialog.js";
import type { PromptActions } from "./useAgentCanvas.js";

const nodeTypes = { turn: TurnNode, file: FileNode, prompt: PromptNode };

const COL_W = 430;
const ROW_H = 360;
const FILE_ROW_H = 280;
const DEFAULT_NODE_WIDTH = 360;
const DEFAULT_NODE_HEIGHT = 300;
const FILE_NODE_WIDTH = 280;
const FILE_NODE_HEIGHT = 240;
const PROMPT_NODE_WIDTH = 300;
const PROMPT_NODE_HEIGHT = 260;
const X0 = 40;
const Y0 = 40;

type CanvasNode = TurnNodeType | FileNodeType | PromptNodeType;
type AgentSettingsTarget =
  | { mode: "create" }
  | { mode: "edit"; agentId: string };

function nodeId(agentId: string, turnIndex: number): string {
  return `${agentId}#${turnIndex}`;
}

function fileNodeId(fileId: string): string {
  return `file:${fileId}`;
}

function promptNodeId(promptId: string): string {
  return `prompt:${promptId}`;
}

function anchorIndex(agents: AgentMap, parentId: string, anchorUuid: string): number {
  const parent = agents[parentId];
  if (!parent) return -1;
  return parent.turns.findIndex((turn) => turn.anchorUuid === anchorUuid);
}

function computeLayout(agents: AgentMap): Record<string, { x: number; y: number }> {
  const positions: Record<string, { x: number; y: number }> = {};
  const baseY: Record<string, number> = {};
  let column = 0;
  for (const view of Object.values(agents)) {
    const currentColumn = column++;
    let y = 0;
    if (view.forkOrigin) {
      const parentBase = baseY[view.forkOrigin.parentAgentId] ?? 0;
      const index = anchorIndex(
        agents,
        view.forkOrigin.parentAgentId,
        view.forkOrigin.anchorUuid,
      );
      y = parentBase + (index >= 0 ? index : 0) * ROW_H;
    }
    baseY[view.id] = y;
    view.turns.forEach((_, index) => {
      positions[nodeId(view.id, index)] = {
        x: X0 + currentColumn * COL_W,
        y: Y0 + y + index * ROW_H,
      };
    });
  }
  return positions;
}

function computeConversationEdges(agents: AgentMap): Edge[] {
  const edges: Edge[] = [];
  for (const view of Object.values(agents)) {
    for (let index = 1; index < view.turns.length; index++) {
      edges.push({
        id: `${view.id}#${index - 1}->${index}`,
        source: nodeId(view.id, index - 1),
        target: nodeId(view.id, index),
        deletable: false,
      });
    }
    if (view.forkOrigin) {
      const index = anchorIndex(
        agents,
        view.forkOrigin.parentAgentId,
        view.forkOrigin.anchorUuid,
      );
      if (index >= 0) {
        edges.push({
          id: `fork->${view.id}`,
          source: nodeId(view.forkOrigin.parentAgentId, index),
          sourceHandle: "fork",
          target: nodeId(view.id, 0),
          animated: true,
          label: "fork",
          style: { stroke: "#7c3aed" },
          deletable: false,
        });
      }
    }
  }
  return edges;
}

export function computeFileEdges(
  agents: AgentMap,
  connections: CanvasFileConnection[],
): Edge[] {
  const edges: Edge[] = [];
  for (const connection of connections) {
    const agent = agents[connection.agentId];
    if (!agent || ["done", "stopped", "terminated", "error"].includes(agent.status)) continue;
    const activeTurnId = nodeId(agent.id, agent.turns.length - 1);
    if (connection.access === "read") {
      edges.push({
        id: connection.id,
        source: fileNodeId(connection.fileId),
        sourceHandle: "read",
        target: activeTurnId,
        targetHandle: "resource-read",
        animated: true,
        style: { stroke: "#0f766e" },
      });
      continue;
    }
    edges.push({
      id: connection.id,
      source: activeTurnId,
      sourceHandle: "resource-write",
      target: fileNodeId(connection.fileId),
      targetHandle: "write",
      animated: true,
      style: { stroke: "#b45309" },
    });
  }
  return edges;
}

export function computePromptEdges(
  agents: AgentMap,
  connections: CanvasPromptConnection[],
): Edge[] {
  const edges: Edge[] = [];
  for (const connection of connections) {
    const agent = agents[connection.agentId];
    if (!agent || ["done", "stopped", "terminated", "error"].includes(agent.status)) continue;
    const activeTurnId = nodeId(agent.id, agent.turns.length - 1);
    if (connection.access === "read") {
      edges.push({
        id: connection.id,
        source: promptNodeId(connection.promptId),
        sourceHandle: "read",
        target: activeTurnId,
        targetHandle: "resource-read",
        animated: true,
        style: { stroke: "#7c3aed" },
      });
      continue;
    }
    edges.push({
      id: connection.id,
      source: activeTurnId,
      sourceHandle: "resource-write",
      target: promptNodeId(connection.promptId),
      targetHandle: "write",
      animated: true,
      style: { stroke: "#a21caf" },
    });
  }
  return edges;
}

function buildNodes(
  agents: AgentMap,
  files: CanvasFileNode[],
  prompts: CanvasPromptNode[],
  actions: AgentActions,
  fileActions: FileActions,
  promptActions: PromptActions,
  current: CanvasNode[],
  onOpenHistory: (agentId: string, turnIndex: number) => void,
  onOpenAgentSettings: (agentId: string) => void,
  onPreviewFile: (fileId: string) => void,
  onOpenFileEditor: (fileId: string) => void,
): CanvasNode[] {
  const layout = computeLayout(agents);
  const byId = new Map(current.map((node) => [node.id, node]));
  const result: CanvasNode[] = [];
  for (const view of Object.values(agents)) {
    view.turns.forEach((turn, index) => {
      const id = nodeId(view.id, index);
      const existing = byId.get(id);
      const existingTurn = existing?.type === "turn" ? existing : undefined;
      const data = {
        agentId: view.id,
        turn,
        agentStatus: view.status,
        provider: view.provider,
        model: view.model,
        providerLocked: !!view.forkOrigin,
        isLatest: index === view.turns.length - 1,
        windowState: existingTurn?.data.windowState,
        onOpenHistory,
        onOpenSettings: index === view.turns.length - 1 ? onOpenAgentSettings : undefined,
        actions,
      };
      if (existingTurn) {
        result.push({ ...existingTurn, data });
      } else {
        result.push({
          id,
          type: "turn",
          position: layout[id] ?? { x: X0, y: Y0 },
          width: DEFAULT_NODE_WIDTH,
          height: DEFAULT_NODE_HEIGHT,
          dragHandle: ".drag-handle",
          data,
        });
      }
    });
  }

  const fileX = X0 + Math.max(Object.keys(agents).length, 1) * COL_W;
  files.forEach((file, index) => {
    const id = fileNodeId(file.id);
    const existing = byId.get(id);
    const existingFile = existing?.type === "file" ? existing : undefined;
    const data = {
      file,
      actions: fileActions,
      onPreview: onPreviewFile,
      onOpenEditor: onOpenFileEditor,
      windowState: existingFile?.data.windowState,
    };
    result.push(
      existingFile
        ? { ...existingFile, data }
        : {
            id,
            type: "file",
            position: { x: fileX, y: Y0 + index * FILE_ROW_H },
            width: FILE_NODE_WIDTH,
            height: FILE_NODE_HEIGHT,
            dragHandle: ".drag-handle",
            data,
          },
    );
  });

  const promptX = fileX + 340;
  prompts.forEach((prompt, index) => {
    const id = promptNodeId(prompt.id);
    const existing = byId.get(id);
    const existingPrompt = existing?.type === "prompt" ? existing : undefined;
    const data = {
      prompt,
      actions: promptActions,
      windowState: existingPrompt?.data.windowState,
    };
    result.push(
      existingPrompt
        ? { ...existingPrompt, data }
        : {
            id,
            type: "prompt",
            position: { x: promptX, y: Y0 + index * FILE_ROW_H },
            width: PROMPT_NODE_WIDTH,
            height: PROMPT_NODE_HEIGHT,
            dragHandle: ".drag-handle",
            data,
          },
    );
  });
  return result;
}

export default function App(): React.ReactElement {
  const {
    agents,
    files,
    fileConnections,
    prompts,
    promptConnections,
    prFlows,
    connected,
    actions,
    fileActions,
    promptActions,
    prActions,
  } = useAgentCanvas();
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [historyTarget, setHistoryTarget] = useState<HistoryTarget>();
  const [openFileId, setOpenFileId] = useState<string>();
  const [fileOpenError, setFileOpenError] = useState<string>();
  const [creatingFile, setCreatingFile] = useState(false);
  const [creatingPrompt, setCreatingPrompt] = useState(false);
  const [showingPullRequests, setShowingPullRequests] = useState(false);
  const [showingSettings, setShowingSettings] = useState(false);
  const [appSettings, setAppSettings] = useState<AgentCanvasSettings>({
    fullPermissionMode: false,
  });
  const [agentSettingsTarget, setAgentSettingsTarget] = useState<AgentSettingsTarget>();
  const [projects, setProjects] = useState<CanvasProjectSummary[]>([]);
  const [workspace, setWorkspace] = useState<WorkspaceProject>();
  const [projectError, setProjectError] = useState<string>();
  const [branches, setBranches] = useState<BranchOption[]>([]);
  const openFile = files.find((file) => file.id === openFileId);
  const settingsAgent =
    agentSettingsTarget?.mode === "edit" ? agents[agentSettingsTarget.agentId] : undefined;

  useEffect(() => {
    let cancelled = false;
    void api.listCanvasProjects().then(
      (nextProjects) => {
        if (!cancelled) setProjects(nextProjects);
      },
      (error) => {
        if (!cancelled) setProjectError(error instanceof Error ? error.message : String(error));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void api.settings().then(
      (settings) => {
        if (!cancelled) setAppSettings(settings);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const updateAppSettings = useCallback(async (settings: Partial<AgentCanvasSettings>) => {
    const updated = await api.updateSettings(settings);
    setAppSettings(updated);
  }, []);

  const refreshBranchOptions = useCallback(async () => {
    const nextBranches = await api.listBranchOptions();
    setBranches(nextBranches);
    return nextBranches;
  }, []);

  const openProject = useCallback(
    async (id: string) => {
      setProjectError(undefined);
      try {
        const nextWorkspace = await api.openCanvasProject(id);
        setWorkspace(nextWorkspace);
        setProjects(await api.listCanvasProjects());
        setBranches(nextWorkspace.repo ? await api.listBranchOptions() : []);
      } catch (error) {
        setProjectError(error instanceof Error ? error.message : String(error));
      }
    },
    [],
  );

  const createProject = useCallback(async (name: string) => {
    setProjectError(undefined);
    try {
      const { workspace: nextWorkspace } = await api.createCanvasProject({ name });
      setWorkspace(nextWorkspace);
      setProjects(await api.listCanvasProjects());
      setBranches([]);
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const connectRepo = useCallback(
    async (input: { remoteUrl: string; defaultBranch?: string }) => {
      setProjectError(undefined);
      try {
        const nextWorkspace = await api.connectWorkspace(input);
        setWorkspace(nextWorkspace);
        await refreshBranchOptions();
      } catch (error) {
        setProjectError(error instanceof Error ? error.message : String(error));
      }
    },
    [refreshBranchOptions],
  );

  const openFileEditor = useCallback((fileId: string) => {
    setFileOpenError(undefined);
    void api.openFileInVscode(fileId).catch((error: unknown) => {
      setFileOpenError(error instanceof Error ? error.message : String(error));
    });
  }, []);

  const openHistory = useCallback(
    (agentId: string, turnIndex: number) => {
      setHistoryTarget({
        agentId,
        turnIndex,
        lastSeq: agents[agentId]?.lastSeq ?? 0,
      });
    },
    [agents],
  );

  const openAgentSettings = useCallback((agentId: string) => {
    setAgentSettingsTarget({ mode: "edit", agentId });
  }, []);

  const createBranch = useCallback(async (branch: string) => {
    const created = await api.createBranch({ branch });
    await refreshBranchOptions();
    return created;
  }, [refreshBranchOptions]);

  useEffect(() => {
    setNodes((current) =>
      buildNodes(
        agents,
        files,
        prompts,
        actions,
        fileActions,
        promptActions,
        current,
        openHistory,
        openAgentSettings,
        setOpenFileId,
        openFileEditor,
      ),
    );
    setEdges([
      ...computeConversationEdges(agents),
      ...computeFileEdges(agents, fileConnections),
      ...computePromptEdges(agents, promptConnections),
    ]);
  }, [
    agents,
    files,
    fileConnections,
    prompts,
    promptConnections,
    actions,
    fileActions,
    promptActions,
    openHistory,
    openAgentSettings,
    openFileEditor,
    setNodes,
    setEdges,
  ]);

  const connect = useCallback(
    async (connection: Connection) => {
      if (
        connection.source.startsWith("file:") &&
        connection.sourceHandle === "read" &&
        connection.targetHandle === "resource-read"
      ) {
        await fileActions.connect(
          connection.source.slice("file:".length),
          connection.target.split("#")[0]!,
          "read",
        );
        return;
      }
      if (
        connection.target.startsWith("file:") &&
        connection.sourceHandle === "resource-write" &&
        connection.targetHandle === "write"
      ) {
        await fileActions.connect(
          connection.target.slice("file:".length),
          connection.source.split("#")[0]!,
          "write",
        );
        return;
      }
      if (
        connection.source.startsWith("prompt:") &&
        connection.sourceHandle === "read" &&
        connection.targetHandle === "resource-read"
      ) {
        await promptActions.connect(
          connection.source.slice("prompt:".length),
          connection.target.split("#")[0]!,
          "read",
        );
        return;
      }
      if (
        connection.target.startsWith("prompt:") &&
        connection.sourceHandle === "resource-write" &&
        connection.targetHandle === "write"
      ) {
        await promptActions.connect(
          connection.target.slice("prompt:".length),
          connection.source.split("#")[0]!,
          "write",
        );
      }
    },
    [fileActions, promptActions],
  );

  if (!workspace) {
    return (
      <ProjectGate
        connected={connected}
        projects={projects}
        error={projectError}
        onOpen={openProject}
        onCreate={createProject}
      />
    );
  }

  if (!workspace.repo) {
    return (
      <RepoConnectGate
        connected={connected}
        project={workspace.canvasProject}
        projectRoot={workspace.projectRoot}
        error={projectError}
        onConnect={connectRepo}
      />
    );
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <strong>agent_canvas</strong>
        <span className={connected ? "connection-state is-connected" : "connection-state"}>
          {connected ? "● 已连接后端" : "● 未连接"}
        </span>
        <span className="app-header__hint">
          {workspace.canvasProject?.name ?? "未命名项目"} · {workspace.repo.remoteUrl}
        </span>
        <button
          className="header-button header-button--secondary"
          onClick={() => setShowingPullRequests(true)}
        >
          <GitPullRequest size={15} />
          PR
        </button>
        <button
          className="header-button header-button--secondary"
          onClick={() => setShowingSettings(true)}
        >
          <Settings size={15} />
          设置
        </button>
        <button
          className="header-button header-button--secondary"
          onClick={() => setCreatingPrompt(true)}
        >
          <MessageSquarePlus size={15} />
          新建提示词
        </button>
        <button className="header-button header-button--secondary" onClick={() => setCreatingFile(true)}>
          <FilePlus2 size={15} />
          新建文件
        </button>
        <button className="header-button" onClick={() => setAgentSettingsTarget({ mode: "create" })}>
          新建 Agent
        </button>
      </header>

      <div className="canvas-wrap">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={(connection) => void connect(connection)}
          onEdgesDelete={(deleted) => {
            for (const edge of deleted) {
              if (edge.id.startsWith("file_connection_")) {
                void fileActions.disconnect(edge.id);
              } else if (edge.id.startsWith("prompt_connection_")) {
                void promptActions.disconnect(edge.id);
              }
            }
          }}
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <MiniMap pannable zoomable />
          <Controls />
        </ReactFlow>
      </div>

      {creatingFile && (
        <CreateFileDialog
          onCreate={async (input) => {
            await fileActions.create(input);
          }}
          onClose={() => setCreatingFile(false)}
        />
      )}
      {agentSettingsTarget?.mode === "create" && (
        <AgentSettingsDialog
          mode="create"
          branches={branches}
          onCreateBranch={createBranch}
          onCreate={async (settings) => {
            await actions.create(settings);
            await refreshBranchOptions();
          }}
          onClose={() => setAgentSettingsTarget(undefined)}
        />
      )}
      {agentSettingsTarget?.mode === "edit" && settingsAgent && (
        <AgentSettingsDialog
          mode="edit"
          agent={settingsAgent}
          branches={branches}
          canChangeBranch={
            settingsAgent.status === "idle" || settingsAgent.status === "waiting_input"
          }
          onCreateBranch={createBranch}
          onUpdate={actions.updateSettings}
          onClose={() => setAgentSettingsTarget(undefined)}
        />
      )}
      {creatingPrompt && (
        <CreatePromptDialog
          onCreate={async (input) => {
            await promptActions.create(input);
          }}
          onClose={() => setCreatingPrompt(false)}
        />
      )}
      {showingPullRequests && (
        <PullRequestDialog
          agents={agents}
          branches={branches}
          flows={prFlows}
          actions={prActions}
          onClose={() => setShowingPullRequests(false)}
        />
      )}
      {showingSettings && (
        <AppSettingsDialog
          settings={appSettings}
          onUpdate={updateAppSettings}
          onClose={() => setShowingSettings(false)}
        />
      )}
      {historyTarget && (
        <ConversationHistoryWindow
          target={{
            ...historyTarget,
            lastSeq: agents[historyTarget.agentId]?.lastSeq ?? historyTarget.lastSeq,
          }}
          onClose={() => setHistoryTarget(undefined)}
        />
      )}
      {openFile && (
        <FileContentWindow
          file={openFile}
          onClose={() => setOpenFileId(undefined)}
          onOpenEditor={openFileEditor}
        />
      )}
      {fileOpenError && (
        <div className="file-open-error" role="alert">
          <span>{fileOpenError}</span>
          <button className="icon-button" title="关闭错误提示" onClick={() => setFileOpenError(undefined)}>
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}

function ProjectGate({
  connected,
  projects,
  error,
  onOpen,
  onCreate,
}: {
  connected: boolean;
  projects: CanvasProjectSummary[];
  error?: string;
  onOpen: (id: string) => Promise<void>;
  onCreate: (name: string) => Promise<void>;
}): React.ReactElement {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      await onCreate(trimmed);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="project-gate">
      <header className="project-gate__header">
        <strong>agent_canvas</strong>
        <span className={connected ? "connection-state is-connected" : "connection-state"}>
          {connected ? "● 已连接后端" : "● 未连接"}
        </span>
      </header>
      <main className="project-gate__panel">
        <section className="project-gate__section">
          <h1>打开 Canvas 项目</h1>
          <div className="project-list">
            {projects.map((project) => (
              <button
                key={project.id}
                className="project-row"
                onClick={() => void onOpen(project.id)}
              >
                <FolderOpen size={18} />
                <span>
                  <strong>{project.name}</strong>
                  <small>{project.projectRoot}</small>
                </span>
              </button>
            ))}
            {projects.length === 0 && <p className="project-empty">暂无项目</p>}
          </div>
        </section>
        <section className="project-gate__section">
          <h2>新建 Canvas 项目</h2>
          <div className="project-create">
            <input
              aria-label="Canvas 项目名称"
              value={name}
              placeholder="项目名称"
              onChange={(event) => setName(event.target.value)}
            />
            <button disabled={busy || !name.trim()} onClick={() => void create()}>
              <Plus size={16} />
              新建
            </button>
          </div>
        </section>
        {error && <div className="file-dialog__error">{error}</div>}
      </main>
    </div>
  );
}

function RepoConnectGate({
  connected,
  project,
  projectRoot,
  error,
  onConnect,
}: {
  connected: boolean;
  project?: CanvasProjectSummary;
  projectRoot: string;
  error?: string;
  onConnect: (input: { remoteUrl: string; defaultBranch?: string }) => Promise<void>;
}): React.ReactElement {
  const [remoteUrl, setRemoteUrl] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("main");
  const [busy, setBusy] = useState(false);
  const connect = async () => {
    const trimmed = remoteUrl.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      await onConnect({
        remoteUrl: trimmed,
        defaultBranch: defaultBranch.trim() || undefined,
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="project-gate">
      <header className="project-gate__header">
        <strong>agent_canvas</strong>
        <span className={connected ? "connection-state is-connected" : "connection-state"}>
          {connected ? "● 已连接后端" : "● 未连接"}
        </span>
      </header>
      <main className="project-gate__panel project-gate__panel--narrow">
        <section className="project-gate__section">
          <h1>{project?.name ?? "Canvas 项目"}</h1>
          <p className="project-path">{projectRoot}</p>
        </section>
        <section className="project-gate__section">
          <h2>连接 GitHub Repo</h2>
          <label className="file-dialog__field">
            <span>Repo URL</span>
            <input
              aria-label="GitHub repo URL"
              value={remoteUrl}
              placeholder="git@github.com:OWNER/REPO.git"
              onChange={(event) => setRemoteUrl(event.target.value)}
            />
          </label>
          <label className="file-dialog__field">
            <span>默认 branch</span>
            <input
              aria-label="默认 branch"
              value={defaultBranch}
              onChange={(event) => setDefaultBranch(event.target.value)}
            />
          </label>
          <button
            className="project-connect-button"
            disabled={busy || !remoteUrl.trim()}
            onClick={() => void connect()}
          >
            <Link size={16} />
            连接
          </button>
        </section>
        {error && <div className="file-dialog__error">{error}</div>}
      </main>
    </div>
  );
}

function AppSettingsDialog({
  settings,
  onUpdate,
  onClose,
}: {
  settings: AgentCanvasSettings;
  onUpdate: (settings: Partial<AgentCanvasSettings>) => Promise<void>;
  onClose: () => void;
}): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const toggleFullPermission = async (fullPermissionMode: boolean) => {
    setBusy(true);
    try {
      await onUpdate({ fullPermissionMode });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="file-dialog-backdrop" onMouseDown={onClose}>
      <section
        className="file-dialog file-dialog--narrow"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="file-dialog__header">
          <h2>设置</h2>
          <button className="icon-button" title="关闭设置" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={settings.fullPermissionMode}
            disabled={busy}
            onChange={(event) => void toggleFullPermission(event.target.checked)}
          />
          <span>
            <strong>完全权限模式</strong>
            <small>开启后所有授权请求由后端直接允许，不再等待前端审批。</small>
          </span>
        </label>
      </section>
    </div>
  );
}
