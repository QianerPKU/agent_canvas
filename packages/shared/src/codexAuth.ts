export type CodexAuthState = "authenticated" | "unauthenticated" | "unknown";

export type CodexLoginSessionState = "running" | "completed" | "failed" | "cancelled";

export interface CodexAuthStatus {
  state: CodexAuthState;
  message?: string;
  raw?: string;
}

export interface CodexLoginSession {
  id: string;
  state: CodexLoginSessionState;
  startedAt: number;
  updatedAt: number;
  loginUrl?: string;
  userCode?: string;
  message?: string;
  output: string;
}
