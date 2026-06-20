import { useEffect, useState } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { Check, MessageSquareText } from "lucide-react";
import type { CanvasPromptNode } from "@agent-canvas/shared";
import type { PromptActions } from "../useAgentCanvas.js";

export interface PromptNodeData {
  prompt: CanvasPromptNode;
  actions: PromptActions;
  [key: string]: unknown;
}

export type PromptNodeType = Node<PromptNodeData, "prompt">;

export function PromptNode({ data }: NodeProps<PromptNodeType>): React.ReactElement {
  const { prompt, actions } = data;
  const [name, setName] = useState(prompt.name);
  const [content, setContent] = useState(prompt.content);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const dirty = name !== prompt.name || content !== prompt.content;

  useEffect(() => {
    if (editing) return;
    setName(prompt.name);
    setContent(prompt.content);
  }, [prompt.name, prompt.content, editing]);

  const save = async () => {
    setSaving(true);
    try {
      await actions.update(prompt.id, { name: name.trim(), content });
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="prompt-node">
      {prompt.kind === "normal" && (
        <>
          <Handle
            id="write"
            type="target"
            position={Position.Left}
            className="file-node__handle file-node__handle--write"
            title="Agent 输出连接到这里：允许写入提示词"
          />
          <span className="file-node__handle-label file-node__handle-label--write">写</span>
          <Handle
            id="read"
            type="source"
            position={Position.Right}
            className="file-node__handle file-node__handle--read"
            title="连接到 Agent 输入：允许读取提示词"
          />
          <span className="file-node__handle-label file-node__handle-label--read">读</span>
        </>
      )}

      <div className="prompt-node__header drag-handle">
        <MessageSquareText size={16} />
        <input
          className="nodrag"
          aria-label="提示词节点名称"
          value={name}
          onChange={(event) => {
            setEditing(true);
            setName(event.target.value);
          }}
        />
        <button
          className="icon-button nodrag"
          title="保存提示词"
          disabled={!dirty || !name.trim() || !content.trim() || saving}
          onClick={() => void save()}
        >
          <Check size={14} />
        </button>
      </div>

      <textarea
        className="prompt-node__content nodrag nowheel"
        aria-label={`${prompt.name} 内容`}
        value={content}
        onChange={(event) => {
          setEditing(true);
          setContent(event.target.value);
        }}
      />

      <div className="file-node__footer nodrag">
        <span>直接拼接上下文</span>
        {prompt.kind === "shared" ? (
          <div className="file-node__toggles">
            <label>
              <input
                type="checkbox"
                checked={prompt.sharedRead}
                onChange={(event) =>
                  void actions.update(prompt.id, { sharedRead: event.target.checked })
                }
              />
              全局读
            </label>
            <label>
              <input
                type="checkbox"
                checked={prompt.sharedWrite}
                onChange={(event) =>
                  void actions.update(prompt.id, { sharedWrite: event.target.checked })
                }
              />
              全局写
            </label>
          </div>
        ) : (
          <span className="file-node__badge">普通</span>
        )}
      </div>
    </div>
  );
}
