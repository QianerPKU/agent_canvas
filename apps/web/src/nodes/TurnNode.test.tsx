// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ReactFlowProvider, type NodeProps } from "@xyflow/react";
import { TurnNode, type TurnNodeData, type TurnNodeType } from "./TurnNode.js";
import type { Turn } from "../agentStore.js";
import type { AgentStatus } from "@agent-canvas/shared";
import type { AgentActions } from "../useAgentCanvas.js";

afterEach(cleanup);

function makeActions(): AgentActions {
  return {
    create: vi.fn().mockResolvedValue(undefined),
    submit: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    fork: vi.fn().mockResolvedValue(undefined),
  };
}

function renderTurn(turn: Turn, agentStatus: AgentStatus, actions: AgentActions, agentId = "agent_1") {
  const data: TurnNodeData = { agentId, turn, agentStatus, actions };
  const props = { data } as unknown as NodeProps<TurnNodeType>;
  return render(
    <ReactFlowProvider>
      <TurnNode {...props} />
    </ReactFlowProvider>,
  );
}

describe("TurnNode", () => {
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

  it("续轮 idle（agent waiting_input）：发送本轮按钮", () => {
    const actions = makeActions();
    renderTurn({ index: 1, status: "idle", lines: [] }, "waiting_input", actions);

    fireEvent.change(screen.getByPlaceholderText("输入下一轮指令…"), {
      target: { value: "继续" },
    });
    fireEvent.click(screen.getByText("▶ 发送本轮"));
    expect(actions.submit).toHaveBeenCalledWith("agent_1", "继续");
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
    expect(actions.fork).toHaveBeenCalledWith("agent_1", "u-1");
  });

  it("完成轮但无 anchorUuid：不显示 fork", () => {
    const actions = makeActions();
    renderTurn({ index: 0, status: "done", lines: [] }, "waiting_input", actions);
    expect(screen.queryByText("⑂ 从此轮 fork")).toBeNull();
  });
});
