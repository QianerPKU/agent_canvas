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

interface FileMutationGuard {
  projectEpoch: number;
  mutationGeneration: number;
}

interface FileRequestGuard extends FileMutationGuard {
  fileId: string;
  requestSequence: number;
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
  const agentMutationGenerationRef = useRef(0);
  const agentMutationGenerationsRef = useRef(new Map<string, number>());
  const agentRuntimeGenerationsRef = useRef(new Map<string, number>());
  const helloSnapshotGenerationRef = useRef(0);
  const workspaceEventGenerationRef = useRef(0);
  const fileProjectEpochRef = useRef(0);
  const fileMutationGenerationRef = useRef(0);
  const fileMutationGenerationsRef = useRef(new Map<string, number>());
  const fileMutationRequestSequencesRef = useRef(new Map<string, number | null>());
  const fileRequestSequenceRef = useRef(0);
  const latestSuccessfulFileRequestSequencesRef = useRef(new Map<string, number>());
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
  const markAgentMutation = useCallback((agentId: string) => {
    const generation = ++agentMutationGenerationRef.current;
    agentMutationGenerationsRef.current.set(agentId, generation);
  }, []);
  const markAgentRuntimeMutation = useCallback((agentId: string) => {
    const generations = agentRuntimeGenerationsRef.current;
    generations.set(agentId, (generations.get(agentId) ?? 0) + 1);
  }, []);
  const advanceFileProjectEpoch = useCallback(() => {
    fileProjectEpochRef.current += 1;
    fileMutationGenerationRef.current += 1;
    fileMutationGenerationsRef.current.clear();
    fileMutationRequestSequencesRef.current.clear();
    latestSuccessfulFileRequestSequencesRef.current.clear();
  }, []);
  const markFileMutation = useCallback((fileId: string, requestSequence?: number) => {
    const generation = ++fileMutationGenerationRef.current;
    fileMutationGenerationsRef.current.set(fileId, generation);
    fileMutationRequestSequencesRef.current.set(fileId, requestSequence ?? null);
  }, []);
  const captureFileMutationGuard = useCallback(
    (): FileMutationGuard => ({
      projectEpoch: fileProjectEpochRef.current,
      mutationGeneration: fileMutationGenerationRef.current,
    }),
    [],
  );
  const beginFileRequest = useCallback((fileId: string): FileRequestGuard => {
    const requestSequence = ++fileRequestSequenceRef.current;
    return {
      fileId,
      requestSequence,
      projectEpoch: fileProjectEpochRef.current,
      mutationGeneration: fileMutationGenerationRef.current,
    };
  }, []);
  const applyUnkeyedFileResults = useCallback(
    (incoming: CanvasFileNode[], guard: FileMutationGuard): CanvasFileNode[] => {
      if (guard.projectEpoch !== fileProjectEpochRef.current) return [];
      const accepted = incoming.filter(
        (file) =>
          (fileMutationGenerationsRef.current.get(file.id) ?? 0) <=
          guard.mutationGeneration,
      );
      if (accepted.length === 0) return accepted;
      for (const file of accepted) markFileMutation(file.id);
      setFiles((current) => accepted.reduce(upsertFile, current));
      return accepted;
    },
    [markFileMutation],
  );
  const applyFileRequestResult = useCallback(
    (file: CanvasFileNode, guard: FileRequestGuard): boolean => {
      const mutationGeneration =
        fileMutationGenerationsRef.current.get(guard.fileId) ?? 0;
      const mutationRequestSequence =
        fileMutationRequestSequencesRef.current.get(guard.fileId);
      const changedAfterRequest = mutationGeneration > guard.mutationGeneration;
      const supersededByMutation =
        changedAfterRequest &&
        (mutationRequestSequence == null ||
          mutationRequestSequence > guard.requestSequence);
      if (
        guard.projectEpoch !== fileProjectEpochRef.current ||
        (latestSuccessfulFileRequestSequencesRef.current.get(guard.fileId) ?? 0) >
          guard.requestSequence ||
        supersededByMutation
      ) {
        return false;
      }
      latestSuccessfulFileRequestSequencesRef.current.set(
        guard.fileId,
        guard.requestSequence,
      );
      markFileMutation(file.id, guard.requestSequence);
      setFiles((current) => replaceFile(current, file));
      return true;
    },
    [markFileMutation],
  );
  const clearProjectScopedState = useCallback(() => {
    helloSnapshotGenerationRef.current += 1;
    agentMutationGenerationsRef.current.clear();
    agentRuntimeGenerationsRef.current.clear();
    advanceFileProjectEpoch();
    setAgents(emptyMap);
    setFiles([]);
    setFileConnections([]);
    setPrompts([]);
    setPromptConnections([]);
    setPrFlows([]);
    setSyncFlows([]);
    setCommits([]);
  }, [advanceFileProjectEpoch]);
  // 始终指向最新 agents，供 submit 判断 start/send（避免闭包过期）
  const agentsRef = useRef(agents);
  agentsRef.current = agents;

  const refresh = useCallback(async () => {
    const generation = ++refreshGenerationRef.current;
    const agentMutationGeneration = agentMutationGenerationRef.current;
    const fileProjectEpoch = fileProjectEpochRef.current;
    const fileMutationGeneration = fileMutationGenerationRef.current;
    const helloSnapshotGeneration = helloSnapshotGenerationRef.current;
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
    const refreshedAgents = applyHello(nextAgents, Object.fromEntries(historyEntries));
    if (helloSnapshotGeneration === helloSnapshotGenerationRef.current) {
      setAgents((current) =>
        mergeRefreshedAgents(
          current,
          refreshedAgents,
          agentMutationGenerationsRef.current,
          agentMutationGeneration,
        ),
      );
      setPrFlows((current) => mergeRefreshedFlows(current, nextPrFlows));
      setSyncFlows((current) => mergeRefreshedFlows(current, nextSyncFlows));
      setCommits((current) => mergeRefreshedCommits(current, nextCommits));
    }
    if (fileProjectEpoch === fileProjectEpochRef.current) {
      setFiles((current) =>
        mergeRefreshedFiles(
          current,
          nextFiles,
          fileMutationGenerationsRef.current,
          fileMutationGeneration,
        ),
      );
    }
    setFileConnections(nextConnections);
    setPrompts(nextPrompts);
    setPromptConnections(nextPromptConnections);
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
        // Invalidate file mutations immediately. Waiting for the reconnect's first workspace
        // frame leaves a window in which an old-project REST response can repopulate cleared data.
        advanceFileProjectEpoch();
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
          helloSnapshotGenerationRef.current += 1;
          setAgents(applyHello(frame.agents, frame.histories));
          setPrFlows(frame.prFlows ?? []);
          setSyncFlows(frame.syncFlows ?? []);
          setCommits(frame.commits ?? []);
        } else if (frame.type === "event") {
          if (frame.envelope.event.kind === "system_init") {
            markAgentRuntimeMutation(frame.envelope.agentId);
          }
          markAgentMutation(frame.envelope.agentId);
          setAgents((prev) => applyEnvelope(prev, frame.envelope));
        } else if (frame.type === "pr_flow") {
          setPrFlows((prev) => upsertFlow(prev, frame.flow));
        } else if (frame.type === "sync_flow") {
          setSyncFlows((prev) => upsertSyncFlow(prev, frame.flow));
        } else if (frame.type === "commit") {
          setCommits((prev) => upsertCommit(prev, frame.commit));
        } else if (frame.type === "file") {
          // File frames do not currently carry a project id/revision. Only accept them after this
          // socket has established its workspace epoch, and record the mutation so an older REST
          // list snapshot cannot overwrite it.
          if (!acceptedWorkspaceInEpoch) return;
          markFileMutation(frame.file.id);
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
            if (acceptedWorkspaceInEpoch) {
              clearProjectScopedState();
            } else {
              advanceFileProjectEpoch();
            }
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
      advanceFileProjectEpoch();
      currentSocket?.close();
    };
  }, [
    advanceFileProjectEpoch,
    clearProjectScopedState,
    markAgentMutation,
    markAgentRuntimeMutation,
    markFileMutation,
    refresh,
  ]);

  const actions = useMemo<AgentActions>(
    () => ({
      create: async (settings) => {
        const workspaceGeneration = workspaceEventGenerationRef.current;
        const id = await api.create(settings);
        if (workspaceGeneration !== workspaceEventGenerationRef.current) return id;
        // The backend normally creates an idle node, but an automation retry can start it before
        // this response arrives. Merge settings into either the optimistic node or that live node
        // without overwriting status/history received over WebSocket.
        markAgentMutation(id);
        setAgents((prev) => recordAgentSettings(prev, id, definedAgentSettings(settings)));
        return id;
      },
      updateSettings: async (agentId, settings) => {
        const workspaceGeneration = workspaceEventGenerationRef.current;
        const agentRuntimeGeneration = agentRuntimeGenerationsRef.current.get(agentId) ?? 0;
        const snapshot = await api.updateAgentSettings(agentId, settings);
        if (workspaceGeneration !== workspaceEventGenerationRef.current) return;
        const runtimeChangedDuringRequest =
          (agentRuntimeGenerationsRef.current.get(agentId) ?? 0) > agentRuntimeGeneration;
        const responseSettings = settingsFromUpdateSnapshot(
          settings,
          snapshot.config,
          runtimeChangedDuringRequest,
        );
        markAgentMutation(agentId);
        setAgents((prev) => recordAgentSettings(prev, agentId, responseSettings));
      },
      submit: async (agentId, text) => {
        const view = agentsRef.current[agentId];
        const startProvider = view?.provider;
        const startModel = view?.model;
        const startReasoningEffort = view?.reasoningEffort;
        // 首轮（idle）用 start（fork 出来的 agent 由后端合并 fork 配置）；续轮用 send
        if (!view || view.status === "idle") {
          markAgentMutation(agentId);
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
          markAgentMutation(agentId);
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
        markAgentMutation(agentId);
        setAgents((prev) => recordCompact(prev, agentId));
        await api.compact(agentId);
      },
      terminate: (agentId) => api.terminate(agentId).then(() => undefined),
      openWorkspace: (agentId) => api.openAgentWorkspace(agentId).then(() => undefined),
      fork: async (agentId, anchorUuid, options = {}) => {
        const workspaceGeneration = workspaceEventGenerationRef.current;
        const { id, origin } = await api.fork(agentId, anchorUuid, options);
        if (workspaceGeneration !== workspaceEventGenerationRef.current) return;
        markAgentMutation(id);
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
    [markAgentMutation],
  );

  const fileActions = useMemo<FileActions>(
    () => ({
      create: async (input) => {
        const guard = captureFileMutationGuard();
        const file = await api.createFile(input);
        applyUnkeyedFileResults([file], guard);
        return file;
      },
      pick: async () => {
        const projectEpoch = fileProjectEpochRef.current;
        const workspaceContext = api.captureWorkspaceContext();
        if (!workspaceContext) throw new Error("当前项目上下文尚未就绪，请稍后重试");
        const selection = await api.pickFiles(workspaceContext);
        if (!selection) return null;
        if (projectEpoch !== fileProjectEpochRef.current) {
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
        const guard = captureFileMutationGuard();
        const workspaceContext =
          pickedSelectionContextsRef.current.get(input.selectionId) ??
          api.captureWorkspaceContext();
        const imported = await api.importPickedFiles(input, workspaceContext);
        pickedSelectionContextsRef.current.delete(input.selectionId);
        applyUnkeyedFileResults(imported, guard);
        return imported;
      },
      importDropped: async (dropped, kind, onImported) => {
        const projectEpoch = fileProjectEpochRef.current;
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
          if (projectEpoch !== fileProjectEpochRef.current) {
            for (const remaining of dropped.slice(index)) {
              failures.push({ file: remaining, reason: "项目已切换，请在当前项目中重新拖入" });
            }
            break;
          }
          try {
            const guard = captureFileMutationGuard();
            const created = await api.importUploadedFile(file, kind, workspaceContext);
            imported.push(created);
            if (applyUnkeyedFileResults([created], guard).length > 0) {
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
        const guard = beginFileRequest(id);
        const file = await api.relinkFile(id);
        if (file) applyFileRequestResult(file, guard);
        return file;
      },
      refresh: async (id) => {
        const guard = beginFileRequest(id);
        const file = await api.refreshFile(id);
        if (applyFileRequestResult(file, guard)) {
          return file;
        }
        return null;
      },
      update: async (id, input) => {
        const guard = beginFileRequest(id);
        const file = await api.updateFile(id, input);
        applyFileRequestResult(file, guard);
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
    [
      applyFileRequestResult,
      applyUnkeyedFileResults,
      beginFileRequest,
      captureFileMutationGuard,
    ],
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

function mergeRefreshedAgents(
  current: AgentMap,
  refreshed: AgentMap,
  mutationGenerations: ReadonlyMap<string, number>,
  refreshStartedAtGeneration: number,
): AgentMap {
  const merged: AgentMap = { ...refreshed };
  for (const [agentId, currentAgent] of Object.entries(current)) {
    const refreshedAgent = refreshed[agentId];
    const changedDuringRefresh =
      (mutationGenerations.get(agentId) ?? 0) > refreshStartedAtGeneration;
    if (changedDuringRefresh) {
      merged[agentId] = currentAgent;
      continue;
    }
    if (refreshedAgent && refreshedAgent.lastSeq > currentAgent.lastSeq) continue;
    if (refreshedAgent && currentAgent.lastSeq > refreshedAgent.lastSeq) {
      merged[agentId] = currentAgent;
    }
  }
  return merged;
}

function mergeRefreshedFiles(
  current: CanvasFileNode[],
  refreshed: CanvasFileNode[],
  mutationGenerations: ReadonlyMap<string, number>,
  refreshStartedAtGeneration: number,
): CanvasFileNode[] {
  const currentById = new Map(current.map((file) => [file.id, file]));
  const refreshedIds = new Set(refreshed.map((file) => file.id));
  const merged = refreshed.map((file) => {
    const changedDuringRefresh =
      (mutationGenerations.get(file.id) ?? 0) > refreshStartedAtGeneration;
    return changedDuringRefresh ? (currentById.get(file.id) ?? file) : file;
  });
  for (const file of current) {
    const changedDuringRefresh =
      (mutationGenerations.get(file.id) ?? 0) > refreshStartedAtGeneration;
    if (!refreshedIds.has(file.id) && changedDuringRefresh) merged.push(file);
  }
  return merged;
}

function mergeRefreshedFlows<T extends { id: string; updatedAt: number }>(
  current: T[],
  refreshed: T[],
): T[] {
  const refreshedById = new Map(refreshed.map((flow) => [flow.id, flow]));
  const currentIds = new Set(current.map((flow) => flow.id));
  return [
    ...current.map((flow) => {
      const snapshot = refreshedById.get(flow.id);
      return snapshot && snapshot.updatedAt > flow.updatedAt ? snapshot : flow;
    }),
    ...refreshed.filter((flow) => !currentIds.has(flow.id)),
  ];
}

function mergeRefreshedCommits(
  current: AgentCommitSnapshot[],
  refreshed: AgentCommitSnapshot[],
): AgentCommitSnapshot[] {
  const currentIds = new Set(current.map((commit) => commit.id));
  return [
    ...current,
    ...refreshed.filter((commit) => !currentIds.has(commit.id)),
  ].sort((left, right) => right.createdAt - left.createdAt);
}

function definedAgentSettings(settings: AgentSettings): AgentSettings {
  return Object.fromEntries(
    Object.entries(settings).filter(([, value]) => value !== undefined),
  ) as AgentSettings;
}

function settingsFromUpdateSnapshot(
  input: UpdateAgentSettingsInput,
  snapshot: AgentSettings,
  preserveRuntimeModel: boolean,
): AgentSettings {
  const settings: AgentSettings = {};
  if (input.model !== undefined && !preserveRuntimeModel) {
    settings.model = snapshot.model ?? input.model ?? undefined;
  }
  if (input.reasoningEffort !== undefined) {
    settings.reasoningEffort =
      snapshot.reasoningEffort ?? input.reasoningEffort ?? undefined;
  }
  if (input.systemPrompt !== undefined) {
    settings.systemPrompt = snapshot.systemPrompt ?? input.systemPrompt;
  }
  if (input.allowSharedResourceWrites !== undefined) {
    settings.allowSharedResourceWrites =
      snapshot.allowSharedResourceWrites ?? input.allowSharedResourceWrites;
  }
  if (
    input.branchWorkspaceId !== undefined ||
    input.branch !== undefined ||
    input.cwd !== undefined ||
    input.scratchDirectory !== undefined
  ) {
    settings.branchWorkspaceId = snapshot.branchWorkspaceId ?? input.branchWorkspaceId;
    settings.branch = snapshot.branch ?? input.branch;
    settings.cwd = snapshot.cwd ?? input.cwd;
    settings.scratchDirectory = snapshot.scratchDirectory ?? input.scratchDirectory;
  }
  return settings;
}

function upsertFlow(
  flows: PullRequestFlowSnapshot[],
  flow: PullRequestFlowSnapshot,
): PullRequestFlowSnapshot[] {
  const existing = flows.find((candidate) => candidate.id === flow.id);
  if (existing && existing.updatedAt > flow.updatedAt) return flows;
  return existing
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
  const existing = files.find((candidate) => candidate.id === file.id);
  if (existing && existing.updatedAt > file.updatedAt) return files;
  return replaceFile(files, file);
}

function replaceFile(files: CanvasFileNode[], file: CanvasFileNode): CanvasFileNode[] {
  const existing = files.some((candidate) => candidate.id === file.id);
  return existing
    ? files.map((candidate) => (candidate.id === file.id ? file : candidate))
    : [...files, file];
}

function upsertSyncFlow(
  flows: SyncFlowSnapshot[],
  flow: SyncFlowSnapshot,
): SyncFlowSnapshot[] {
  const existing = flows.find((candidate) => candidate.id === flow.id);
  if (existing && existing.updatedAt > flow.updatedAt) return flows;
  return existing
    ? flows.map((candidate) => (candidate.id === flow.id ? flow : candidate))
    : [flow, ...flows];
}
