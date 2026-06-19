/**
 * 把 WebSocket 事件流 + REST 命令收敛成一个 React hook。
 *  - 订阅 /ws，用 agentStore 的纯函数折叠出 agents 视图表
 *  - 暴露 create/start/stop/send/resume 动作
 *  - 自动断线重连
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentStartConfig, ServerFrame } from "@agent-canvas/shared";
import { api } from "./api.js";
import {
  applyEnvelope,
  applyHello,
  emptyMap,
  newAgentView,
  type AgentMap,
} from "./agentStore.js";

export interface AgentActions {
  create: () => Promise<void>;
  start: (id: string, config: AgentStartConfig) => Promise<void>;
  stop: (id: string) => Promise<void>;
  send: (id: string, text: string) => Promise<void>;
  resume: (id: string, sessionId: string, text: string) => Promise<void>;
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
      start: (id, config) => api.start(id, config).then(() => undefined),
      stop: (id) => api.stop(id).then(() => undefined),
      send: (id, text) => api.send(id, text).then(() => undefined),
      resume: (id, sessionId, text) => api.resume(id, sessionId, text).then(() => undefined),
    }),
    [],
  );

  return { agents, connected, actions };
}
