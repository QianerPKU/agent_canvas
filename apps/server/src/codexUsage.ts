import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import type { CodexUsageSnapshot } from "@agent-canvas/shared";

interface JsonRpcMessage {
  id?: number | string;
  result?: unknown;
  error?: { message?: string; code?: number };
}

export interface CodexUsageReaderDeps {
  command?: string;
  spawnFn?: typeof spawn;
  timeoutMs?: number;
}

export async function readCodexUsage(
  deps: CodexUsageReaderDeps = {},
): Promise<CodexUsageSnapshot> {
  const client = new CodexUsageClient(deps);
  try {
    await client.start();
    const [tokenUsageResult, rateLimitsResult] = await Promise.allSettled([
      client.request("account/usage/read"),
      client.request("account/rateLimits/read"),
    ]);
    if (tokenUsageResult.status === "rejected" && rateLimitsResult.status === "rejected") {
      throw new AggregateError(
        [tokenUsageResult.reason, rateLimitsResult.reason],
        "Unable to read Codex usage or rate limits",
      );
    }
    const tokenUsage = tokenUsageResult.status === "fulfilled" ? tokenUsageResult.value : undefined;
    const rateLimits = rateLimitsResult.status === "fulfilled" ? rateLimitsResult.value : undefined;
    return {
      tokenUsage: accountTokenUsageSummary(tokenUsage),
      rateLimits,
      fetchedAt: Date.now(),
    };
  } finally {
    client.close();
  }
}

class CodexUsageClient {
  private readonly command: string;
  private readonly spawnFn: typeof spawn;
  private readonly timeoutMs: number;
  private child?: ChildProcessWithoutNullStreams;
  private reader?: readline.Interface;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(deps: CodexUsageReaderDeps) {
    this.command = deps.command ?? "codex";
    this.spawnFn = deps.spawnFn ?? spawn;
    this.timeoutMs = deps.timeoutMs ?? 7000;
  }

  async start(): Promise<void> {
    this.child = this.spawnFn(this.command, ["app-server", "--stdio"], {
      stdio: "pipe",
      windowsHide: true,
    });
    this.child.once("error", (error) => {
      this.rejectPending(error instanceof Error ? error : new Error("Codex app-server failed to start"));
    });
    this.child.once("exit", () => {
      this.rejectPending(new Error("Codex app-server exited before usage response"));
    });
    this.child.stdin.on("error", (error) => {
      this.rejectPending(error instanceof Error ? error : new Error("Codex app-server stdin failed"));
    });
    this.reader = readline.createInterface({ input: this.child.stdout });
    this.reader.on("line", (line) => {
      this.handleLine(line);
    });
    await new Promise<void>((resolve, reject) => {
      const child = this.child;
      if (!child) {
        reject(new Error("Codex usage client is not started"));
        return;
      }
      let settled = false;
      const cleanup = () => {
        child.off("error", onError);
        child.off("spawn", onSpawn);
      };
      const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
      };
      const onError = (error: Error) => {
        settle(() => reject(error));
      };
      const onSpawn = () => {
        settle(resolve);
      };
      child.once("error", onError);
      child.once("spawn", onSpawn);
      setImmediate(() => settle(resolve));
    });
    await this.request("initialize", {
      clientInfo: {
        name: "agent_canvas",
        title: "agent_canvas",
        version: "0.0.1",
      },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized", {});
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (!this.child) throw new Error("Codex usage client is not started");
    const id = this.nextId++;
    const timer = setTimeout(() => {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      pending.reject(new Error(`Timed out reading Codex ${method}`));
    }, this.timeoutMs);
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, timer });
    });
    try {
      this.write({ id, method, params });
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return promise;
  }

  notify(method: string, params?: unknown): void {
    if (!this.child) throw new Error("Codex usage client is not started");
    this.write({ method, params });
  }

  close(): void {
    this.reader?.close();
    this.reader = undefined;
    this.rejectPending(new Error("Codex usage client closed"));
    try {
      this.child?.stdin.end();
    } catch {
      // The process may already have closed its stdin.
    }
    this.child?.kill();
    this.child = undefined;
  }

  private handleLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new Error(message.error.message ?? "Codex app-server request failed"));
      return;
    }
    pending.resolve(message.result);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private write(message: unknown): void {
    if (!this.child?.stdin.writable) throw new Error("Codex app-server is not writable");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
}

function accountTokenUsageSummary(value: unknown): CodexUsageSnapshot["tokenUsage"] {
  const summary = asRecord(asRecord(value)?.summary);
  if (!summary) return undefined;
  return {
    lifetimeTokens: nullableNumber(summary.lifetimeTokens),
    peakDailyTokens: nullableNumber(summary.peakDailyTokens),
    currentStreakDays: nullableNumber(summary.currentStreakDays),
    longestStreakDays: nullableNumber(summary.longestStreakDays),
    longestRunningTurnSec: nullableNumber(summary.longestRunningTurnSec),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function nullableNumber(value: unknown): number | null | undefined {
  return value === null || typeof value === "number" ? value : undefined;
}
