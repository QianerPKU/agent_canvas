import { describe, expect, it } from "vitest";
import { detectCodexModels, modelsForVersion, parseVersion } from "./codexModels.js";

describe("codex model detection", () => {
  it("parses Codex CLI semantic versions from mixed output", () => {
    expect(parseVersion("codex-cli 0.141.0\nWARNING: ignored")).toBe("0.141.0");
  });

  it("uses gpt-5.6 for Codex versions that support it", () => {
    expect(modelsForVersion("codex-cli 0.141.0")).toEqual([
      "gpt-5.6",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
    ]);
  });

  it("allows Agent Canvas environment overrides", async () => {
    await expect(
      detectCodexModels({
        AGENT_CANVAS_CODEX_MODELS: "gpt-5.6,gpt-5.6-mini",
        AGENT_CANVAS_DEFAULT_CODEX_MODEL: "gpt-5.6-mini",
      }),
    ).resolves.toMatchObject({
      models: ["gpt-5.6", "gpt-5.6-mini"],
      defaultModel: "gpt-5.6-mini",
    });
  });
});
