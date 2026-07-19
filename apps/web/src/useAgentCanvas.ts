/**
 * 把 WebSocket 事件流 + REST 命令收敛成一个 React hook。
 *  - 订阅 /ws，用 agentStore 的纯函数折叠出 agents 视图表
 *  - 暴露 create/start/stop/send/steer/resume 动作
 *  - 自动断线重连
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentApprovalResponse,
  AgentCommitSnapshot,
  AgentQuestionResponse,
  AgentSettings,
  CanvasFileConnection,
  CanvasFileKind,
  CanvasFileNode,
  CanvasPromptConnection,
  CanvasPromptNode,
  ForkAgentInput,
  CreateCanvasFileInput,
  CreateCanvasPromptInput,
  CreatePullRequestFlowInput,
  CreateSyncFlowInput,
  FileConnectionAccess,
  ImportPickedCanvasFilesInput,
  PickedCanvasFileSelection,
  PullRequestCreatedInput,
  PullRequestFlowSnapshot,
  PromptConnectionAccess,
  ServerFrame,
  SyncFlowAppliedInput,
  SyncFlowSnapshot,
  UpdateCanvasFileInput,
  UpdateCanvasPromptInput,
  UpdateAgentSettingsInput,
  WorkspaceProject,
} from "@agent-canvas/shared";
import { api, type WorkspaceRequestContext } from "./api.js";
import {
  applyEnvelope,
  applyHello,
  emptyMap,
  insertForked,
  newAgentView,
  recordAgentSettings,
  recordCompact,
  recordInput,
  type AgentMap,
} from "./agentStore.js";

export interface AgentActions {
  /** 新建一个 agent（出现一个 idle 起始节点）。 */
  create: (settings: AgentSettings) => Promise<string>;
  /** 更新已创建 agent 的可变设置。 */
  updateSettings: (
    agentId: string,
    settings: UpdateAgentSettingsInput,
  ) => Promise<void>;
  /** 在末尾 idle 轮提交输入：首轮→start，续轮→send（自动判断）。 */
  submit: (agentId: string, text: string) => Promise<void>;
  /** 尽快引导当前正在运行的一轮。 */
  steer: (agentId: string, text: string) => Promise<void>;
  /** 回答底层 agent 发出的交互问题。 */
  answerQuestion: (
    agentId: string,
    requestId: string,
    response: AgentQuestionResponse,
  ) => Promise<void>;
  /** 回答底层 agent 发出的授权审批。 */
  answerApproval: (
    agentId: string,
    requestId: string,
    response: AgentApprovalResponse,
  ) => Promise<void>;
  /** 中止 agent。 */
  stop: (agentId: string) => Promise<void>;
  /** 手动压缩上下文，并把 compact 记为独立一轮。 */
  compact: (agentId: string) => Promise<void>;
  /** 关闭底层 CLI / Query。 */
  terminate: (agentId: string) => Promise<void>;
  /** 用 VS Code 打开该 agent 当前 branch workspace。 */
  openWorkspace: (agentId: string) => Promise<void>;
  /** 从某轮（anchorUuid）fork 出一个新 agent。 */
  fork: (
    agentId: string,
    anchorUuid: string,
    options?: Omit<ForkAgentInput, "anchorUuid">,
  ) => Promise<void>;
}

export interface UseAgentCanvas {
  agents: AgentMap;
  files: CanvasFileNode[];
  fileConnections: CanvasFileConnection[];
  prompts: CanvasPromptNode[];
  promptConnections: CanvasPromptConnection[];
  prFlows: PullRequestFlowSnapshot[];
  syncFlows: SyncFlowSnapshot[];
  commits: AgentCommitSnapshot[];
  /** 首帧、重连或 project/revision 变化；消费者必须替换项目级快照。 */
  workspaceUpdate?: WorkspaceUpdate;
  /** 同一 project/revision 的 branch/shared-resource 等元数据更新。 */
  workspaceMetadataUpdate?: WorkspaceUpdate;
  currentWorkspaceEventGeneration: () => number;
  /** 每个已接受 workspace 帧递增，用于丢弃早于最新快照的异步结果。 */
  currentWorkspaceSnapshotGeneration: () => number;
  /** WebSocket 回调中同步保存的最新已接受 workspace 快照。 */
  currentWorkspaceSnapshot: () => WorkspaceProject | undefined;
  currentWorkspaceEventIdentity: () => string | undefined;
  invalidateWorkspaceRefresh: () => void;
  connected: boolean;
  refresh: () => Promise<void>;
  actions: AgentActions;
  fileActions: FileActions;
  promptActions: PromptActions;
  prActions: PullRequestActions;
  syncActions: SyncFlowActions;
}

export type WorkspaceUpdate = Omit<Extract<ServerFrame, { type: "workspace" }>, "type">;

export function workspaceEventIdentity(workspace?: WorkspaceProject): string {
  const revision = workspace?.revision;
  const revisionSuffix = Number.isSafeInteger(revision) ? `@${revision}` : "";
  const projectId = workspace?.canvasProject?.id?.trim();
  if (projectId) return `project:${projectId}${revisionSuffix}`;
  const projectRoot = workspace?.projectRoot?.trim();
  return projectRoot ? `root:${projectRoot}${revisionSuffix}` : `workspace:none${revisionSuffix}`;
}

export interface FileActions {
  create: (input: CreateCanvasFileInput) => Promise<CanvasFileNode>;
  pick: () => Promise<PickedCanvasFileSelection | null>;
  releasePickedSelection: (selectionId: string) => Promise<void>;
  importPicked: (input: ImportPickedCanvasFilesInput) => Promise<CanvasFileNode[]>;
  importDropped: (
    files: File[],
    kind: CanvasFileKind,
    onImported?: (file: CanvasFileNode, sourceIndex: number) => void,
  ) => Promise<DroppedFileImportResult>;
  relink: (id: string) => Promise<CanvasFileNode | null>;
  refresh: (id: string) => Promise<CanvasFileNode | null>;
  update: (id: string, input: UpdateCanvasFileInput) => Promise<void>;
  connect: (
    fileId: string,
    agentId: string,
    access: FileConnectionAccess,
  ) => Promise<void>;
  disconnect: (connectionId: string) => Promise<void>;
}

export interface DroppedFileImportFailure {
  file: File;
  reason: string;
}

export interface DroppedFileImportResult {
  imported: CanvasFileNode[];
  failures: DroppedFileImportFailure[];
}

export interface PromptActions {
  create: (input: CreateCanvasPromptInput) => Promise<CanvasPromptNode>;
  update: (id: string, input: UpdateCanvasPromptInput) => Promise<void>;
  connect: (
    promptId: string,
    agentId: string,
    access: PromptConnectionAccess,
  ) => Promise<void>;
  disconnect: (connectionId: string) => Promise<void>;
}

export interface PullRequestActions {
  create: (input: CreatePullRequestFlowInput) => Promise<void>;
  recordCreated: (id: string, input: PullRequestCreatedInput) => Promise<void>;
  recordMerged: (id: string) => Promise<void>;
  retry: (id: string) => Promise<void>;
  cancel: (id: string) => Promise<void>;
}

export interface SyncFlowActions {
  create: (input: CreateSyncFlowInput) => Promise<void>;
  recordApplied: (id: string, input: SyncFlowAppliedInput) => Promise<void>;
  cancel: (id: string) => Promise<void>;
}

function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}

export function useAgentCanvas(): UseAgentCanvas {
  const [agents, setAgents] = useState<AgentMap>(emptyMap);
  const [files, setFiles] = useState<CanvasFileNode[]>([]);
  const [fileConnections, setFileConnections] = useState<CanvasFileConnection[]>([]);
  const [prompts, setPrompts] = useState<CanvasPromptNode[]>([]);
  const [promptConnections, setPromptConnections] = useState<CanvasPromptConnection[]>([]);
  const [prFlows, setPrFlows] = useState<PullRequestFlowSnapshot[]>([]);
  const [syncFlows, setSyncFlows] = useState<SyncFlowSnapshot[]>([]);
  const [commits, setCommits] = useState<AgentCommitSnapshot[]>([]);
  const [workspaceUpdate, setWorkspaceUpdate] = useState<WorkspaceUpdate>();
  const [workspaceMetadataUpdate, setWorkspaceMetadataUpdate] = useState<WorkspaceUpdate>();
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const refreshGenerationRef = useRef(0);
  const workspaceEventGenerationRef = useRef(0);
  const workspaceSnapshotGenerationRef = useRef(0);
  const workspaceSnapshotRef = useRef<WorkspaceProject>();
  const workspaceEventIdentityRef = useRef<string>();
  const workspaceProjectRootRef = useRef<string>();
  const latestWorkspaceVersionRef = useRef<{ projectId: string; revision: number }>();
  const pickedSelectionContextsRef = useRef(
    new Map<string, WorkspaceRequestContext>(),
  );
  const currentWorkspaceEventGeneration = useCallback(
    () => workspaceEventGenerationRef.current,
    [],
  );
  const currentWorkspaceSnapshotGeneration = useCallback(
    () => workspaceSnapshotGenerationRef.current,
    [],
  );
  const currentWorkspaceSnapshot = useCallback(() => workspaceSnapshotRef.current, []);
  const currentWorkspaceEventIdentity = useCallback(
    () => workspaceEventIdentityRef.current,
    [],
  );
  const invalidateWorkspaceRefresh = useCallback(() => {
    refreshGenerationRef.current += 1;
  }, []);
  const clearProjectScopedState = useCallback(() => {
    setAgents(emptyMap);
    setFiles([]);
    setFileConnections([]);
    setPrompts([]);
    setPromptConnections([]);
    setPrFlows([]);
    setSyncFlows([]);
    setCommits([]);
  }, []);
  // 始终指向最新 agents，供 submit 判断 start/send（避免闭包过期）
  const agentsRef = useRef(agents);
  agentsRef.current = agents;

  const refresh = useCallback(async () => {
    const generation = ++refreshGenerationRef.current;
    const [
      nextAgents,
      nextFiles,
      nextConnections,
      nextPrompts,
      nextPromptConnections,
      nextPrFlows,
      nextSyncFlows,
      nextCommits,
    ] = await Promise.all([
      api.list(),
      api.listFiles(),
      api.listFileConnections(),
      api.listPrompts(),
      api.listPromptConnections(),
      api.listPullRequestFlows(),
      api.listSyncFlows(),
      api.listCommits(),
    ]);
    const historyEntries = await Promise.all(
      nextAgents.map(async (agent) => [agent.id, await api.history(agent.id)] as const),
    );
    if (generation !== refreshGenerationRef.current) return;
    setAgents(applyHello(nextAgents, Object.fromEntries(historyEntries)));
    setFiles(nextFiles);
    setFileConnections(nextConnections);
    setPrompts(nextPrompts);
    setPromptConnections(nextPromptConnections);
    setPrFlows(nextPrFlows);
    setSyncFlows(nextSyncFlows);
    setCommits(nextCommits);
  }, []);

  useEffect(() => {
    let closed = false;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    let promptTimer: number | undefined;

    const connect = () => {
      // A reconnecting server sends hello before its asynchronous workspace frame. Clear the
      // previous epoch now so that hello can never combine the current project's agents and
      // flows with files, prompts, or connections cached from the project seen before disconnect.
      api.setWorkspaceContext(undefined);
      refreshGenerationRef.current += 1;
      latestWorkspaceVersionRef.current = undefined;
      workspaceProjectRootRef.current = undefined;
      setWorkspaceMetadataUpdate(undefined);
      clearProjectScopedState();
      const ws = new WebSocket(wsUrl());
      wsRef.current = ws;
      let acceptedWorkspaceInEpoch = false;
      const isCurrentSocket = () => !closed && wsRef.current === ws;
      ws.onopen = () => {
        if (!isCurrentSocket()) return;
        setConnected(true);
      };
      ws.onclose = () => {
        if (!isCurrentSocket()) return;
        wsRef.current = null;
        workspaceSnapshotRef.current = undefined;
        workspaceSnapshotGenerationRef.current += 1;
        api.setWorkspaceContext(undefined);
        setConnected(false);
        scheduleConnect(1000);
      };
      ws.onerror = () => {
        if (!isCurrentSocket()) return;
        ws.close();
      };
      ws.onmessage = (ev) => {
        if (!isCurrentSocket()) return;
        let frame: ServerFrame;
        try {
          frame = JSON.parse(ev.data as string);
        } catch {
          return;
        }
        if (frame.type === "hello") {
          setAgents(applyHello(frame.agents, frame.histories));
          setPrFlows(frame.prFlows ?? []);
          setSyncFlows(frame.syncFlows ?? []);
          setCommits(frame.commits ?? []);
        } else if (frame.type === "event") {
          setAgents((prev) => applyEnvelope(prev, frame.envelope));
        } else if (frame.type === "pr_flow") {
          setPrFlows((prev) => upsertFlow(prev, frame.flow));
        } else if (frame.type === "sync_flow") {
          setSyncFlows((prev) => upsertSyncFlow(prev, frame.flow));
        } else if (frame.type === "commit") {
          setCommits((prev) => upsertCommit(prev, frame.commit));
        } else if (frame.type === "file") {
          setFiles((prev) => upsertFile(prev, frame.file));
        } else if (frame.type === "workspace") {
          const projectId = frame.workspace?.canvasProject?.id;
          const revision = frame.workspace?.revision;
          const latestVersion = latestWorkspaceVersionRef.current;
          if (
            projectId &&
            Number.isSafeInteger(revision) &&
            latestVersion?.projectId === projectId &&
            revision! < latestVersion.revision
          ) {
            return;
          }
          // This ref advances synchronously in the socket callback, before React effects run.
          // Consumers can therefore reject an older REST response even in the narrow window
          // between accepting newer workspace metadata and committing it to component state.
          workspaceSnapshotRef.current = frame.workspace;
          workspaceSnapshotGenerationRef.current += 1;
          if (projectId && Number.isSafeInteger(revision)) {
            latestWorkspaceVersionRef.current = { projectId, revision: revision! };
          }
          const nextUpdate: WorkspaceUpdate = {
            workspace: frame.workspace,
            partialSuccess: frame.partialSuccess,
            workDocumentation: frame.workDocumentation,
          };
          const nextIdentity = workspaceEventIdentity(frame.workspace);
          const nextProjectRoot = frame.workspace?.projectRoot?.trim();
          const isMetadataUpdate =
            acceptedWorkspaceInEpoch &&
            !!projectId &&
            !!nextProjectRoot &&
            Number.isSafeInteger(revision) &&
            latestVersion?.projectId === projectId &&
            latestVersion.revision === revision &&
            workspaceProjectRootRef.current === nextProjectRoot &&
            workspaceEventIdentityRef.current === nextIdentity;
          api.setWorkspaceContext(frame.workspace);
          workspaceEventIdentityRef.current = nextIdentity;
          workspaceProjectRootRef.current = nextProjectRoot;
          if (isMetadataUpdate) {
            // Branch/shared-resource mutations broadcast an updated workspace snapshot without
            // changing project identity. Publish that metadata independently so it cannot cancel
            // an in-flight project replacement refresh or blank the existing graph.
            setWorkspaceMetadataUpdate(nextUpdate);
          } else {
            // Invalidate an old project's in-flight refresh before React schedules the App effect
            // that starts the authoritative project's replacement refresh.
            refreshGenerationRef.current += 1;
            workspaceEventGenerationRef.current += 1;
            // The epoch was already cleared before its hello frame. A later identity change is a
            // real project replacement and must discard the prior project-scoped snapshot.
            if (acceptedWorkspaceInEpoch) clearProjectScopedState();
            setWorkspaceMetadataUpdate(undefined);
            setWorkspaceUpdate(nextUpdate);
          }
          acceptedWorkspaceInEpoch = true;
        }
      };
    };

    const scheduleConnect = (delay: number) => {
      if (closed) return;
      if (connectTimer) clearTimeout(connectTimer);
      connectTimer = setTimeout(() => {
        connectTimer = undefined;
        connect();
      }, delay);
    };

    // React StrictMode 会在开发环境执行一次 setup→cleanup→setup。
    // 延迟到下一轮事件循环，避免试探性 setup 建立后立刻中断 WebSocket。
    scheduleConnect(0);
    void refresh().catch(() => undefined);
    const refreshPrompts = () => {
      const workspaceGeneration = workspaceEventGenerationRef.current;
      void api
        .listPrompts()
        .then(
          (nextPrompts) => {
            if (
              !closed &&
              workspaceGeneration === workspaceEventGenerationRef.current
            ) {
              setPrompts(nextPrompts);
            }
          },
          () => undefined,
        )
        .finally(() => {
          if (!closed) promptTimer = window.setTimeout(refreshPrompts, 2000);
        });
    };
    promptTimer = window.setTimeout(refreshPrompts, 2000);
    return () => {
      closed = true;
      api.setWorkspaceContext(undefined);
      latestWorkspaceVersionRef.current = undefined;
      workspaceProjectRootRef.current = undefined;
      if (promptTimer) window.clearTimeout(promptTimer);
      if (connectTimer) clearTimeout(connectTimer);
      const currentSocket = wsRef.current;
      wsRef.current = null;
      currentSocket?.close();
    };
  }, [clearProjectScopedState, refresh]);

  const actions = useMemo<AgentActions>(
    () => ({
      create: async (settings) => {
        const workspaceGeneration = workspaceEventGenerationRef.current;
        const id = await api.create(settings);
        if (workspaceGeneration !== workspaceEventGenerationRef.current) return id;
        // 后端 create 不发事件，乐观插入一个 idle 节点
        setAgents((prev) =>
          prev[id]
            ? prev
            : {
                ...prev,
                [id]: newAgentView(id, {
                  provider: settings.provider,
                  model: settings.model,
                  reasoningEffort: settings.reasoningEffort,
                  branchWorkspaceId: settings.branchWorkspaceId,
                  branch: settings.branch,
                  cwd: settings.cwd,
                  scratchDirectory: settings.scratchDirectory,
                  systemPrompt: settings.systemPrompt,
                }),
              },
        );
        return id;
      },
      updateSettings: async (agentId, settings) => {
        const workspaceGeneration = workspaceEventGenerationRef.current;
        const snapshot = await api.updateAgentSettings(agentId, settings);
        if (workspaceGeneration !== workspaceEventGenerationRef.current) return;
        setAgents((prev) =>
          recordAgentSettings(prev, agentId, {
            provider: snapshot.config.provider,
            model: snapshot.config.model,
            reasoningEffort: snapshot.config.reasoningEffort,
            branchWorkspaceId: snapshot.config.branchWorkspaceId,
            branch: snapshot.config.branch,
            cwd: snapshot.config.cwd,
            scratchDirectory: snapshot.config.scratchDirectory,
            systemPrompt: snapshot.config.systemPrompt,
          }),
        );
      },
      submit: async (agentId, text) => {
        const view = agentsRef.current[agentId];
        const startProvider = view?.provider;
        const startModel = view?.model;
        const startReasoningEffort = view?.reasoningEffort;
        // 首轮（idle）用 start（fork 出来的 agent 由后端合并 fork 配置）；续轮用 send
        if (!view || view.status === "idle") {
          setAgents((prev) => recordInput(prev, agentId, text, startProvider, startModel));
          await api.start(agentId, {
            prompt: text,
            provider: startProvider,
            model: startModel,
            reasoningEffort: startReasoningEffort,
            branchWorkspaceId: view?.branchWorkspaceId,
            branch: view?.branch,
            cwd: view?.cwd,
            scratchDirectory: view?.scratchDirectory,
            systemPrompt: view?.systemPrompt,
          });
        } else if (
          view.status === "waiting_input" ||
          view.status === "stopped" ||
          view.status === "terminated"
        ) {
          setAgents((prev) => recordInput(prev, agentId, text, startProvider, startModel));
          await api.send(agentId, text);
        } else {
          await api.send(agentId, text);
        }
      },
      steer: (agentId, text) => api.steer(agentId, text).then(() => undefined),
      answerQuestion: (agentId, requestId, response) =>
        api.answerQuestion(agentId, requestId, response).then(() => undefined),
      answerApproval: (agentId, requestId, response) =>
        api.answerApproval(agentId, requestId, response).then(() => undefined),
      stop: (agentId) => api.stop(agentId).then(() => undefined),
      compact: async (agentId) => {
        setAgents((prev) => recordCompact(prev, agentId));
        await api.compact(agentId);
      },
      terminate: (agentId) => api.terminate(agentId).then(() => undefined),
      openWorkspace: (agentId) => api.openAgentWorkspace(agentId).then(() => undefined),
      fork: async (agentId, anchorUuid, options = {}) => {
        const workspaceGeneration = workspaceEventGenerationRef.current;
        const { id, origin } = await api.fork(agentId, anchorUuid, options);
        if (workspaceGeneration !== workspaceEventGenerationRef.current) return;
        setAgents((prev) => insertForked(prev, id, origin, options));
        const [nextFileConnections, nextPromptConnections] = await Promise.all([
          api.listFileConnections(),
          api.listPromptConnections(),
        ]);
        if (workspaceGeneration !== workspaceEventGenerationRef.current) return;
        setFileConnections(nextFileConnections);
        setPromptConnections(nextPromptConnections);
      },
    }),
    [],
  );

  const fileActions = useMemo<FileActions>(
    () => ({
      create: async (input) => {
        const workspaceGeneration = workspaceEventGenerationRef.current;
        const file = await api.createFile(input);
        if (workspaceGeneration === workspaceEventGenerationRef.current) {
          setFiles((current) => upsertFile(current, file));
        }
        return file;
      },
      pick: async () => {
        const workspaceGeneration = workspaceEventGenerationRef.current;
        const workspaceContext = api.captureWorkspaceContext();
        if (!workspaceContext) throw new Error("当前项目上下文尚未就绪，请稍后重试");
        const selection = await api.pickFiles(workspaceContext);
        if (!selection) return null;
        if (workspaceGeneration !== workspaceEventGenerationRef.current) {
          await api.releasePickedSelection(selection.id, workspaceContext).catch(() => undefined);
          throw new Error("文件选择期间项目已切换，请在当前项目中重新浏览");
        }
        pickedSelectionContextsRef.current.set(selection.id, workspaceContext);
        return selection;
      },
      releasePickedSelection: async (selectionId) => {
        const workspaceContext = pickedSelectionContextsRef.current.get(selectionId);
        pickedSelectionContextsRef.current.delete(selectionId);
        await api.releasePickedSelection(selectionId, workspaceContext);
      },
      importPicked: async (input) => {
        const workspaceGeneration = workspaceEventGenerationRef.current;
        const workspaceContext =
          pickedSelectionContextsRef.current.get(input.selectionId) ??
          api.captureWorkspaceContext();
        const imported = await api.importPickedFiles(input, workspaceContext);
        pickedSelectionContextsRef.current.delete(input.selectionId);
        if (workspaceGeneration === workspaceEventGenerationRef.current) {
          setFiles((current) => imported.reduce(upsertFile, current));
        }
        return imported;
      },
      importDropped: async (dropped, kind, onImported) => {
        const workspaceGeneration = workspaceEventGenerationRef.current;
        const workspaceContext = api.captureWorkspaceContext();
        const imported: CanvasFileNode[] = [];
        const failures: DroppedFileImportFailure[] = [];
        if (!workspaceContext) {
          return {
            imported,
            failures: dropped.map((file) => ({
              file,
              reason: "当前项目上下文尚未就绪，请稍后重试",
            })),
          };
        }

        for (let index = 0; index < dropped.length; index += 1) {
          const file = dropped[index]!;
          if (workspaceGeneration !== workspaceEventGenerationRef.current) {
            for (const remaining of dropped.slice(index)) {
              failures.push({ file: remaining, reason: "项目已切换，请在当前项目中重新拖入" });
            }
            break;
          }
          try {
            const created = await api.importUploadedFile(file, kind, workspaceContext);
            imported.push(created);
            if (workspaceGeneration === workspaceEventGenerationRef.current) {
              setFiles((current) => upsertFile(current, created));
              onImported?.(created, index);
            }
          } catch (reason) {
            failures.push({
              file,
              reason: reason instanceof Error ? reason.message : String(reason),
            });
          }
        }
        return { imported, failures };
      },
      relink: async (id) => {
        const workspaceGeneration = workspaceEventGenerationRef.current;
        const file = await api.relinkFile(id);
        if (file && workspaceGeneration === workspaceEventGenerationRef.current) {
          setFiles((current) => upsertFile(current, file));
        }
        return file;
      },
      refresh: async (id) => {
        const workspaceGeneration = workspaceEventGenerationRef.current;
        const file = await api.refreshFile(id);
        if (workspaceGeneration === workspaceEventGenerationRef.current) {
          setFiles((current) => upsertFile(current, file));
          return file;
        }
        return null;
      },
      update: async (id, input) => {
        const workspaceGeneration = workspaceEventGenerationRef.current;
        const file = await api.updateFile(id, input);
        if (workspaceGeneration === workspaceEventGenerationRef.current) {
          setFiles((current) => upsertFile(current, file));
        }
      },
      connect: async (fileId, agentId, access) => {
        const workspaceGeneration = workspaceEventGenerationRef.current;
        const connection = await api.connectFile(fileId, agentId, access);
        if (workspaceGeneration !== workspaceEventGenerationRef.current) return;
        setFileConnections((current) =>
          current.some((candidate) => candidate.id === connection.id)
            ? current
            : [...current, connection],
        );
      },
      disconnect: async (connectionId) => {
        const workspaceGeneration = workspaceEventGenerationRef.current;
        await api.disconnectFile(connectionId);
        if (workspaceGeneration !== workspaceEventGenerationRef.current) return;
        setFileConnections((current) =>
          current.filter((connection) => connection.id !== connectionId),
        );
      },
    }),
    [],
  );

  const promptActions = useMemo<PromptActions>(
    () => ({
      create: async (input) => {
        const workspaceGeneration = workspaceEventGenerationRef.current;
        const prompt = await api.createPrompt(input);
        if (workspaceGeneration === workspaceEventGenerationRef.current) {
          setPrompts((current) => [...current, prompt]);
        }
        return prompt;
      },
      update: async (id, input) => {
        const workspaceGeneration = workspaceEventGenerationRef.current;
        const prompt = await api.updatePrompt(id, input);
        if (workspaceGeneration !== workspaceEventGenerationRef.current) return;
        setPrompts((current) =>
          current.map((candidate) => (candidate.id === id ? prompt : candidate)),
        );
      },
      connect: async (promptId, agentId, access) => {
        const workspaceGeneration = workspaceEventGenerationRef.current;
        const connection = await api.connectPrompt(promptId, agentId, access);
        if (workspaceGeneration !== workspaceEventGenerationRef.current) return;
        setPromptConnections((current) =>
          current.some((candidate) => candidate.id === connection.id)
            ? current
            : [...current, connection],
        );
      },
      disconnect: async (connectionId) => {
        const workspaceGeneration = workspaceEventGenerationRef.current;
        await api.disconnectPrompt(connectionId);
        if (workspaceGeneration !== workspaceEventGenerationRef.current) return;
        setPromptConnections((current) =>
          current.filter((connection) => connection.id !== connectionId),
        );
      },
    }),
    [],
  );

  const prActions = useMemo<PullRequestActions>(
    () => ({
      create: async (input) => {
        const workspaceGeneration = workspaceEventGenerationRef.current;
        const flow = await api.createPullRequestFlow(input);
        if (workspaceGeneration === workspaceEventGenerationRef.current) {
          setPrFlows((current) => upsertFlow(current, flow));
        }
      },
      recordCreated: async (id, input) => {
        const workspaceGeneration = workspaceEventGenerationRef.current;
        const flow = await api.recordPullRequestCreated(id, input);
        if (workspaceGeneration === workspaceEventGenerationRef.current) {
          setPrFlows((current) => upsertFlow(current, flow));
        }
      },
      recordMerged: async (id) => {
        const workspaceGeneration = workspaceEventGenerationRef.current;
        const flow = await api.recordPullRequestMerged(id);
        if (workspaceGeneration === workspaceEventGenerationRef.current) {
          setPrFlows((current) => upsertFlow(current, flow));
        }
      },
      retry: async (id) => {
        const workspaceGeneration = workspaceEventGenerationRef.current;
        const flow = await api.retryPullRequestFlow(id);
        if (workspaceGeneration === workspaceEventGenerationRef.current) {
          setPrFlows((current) => upsertFlow(current, flow));
        }
      },
      cancel: async (id) => {
        const workspaceGeneration = workspaceEventGenerationRef.current;
        const flow = await api.cancelPullRequestFlow(id);
        if (workspaceGeneration === workspaceEventGenerationRef.current) {
          setPrFlows((current) => upsertFlow(current, flow));
        }
      },
    }),
    [],
  );

  const syncActions = useMemo<SyncFlowActions>(
    () => ({
      create: async (input) => {
        const workspaceGeneration = workspaceEventGenerationRef.current;
        const flow = await api.createSyncFlow(input);
        if (workspaceGeneration === workspaceEventGenerationRef.current) {
          setSyncFlows((current) => upsertSyncFlow(current, flow));
        }
      },
      recordApplied: async (id, input) => {
        const workspaceGeneration = workspaceEventGenerationRef.current;
        const flow = await api.recordSyncFlowApplied(id, input);
        if (workspaceGeneration === workspaceEventGenerationRef.current) {
          setSyncFlows((current) => upsertSyncFlow(current, flow));
        }
      },
      cancel: async (id) => {
        const workspaceGeneration = workspaceEventGenerationRef.current;
        const flow = await api.cancelSyncFlow(id);
        if (workspaceGeneration === workspaceEventGenerationRef.current) {
          setSyncFlows((current) => upsertSyncFlow(current, flow));
        }
      },
    }),
    [],
  );

  return {
    agents,
    files,
    fileConnections,
    prompts,
    promptConnections,
    prFlows,
    syncFlows,
    commits,
    workspaceUpdate,
    workspaceMetadataUpdate,
    currentWorkspaceEventGeneration,
    currentWorkspaceSnapshotGeneration,
    currentWorkspaceSnapshot,
    currentWorkspaceEventIdentity,
    invalidateWorkspaceRefresh,
    connected,
    refresh,
    actions,
    fileActions,
    promptActions,
    prActions,
    syncActions,
  };
}

function upsertFlow(
  flows: PullRequestFlowSnapshot[],
  flow: PullRequestFlowSnapshot,
): PullRequestFlowSnapshot[] {
  return flows.some((candidate) => candidate.id === flow.id)
    ? flows.map((candidate) => (candidate.id === flow.id ? flow : candidate))
    : [flow, ...flows];
}

function upsertCommit(
  commits: AgentCommitSnapshot[],
  commit: AgentCommitSnapshot,
): AgentCommitSnapshot[] {
  return commits.some((candidate) => candidate.id === commit.id)
    ? commits.map((candidate) => (candidate.id === commit.id ? commit : candidate))
    : [commit, ...commits];
}

function upsertFile(files: CanvasFileNode[], file: CanvasFileNode): CanvasFileNode[] {
  return files.some((candidate) => candidate.id === file.id)
    ? files.map((candidate) => (candidate.id === file.id ? file : candidate))
    : [...files, file];
}

function upsertSyncFlow(
  flows: SyncFlowSnapshot[],
  flow: SyncFlowSnapshot,
): SyncFlowSnapshot[] {
  return flows.some((candidate) => candidate.id === flow.id)
    ? flows.map((candidate) => (candidate.id === flow.id ? flow : candidate))
    : [flow, ...flows];
}
