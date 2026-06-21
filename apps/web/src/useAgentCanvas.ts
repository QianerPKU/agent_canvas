/**
 * 把 WebSocket 事件流 + REST 命令收敛成一个 React hook。
 *  - 订阅 /ws，用 agentStore 的纯函数折叠出 agents 视图表
 *  - 暴露 create/start/stop/send/steer/resume 动作
 *  - 自动断线重连
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentSettings,
  CanvasFileConnection,
  CanvasFileNode,
  CanvasPromptConnection,
  CanvasPromptNode,
  CreateCanvasFileInput,
  CreateCanvasPromptInput,
  FileConnectionAccess,
  PromptConnectionAccess,
  ServerFrame,
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
  create: (settings: AgentSettings) => Promise<void>;
  /** 更新已创建 agent 的可变设置。 */
  updateSettings: (agentId: string, settings: Pick<AgentSettings, "systemPrompt">) => Promise<void>;
  /** 在末尾 idle 轮提交输入：首轮→start，续轮→send（自动判断）。 */
  submit: (agentId: string, text: string) => Promise<void>;
  /** 尽快引导当前正在运行的一轮。 */
  steer: (agentId: string, text: string) => Promise<void>;
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
  connected: boolean;
  actions: AgentActions;
  fileActions: FileActions;
  promptActions: PromptActions;
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
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  // 始终指向最新 agents，供 submit 判断 start/send（避免闭包过期）
  const agentsRef = useRef(agents);
  agentsRef.current = agents;

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
          setAgents(applyHello(frame.agents));
        } else if (frame.type === "event") {
          setAgents((prev) => applyEnvelope(prev, frame.envelope));
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
    void Promise.all([
      api.listFiles(),
      api.listFileConnections(),
      api.listPrompts(),
      api.listPromptConnections(),
    ]).then(
      ([nextFiles, nextConnections, nextPrompts, nextPromptConnections]) => {
        if (closed) return;
        setFiles(nextFiles);
        setFileConnections(nextConnections);
        setPrompts(nextPrompts);
        setPromptConnections(nextPromptConnections);
      },
      () => undefined,
    );
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
  }, []);

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
                  cwd: settings.cwd,
                  systemPrompt: settings.systemPrompt,
                }),
              },
        );
      },
      updateSettings: async (agentId, settings) => {
        const snapshot = await api.updateAgentSettings(agentId, settings);
        setAgents((prev) =>
          recordAgentSettings(prev, agentId, {
            provider: snapshot.config.provider,
            model: snapshot.config.model,
            cwd: snapshot.config.cwd,
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
            cwd: view?.cwd,
            systemPrompt: view?.systemPrompt,
          });
        } else if (view.status === "waiting_input") {
          setAgents((prev) => recordInput(prev, agentId, text, startProvider, startModel));
          await api.send(agentId, text);
        } else {
          await api.send(agentId, text);
        }
      },
      steer: (agentId, text) => api.steer(agentId, text).then(() => undefined),
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

  return {
    agents,
    files,
    fileConnections,
    prompts,
    promptConnections,
    connected,
    actions,
    fileActions,
    promptActions,
  };
}
