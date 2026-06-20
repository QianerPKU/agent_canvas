// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ReactFlowProvider, type NodeProps } from "@xyflow/react";
import {
  TurnNode,
  toggleTurnNodeWindow,
  type TurnNodeData,
  type TurnNodeType,
} from "./TurnNode.js";
import type { Turn } from "../agentStore.js";
import type { AgentStatus } from "@agent-canvas/shared";
import type { AgentActions } from "../useAgentCanvas.js";

afterEach(cleanup);

function makeActions(): AgentActions {
  return {
    create: vi.fn().mockResolvedValue(undefined),
    submit: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    compact: vi.fn().mockResolvedValue(undefined),
    terminate: vi.fn().mockResolvedValue(undefined),
    fork: vi.fn().mockResolvedValue(undefined),
  };
}

function renderTurn(turn: Turn, agentStatus: AgentStatus, actions: AgentActions, agentId = "agent_1") {
  const data: TurnNodeData = {
    agentId,
    turn,
    agentStatus,
    isLatest: true,
    onOpenHistory: vi.fn(),
    actions,
  };
  const props = { data } as unknown as NodeProps<TurnNodeType>;
  return render(
    <ReactFlowProvider>
      <TurnNode {...props} />
    </ReactFlowProvider>,
  );
}

describe("TurnNode", () => {
  it("最小化保存当前尺寸，并能恢复", () => {
    const actions = makeActions();
    const node: TurnNodeType = {
      id: "agent_1#0",
      type: "turn",
      position: { x: 0, y: 0 },
      width: 520,
      height: 410,
      data: {
        agentId: "agent_1",
        turn: { index: 0, status: "idle", lines: [] },
        agentStatus: "idle",
        isLatest: true,
        onOpenHistory: vi.fn(),
        actions,
      },
    };

    const minimized = { ...node, ...toggleTurnNodeWindow(node) } as TurnNodeType;
    expect(minimized).toMatchObject({
      width: 68,
      height: 48,
      data: {
        windowState: {
          minimized: true,
          restoreWidth: 520,
          restoreHeight: 410,
        },
      },
    });

    const restored = toggleTurnNodeWindow(minimized);
    expect(restored).toMatchObject({
      width: 520,
      height: 410,
      data: { windowState: { minimized: false } },
    });
  });

  it("最小化节点仍保留全部连接 Handle", () => {
    const actions = makeActions();
    const data: TurnNodeData = {
      agentId: "agent_1",
      turn: { index: 2, status: "done", lines: [] },
      agentStatus: "waiting_input",
      isLatest: false,
      windowState: { minimized: true, restoreWidth: 360, restoreHeight: 300 },
      onOpenHistory: vi.fn(),
      actions,
    };
    const { container } = render(
      <ReactFlowProvider>
        <TurnNode {...({ data, id: "agent_1#2" } as unknown as NodeProps<TurnNodeType>)} />
      </ReactFlowProvider>,
    );

    expect(container.querySelectorAll(".react-flow__handle")).toHaveLength(3);
    const restoreButton = screen.getByTitle("恢复 agent_1 第 3 轮");
    expect(restoreButton.classList.contains("drag-handle")).toBe(true);
    expect(restoreButton.classList.contains("nodrag")).toBe(false);
  });

  it("首轮 idle（可输入）：启动按钮 + submit 带 prompt", () => {
    const actions = makeActions();
    renderTurn({ index: 0, status: "idle", lines: [] }, "idle", actions);

    expect(screen.getByText("待输入")).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("输入任务/提示词…"), {
      target: { value: "写个 a+b" },
    });
    fireEvent.click(screen.getByText("▶ 启动"));
    expect(actions.submit).toHaveBeenCalledWith("agent_1", "写个 a+b", "claude", undefined);
  });

  it("首轮可选择 Codex provider 与模型", () => {
    const actions = makeActions();
    renderTurn({ index: 0, status: "idle", lines: [] }, "idle", actions);

    fireEvent.change(screen.getByLabelText("agent provider"), {
      target: { value: "codex" },
    });
    fireEvent.change(screen.getByPlaceholderText("输入任务/提示词…"), {
      target: { value: "用 codex 跑" },
    });
    fireEvent.change(screen.getByLabelText("codex model"), {
      target: { value: "gpt-5.4-mini" },
    });
    fireEvent.click(screen.getByText("▶ 启动"));
    expect(actions.submit).toHaveBeenCalledWith(
      "agent_1",
      "用 codex 跑",
      "codex",
      "gpt-5.4-mini",
    );
  });

  it("续轮 idle（agent waiting_input）：发送本轮按钮", () => {
    const actions = makeActions();
    renderTurn({ index: 1, status: "idle", lines: [] }, "waiting_input", actions);

    fireEvent.change(screen.getByPlaceholderText("输入下一轮指令…"), {
      target: { value: "继续" },
    });
    fireEvent.click(screen.getByText("▶ 发送本轮"));
    expect(actions.submit).toHaveBeenCalledWith("agent_1", "继续", undefined, undefined);
  });

  it("等待输入时可 compact，并始终可 terminate CLI", () => {
    const actions = makeActions();
    renderTurn({ index: 1, status: "idle", lines: [] }, "waiting_input", actions);

    fireEvent.click(screen.getByText("Compact"));
    fireEvent.click(screen.getByText("Terminate"));
    expect(actions.compact).toHaveBeenCalledWith("agent_1");
    expect(actions.terminate).toHaveBeenCalledWith("agent_1");
  });

  it("运行中：显示停止按钮", () => {
    const actions = makeActions();
    renderTurn(
      { index: 0, status: "running", lines: [{ kind: "assistant", text: "思考中" }] },
      "running",
      actions,
    );
    expect(screen.getByText("运行中")).toBeTruthy();
    fireEvent.click(screen.getByText("停止"));
    expect(actions.stop).toHaveBeenCalledWith("agent_1");
  });

  it("完成轮（有 anchorUuid）：fork 按钮 + 展示用户输入", () => {
    const actions = makeActions();
    renderTurn(
      {
        index: 0,
        status: "done",
        anchorUuid: "u-1",
        userInput: "做 x",
        lines: [{ kind: "assistant", text: "完成了" }],
      },
      "waiting_input",
      actions,
    );
    expect(screen.getByText("完成")).toBeTruthy();
    expect(screen.getByText(/做 x/)).toBeTruthy();
    fireEvent.click(screen.getByText("⑂ 从此轮 fork"));
    expect(actions.fork).toHaveBeenCalledWith("agent_1", "u-1", undefined);
  });

  it("Codex 完成轮可选择 fork 模型", () => {
    const actions = makeActions();
    const data: TurnNodeData = {
      agentId: "agent_1",
      turn: {
        index: 0,
        status: "done",
        anchorUuid: "u-1",
        lines: [{ kind: "assistant", text: "完成了" }],
      },
      agentStatus: "waiting_input",
      provider: "codex",
      model: "gpt-5.4",
      isLatest: false,
      onOpenHistory: vi.fn(),
      actions,
    };
    render(
      <ReactFlowProvider>
        <TurnNode {...({ data } as unknown as NodeProps<TurnNodeType>)} />
      </ReactFlowProvider>,
    );

    fireEvent.change(screen.getByLabelText("fork model"), {
      target: { value: "gpt-5.5" },
    });
    fireEvent.click(screen.getByText("⑂ 从此轮 fork"));
    expect(actions.fork).toHaveBeenCalledWith("agent_1", "u-1", "gpt-5.5");
  });

  it("完成轮但无 anchorUuid：不显示 fork", () => {
    const actions = makeActions();
    renderTurn({ index: 0, status: "done", lines: [] }, "waiting_input", actions);
    expect(screen.queryByText("⑂ 从此轮 fork")).toBeNull();
  });

  it("点击节点主体打开累计历史，点击控制按钮不会误触", () => {
    const actions = makeActions();
    const onOpenHistory = vi.fn();
    const data: TurnNodeData = {
      agentId: "agent_1",
      turn: { index: 0, status: "idle", lines: [] },
      agentStatus: "idle",
      isLatest: true,
      onOpenHistory,
      actions,
    };
    const { container } = render(
      <ReactFlowProvider>
        <TurnNode {...({ data, id: "agent_1#0" } as unknown as NodeProps<TurnNodeType>)} />
      </ReactFlowProvider>,
    );

    fireEvent.click(container.querySelector(".turn-node")!);
    expect(onOpenHistory).toHaveBeenCalledWith("agent_1", 0);

    fireEvent.click(screen.getByText("Terminate"));
    expect(onOpenHistory).toHaveBeenCalledOnce();
  });
});
