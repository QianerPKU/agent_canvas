import type { AgentSharedResourceReference } from "./workspaces.js";

export type CanvasFileKind = "normal" | "shared";
export type CanvasFileStorage = "isolated";
export type FilePreviewKind = "text" | "markdown" | "csv" | "image" | "none";
export type FileConnectionAccess = "read" | "write";
export type AgentResultReportKind = "image" | "table" | "document" | "artifact";
export type AgentResultReportEncoding = "utf8" | "base64";

export interface CanvasFileOrigin {
  kind: "agent_result";
  agentId: string;
  sourceTurnIndex: number;
  resultKind?: AgentResultReportKind;
  title?: string;
  summary?: string;
}

export interface CanvasFileNode {
  id: string;
  name: string;
  extension: string;
  filename: string;
  path: string;
  storage: CanvasFileStorage;
  kind: CanvasFileKind;
  sharedRead: boolean;
  sharedWrite: boolean;
  previewKind: FilePreviewKind;
  mimeType: string;
  createdAt: number;
  updatedAt: number;
  origin?: CanvasFileOrigin;
}

export interface CreateCanvasFileInput {
  name: string;
  extension?: string;
  /** 文件节点固定使用隔离目录；保留字段便于旧调用方显式传 isolated。 */
  storage?: CanvasFileStorage;
  kind: CanvasFileKind;
}

export interface UpdateCanvasFileInput {
  name?: string;
  extension?: string;
  sharedRead?: boolean;
  sharedWrite?: boolean;
}

export interface ReportAgentResultInput {
  name: string;
  extension?: string;
  resultKind?: AgentResultReportKind;
  title?: string;
  summary?: string;
  content?: string;
  encoding?: AgentResultReportEncoding;
  sourcePath?: string;
}

export interface CanvasFileConnection {
  id: string;
  fileId: string;
  agentId: string;
  access: FileConnectionAccess;
}

export interface AgentFileReference {
  name: string;
  path: string;
  previewKind: FilePreviewKind;
}

export interface AgentFileAccess {
  readableFiles: AgentFileReference[];
  readableDirectories?: string[];
  writableFiles: AgentFileReference[];
  /** Extra provider sandbox roots that must not disable normal approval prompts. */
  sandboxWritableDirectories?: string[];
  writableDirectories: string[];
  sharedResources?: AgentSharedResourceReference[];
}

export function emptyAgentFileAccess(): AgentFileAccess {
  return {
    readableFiles: [],
    readableDirectories: [],
    writableFiles: [],
    sandboxWritableDirectories: [],
    writableDirectories: [],
    sharedResources: [],
  };
}
