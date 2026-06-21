import {
  Handle,
  NodeResizer,
  Position,
  useReactFlow,
  useUpdateNodeInternals,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { GitCommitHorizontal, Minimize2 } from "lucide-react";
import type { AgentCommitSnapshot } from "@agent-canvas/shared";

export interface CommitNodeData {
  commit: AgentCommitSnapshot;
  onOpenDetails: (commitId: string) => void;
  windowState?: {
    minimized: boolean;
    restoreWidth?: number;
    restoreHeight?: number;
  };
  [key: string]: unknown;
}

export type CommitNodeType = Node<CommitNodeData, "commit">;

export function toggleCommitNodeWindow(node: CommitNodeType): Partial<CommitNodeType> {
  const state = node.data.windowState;
  if (state?.minimized) {
    return {
      width: state.restoreWidth ?? 260,
      height: state.restoreHeight ?? 170,
      data: {
        ...node.data,
        windowState: { ...state, minimized: false },
      },
    };
  }
  return {
    width: 76,
    height: 50,
    data: {
      ...node.data,
      windowState: {
        minimized: true,
        restoreWidth: node.width ?? node.measured?.width ?? 260,
        restoreHeight: node.height ?? node.measured?.height ?? 170,
      },
    },
  };
}

export function CommitNode({ id, data }: NodeProps<CommitNodeType>): React.ReactElement {
  const { commit, onOpenDetails } = data;
  const reactFlow = useReactFlow<CommitNodeType>();
  const updateNodeInternals = useUpdateNodeInternals();
  const minimized = data.windowState?.minimized === true;

  const toggleMinimized = (event: React.MouseEvent) => {
    event.stopPropagation();
    reactFlow.updateNode(id, toggleCommitNodeWindow);
    requestAnimationFrame(() => updateNodeInternals(id));
  };

  if (minimized) {
    return (
      <div className="commit-node commit-node--minimized">
        <button
          className="resource-node__restore drag-handle"
          title={`恢复 commit ${commit.shortSha}`}
          onClick={toggleMinimized}
        >
          <GitCommitHorizontal size={16} />
          <span>{commit.shortSha}</span>
        </button>
        <CommitHandle />
      </div>
    );
  }

  return (
    <article
      className="commit-node"
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("button, .react-flow__resize-control")) return;
        onOpenDetails(commit.id);
      }}
    >
      <NodeResizer
        isVisible
        minWidth={220}
        minHeight={140}
        maxWidth={620}
        maxHeight={520}
        color="#94a3b8"
        lineStyle={{ opacity: 0.55 }}
        handleStyle={{ width: 8, height: 8, borderRadius: 2 }}
      />
      <CommitHandle />
      <header className="commit-node__header drag-handle">
        <GitCommitHorizontal size={16} />
        <strong>{commit.shortSha}</strong>
        <button
          className="icon-button nodrag"
          title="最小化 commit 节点"
          onClick={toggleMinimized}
        >
          <Minimize2 size={13} />
        </button>
      </header>
      <div className="commit-node__body nodrag">
        <p>{commit.summary}</p>
        <small>
          {commit.branch ?? "unknown branch"} · {commit.files.length} files · {commit.agentId}
        </small>
      </div>
    </article>
  );
}

function CommitHandle(): React.ReactElement {
  return (
    <Handle
      type="target"
      position={Position.Left}
      className="commit-node__handle"
      title="commit 来源"
    />
  );
}
