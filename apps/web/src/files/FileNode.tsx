import { useEffect, useState } from "react";
import {
  Handle,
  NodeResizer,
  Position,
  useReactFlow,
  useUpdateNodeInternals,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import {
  AlertTriangle,
  Check,
  ExternalLink,
  Eye,
  File,
  FileText,
  Image,
  Minimize2,
  Pencil,
  RefreshCw,
  X,
} from "lucide-react";
import type { AgentResultReportKind, CanvasFileNode } from "@agent-canvas/shared";
import { api } from "../api.js";
import type { FileActions } from "../useAgentCanvas.js";
import { FILE_NODE_DIMENSIONS } from "../nodeDimensions.js";

export interface FileNodeData {
  file: CanvasFileNode;
  actions: FileActions;
  onPreview: (fileId: string) => void;
  onOpenEditor: (fileId: string) => void;
  windowState?: {
    minimized: boolean;
    restoreWidth?: number;
    restoreHeight?: number;
  };
  [key: string]: unknown;
}

export type FileNodeType = Node<FileNodeData, "file">;

const REFERENCE_REFRESH_INTERVAL_MS = 10_000;

export function toggleFileNodeWindow(node: FileNodeType): Partial<FileNodeType> {
  const state = node.data.windowState;
  if (state?.minimized) {
    return {
      width: state.restoreWidth ?? FILE_NODE_DIMENSIONS.width,
      height: state.restoreHeight ?? FILE_NODE_DIMENSIONS.height,
      data: {
        ...node.data,
        windowState: { ...state, minimized: false },
      },
    };
  }
  return {
    width: FILE_NODE_DIMENSIONS.minimizedWidth,
    height: FILE_NODE_DIMENSIONS.minimizedHeight,
    data: {
      ...node.data,
      windowState: {
        minimized: true,
        restoreWidth:
          node.width ?? node.measured?.width ?? FILE_NODE_DIMENSIONS.width,
        restoreHeight:
          node.height ?? node.measured?.height ?? FILE_NODE_DIMENSIONS.height,
      },
    },
  };
}

export function FileNode({ id, data }: NodeProps<FileNodeType>): React.ReactElement {
  const { file, actions, onPreview, onOpenEditor } = data;
  const reactFlow = useReactFlow<FileNodeType>();
  const updateNodeInternals = useUpdateNodeInternals();
  const [preview, setPreview] = useState("");
  const [previewError, setPreviewError] = useState("");
  const [imageVersion, setImageVersion] = useState(() => Date.now());
  const [imageError, setImageError] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [relinking, setRelinking] = useState(false);
  const [relinkError, setRelinkError] = useState("");
  const [name, setName] = useState(file.name);
  const [extension, setExtension] = useState(file.extension);
  const minimized = data.windowState?.minimized === true;
  const isAgentResult = file.origin?.kind === "agent_result";
  const isReferenced = file.storage === "referenced";
  const referenceMissing = isReferenced && file.availability === "missing";

  useEffect(() => {
    setName(file.name);
    setExtension(file.extension);
  }, [file.name, file.extension]);

  useEffect(() => {
    if (file.storage === "referenced" && file.availability === "missing") return;
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
          if (!cancelled) {
            setPreviewError(error.message);
            if (isReferenced) void actions.refresh(file.id).catch(() => undefined);
          }
        },
      );
    };
    load();
    const timer = window.setInterval(load, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    actions,
    file.availability,
    file.id,
    file.previewKind,
    file.storage,
    file.updatedAt,
    isReferenced,
  ]);

  useEffect(() => {
    if (file.storage !== "referenced") return;
    if (file.availability !== "missing" && file.previewKind !== "none") return;
    let cancelled = false;
    let timer: number | undefined;
    const refreshAvailability = async () => {
      try {
        await actions.refresh(file.id);
      } catch {
        // Preview requests surface actionable errors; this probe only keeps availability fresh.
      } finally {
        if (!cancelled) {
          timer = window.setTimeout(refreshAvailability, REFERENCE_REFRESH_INTERVAL_MS);
        }
      }
    };
    void refreshAvailability();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [actions, file.availability, file.id, file.previewKind, file.storage]);

  useEffect(() => {
    if (file.storage === "referenced" && file.availability === "missing") return;
    if (file.previewKind !== "image") return;
    setImageError(false);
    setImageVersion(Date.now());
    const timer = window.setInterval(() => {
      setImageError(false);
      setImageVersion(Date.now());
    }, 2000);
    return () => window.clearInterval(timer);
  }, [file.availability, file.id, file.previewKind, file.storage, file.updatedAt]);

  const finishRename = async () => {
    await actions.update(
      file.id,
      isReferenced ? { name: name.trim() } : { name: name.trim(), extension },
    );
    setRenaming(false);
  };

  const relink = async () => {
    setRelinking(true);
    setRelinkError("");
    try {
      await actions.relink(file.id);
    } catch (error) {
      setRelinkError(error instanceof Error ? error.message : String(error));
    } finally {
      setRelinking(false);
    }
  };

  const toggleMinimized = (event: React.MouseEvent) => {
    event.stopPropagation();
    reactFlow.updateNode(id, toggleFileNodeWindow);
    requestAnimationFrame(() => updateNodeInternals(id));
  };

  if (minimized) {
    return (
      <div className="file-node file-node--minimized">
        <button
          className="resource-node__restore drag-handle"
          title={`恢复文件节点 ${file.filename}`}
          onClick={toggleMinimized}
        >
          <FileKindIcon file={file} />
          <span>{isAgentResult ? "结果" : "文件"}</span>
        </button>
        <FileNodeHandles file={file} />
      </div>
    );
  }

  return (
    <div className="file-node">
      <NodeResizer
        isVisible
        minWidth={240}
        minHeight={180}
        maxWidth={720}
        maxHeight={720}
        color="#94a3b8"
        lineStyle={{ opacity: 0.55 }}
        handleStyle={{ width: 8, height: 8, borderRadius: 2 }}
      />
      <FileNodeHandles file={file} />

      <div className="file-node__header drag-handle">
        <FileKindIcon file={file} />
        {renaming ? (
          <div
            className={
              isReferenced
                ? "file-node__rename file-node__rename--referenced nodrag"
                : "file-node__rename nodrag"
            }
          >
            <input
              aria-label="文件名"
              value={name}
              autoFocus
              onChange={(event) => setName(event.target.value)}
            />
            {!isReferenced && (
              <input
                aria-label="文件后缀"
                value={extension}
                placeholder="无后缀"
                onChange={(event) => setExtension(event.target.value)}
              />
            )}
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
              title="最小化文件节点"
              onClick={toggleMinimized}
            >
              <Minimize2 size={13} />
            </button>
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
        className={`file-node__preview nodrag nowheel${referenceMissing ? " file-node__preview--missing" : ""}`}
        role={referenceMissing ? undefined : "button"}
        tabIndex={referenceMissing ? undefined : 0}
        aria-label={referenceMissing ? undefined : `用 VS Code 打开 ${file.filename}`}
        onClick={referenceMissing ? undefined : () => onOpenEditor(file.id)}
        onKeyDown={
          referenceMissing
            ? undefined
            : (event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onOpenEditor(file.id);
                }
              }
        }
      >
        {referenceMissing ? (
          <div className="file-node__reference-error">
            <AlertTriangle size={28} />
            <strong>外部引用失效</strong>
            <span>{relinkError || "原文件已移动、删除或暂时无法读取。"}</span>
            <button
              type="button"
              disabled={relinking}
              onClick={(event) => {
                event.stopPropagation();
                void relink();
              }}
            >
              <RefreshCw size={13} />
              {relinking ? "正在定位…" : "重新定位"}
            </button>
          </div>
        ) : file.previewKind === "image" ? (
          imageError ? (
            isReferenced ? (
              <div className="file-node__binary file-node__binary--error">
                <Image size={32} />
                <strong>图片预览失败</strong>
                <span>原文件仍可用，可点击此区域在 VS Code 中打开。</span>
              </div>
            ) : (
              <div className="file-node__binary">
                <Image size={32} />
                <span>等待图片内容</span>
              </div>
            )
          ) : (
            <img
              src={api.fileRawUrl(file.id, imageVersion)}
              alt={file.filename}
              onLoad={() => setImageError(false)}
              onError={() => {
                setImageError(true);
                if (isReferenced) void actions.refresh(file.id).catch(() => undefined);
              }}
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
        <span>
          {isAgentResult
            ? "Agent 汇报结果"
            : isReferenced
              ? "外部引用 · 只读"
              : "项目文件"}
        </span>
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
            {!isReferenced && (
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
            )}
          </div>
        ) : (
          <span className="file-node__badge">
            {isAgentResult ? resultKindLabel(file.origin?.resultKind) : "隔离"}
          </span>
        )}
      </div>
    </div>
  );
}

function FileNodeHandles({ file }: { file: CanvasFileNode }): React.ReactElement | null {
  if (file.kind !== "normal") return null;
  return (
    <>
      {file.storage !== "referenced" && (
        <>
          <Handle
            id="write"
            type="target"
            position={Position.Left}
            className="file-node__handle file-node__handle--write"
            title="Agent 输出连接到这里：允许写入"
          />
          <span className="file-node__handle-label file-node__handle-label--write">写</span>
        </>
      )}
      <Handle
        id="read"
        type="source"
        position={Position.Right}
        className="file-node__handle file-node__handle--read"
        title="连接到 Agent 输入：允许读取"
      />
      <span className="file-node__handle-label file-node__handle-label--read">读</span>
    </>
  );
}

function resultKindLabel(kind: AgentResultReportKind | undefined): string {
  if (kind === "image") return "图片";
  if (kind === "table") return "表格";
  if (kind === "document") return "文档";
  return "结果";
}

function FileKindIcon({ file }: { file: CanvasFileNode }): React.ReactElement {
  if (file.previewKind === "image") return <Image size={16} />;
  if (file.previewKind === "none") return <File size={16} />;
  return <FileText size={16} />;
}
