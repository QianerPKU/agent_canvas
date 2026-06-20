/**
 * 把 WebSocket 事件流 + REST 命令收敛成一个 React hook。
 *  - 订阅 /ws，用 agentStore 的纯函数折叠出 agents 视图表
 *  - 暴露 create/start/stop/send/resume 动作
 *  - 自动断线重连
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentProvider, ServerFrame } from "@agent-canvas/shared";
import { api } from "./api.js";
import {
  applyEnvelope,
  applyHello,
  emptyMap,
  insertForked,
  newAgentView,
  recordInput,
  type AgentMap,
} from "./agentStore.js";

export interface AgentActions {
  /** 新建一个 agent（出现一个 idle 起始节点）。 */
  create: () => Promise<void>;
  /** 在末尾 idle 轮提交输入：首轮→start，续轮→send（自动判断）。 */
  submit: (agentId: string, text: string, provider?: AgentProvider) => Promise<void>;
  /** 中止 agent。 */
  stop: (agentId: string) => Promise<void>;
  /** 从某轮（anchorUuid）fork 出一个新 agent。 */
  fork: (agentId: string, anchorUuid: string) => Promise<void>;
}

export interface UseAgentCanvas {
  agents: AgentMap;
  connected: boolean;
  actions: AgentActions;
}

function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}

export function useAgentCanvas(): UseAgentCanvas {
  const [agents, setAgents] = useState<AgentMap>(emptyMap);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  // 始终指向最新 agents，供 submit 判断 start/send（避免闭包过期）
  const agentsRef = useRef(agents);
  agentsRef.current = agents;

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      const ws = new WebSocket(wsUrl());
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        if (!closed) retry = setTimeout(connect, 1000);
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

    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      wsRef.current?.close();
    };
  }, []);

  const actions = useMemo<AgentActions>(
    () => ({
      create: async () => {
        const id = await api.create();
        // 后端 create 不发事件，乐观插入一个 idle 节点
        setAgents((prev) => (prev[id] ? prev : { ...prev, [id]: newAgentView(id) }));
      },
      submit: async (agentId, text, provider) => {
        const view = agentsRef.current[agentId];
        const startProvider = provider ?? view?.provider;
        setAgents((prev) => recordInput(prev, agentId, text, startProvider)); // 乐观置 running
        // 首轮（idle）用 start（fork 出来的 agent 由后端合并 fork 配置）；续轮用 send
        if (!view || view.status === "idle") {
          await api.start(agentId, { prompt: text, provider: startProvider });
        } else {
          await api.send(agentId, text);
        }
      },
      stop: (agentId) => api.stop(agentId).then(() => undefined),
      fork: async (agentId, anchorUuid) => {
        const { id, origin } = await api.fork(agentId, anchorUuid);
        setAgents((prev) => insertForked(prev, id, origin));
      },
    }),
    [],
  );

  return { agents, connected, actions };
}
