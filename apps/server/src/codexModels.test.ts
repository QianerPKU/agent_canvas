import { describe, expect, it } from "vitest";
import { detectCodexModels, detectionFromCatalog, parseVersion } from "./codexModels.js";

describe("codex model detection", () => {
  it("parses Codex CLI semantic versions from mixed output", () => {
    expect(parseVersion("codex-cli 0.141.0\nWARNING: ignored")).toBe("0.141.0");
  });

  it("reads listed models and reasoning efforts from the Codex catalog", () => {
    expect(
      detectionFromCatalog({
        models: [
          model("codex-auto-review", 50, ["low"], "hide"),
          model("gpt-5.6-terra", 2, ["low", "medium", "high", "xhigh"]),
          model("gpt-5.6-sol", 1, ["low", "medium", "high", "xhigh", "max"]),
          model("gpt-5.6-luna", 3, ["low", "medium", "high"]),
        ],
      }),
    ).toMatchObject({
      models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
      defaultModel: "gpt-5.6-sol",
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
      modelCapabilities: [
        {
          model: "gpt-5.6-sol",
          reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
        },
        {
          model: "gpt-5.6-terra",
          reasoningEfforts: ["low", "medium", "high", "xhigh"],
        },
        {
          model: "gpt-5.6-luna",
          reasoningEfforts: ["low", "medium", "high"],
        },
      ],
    });
  });

  it("allows Agent Canvas environment overrides", async () => {
    await expect(
      detectCodexModels({
        AGENT_CANVAS_CODEX_MODELS: "gpt-5.6-sol,gpt-5.6-terra",
        AGENT_CANVAS_DEFAULT_CODEX_MODEL: "gpt-5.6-terra",
        AGENT_CANVAS_CODEX_REASONING_EFFORTS: "low,medium,high,xhigh,max",
      }),
    ).resolves.toMatchObject({
      models: ["gpt-5.6-sol", "gpt-5.6-terra"],
      defaultModel: "gpt-5.6-terra",
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    });
  });
});

function model(
  slug: string,
  priority: number,
  efforts: string[],
  visibility = "list",
): Record<string, unknown> {
  return {
    slug,
    display_name: slug,
    visibility,
    priority,
    default_reasoning_level: "medium",
    supported_reasoning_levels: efforts.map((effort) => ({ effort })),
  };
}
