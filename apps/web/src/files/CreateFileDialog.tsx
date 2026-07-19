import { useEffect, useId, useRef, useState } from "react";
import { FilePlus2, FolderOpen, X } from "lucide-react";
import type {
  CanvasFileImportMode,
  CanvasFileKind,
  CreateCanvasFileInput,
  ImportPickedCanvasFilesInput,
  PickedCanvasFile,
  PickedCanvasFileSelection,
} from "@agent-canvas/shared";
import { isPickedFileSelectionExpiredError } from "../api.js";
import type { DroppedFileImportResult } from "../useAgentCanvas.js";

export interface CreateFileDialogProps {
  droppedFiles?: File[];
  onCreate: (input: CreateCanvasFileInput) => Promise<void>;
  onPick: () => Promise<PickedCanvasFileSelection | null>;
  onReleasePickedSelection?: (selectionId: string) => Promise<void>;
  onImportPicked: (input: ImportPickedCanvasFilesInput) => Promise<void>;
  onImportDropped: (
    files: File[],
    kind: CanvasFileKind,
    placementIndexes: number[],
  ) => Promise<DroppedFileImportResult>;
  onClose: () => void;
}

export function CreateFileDialog({
  droppedFiles = [],
  onCreate,
  onPick,
  onReleasePickedSelection,
  onImportPicked,
  onImportDropped,
  onClose,
}: CreateFileDialogProps): React.ReactElement {
  const [name, setName] = useState("");
  const [extension, setExtension] = useState("txt");
  const [kind, setKind] = useState<CanvasFileKind>("normal");
  const [mode, setMode] = useState<CanvasFileImportMode>("copy");
  const [selection, setSelection] = useState<PickedCanvasFileSelection | null>(null);
  const [selectionExpired, setSelectionExpired] = useState(false);
  const [pendingDroppedFiles, setPendingDroppedFiles] = useState(() =>
    droppedFiles.map((file, placementIndex) => ({ file, placementIndex })),
  );
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [picking, setPicking] = useState(false);
  const selectionRef = useRef<PickedCanvasFileSelection | null>(null);
  const dialogRef = useRef<HTMLFormElement | null>(null);
  const mountedRef = useRef(false);
  const releaseHandlerRef = useRef(onReleasePickedSelection);
  const titleId = useId();
  const isDroppedImport = pendingDroppedFiles.length > 0;
  const isPickedImport = !isDroppedImport && selection !== null;
  const isImport = isDroppedImport || isPickedImport;
  const busy = submitting || picking;

  selectionRef.current = selection;
  releaseHandlerRef.current = onReleasePickedSelection;

  const releaseSelection = (picked: PickedCanvasFileSelection | null) => {
    const release = releaseHandlerRef.current;
    if (!picked || !release) return;
    void release(picked.id).catch(() => undefined);
  };

  const requestClose = () => {
    if (busy) return;
    const picked = selectionRef.current;
    selectionRef.current = null;
    setSelection(null);
    releaseSelection(picked);
    onClose();
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) requestClose();
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
      )];
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose, onReleasePickedSelection]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      releaseSelection(selectionRef.current);
      selectionRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!isImport) return;
    dialogRef.current
      ?.querySelector<HTMLButtonElement>("fieldset .segmented-control button")
      ?.focus();
  }, [isImport, selection?.id]);

  const browse = async () => {
    setPicking(true);
    setError("");
    try {
      const nextSelection = await onPick();
      if (!mountedRef.current) {
        releaseSelection(nextSelection);
        return;
      }
      if (nextSelection) {
        const previous = selectionRef.current;
        selectionRef.current = nextSelection;
        setSelection(nextSelection);
        setSelectionExpired(false);
        if (previous?.id !== nextSelection.id) releaseSelection(previous);
      }
    } catch (reason) {
      if (mountedRef.current) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (mountedRef.current) setPicking(false);
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      if (isDroppedImport) {
        const result = await onImportDropped(
          pendingDroppedFiles.map((pending) => pending.file),
          kind,
          pendingDroppedFiles.map((pending) => pending.placementIndex),
        );
        if (result.failures.length > 0) {
          const pendingByFile = new Map(
            pendingDroppedFiles.map((pending) => [pending.file, pending] as const),
          );
          setPendingDroppedFiles(
            result.failures.map(
              (failure) =>
                pendingByFile.get(failure.file) ?? {
                  file: failure.file,
                  placementIndex: pendingDroppedFiles.length,
                },
            ),
          );
          const successful = result.imported.length;
          setError(
            `${successful > 0 ? `${successful} 个文件已创建；` : ""}${result.failures.length} 个文件导入失败，请修正后重试。\n${result.failures
              .map((failure) => `${failure.file.name}: ${failure.reason}`)
              .join("\n")}`,
          );
          return;
        }
      } else if (selection) {
        try {
          await onImportPicked({ selectionId: selection.id, mode, kind });
          selectionRef.current = null;
          setSelection(null);
        } catch (reason) {
          if (isPickedFileSelectionExpiredError(reason)) {
            selectionRef.current = null;
            setSelection(null);
            setSelectionExpired(true);
            releaseSelection(selection);
            throw new Error(`${reason.message}；本次文件选择已失效，请重新浏览。`);
          }
          throw reason;
        }
      } else {
        await onCreate({
          name: name.trim(),
          extension,
          kind,
          storage: "isolated",
        });
      }
      selectionRef.current = null;
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSubmitting(false);
    }
  };

  const importedFiles: PickedCanvasFile[] = isDroppedImport
    ? pendingDroppedFiles.map((pending) => pickedFileFromBrowserFile(pending.file))
    : selection?.files ?? [];

  return (
    <div className="file-dialog-backdrop" role="presentation" onMouseDown={requestClose}>
      <form
        ref={dialogRef}
        className="file-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={busy}
        onSubmit={submit}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <FilePlus2 size={17} />
          <strong id={titleId}>{isImport ? "导入文件节点" : "新建文件节点"}</strong>
          <button
            type="button"
            className="icon-button"
            title="关闭"
            disabled={busy}
            onClick={requestClose}
          >
            <X size={16} />
          </button>
        </header>

        {isImport ? (
          <section className="file-dialog__selection" aria-label="待导入文件">
            <div>
              <span>已选择 {importedFiles.length} 个文件</span>
              {!isDroppedImport && (
                <button type="button" disabled={picking || submitting} onClick={() => void browse()}>
                  <FolderOpen size={14} />
                  重新浏览
                </button>
              )}
            </div>
            <ul>
              {importedFiles.map((file, index) => (
                <li key={`${file.filename}:${index}`}>
                  <strong title={file.filename}>{file.filename}</strong>
                  <span>{formatFileSize(file.size)}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : (
        <label className="file-dialog__field">
          <span>文件名</span>
          <div className="file-dialog__filename file-dialog__filename--browse">
            <input
              aria-label="新文件名"
              value={name}
              autoFocus
              placeholder="notes"
              onChange={(event) => setName(event.target.value)}
            />
            <input
              aria-label="新文件后缀"
              value={extension}
              placeholder="txt"
              onChange={(event) => setExtension(event.target.value)}
            />
            <button
              type="button"
              className="file-dialog__browse"
              disabled={picking || submitting}
              onClick={() => void browse()}
            >
              <FolderOpen size={15} />
              浏览
            </button>
          </div>
        </label>
        )}

        <fieldset>
          <legend>节点范围</legend>
          <Segmented
            value={kind}
            autoFocusFirst={isImport}
            options={[
              ["normal", "隔离节点"],
              ["shared", "共享节点"],
            ]}
            onChange={(value) => setKind(value as CanvasFileKind)}
          />
        </fieldset>

        {isPickedImport && (
          <fieldset>
            <legend>文件存储</legend>
            <Segmented
              value={mode}
              options={[
                ["copy", "复制到项目"],
                ["reference", "仅引用原文件"],
              ]}
              onChange={(value) => setMode(value as CanvasFileImportMode)}
            />
            {mode === "reference" && (
              <p className="file-dialog__hint">引用文件保持在原位置，并始终以只读方式提供给 Agent。</p>
            )}
          </fieldset>
        )}

        {isDroppedImport && (
          <section className="file-dialog__drop-mode">
            <strong>复制到项目</strong>
            <span>浏览器不会提供拖入文件的可信原路径，因此拖入文件固定使用复制模式。</span>
          </section>
        )}

        {error && <div className="file-dialog__error" role="alert">{error}</div>}
        <footer>
          <button type="button" disabled={busy} onClick={requestClose}>
            取消
          </button>
          <button
            type="submit"
            className="file-dialog__primary"
            disabled={
              (!isImport && !name.trim()) ||
              selectionExpired ||
              submitting ||
              picking
            }
          >
            {isImport ? `创建 ${importedFiles.length} 个节点` : "创建"}
          </button>
        </footer>
      </form>
    </div>
  );
}

function pickedFileFromBrowserFile(file: File): PickedCanvasFile {
  const separator = file.name.lastIndexOf(".");
  const hasExtension = separator > 0 && separator < file.name.length - 1;
  return {
    name: hasExtension ? file.name.slice(0, separator) : file.name,
    extension: hasExtension ? file.name.slice(separator + 1) : "",
    filename: file.name,
    size: file.size,
  };
}

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function Segmented({
  value,
  options,
  onChange,
  autoFocusFirst = false,
}: {
  value: string;
  options: Array<[string, string]>;
  onChange: (value: string) => void;
  autoFocusFirst?: boolean;
}): React.ReactElement {
  return (
    <div className="segmented-control">
      {options.map(([option, label], index) => (
        <button
          key={option}
          type="button"
          className={option === value ? "is-active" : ""}
          aria-pressed={option === value}
          autoFocus={autoFocusFirst && index === 0}
          onClick={() => onChange(option)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
