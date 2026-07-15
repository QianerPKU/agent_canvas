import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CODEX_MODELS, DEFAULT_CODEX_MODEL } from "@agent-canvas/shared";

const execFileAsync = promisify(execFile);

export interface CodexModelDetection {
  models: string[];
  defaultModel: string;
  version?: string;
}

interface VersionModelRule {
  minVersion: string;
  models: string[];
}

const VERSION_MODEL_RULES: VersionModelRule[] = [
  {
    minVersion: "0.141.0",
    models: ["gpt-5.6", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini"],
  },
  {
    minVersion: "0.0.0",
    models: [...CODEX_MODELS],
  },
];

export async function detectCodexModels(
  env: NodeJS.ProcessEnv = process.env,
): Promise<CodexModelDetection> {
  const overrideModels = parseModelList(env.AGENT_CANVAS_CODEX_MODELS);
  const overrideDefault = env.AGENT_CANVAS_DEFAULT_CODEX_MODEL?.trim();
  const version = overrideModels ? undefined : await codexVersion().catch(() => undefined);
  const models = overrideModels ?? modelsForVersion(version);
  return normalizeDetection({
    models,
    defaultModel: overrideDefault || models[0] || DEFAULT_CODEX_MODEL,
    version,
  });
}

export function modelsForVersion(version: string | undefined): string[] {
  const normalized = parseVersion(version);
  if (!normalized) return [...CODEX_MODELS];
  const rule = VERSION_MODEL_RULES.find((candidate) =>
    compareVersions(normalized, candidate.minVersion) >= 0,
  );
  return [...(rule?.models ?? CODEX_MODELS)];
}

export function parseVersion(output: string | undefined): string | undefined {
  const match = output?.match(/\b(\d+\.\d+\.\d+)\b/u);
  return match?.[1];
}

function normalizeDetection(detection: CodexModelDetection): CodexModelDetection {
  const models = uniqueNonEmpty(detection.models);
  const fallback = models.length > 0 ? models : [...CODEX_MODELS];
  const defaultModel = fallback.includes(detection.defaultModel)
    ? detection.defaultModel
    : fallback[0]!;
  return {
    models: fallback,
    defaultModel,
    version: detection.version,
  };
}

function parseModelList(value: string | undefined): string[] | undefined {
  const models = uniqueNonEmpty(value?.split(",") ?? []);
  return models.length > 0 ? models : undefined;
}

function uniqueNonEmpty(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

async function codexVersion(): Promise<string | undefined> {
  const { stdout, stderr } = await execFileAsync("codex", ["--version"], {
    timeout: 5000,
    windowsHide: true,
  });
  return parseVersion(`${stdout}\n${stderr}`);
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index++) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
