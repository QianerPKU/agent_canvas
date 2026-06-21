import type { AgentSharedResourceReference } from "./workspaces.js";

export type CanvasFileKind = "normal" | "shared";
export type CanvasFileStorage = "isolated";
export type FilePreviewKind = "text" | "markdown" | "csv" | "image" | "none";
export type FileConnectionAccess = "read" | "write";

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
  writableDirectories: string[];
  sharedResources?: AgentSharedResourceReference[];
}

export function emptyAgentFileAccess(): AgentFileAccess {
  return {
    readableFiles: [],
    readableDirectories: [],
    writableFiles: [],
    writableDirectories: [],
    sharedResources: [],
  };
}
