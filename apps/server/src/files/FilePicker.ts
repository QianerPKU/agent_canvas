import { execFile } from "node:child_process";

export interface PickFilesOptions {
  initialDirectory?: string;
  multiple?: boolean;
}

export type PickFiles = (options?: PickFilesOptions) => Promise<string[]>;

interface PickerCommandResult {
  stdout: string;
  stderr: string;
}

type RunPickerCommand = (
  command: string,
  args: string[],
  options?: { windowsHide?: boolean },
) => Promise<PickerCommandResult>;

interface FilePickerRuntime {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  run?: RunPickerCommand;
}

type PickAttempt =
  | { status: "picked"; paths: string[] }
  | { status: "cancelled" }
  | { status: "unavailable" };

export function createFilePicker(runtime: FilePickerRuntime = {}): PickFiles {
  const platform = runtime.platform ?? process.platform;
  const env = runtime.env ?? process.env;
  const run = runtime.run ?? runPickerCommand;
  return async (options = {}) => {
    if (platform === "win32") return await pickWindowsFiles(options, run);
    if (platform === "linux") return await pickLinuxFiles(options, env, run);
    throw new Error("当前平台暂不支持文件浏览");
  };
}

export const pickFiles: PickFiles = createFilePicker();

async function pickWindowsFiles(
  options: PickFilesOptions,
  run: RunPickerCommand,
): Promise<string[]> {
  const initialDirectory = powershellString(options.initialDirectory ?? "");
  const multiple = options.multiple === false ? "$false" : "$true";
  const script = `
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = '选择文件'
$dialog.CheckFileExists = $true
$dialog.Multiselect = ${multiple}
$owner = New-Object System.Windows.Forms.Form
$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$owner.Width = 1
$owner.Height = 1
$owner.ShowInTaskbar = $false
$owner.TopMost = $true
if (${initialDirectory}.Length -gt 0 -and [System.IO.Directory]::Exists(${initialDirectory})) {
  $dialog.InitialDirectory = ${initialDirectory}
}
try {
  $owner.Show()
  $owner.Activate()
  $result = $dialog.ShowDialog($owner)
  if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
    foreach ($file in $dialog.FileNames) {
      [Console]::WriteLine($file)
    }
  }
} finally {
  $owner.Dispose()
  $dialog.Dispose()
}
`;
  const result = await run(
    "powershell.exe",
    ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command", script],
    { windowsHide: false },
  );
  return outputPaths(result.stdout);
}

async function pickLinuxFiles(
  options: PickFilesOptions,
  env: NodeJS.ProcessEnv,
  run: RunPickerCommand,
): Promise<string[]> {
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) {
    throw new Error("当前 Linux 环境没有图形会话，无法浏览文件");
  }
  const initial = options.initialDirectory;
  const multiple = options.multiple !== false;
  const zenity = await tryPickWith(
    "zenity",
    [
      "--file-selection",
      ...(multiple ? ["--multiple", "--separator=\n"] : []),
      ...(initial
        ? ["--filename", initial.endsWith("/") ? initial : `${initial}/`]
        : []),
    ],
    run,
  );
  if (zenity.status === "picked") return zenity.paths;
  if (zenity.status === "cancelled") return [];

  const kdialog = await tryPickWith(
    "kdialog",
    [
      "--getopenfilename",
      initial || env.HOME || ".",
      ...(multiple ? ["--multiple", "--separate-output"] : []),
    ],
    run,
  );
  if (kdialog.status === "picked") return kdialog.paths;
  if (kdialog.status === "cancelled") return [];

  throw new Error("找不到 Linux 图形文件选择器 zenity/kdialog");
}

async function tryPickWith(
  command: string,
  args: string[],
  run: RunPickerCommand,
): Promise<PickAttempt> {
  try {
    const result = await run(command, args);
    const paths = outputPaths(result.stdout);
    return paths.length > 0 ? { status: "picked", paths } : { status: "cancelled" };
  } catch (error) {
    return numericExitCode(error) === 1 ? { status: "cancelled" } : { status: "unavailable" };
  }
}

function runPickerCommand(
  command: string,
  args: string[],
  options: { windowsHide?: boolean } = {},
): Promise<PickerCommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { encoding: "utf8", windowsHide: options.windowsHide },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stderr: stderr.trim() }));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function outputPaths(stdout: string): string[] {
  return stdout
    .split(/\r?\n/u)
    .filter((candidate) => candidate.length > 0);
}

function numericExitCode(error: unknown): number | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "number" ? code : undefined;
}

function powershellString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
