import { describe, expect, it, vi } from "vitest";
import { createFilePicker } from "./FilePicker.js";

describe("FilePicker", () => {
  it("uses a multi-select Windows OpenFileDialog and returns every selected file", async () => {
    const run = vi.fn().mockResolvedValue({
      stdout: "C:\\data\\one.txt\r\nC:\\data\\two.png\r\n",
      stderr: "",
    });
    const picker = createFilePicker({ platform: "win32", run });

    await expect(
      picker({ initialDirectory: "C:\\data's", multiple: true }),
    ).resolves.toEqual(["C:\\data\\one.txt", "C:\\data\\two.png"]);
    expect(run).toHaveBeenCalledWith(
      "powershell.exe",
      expect.arrayContaining(["-STA", "-Command"]),
      { windowsHide: false },
    );
    const script = run.mock.calls[0]?.[1]?.at(-1) as string;
    expect(script).toContain("$dialog.Multiselect = $true");
    expect(script).toContain("'C:\\data''s'");
  });

  it("returns an empty selection when the Windows dialog is cancelled", async () => {
    const picker = createFilePicker({
      platform: "win32",
      run: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
    });

    await expect(picker()).resolves.toEqual([]);
  });

  it("preserves whitespace that belongs to a selected filename", async () => {
    const picker = createFilePicker({
      platform: "linux",
      env: { DISPLAY: ":0" },
      run: vi.fn().mockResolvedValue({
        stdout: "/data/ report.txt\n/../\n/data/report .txt\n",
        stderr: "",
      }),
    });

    await expect(picker()).resolves.toEqual([
      "/data/ report.txt",
      "/data/report .txt",
    ]);
  });

  it("uses zenity multi-select on Linux", async () => {
    const run = vi.fn().mockResolvedValue({
      stdout: "/data/one.txt\n/../\n/data/two.png\n",
      stderr: "",
    });
    const picker = createFilePicker({
      platform: "linux",
      env: { DISPLAY: ":0", HOME: "/home/test" },
      run,
    });

    await expect(picker({ initialDirectory: "/data", multiple: true })).resolves.toEqual([
      "/data/one.txt",
      "/data/two.png",
    ]);
    expect(run).toHaveBeenCalledWith(
      "zenity",
      ["--file-selection", "--multiple", "--separator=\n/../\n", "--filename", "/data/"],
    );
  });

  it("preserves a newline in a selected directory name", async () => {
    const selected = "/data/folder\nname/report.txt";
    const picker = createFilePicker({
      platform: "linux",
      env: { DISPLAY: ":0" },
      run: vi.fn().mockResolvedValue({ stdout: `${selected}\n`, stderr: "" }),
    });

    await expect(picker({ multiple: false })).resolves.toEqual([selected]);
  });

  it("preserves a newline in a selected filename without creating another selection", async () => {
    const first = "/data/report\nfinal.txt";
    const second = "/data/other.txt";
    const picker = createFilePicker({
      platform: "linux",
      env: { DISPLAY: ":0" },
      run: vi.fn().mockResolvedValue({
        stdout: `${first}\n/../\n${second}\n`,
        stderr: "",
      }),
    });

    await expect(picker()).resolves.toEqual([first, second]);
  });

  it("treats picker exit code 1 as cancellation without falling through", async () => {
    const cancelled = Object.assign(new Error("cancelled"), { code: 1 });
    const run = vi.fn().mockRejectedValue(cancelled);
    const picker = createFilePicker({
      platform: "linux",
      env: { WAYLAND_DISPLAY: "wayland-0" },
      run,
    });

    await expect(picker()).resolves.toEqual([]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("falls back to kdialog when zenity is unavailable", async () => {
    const unavailable = Object.assign(new Error("missing"), { code: "ENOENT" });
    const run = vi
      .fn()
      .mockRejectedValueOnce(unavailable)
      .mockResolvedValueOnce({ stdout: "file:///data/report.csv\n", stderr: "" });
    const picker = createFilePicker({
      platform: "linux",
      env: { DISPLAY: ":0", HOME: "/home/test" },
      run,
    });

    await expect(picker({ multiple: false })).resolves.toEqual(["/data/report.csv"]);
    expect(run).toHaveBeenNthCalledWith(
      2,
      "kdialog",
      ["--getopenurl", "/home/test"],
    );
  });

  it("decodes a newline in a kdialog file URL without creating another selection", async () => {
    const unavailable = Object.assign(new Error("missing"), { code: "ENOENT" });
    const run = vi
      .fn()
      .mockRejectedValueOnce(unavailable)
      .mockResolvedValueOnce({
        stdout: "file:///data/report%0Afinal.txt\nfile:///data/other.txt\n",
        stderr: "",
      });
    const picker = createFilePicker({
      platform: "linux",
      env: { DISPLAY: ":0" },
      run,
    });

    await expect(picker()).resolves.toEqual([
      "/data/report\nfinal.txt",
      "/data/other.txt",
    ]);
  });

  it("reports a headless Linux session clearly", async () => {
    const picker = createFilePicker({ platform: "linux", env: {} });

    await expect(picker()).rejects.toThrow("没有图形会话");
  });
});
