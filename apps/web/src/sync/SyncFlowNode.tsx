import {
  Handle,
  NodeResizer,
  Position,
  useReactFlow,
  useUpdateNodeInternals,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { GitBranch, GitCommitHorizontal, Minimize2 } from "lucide-react";
import type { SyncFlowSnapshot } from "@agent-canvas/shared";
import { flowDisplayText } from "../displayText.js";
import { SYNC_FLOW_NODE_DIMENSIONS } from "../nodeDimensions.js";

export interface SyncFlowNodeData {
  flow: SyncFlowSnapshot;
  onOpenDetails: (flowId: string) => void;
  windowState?: {
    minimized: boolean;
    restoreWidth?: number;
    restoreHeight?: number;
  };
  [key: string]: unknown;
}

export type SyncFlowNodeType = Node<SyncFlowNodeData, "syncFlow">;

export function toggleSyncFlowNodeWindow(node: SyncFlowNodeType): Partial<SyncFlowNodeType> {
  const state = node.data.windowState;
  if (state?.minimized) {
    return {
      width: state.restoreWidth ?? SYNC_FLOW_NODE_DIMENSIONS.width,
      height: state.restoreHeight ?? SYNC_FLOW_NODE_DIMENSIONS.height,
      data: {
        ...node.data,
        windowState: { ...state, minimized: false },
      },
    };
  }
  return {
    width: SYNC_FLOW_NODE_DIMENSIONS.minimizedWidth,
    height: SYNC_FLOW_NODE_DIMENSIONS.minimizedHeight,
    data: {
      ...node.data,
      windowState: {
        minimized: true,
        restoreWidth:
          node.width ?? node.measured?.width ?? SYNC_FLOW_NODE_DIMENSIONS.width,
        restoreHeight:
          node.height ?? node.measured?.height ?? SYNC_FLOW_NODE_DIMENSIONS.height,
      },
    },
  };
}

export function SyncFlowNode({ id, data }: NodeProps<SyncFlowNodeType>): React.ReactElement {
  const { flow, onOpenDetails } = data;
  const reactFlow = useReactFlow<SyncFlowNodeType>();
  const updateNodeInternals = useUpdateNodeInternals();
  const minimized = data.windowState?.minimized === true;
  const meta = syncStatusMeta(flow.status);
  const Icon = flow.kind === "cherry_pick" ? GitCommitHorizontal : GitBranch;
  const display = flowDisplayText(flow);

  const toggleMinimized = (event: React.MouseEvent) => {
    event.stopPropagation();
    reactFlow.updateNode(id, toggleSyncFlowNodeWindow);
    requestAnimationFrame(() => updateNodeInternals(id));
  };

  if (minimized) {
    return (
      <div className="sync-node sync-node--minimized">
        <button
          className="resource-node__restore drag-handle"
          title={`Restore sync node ${flow.id}`}
          onClick={toggleMinimized}
        >
          <Icon size={16} />
          <span>{flow.kind === "cherry_pick" ? "pick" : "pull"}</span>
        </button>
        <SyncFlowHandle />
      </div>
    );
  }

  return (
    <article
      className="sync-node"
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
      <SyncFlowHandle />
      <header className="sync-node__header drag-handle">
        <Icon size={16} />
        <strong>{display.title}</strong>
        <button
          className="icon-button nodrag"
          title="Minimize sync node"
          onClick={toggleMinimized}
        >
          <Minimize2 size={13} />
        </button>
      </header>
      <div className="sync-node__body nodrag">
        <span style={{ color: meta.color }}>{meta.label}</span>
        <p>{display.summary}</p>
        <small>
          {flow.sourceBranch ?? flow.commitSha ?? "commit"} -&gt; {flow.targetBranch} -{" "}
          {flow.files.length} files
        </small>
      </div>
    </article>
  );
}

function SyncFlowHandle(): React.ReactElement {
  return (
    <Handle
      type="target"
      position={Position.Left}
      className="sync-node__handle"
      title="sync source"
    />
  );
}

export function syncStatusMeta(status: SyncFlowSnapshot["status"]): {
  label: string;
  color: string;
} {
  const labels: Record<SyncFlowSnapshot["status"], { label: string; color: string }> = {
    queued: { label: "waiting for branch review", color: "#64748b" },
    review_collecting: { label: "reviewing", color: "#2563eb" },
    review_failed: { label: "review rejected", color: "#dc2626" },
    apply_authorized: { label: "authorized", color: "#7c3aed" },
    applied: { label: "applied", color: "#16a34a" },
    timed_out: { label: "timed out", color: "#b45309" },
    cancelled: { label: "cancelled", color: "#64748b" },
    blocked: { label: "blocked", color: "#dc2626" },
  };
  return labels[status];
}
