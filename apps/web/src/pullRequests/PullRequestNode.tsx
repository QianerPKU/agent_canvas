import {
  Handle,
  NodeResizer,
  Position,
  useReactFlow,
  useUpdateNodeInternals,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { GitPullRequest, Minimize2 } from "lucide-react";
import type { PullRequestFlowSnapshot } from "@agent-canvas/shared";
import { PULL_REQUEST_NODE_DIMENSIONS } from "../nodeDimensions.js";

export interface PullRequestNodeData {
  flow: PullRequestFlowSnapshot;
  onOpenDetails: (flowId: string) => void;
  windowState?: {
    minimized: boolean;
    restoreWidth?: number;
    restoreHeight?: number;
  };
  [key: string]: unknown;
}

export type PullRequestNodeType = Node<PullRequestNodeData, "pullRequest">;

export function togglePullRequestNodeWindow(
  node: PullRequestNodeType,
): Partial<PullRequestNodeType> {
  const state = node.data.windowState;
  if (state?.minimized) {
    return {
      width: state.restoreWidth ?? PULL_REQUEST_NODE_DIMENSIONS.width,
      height: state.restoreHeight ?? PULL_REQUEST_NODE_DIMENSIONS.height,
      data: {
        ...node.data,
        windowState: { ...state, minimized: false },
      },
    };
  }
  return {
    width: PULL_REQUEST_NODE_DIMENSIONS.minimizedWidth,
    height: PULL_REQUEST_NODE_DIMENSIONS.minimizedHeight,
    data: {
      ...node.data,
      windowState: {
        minimized: true,
        restoreWidth:
          node.width ?? node.measured?.width ?? PULL_REQUEST_NODE_DIMENSIONS.width,
        restoreHeight:
          node.height ?? node.measured?.height ?? PULL_REQUEST_NODE_DIMENSIONS.height,
      },
    },
  };
}

export function PullRequestNode({
  id,
  data,
}: NodeProps<PullRequestNodeType>): React.ReactElement {
  const { flow, onOpenDetails } = data;
  const reactFlow = useReactFlow<PullRequestNodeType>();
  const updateNodeInternals = useUpdateNodeInternals();
  const minimized = data.windowState?.minimized === true;
  const meta = statusMeta(flow.status);

  const toggleMinimized = (event: React.MouseEvent) => {
    event.stopPropagation();
    reactFlow.updateNode(id, togglePullRequestNodeWindow);
    requestAnimationFrame(() => updateNodeInternals(id));
  };

  if (minimized) {
    return (
      <div className="pr-node pr-node--minimized">
        <button
          className="resource-node__restore drag-handle"
          title={`恢复 PR 节点 ${flow.id}`}
          onClick={toggleMinimized}
        >
          <GitPullRequest size={16} />
          <span>PR</span>
        </button>
        <PullRequestHandle />
      </div>
    );
  }

  return (
    <article
      className="pr-node"
      style={{ borderTopColor: meta.color }}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("button, .react-flow__resize-control")) return;
        onOpenDetails(flow.id);
      }}
    >
      <NodeResizer
        isVisible
        minWidth={230}
        minHeight={150}
        maxWidth={660}
        maxHeight={560}
        color="#94a3b8"
        lineStyle={{ opacity: 0.55 }}
        handleStyle={{ width: 8, height: 8, borderRadius: 2 }}
      />
      <PullRequestHandle />
      <header className="pr-node__header drag-handle">
        <GitPullRequest size={16} />
        <strong>{flow.title || flow.id}</strong>
        <button
          className="icon-button nodrag"
          title="最小化 PR 节点"
          onClick={toggleMinimized}
        >
          <Minimize2 size={13} />
        </button>
      </header>
      <div className="pr-node__body nodrag">
        <span style={{ color: meta.color }}>{meta.label}</span>
        <p>{flow.summary}</p>
        <small>
          {flow.sourceBranch} → {flow.targetBranch} · {flow.files.length} files
        </small>
      </div>
    </article>
  );
}

function PullRequestHandle(): React.ReactElement {
  return (
    <Handle
      type="target"
      position={Position.Left}
      className="pr-node__handle"
      title="PR 来源"
    />
  );
}

export function statusMeta(status: PullRequestFlowSnapshot["status"]): {
  label: string;
  color: string;
} {
  const labels: Record<PullRequestFlowSnapshot["status"], { label: string; color: string }> = {
    queued: { label: "排队等待审核", color: "#64748b" },
    source_review_collecting: { label: "源 branch 审核中", color: "#2563eb" },
    source_review_failed: { label: "源 branch 已拒绝", color: "#dc2626" },
    create_pr_authorized: { label: "正在提交 PR", color: "#7c3aed" },
    target_review_collecting: { label: "接收方审核中", color: "#2563eb" },
    target_review_failed: { label: "接收方已拒绝", color: "#dc2626" },
    merge_authorized: { label: "等待合并", color: "#7c3aed" },
    merged: { label: "已 merged", color: "#16a34a" },
    timed_out: { label: "超时 closed", color: "#b45309" },
    cancelled: { label: "已取消 closed", color: "#64748b" },
    blocked: { label: "阻塞 closed", color: "#dc2626" },
  };
  return labels[status];
}
