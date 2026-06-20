import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";

export interface VscodeFileOpenerOptions {
  command?: string;
  platform?: NodeJS.Platform;
  comSpec?: string;
  env?: NodeJS.ProcessEnv;
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
  const vscodeCommand = options.command ?? (await resolveVscodeCommand());
  const spawnFn = options.spawnFn ?? spawn;
  const launch = vscodeLaunch(
    vscodeCommand,
    filePath,
    options.platform ?? process.platform,
    options.comSpec ?? process.env.ComSpec,
    options.env ?? process.env,
  );
  await new Promise<void>((resolve, reject) => {
    const child = spawnFn(launch.command, launch.args, launch.options);
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf-8")).slice(-4000);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          stderr.trim() || `VS Code 启动器异常退出（exit code ${code ?? "unknown"}）`,
        ),
      );
    });
  });
}

async function resolveVscodeCommand(): Promise<string> {
  const configured = process.env.AGENT_CANVAS_VSCODE_PATH?.trim();
  if (configured) return resolveConfiguredCommand(configured);
  if (process.platform !== "win32") return "code";

  const pathCandidates = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.join(directory, "code.cmd"));
  const candidates = [
    process.env.LOCALAPPDATA &&
      path.join(process.env.LOCALAPPDATA, "Programs", "Microsoft VS Code", "bin", "code.cmd"),
    process.env.ProgramFiles &&
      path.join(process.env.ProgramFiles, "Microsoft VS Code", "bin", "code.cmd"),
    process.env["ProgramFiles(x86)"] &&
      path.join(process.env["ProgramFiles(x86)"], "Microsoft VS Code", "bin", "code.cmd"),
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
    "找不到 VS Code CLI。请安装 VS Code，或设置 AGENT_CANVAS_VSCODE_PATH 为 code.cmd 的完整路径。",
  );
}

async function resolveConfiguredCommand(configured: string): Promise<string> {
  if (
    process.platform === "win32" &&
    path.basename(configured).toLowerCase() === "code.exe"
  ) {
    const cliCommand = path.join(path.dirname(configured), "bin", "code.cmd");
    try {
      await access(cliCommand);
      return cliCommand;
    } catch {
      throw new Error(`找不到与 ${configured} 配套的 VS Code CLI: ${cliCommand}`);
    }
  }
  return configured;
}

function vscodeLaunch(
  vscodeCommand: string,
  filePath: string,
  platform: NodeJS.Platform,
  comSpec: string | undefined,
  env: NodeJS.ProcessEnv,
): { command: string; args: string[]; options: SpawnOptions } {
  if (platform !== "win32") {
    return {
      command: vscodeCommand,
      args: ["--reuse-window", filePath],
      options: {
        stdio: ["ignore", "ignore", "pipe"],
      },
    };
  }

  const command = comSpec ?? "cmd.exe";
  const cliVariable = "AGENT_CANVAS_VSCODE_CLI";
  const fileVariable = "AGENT_CANVAS_FILE_TO_OPEN";
  return {
    command,
    args: [
      "/d",
      "/s",
      "/v:off",
      "/c",
      `call "%${cliVariable}%" --reuse-window "%${fileVariable}%"`,
    ],
    options: {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: true,
      env: {
        ...env,
        [cliVariable]: vscodeCommand,
        [fileVariable]: filePath,
      },
    },
  };
}
