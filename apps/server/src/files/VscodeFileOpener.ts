import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";

export interface VscodeFileOpenerOptions {
  command?: string;
  spawnFn?: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => ChildProcess;
}

export async function openFileInVscode(
  filePath: string,
  options: VscodeFileOpenerOptions = {},
): Promise<void> {
  const command = options.command ?? (await resolveVscodeCommand());
  const spawnFn = options.spawnFn ?? spawn;
  await new Promise<void>((resolve, reject) => {
    const child = spawnFn(command, ["--reuse-window", filePath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

async function resolveVscodeCommand(): Promise<string> {
  const configured = process.env.AGENT_CANVAS_VSCODE_PATH?.trim();
  if (configured) return configured;
  if (process.platform !== "win32") return "code";

  const pathCandidates = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .flatMap((directory) => [
      path.join(directory, "Code.exe"),
      path.join(directory, "code.exe"),
      path.resolve(directory, "..", "Code.exe"),
    ]);
  const candidates = [
    process.env.LOCALAPPDATA &&
      path.join(process.env.LOCALAPPDATA, "Programs", "Microsoft VS Code", "Code.exe"),
    process.env.ProgramFiles &&
      path.join(process.env.ProgramFiles, "Microsoft VS Code", "Code.exe"),
    process.env["ProgramFiles(x86)"] &&
      path.join(process.env["ProgramFiles(x86)"], "Microsoft VS Code", "Code.exe"),
    ...pathCandidates,
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of new Set(candidates)) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // 继续检查下一个标准安装位置。
    }
  }
  throw new Error(
    "找不到 VS Code。请安装 VS Code，或设置 AGENT_CANVAS_VSCODE_PATH 为 Code.exe 的完整路径。",
  );
}
