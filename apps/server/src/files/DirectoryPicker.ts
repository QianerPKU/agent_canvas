import { execFile } from "node:child_process";

export type PickDirectory = (initialDirectory?: string) => Promise<string | undefined>;

export const pickDirectory: PickDirectory = async (initialDirectory) => {
  if (process.platform !== "win32") {
    throw new Error("当前平台暂不支持目录浏览，请手动输入目录路径");
  }
  return pickWindowsDirectory(initialDirectory);
};

function pickWindowsDirectory(initialDirectory: string | undefined): Promise<string | undefined> {
  const selectedPath = powershellString(initialDirectory?.trim() ?? "");
  const script = `
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '选择目录'
$dialog.ShowNewFolderButton = $true
if (${selectedPath}.Length -gt 0 -and [System.IO.Directory]::Exists(${selectedPath})) {
  $dialog.SelectedPath = ${selectedPath}
}
$result = $dialog.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::WriteLine($dialog.SelectedPath)
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

function powershellString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
