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
    updateSettings: vi.fn().mockResolvedValue(undefined),
    submit: vi.fn().mockResolvedValue(undefined),
    steer: vi.fn().mockResolvedValue(undefined),
    answerQuestion: vi.fn().mockResolvedValue(undefined),
    answerApproval: vi.fn().mockResolvedValue(undefined),
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

  it("只有最新活跃轮次显示资源读写 Handle", () => {
    const actions = makeActions();
    const { container, rerender } = render(
      <ReactFlowProvider>
        <TurnNode
          {...({
            id: "agent_1#1",
            data: {
              agentId: "agent_1",
              turn: { index: 1, status: "idle", lines: [] },
              agentStatus: "waiting_input",
              isLatest: true,
              onOpenHistory: vi.fn(),
              actions,
            },
          } as unknown as NodeProps<TurnNodeType>)}
        />
      </ReactFlowProvider>,
    );
    expect(container.querySelector('[data-handleid="resource-read"]')).toBeTruthy();
    expect(container.querySelector('[data-handleid="resource-write"]')).toBeTruthy();

    rerender(
      <ReactFlowProvider>
        <TurnNode
          {...({
            id: "agent_1#0",
            data: {
              agentId: "agent_1",
              turn: { index: 0, status: "done", lines: [] },
              agentStatus: "waiting_input",
              isLatest: false,
              onOpenHistory: vi.fn(),
              actions,
            },
          } as unknown as NodeProps<TurnNodeType>)}
        />
      </ReactFlowProvider>,
    );
    expect(container.querySelector('[data-handleid="resource-read"]')).toBeNull();
    expect(container.querySelector('[data-handleid="resource-write"]')).toBeNull();
  });

  it("首轮 idle（可输入）：启动按钮 + submit 带 prompt", () => {
    const actions = makeActions();
    renderTurn({ index: 0, status: "idle", lines: [] }, "idle", actions);

    expect(screen.getByText("待输入")).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("输入任务/提示词…"), {
      target: { value: "写个 a+b" },
    });
    fireEvent.click(screen.getByText("▶ 启动"));
    expect(actions.submit).toHaveBeenCalledWith("agent_1", "写个 a+b");
  });

  it("最新节点可打开 Agent 设置", () => {
    const actions = makeActions();
    const onOpenSettings = vi.fn();
    const data: TurnNodeData = {
      agentId: "agent_1",
      turn: { index: 0, status: "idle", lines: [] },
      agentStatus: "idle",
      isLatest: true,
      onOpenHistory: vi.fn(),
      onOpenSettings,
      actions,
    };
    render(
      <ReactFlowProvider>
        <TurnNode {...({ data, id: "agent_1#0" } as unknown as NodeProps<TurnNodeType>)} />
      </ReactFlowProvider>,
    );

    fireEvent.click(screen.getByTitle("Agent 设置"));
    expect(onOpenSettings).toHaveBeenCalledWith("agent_1");
  });

  it("续轮 idle（agent waiting_input）：发送本轮按钮", () => {
    const actions = makeActions();
    renderTurn({ index: 1, status: "idle", lines: [] }, "waiting_input", actions);

    fireEvent.change(screen.getByPlaceholderText("输入下一轮指令…"), {
      target: { value: "继续" },
    });
    fireEvent.click(screen.getByText("▶ 发送本轮"));
    expect(actions.submit).toHaveBeenCalledWith("agent_1", "继续");
  });

  it("等待输入时可 compact，并始终可 terminate CLI", () => {
    const actions = makeActions();
    renderTurn({ index: 1, status: "idle", lines: [] }, "waiting_input", actions);

    fireEvent.click(screen.getByText("Compact"));
    fireEvent.click(screen.getByText("Terminate"));
    expect(actions.compact).toHaveBeenCalledWith("agent_1");
    expect(actions.terminate).toHaveBeenCalledWith("agent_1");
  });

  it("运行中：可排队、引导和停止", () => {
    const actions = makeActions();
    renderTurn(
      { index: 0, status: "running", lines: [{ kind: "assistant", text: "思考中" }] },
      "running",
      actions,
    );
    expect(screen.getByText("运行中")).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText("运行中追加提示词…"), {
      target: { value: "下一轮整理结果" },
    });
    fireEvent.click(screen.getByText("排队"));
    expect(actions.submit).toHaveBeenCalledWith(
      "agent_1",
      "下一轮整理结果",
    );

    fireEvent.change(screen.getByPlaceholderText("运行中追加提示词…"), {
      target: { value: "先看失败测试" },
    });
    fireEvent.click(screen.getByText("引导"));
    expect(actions.steer).toHaveBeenCalledWith("agent_1", "先看失败测试");

    fireEvent.click(screen.getByText("停止"));
    expect(actions.stop).toHaveBeenCalledWith("agent_1");
  });

  it("运行中问题面板可提交回答", () => {
    const actions = makeActions();
    renderTurn(
      {
        index: 0,
        status: "running",
        lines: [
          {
            kind: "question",
            status: "pending",
            request: {
              requestId: "claude:tool-1",
              kind: "ask_user_question",
              title: "Claude 需要确认",
              questions: [
                {
                  id: "question_1",
                  header: "框架",
                  question: "选择哪个框架？",
                  options: [
                    { label: "React", description: "使用 React" },
                    { label: "Vue", description: "使用 Vue" },
                  ],
                },
              ],
            },
          },
        ],
      },
      "running",
      actions,
    );

    fireEvent.click(screen.getByText("React"));
    fireEvent.click(screen.getByText("回答"));
    expect(actions.answerQuestion).toHaveBeenCalledWith("agent_1", "claude:tool-1", {
      action: "accept",
      answers: { question_1: "React" },
    });
  });

  it("待授权时显示红点并可允许授权", () => {
    const actions = makeActions();
    const { container } = renderTurn(
      {
        index: 0,
        status: "running",
        lines: [
          {
            kind: "approval",
            status: "pending",
            request: {
              requestId: "codex-approval:9",
              kind: "command",
              title: "Codex 请求执行命令",
              command: "npm test",
              cwd: "C:/repo",
            },
          },
        ],
      },
      "running",
      actions,
    );

    expect(container.querySelector(".turn-node__interaction-dot")).toBeTruthy();
    fireEvent.click(screen.getByText("允许"));
    expect(actions.answerApproval).toHaveBeenCalledWith("agent_1", "codex-approval:9", {
      action: "approve",
      remember: false,
    });
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
