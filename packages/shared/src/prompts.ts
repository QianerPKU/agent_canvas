import type { FileConnectionAccess } from "./files.js";

export type CanvasPromptKind = "normal" | "shared";
export type PromptConnectionAccess = FileConnectionAccess;

export interface CanvasPromptNode {
  id: string;
  name: string;
  content: string;
  kind: CanvasPromptKind;
  sharedRead: boolean;
  sharedWrite: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CreateCanvasPromptInput {
  name: string;
  content: string;
  kind: CanvasPromptKind;
}

export interface UpdateCanvasPromptInput {
  name?: string;
  content?: string;
  sharedRead?: boolean;
  sharedWrite?: boolean;
}

export interface CanvasPromptConnection {
  id: string;
  promptId: string;
  agentId: string;
  access: PromptConnectionAccess;
}

export interface AgentPromptReference {
  id: string;
  name: string;
  content: string;
  kind: CanvasPromptKind;
}

export interface AgentPromptWriteTarget {
  id: string;
  name: string;
  path: string;
}

export interface AgentPromptAccess {
  readablePrompts: AgentPromptReference[];
  writablePrompts: AgentPromptWriteTarget[];
  writableDirectories: string[];
}

export function emptyAgentPromptAccess(): AgentPromptAccess {
  return { readablePrompts: [], writablePrompts: [], writableDirectories: [] };
}
