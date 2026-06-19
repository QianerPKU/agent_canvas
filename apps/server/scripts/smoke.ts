/**
 * 真机冒烟：用真实 Claude Agent SDK 跑通一次 start→实时事件→结束。
 *
 * 安全参数（首跑）：
 *  - 一次性临时目录（OS temp，跑完不影响仓库）
 *  - model = haiku（最便宜）
 *  - permissionMode = acceptEdits（临时目录内自动接受文件编辑）
 *  - allowedTools 仅 Read/Write/Edit（不放开 Bash，避免权限卡住）
 *  - maxTurns 限制，防跑飞
 *
 * 运行：npm run smoke --workspace apps/server
 */
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentEventEnvelope } from "@agent-canvas/shared";
import { AgentManager } from "../src/AgentManager.js";
import { realQuery } from "../src/sdk/realQuery.js";

const TIMEOUT_MS = 180_000;

function short(v: unknown, n = 200): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function printEvent(env: AgentEventEnvelope): void {
  const e = env.event;
  const tag = `#${env.seq}`;
  switch (e.kind) {
    case "status":
      console.log(`${tag} · 状态 → ${e.status}`);
      break;
    case "system_init":
      console.log(
        `${tag} ▸ 会话已建立 session=${e.sessionId.slice(0, 8)} model=${e.model} cwd=${e.cwd}`,
      );
      console.log(`     可用工具: ${e.tools.join(", ") || "(无)"}`);
      break;
    case "assistant_text":
      console.log(`${tag} 🗣  ${short(e.text, 500)}`);
      break;
    case "tool_use":
      console.log(`${tag} 🔧 ${e.name}(${short(e.input)})`);
      break;
    case "tool_result":
      console.log(`${tag} ↩  ${e.isError ? "[错误] " : ""}${short(e.content)}`);
      break;
    case "result":
      console.log(
        `${tag} ✅ result subtype=${e.subtype} isError=${e.isError} cost=$${e.costUsd ?? "?"} turns=${e.numTurns ?? "?"}`,
      );
      if (e.usage) console.log(`     usage: ${JSON.stringify(e.usage)}`);
      break;
    case "error":
      console.log(`${tag} ❌ ${e.message}`);
      break;
  }
}

function listFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full, base));
    else out.push(path.relative(base, full));
  }
  return out;
}

async function main(): Promise<void> {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "agent-canvas-smoke-"));
  console.log(`\n=== 真机冒烟开始 ===`);
  console.log(`临时工作目录: ${tmpDir}\n`);

  const manager = new AgentManager({ query: realQuery });
  const runner = manager.create();

  let sawError = false;
  const finished = new Promise<void>((resolve) => {
    manager.onEvent((env) => {
      printEvent(env);
      const e = env.event;
      if (e.kind === "error") sawError = true;
      if (e.kind === "result") resolve();
      if (e.kind === "status" && (e.status === "done" || e.status === "error" || e.status === "stopped")) {
        resolve();
      }
    });
  });

  runner.start({
    prompt:
      "在当前目录写一个 Python 文件 add.py：定义函数 add(a, b) 返回 a+b，" +
      "并在 if __name__ == '__main__' 里打印 add(2, 3)。只需创建文件，不要运行。",
    cwd: tmpDir,
    model: "haiku",
    permissionMode: "acceptEdits",
    allowedTools: ["Read", "Write", "Edit"],
    maxTurns: 8,
  });

  const timeout = new Promise<void>((resolve) => setTimeout(resolve, TIMEOUT_MS));
  await Promise.race([finished, timeout]);
  await runner.stop();

  console.log(`\n=== 结束，最终状态: ${runner.getStatus()} ===`);
  const snap = runner.snapshot();
  console.log(`累计花费: $${snap.totalCostUsd ?? "?"}  usage: ${JSON.stringify(snap.usage ?? {})}`);

  console.log(`\n--- 临时目录产物 ---`);
  const files = listFiles(tmpDir);
  if (files.length === 0) {
    console.log("(没有生成任何文件)");
  } else {
    for (const f of files) {
      console.log(`\n[${f}]`);
      console.log(readFileSync(path.join(tmpDir, f), "utf-8"));
    }
  }

  process.exit(sawError ? 1 : 0);
}

main().catch((err) => {
  console.error("冒烟脚本异常:", err);
  process.exit(1);
});
