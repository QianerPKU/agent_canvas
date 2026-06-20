import { useEffect, useState } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { Check, ExternalLink, Eye, File, FileText, Image, Pencil, X } from "lucide-react";
import type { CanvasFileNode } from "@agent-canvas/shared";
import { api } from "../api.js";
import type { FileActions } from "../useAgentCanvas.js";

export interface FileNodeData {
  file: CanvasFileNode;
  actions: FileActions;
  onPreview: (fileId: string) => void;
  onOpenEditor: (fileId: string) => void;
  [key: string]: unknown;
}

export type FileNodeType = Node<FileNodeData, "file">;

export function FileNode({ data }: NodeProps<FileNodeType>): React.ReactElement {
  const { file, actions, onPreview, onOpenEditor } = data;
  const [preview, setPreview] = useState("");
  const [previewError, setPreviewError] = useState("");
  const [imageVersion, setImageVersion] = useState(() => Date.now());
  const [imageError, setImageError] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(file.name);
  const [extension, setExtension] = useState(file.extension);

  useEffect(() => {
    setName(file.name);
    setExtension(file.extension);
  }, [file.name, file.extension]);

  useEffect(() => {
    if (file.previewKind === "image" || file.previewKind === "none") return;
    let cancelled = false;
    const load = () => {
      void api.fileContent(file.id).then(
        (result) => {
          if (!cancelled) {
            setPreview(result.content);
            setPreviewError("");
          }
        },
        (error: Error) => {
          if (!cancelled) setPreviewError(error.message);
        },
      );
    };
    load();
    const timer = window.setInterval(load, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [file.id, file.previewKind, file.updatedAt]);

  useEffect(() => {
    if (file.previewKind !== "image") return;
    setImageError(false);
    setImageVersion(Date.now());
    const timer = window.setInterval(() => {
      setImageError(false);
      setImageVersion(Date.now());
    }, 2000);
    return () => window.clearInterval(timer);
  }, [file.id, file.previewKind, file.updatedAt]);

  const finishRename = async () => {
    await actions.update(file.id, { name: name.trim(), extension });
    setRenaming(false);
  };

  return (
    <div className="file-node">
      {file.kind === "normal" && (
        <>
          <Handle
            id="write"
            type="target"
            position={Position.Left}
            className="file-node__handle file-node__handle--write"
            title="Agent 输出连接到这里：允许写入"
          />
          <span className="file-node__handle-label file-node__handle-label--write">写</span>
          <Handle
            id="read"
            type="source"
            position={Position.Right}
            className="file-node__handle file-node__handle--read"
            title="连接到 Agent 输入：允许读取"
          />
          <span className="file-node__handle-label file-node__handle-label--read">读</span>
        </>
      )}

      <div className="file-node__header drag-handle">
        <FileKindIcon file={file} />
        {renaming ? (
          <div className="file-node__rename nodrag">
            <input
              aria-label="文件名"
              value={name}
              autoFocus
              onChange={(event) => setName(event.target.value)}
            />
            <input
              aria-label="文件后缀"
              value={extension}
              placeholder="无后缀"
              onChange={(event) => setExtension(event.target.value)}
            />
            <button className="icon-button" title="确认重命名" onClick={() => void finishRename()}>
              <Check size={14} />
            </button>
            <button className="icon-button" title="取消重命名" onClick={() => setRenaming(false)}>
              <X size={14} />
            </button>
          </div>
        ) : (
          <>
            <strong title={file.path}>{file.filename}</strong>
            <button
              className="icon-button nodrag"
              title="用 VS Code 打开"
              onClick={() => onOpenEditor(file.id)}
            >
              <ExternalLink size={14} />
            </button>
            <button
              className="icon-button nodrag"
              title="查看完整内容"
              onClick={() => onPreview(file.id)}
            >
              <Eye size={14} />
            </button>
            <button
              className="icon-button nodrag"
              title="重命名文件"
              onClick={() => setRenaming(true)}
            >
              <Pencil size={13} />
            </button>
          </>
        )}
      </div>

      <div
        className="file-node__preview nodrag nowheel"
        role="button"
        tabIndex={0}
        aria-label={`用 VS Code 打开 ${file.filename}`}
        onClick={() => onOpenEditor(file.id)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onOpenEditor(file.id);
          }
        }}
      >
        {file.previewKind === "image" ? (
          imageError ? (
            <div className="file-node__binary">
              <Image size={32} />
              <span>等待图片内容</span>
            </div>
          ) : (
            <img
              src={api.fileRawUrl(file.id, imageVersion)}
              alt={file.filename}
              onError={() => setImageError(true)}
            />
          )
        ) : file.previewKind === "none" ? (
          <div className="file-node__binary">
            <File size={32} />
            <span>{file.filename}</span>
          </div>
        ) : previewError ? (
          <span className="file-node__error">{previewError}</span>
        ) : (
          <pre>{preview || "空文件"}</pre>
        )}
      </div>

      <div className="file-node__footer nodrag">
        <span>{file.storage === "agent" ? "Agent 工作目录" : "隔离目录"}</span>
        {file.kind === "shared" ? (
          <div className="file-node__toggles">
            <label>
              <input
                type="checkbox"
                checked={file.sharedRead}
                onChange={(event) =>
                  void actions.update(file.id, { sharedRead: event.target.checked })
                }
              />
              全局读
            </label>
            <label>
              <input
                type="checkbox"
                checked={file.sharedWrite}
                onChange={(event) =>
                  void actions.update(file.id, { sharedWrite: event.target.checked })
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

function FileKindIcon({ file }: { file: CanvasFileNode }): React.ReactElement {
  if (file.previewKind === "image") return <Image size={16} />;
  if (file.previewKind === "none") return <File size={16} />;
  return <FileText size={16} />;
}
