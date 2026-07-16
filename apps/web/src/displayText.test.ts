import { describe, expect, it } from "vitest";
import {
  commitDisplayText,
  flowDisplayText,
  isLikelyEncodingDamage,
  readableCanvasText,
} from "./displayText.js";

describe("canvas display text", () => {
  it("detects lossy question-mark and replacement-character encoding", () => {
    expect(isLikelyEncodingDamage("???? agent ???????? VS Code ?????")).toBe(true);
    expect(isLikelyEncodingDamage("?")).toBe(true);
    expect(isLikelyEncodingDamage("???")).toBe(true);
    expect(isLikelyEncodingDamage("fix: apps/web/src/App.tsx ?????")).toBe(true);
    expect(isLikelyEncodingDamage("broken \uFFFD text")).toBe(true);
    expect(isLikelyEncodingDamage("Why??? Add tests for this edge case")).toBe(false);
    expect(isLikelyEncodingDamage("Really???")).toBe(false);
    expect(isLikelyEncodingDamage("为什么？补充这个测试")).toBe(false);
  });

  it("falls back from damaged commit summaries to the Git subject", () => {
    expect(
      commitDisplayText({
        shortSha: "abcdef1",
        subject: "feat: 完成画布生命周期",
        summary: "?? Canvas ?????????????????",
      }),
    ).toEqual({
      subject: "feat: 完成画布生命周期",
      summary: "feat: 完成画布生命周期",
    });
  });

  it("uses stable flow identifiers and branches when submitted text is damaged", () => {
    expect(
      flowDisplayText({
        id: "pr_flow_1",
        title: "?? Canvas ??????????",
        summary: "????????,??????????,????????",
        sourceBranch: "feat/projects",
        targetBranch: "main",
      }),
    ).toEqual({
      title: "pr_flow_1",
      summary: "feat/projects → main",
    });
    expect(readableCanvasText(" 正常中文 ", "fallback")).toBe("正常中文");
  });

  it("prefers PR metadata when it can recover damaged flow text", () => {
    expect(
      flowDisplayText({
        id: "pr_flow_2",
        title: "????????",
        summary: "????????????",
        sourceBranch: "feat/projects",
        targetBranch: "main",
        pr: {
          title: "修复节点乱码",
          summary: "确保画布能够显示中文提交信息",
        },
      }),
    ).toEqual({
      title: "修复节点乱码",
      summary: "确保画布能够显示中文提交信息",
    });
  });
});
