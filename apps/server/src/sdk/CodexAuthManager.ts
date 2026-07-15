import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { CodexAuthStatus, CodexLoginSession } from "@agent-canvas/shared";

export interface CodexAuthManagerDeps {
  command?: string;
  spawnFn?: typeof spawn;
  now?: () => number;
}

export class CodexAuthManager {
  private readonly command: string;
  private readonly spawnFn: typeof spawn;
  private readonly now: () => number;
  private session?: LoginProcess;
  private nextId = 0;

  constructor(deps: CodexAuthManagerDeps = {}) {
    this.command = deps.command ?? "codex";
    this.spawnFn = deps.spawnFn ?? spawn;
    this.now = deps.now ?? (() => Date.now());
  }

  async status(): Promise<CodexAuthStatus> {
    const result = await runCodex(this.spawnFn, this.command, ["login", "status"]);
    const raw = `${result.stdout}${result.stderr}`.trim();
    if (result.code === 0) {
      return {
        state: /not\s+logged\s+in|unauthenticated|logged\s+out/i.test(raw)
          ? "unauthenticated"
          : "authenticated",
        message: firstLine(raw) || "Codex is authenticated",
        raw,
      };
    }
    return {
      state: /not\s+logged\s+in|unauthenticated|logged\s+out/i.test(raw)
        ? "unauthenticated"
        : "unknown",
      message: firstLine(raw) || `codex login status exited with ${result.code ?? "unknown"}`,
      raw,
    };
  }

  startDeviceLogin(): CodexLoginSession {
    if (this.session?.snapshot().state === "running") {
      return this.session.snapshot();
    }
    const id = `codex_login_${++this.nextId}`;
    this.session = new LoginProcess({
      id,
      command: this.command,
      spawnFn: this.spawnFn,
      now: this.now,
    });
    this.session.start();
    return this.session.snapshot();
  }

  loginSession(): CodexLoginSession | undefined {
    return this.session?.snapshot();
  }

  cancelLogin(): CodexLoginSession | undefined {
    this.session?.cancel();
    return this.session?.snapshot();
  }
}

interface LoginProcessDeps {
  id: string;
  command: string;
  spawnFn: typeof spawn;
  now: () => number;
}

class LoginProcess {
  private readonly id: string;
  private readonly command: string;
  private readonly spawnFn: typeof spawn;
  private readonly now: () => number;
  private proc?: ChildProcessWithoutNullStreams;
  private state: CodexLoginSession["state"] = "running";
  private startedAt: number;
  private updatedAt: number;
  private output = "";
  private loginUrl?: string;
  private userCode?: string;
  private message?: string;

  constructor(deps: LoginProcessDeps) {
    this.id = deps.id;
    this.command = deps.command;
    this.spawnFn = deps.spawnFn;
    this.now = deps.now;
    this.startedAt = deps.now();
    this.updatedAt = this.startedAt;
  }

  start(): void {
    this.proc = this.spawnFn(this.command, ["login", "--device-auth"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.proc.stdout.on("data", (chunk: Buffer) => this.append(chunk.toString("utf-8")));
    this.proc.stderr.on("data", (chunk: Buffer) => this.append(chunk.toString("utf-8")));
    this.proc.once("error", (error) => {
      this.state = "failed";
      this.message = error.message;
      this.touch();
    });
    this.proc.once("exit", (code, signal) => {
      if (this.state === "cancelled") return;
      this.state = code === 0 ? "completed" : "failed";
      this.message =
        this.state === "completed"
          ? "Codex login completed"
          : `codex login exited with ${signal ?? code ?? "unknown"}`;
      this.touch();
    });
  }

  cancel(): void {
    if (this.state !== "running") return;
    this.state = "cancelled";
    this.message = "Codex login cancelled";
    this.touch();
    this.proc?.kill();
  }

  snapshot(): CodexLoginSession {
    return {
      id: this.id,
      state: this.state,
      startedAt: this.startedAt,
      updatedAt: this.updatedAt,
      loginUrl: this.loginUrl,
      userCode: this.userCode,
      message: this.message,
      output: this.output.trim(),
    };
  }

  private append(text: string): void {
    this.output = (this.output + text).slice(-8000);
    this.loginUrl = findLoginUrl(this.output) ?? this.loginUrl;
    this.userCode = findUserCode(this.output) ?? this.userCode;
    this.message = firstLine(this.output) || this.message;
    this.touch();
  }

  private touch(): void {
    this.updatedAt = this.now();
  }
}

function runCodex(
  spawnFn: typeof spawn,
  command: string,
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawnFn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    proc.once("error", reject);
    proc.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

function findLoginUrl(text: string): string | undefined {
  return text.match(/https?:\/\/\S+/u)?.[0]?.replace(/[).,;]+$/u, "");
}

function findUserCode(text: string): string | undefined {
  return (
    text.match(/(?:code|enter)\s*[:：]\s*([A-Z0-9-]{4,})/iu)?.[1] ??
    text.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/u)?.[1]
  );
}

function firstLine(text: string): string | undefined {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
}
