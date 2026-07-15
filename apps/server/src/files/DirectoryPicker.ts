import { execFile } from "node:child_process";

export type PickDirectory = (initialDirectory?: string) => Promise<string | undefined>;
type PickAttempt =
  | { status: "picked"; path: string }
  | { status: "cancelled" }
  | { status: "unavailable" };

export const pickDirectory: PickDirectory = async (initialDirectory) => {
  if (process.platform === "win32") return pickWindowsDirectory(initialDirectory);
  if (process.platform === "linux") return pickLinuxDirectory(initialDirectory);
  throw new Error("当前平台暂不支持目录浏览，请手动输入目录路径");
};

function pickWindowsDirectory(initialDirectory: string | undefined): Promise<string | undefined> {
  const selectedPath = powershellString(initialDirectory?.trim() ?? "");
  const script = `
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '选择目录'
$dialog.ShowNewFolderButton = $true
$owner = New-Object System.Windows.Forms.Form
$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$owner.Width = 1
$owner.Height = 1
$owner.ShowInTaskbar = $false
$owner.TopMost = $true
if (${selectedPath}.Length -gt 0 -and [System.IO.Directory]::Exists(${selectedPath})) {
  $dialog.SelectedPath = ${selectedPath}
}
try {
  $owner.Show()
  $owner.Activate()
  $result = $dialog.ShowDialog($owner)
  if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::WriteLine($dialog.SelectedPath)
  }
} finally {
  $owner.Dispose()
  $dialog.Dispose()
}
`;
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command", script],
      { encoding: "utf8", windowsHide: false },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        const directory = stdout.trim();
        resolve(directory || undefined);
      },
    );
  });
}

async function pickLinuxDirectory(initialDirectory: string | undefined): Promise<string | undefined> {
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new Error("当前 Linux 环境没有图形会话，请手动输入目录路径");
  }
  const initial = initialDirectory?.trim();
  const zenity = await tryPickWith("zenity", [
    "--file-selection",
    "--directory",
    ...(initial ? ["--filename", initial.endsWith("/") ? initial : `${initial}/`] : []),
  ]);
  if (zenity.status === "picked") return zenity.path;
  if (zenity.status === "cancelled") return undefined;

  const kdialog = await tryPickWith("kdialog", [
    "--getexistingdirectory",
    initial || process.env.HOME || ".",
  ]);
  if (kdialog.status === "picked") return kdialog.path;
  if (kdialog.status === "cancelled") return undefined;

  return failNoLinuxPicker();
}

function tryPickWith(command: string, args: string[]): Promise<PickAttempt> {
  return new Promise((resolve) => {
    execFile(command, args, { encoding: "utf8" }, (error, stdout) => {
      const exitCode = typeof error?.code === "number" ? error.code : undefined;
      if (exitCode === 1) {
        resolve({ status: "cancelled" });
        return;
      }
      if (error) {
        resolve({ status: "unavailable" });
        return;
      }
      const directory = stdout.trim();
      resolve(directory ? { status: "picked", path: directory } : { status: "cancelled" });
    });
  });
}

function failNoLinuxPicker(): never {
  throw new Error("找不到 Linux 图形目录选择器 zenity/kdialog，请手动输入目录路径");
}

function powershellString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
