export type CanvasFileKind = "normal" | "shared";
export type CanvasFileStorage = "agent" | "isolated";
export type FilePreviewKind = "text" | "markdown" | "csv" | "image" | "none";
export type FileConnectionAccess = "read" | "write";

export interface CanvasFileNode {
  id: string;
  name: string;
  extension: string;
  filename: string;
  path: string;
  storage: CanvasFileStorage;
  agentId?: string;
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
  storage: CanvasFileStorage;
  agentId?: string;
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
  writableFiles: AgentFileReference[];
  writableDirectories: string[];
}

export function emptyAgentFileAccess(): AgentFileAccess {
  return { readableFiles: [], writableFiles: [], writableDirectories: [] };
}
