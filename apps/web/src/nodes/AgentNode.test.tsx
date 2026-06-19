// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { NodeProps } from "@xyflow/react";
import { AgentNode, type AgentNodeData, type AgentNodeType } from "./AgentNode.js";
import { newAgentView } from "../agentStore.js";
import type { AgentActions } from "../useAgentCanvas.js";

afterEach(cleanup);

function makeActions(): AgentActions {
  return {
    create: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn().mockResolvedValue(undefined),
  };
}

function renderNode(data: AgentNodeData) {
  // 组件仅使用 data；其余 NodeProps 字段在运行时用不到。
  const props = { data } as unknown as NodeProps<AgentNodeType>;
  return render(<AgentNode {...props} />);
}

describe("AgentNode", () => {
  it("idle：显示空闲徽标和启动按钮，输入后启动会带上 prompt", () => {
    const actions = makeActions();
    const data: AgentNodeData = { view: newAgentView("agent_1"), actions };
    renderNode(data);

    expect(screen.getByText("空闲")).toBeTruthy();
    const startBtn = screen.getByText("▶ 启动") as HTMLButtonElement;
    expect(startBtn.disabled).toBe(true); // 没输入时禁用

    fireEvent.change(screen.getByPlaceholderText("输入任务/提示词…"), {
      target: { value: "写个 a+b" },
    });
    expect((screen.getByText("▶ 启动") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByText("▶ 启动"));
    expect(actions.start).toHaveBeenCalledWith("agent_1", { prompt: "写个 a+b" });
  });

  it("running：显示运行中徽标和停止按钮", () => {
    const data: AgentNodeData = {
      view: newAgentView("agent_2", { status: "running" }),
      actions: makeActions(),
    };
    renderNode(data);
    expect(screen.getByText("运行中")).toBeTruthy();
    expect(screen.getByText("停止")).toBeTruthy();
  });

  it("waiting_input：可发送干预指令", () => {
    const actions = makeActions();
    const data: AgentNodeData = {
      view: newAgentView("agent_3", {
        status: "waiting_input",
        lines: [{ kind: "assistant", text: "我做完了第一步" }],
      }),
      actions,
    };
    renderNode(data);

    expect(screen.getByText("待输入")).toBeTruthy();
    expect(screen.getByText("我做完了第一步")).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText("追加指令（中途干预）…"), {
      target: { value: "再翻译成英文" },
    });
    fireEvent.click(screen.getByText("发送"));
    expect(actions.send).toHaveBeenCalledWith("agent_3", "再翻译成英文");
  });

  it("error：显示错误徽标", () => {
    const data: AgentNodeData = {
      view: newAgentView("agent_4", { status: "error" }),
      actions: makeActions(),
    };
    renderNode(data);
    expect(screen.getByText("错误")).toBeTruthy();
  });
});
