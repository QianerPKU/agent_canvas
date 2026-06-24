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
  CanvasFileNode,
  CanvasPromptConnection,
  CanvasPromptNode,
  CreateCanvasFileInput,
  CreateCanvasPromptInput,
  CreatePullRequestFlowInput,
  CreateSyncFlowInput,
  FileConnectionAccess,
  PullRequestCreatedInput,
  PullRequestFlowSnapshot,
  PromptConnectionAccess,
  ServerFrame,
  SyncFlowAppliedInput,
  SyncFlowSnapshot,
  UpdateCanvasFileInput,
  UpdateCanvasPromptInput,
} from "@agent-canvas/shared";
import { api } from "./api.js";
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
    settings: Pick<
      AgentSettings,
      "systemPrompt" | "branchWorkspaceId" | "branch" | "cwd" | "scratchDirectory"
    >,
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
  /** 从某轮（anchorUuid）fork 出一个新 agent。 */
  fork: (agentId: string, anchorUuid: string, model?: string) => Promise<void>;
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
  connected: boolean;
  refresh: () => Promise<void>;
  actions: AgentActions;
  fileActions: FileActions;
  promptActions: PromptActions;
  prActions: PullRequestActions;
  syncActions: SyncFlowActions;
}

export interface FileActions {
  create: (input: CreateCanvasFileInput) => Promise<CanvasFileNode>;
  update: (id: string, input: UpdateCanvasFileInput) => Promise<void>;
  connect: (
    fileId: string,
    agentId: string,
    access: FileConnectionAccess,
  ) => Promise<void>;
  disconnect: (connectionId: string) => Promise<void>;
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
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  // 始终指向最新 agents，供 submit 判断 start/send（避免闭包过期）
  const agentsRef = useRef(agents);
  agentsRef.current = agents;

  const refresh = useCallback(async () => {
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
      const ws = new WebSocket(wsUrl());
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        scheduleConnect(1000);
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (ev) => {
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
      void api
        .listPrompts()
        .then(
          (nextPrompts) => {
            if (!closed) setPrompts(nextPrompts);
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
      if (promptTimer) window.clearTimeout(promptTimer);
      if (connectTimer) clearTimeout(connectTimer);
      wsRef.current?.close();
    };
  }, [refresh]);

  const actions = useMemo<AgentActions>(
    () => ({
      create: async (settings) => {
        const id = await api.create(settings);
        // 后端 create 不发事件，乐观插入一个 idle 节点
        setAgents((prev) =>
          prev[id]
            ? prev
            : {
                ...prev,
                [id]: newAgentView(id, {
                  provider: settings.provider,
                  model: settings.model,
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
        const snapshot = await api.updateAgentSettings(agentId, settings);
        setAgents((prev) =>
          recordAgentSettings(prev, agentId, {
            provider: snapshot.config.provider,
            model: snapshot.config.model,
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
        const startModel = startProvider === "codex" ? view?.model : undefined;
        // 首轮（idle）用 start（fork 出来的 agent 由后端合并 fork 配置）；续轮用 send
        if (!view || view.status === "idle") {
          setAgents((prev) => recordInput(prev, agentId, text, startProvider, startModel));
          await api.start(agentId, {
            prompt: text,
            provider: startProvider,
            model: startModel,
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
      fork: async (agentId, anchorUuid, model) => {
        const { id, origin } = await api.fork(agentId, anchorUuid, model);
        setAgents((prev) => insertForked(prev, id, origin, model));
        const [nextFileConnections, nextPromptConnections] = await Promise.all([
          api.listFileConnections(),
          api.listPromptConnections(),
        ]);
        setFileConnections(nextFileConnections);
        setPromptConnections(nextPromptConnections);
      },
    }),
    [],
  );

  const fileActions = useMemo<FileActions>(
    () => ({
      create: async (input) => {
        const file = await api.createFile(input);
        setFiles((current) => [...current, file]);
        return file;
      },
      update: async (id, input) => {
        const file = await api.updateFile(id, input);
        setFiles((current) => current.map((candidate) => (candidate.id === id ? file : candidate)));
      },
      connect: async (fileId, agentId, access) => {
        const connection = await api.connectFile(fileId, agentId, access);
        setFileConnections((current) =>
          current.some((candidate) => candidate.id === connection.id)
            ? current
            : [...current, connection],
        );
      },
      disconnect: async (connectionId) => {
        await api.disconnectFile(connectionId);
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
        const prompt = await api.createPrompt(input);
        setPrompts((current) => [...current, prompt]);
        return prompt;
      },
      update: async (id, input) => {
        const prompt = await api.updatePrompt(id, input);
        setPrompts((current) =>
          current.map((candidate) => (candidate.id === id ? prompt : candidate)),
        );
      },
      connect: async (promptId, agentId, access) => {
        const connection = await api.connectPrompt(promptId, agentId, access);
        setPromptConnections((current) =>
          current.some((candidate) => candidate.id === connection.id)
            ? current
            : [...current, connection],
        );
      },
      disconnect: async (connectionId) => {
        await api.disconnectPrompt(connectionId);
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
        const flow = await api.createPullRequestFlow(input);
        setPrFlows((current) => upsertFlow(current, flow));
      },
      recordCreated: async (id, input) => {
        const flow = await api.recordPullRequestCreated(id, input);
        setPrFlows((current) => upsertFlow(current, flow));
      },
      recordMerged: async (id) => {
        const flow = await api.recordPullRequestMerged(id);
        setPrFlows((current) => upsertFlow(current, flow));
      },
      cancel: async (id) => {
        const flow = await api.cancelPullRequestFlow(id);
        setPrFlows((current) => upsertFlow(current, flow));
      },
    }),
    [],
  );

  const syncActions = useMemo<SyncFlowActions>(
    () => ({
      create: async (input) => {
        const flow = await api.createSyncFlow(input);
        setSyncFlows((current) => upsertSyncFlow(current, flow));
      },
      recordApplied: async (id, input) => {
        const flow = await api.recordSyncFlowApplied(id, input);
        setSyncFlows((current) => upsertSyncFlow(current, flow));
      },
      cancel: async (id) => {
        const flow = await api.cancelSyncFlow(id);
        setSyncFlows((current) => upsertSyncFlow(current, flow));
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

function upsertSyncFlow(
  flows: SyncFlowSnapshot[],
  flow: SyncFlowSnapshot,
): SyncFlowSnapshot[] {
  return flows.some((candidate) => candidate.id === flow.id)
    ? flows.map((candidate) => (candidate.id === flow.id ? flow : candidate))
    : [flow, ...flows];
}
