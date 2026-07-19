import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { readCodexUsage } from "./codexUsage.js";

interface ClientMessage {
  id?: number;
  method?: string;
  params?: unknown;
}

function fakeCodexProcess(
  onMessage: (message: ClientMessage, proc: ReturnType<typeof createFakeProcess>) => void = () => {},
) {
  const proc = createFakeProcess();
  let buffered = "";
  proc.stdin.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    while (buffered.includes("\n")) {
      const newline = buffered.indexOf("\n");
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line.trim()) onMessage(JSON.parse(line) as ClientMessage, proc);
    }
  });
  return proc;
}

function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn(() => true);
  return proc;
}

function respond(
  proc: ReturnType<typeof createFakeProcess>,
  message: { id: number; result?: unknown; error?: { code: number; message: string } },
): void {
  proc.stdout.write(`${JSON.stringify(message)}\n`);
}

describe("Codex usage reader", () => {
  it("rejects cleanly when the Codex app-server process fails to spawn", async () => {
    const proc = fakeCodexProcess();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => proc.emit("error", new Error("spawn codex ENOENT")));
      return proc;
    });

    await expect(readCodexUsage({ spawnFn: spawnFn as never })).rejects.toThrow("spawn codex ENOENT");
    expect(proc.kill).toHaveBeenCalled();
  });

  it("initializes the app-server before reading account usage and rate limits", async () => {
    const messages: ClientMessage[] = [];
    const proc = fakeCodexProcess((message, child) => {
      messages.push(message);
      if (message.method === "initialize" && message.id !== undefined) {
        respond(child, { id: message.id, result: {} });
      } else if (message.method === "account/usage/read" && message.id !== undefined) {
        respond(child, {
          id: message.id,
          result: {
            summary: {
              lifetimeTokens: 12_345,
              peakDailyTokens: 2_345,
              currentStreakDays: 4,
              longestStreakDays: 9,
              longestRunningTurnSec: 321,
            },
            dailyUsageBuckets: null,
          },
        });
      } else if (message.method === "account/rateLimits/read" && message.id !== undefined) {
        respond(child, {
          id: message.id,
          result: {
            rateLimits: {
              primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_800_000_000 },
              secondary: null,
            },
            rateLimitsByLimitId: null,
            rateLimitResetCredits: null,
          },
        });
      }
    });

    const snapshot = await readCodexUsage({ spawnFn: vi.fn(() => proc) as never });

    expect(messages.map((message) => message.method)).toEqual([
      "initialize",
      "initialized",
      "account/usage/read",
      "account/rateLimits/read",
    ]);
    expect(messages[0]?.params).toEqual({
      clientInfo: { name: "agent_canvas", title: "agent_canvas", version: "0.0.1" },
      capabilities: { experimentalApi: true },
    });
    expect(snapshot).toEqual({
      tokenUsage: {
        lifetimeTokens: 12_345,
        peakDailyTokens: 2_345,
        currentStreakDays: 4,
        longestStreakDays: 9,
        longestRunningTurnSec: 321,
      },
      rateLimits: {
        rateLimits: {
          primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_800_000_000 },
          secondary: null,
        },
        rateLimitsByLimitId: null,
        rateLimitResetCredits: null,
      },
      fetchedAt: expect.any(Number),
    });
    expect(proc.kill).toHaveBeenCalled();
  });

  it("rejects instead of returning an empty snapshot when both account requests fail", async () => {
    const proc = fakeCodexProcess((message, child) => {
      if (message.method === "initialize" && message.id !== undefined) {
        respond(child, { id: message.id, result: {} });
      } else if (message.id !== undefined && message.method?.startsWith("account/")) {
        respond(child, {
          id: message.id,
          error: { code: -32600, message: `Failed ${message.method}` },
        });
      }
    });

    await expect(readCodexUsage({ spawnFn: vi.fn(() => proc) as never })).rejects.toThrow(
      "Unable to read Codex usage or rate limits",
    );
    expect(proc.kill).toHaveBeenCalled();
  });
});
