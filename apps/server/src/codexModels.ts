import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  CODEX_MODELS,
  CODEX_REASONING_EFFORTS,
  DEFAULT_CODEX_MODEL,
  type CodexModelCapability,
} from "@agent-canvas/shared";

const execFileAsync = promisify(execFile);

export interface CodexModelDetection {
  models: string[];
  defaultModel: string;
  reasoningEfforts: string[];
  modelCapabilities: CodexModelCapability[];
  version?: string;
}

interface CatalogModel {
  slug?: unknown;
  display_name?: unknown;
  default_reasoning_level?: unknown;
  supported_reasoning_levels?: unknown;
  visibility?: unknown;
  priority?: unknown;
}

export async function detectCodexModels(
  env: NodeJS.ProcessEnv = process.env,
): Promise<CodexModelDetection> {
  const overrideModels = parseList(env.AGENT_CANVAS_CODEX_MODELS);
  const overrideEfforts = parseList(env.AGENT_CANVAS_CODEX_REASONING_EFFORTS);
  const overrideDefault = env.AGENT_CANVAS_DEFAULT_CODEX_MODEL?.trim();
  const version = overrideModels ? undefined : await codexVersion().catch(() => undefined);

  if (overrideModels) {
    return normalizeDetection({
      models: overrideModels,
      defaultModel: overrideDefault || overrideModels[0] || DEFAULT_CODEX_MODEL,
      reasoningEfforts: overrideEfforts ?? [...CODEX_REASONING_EFFORTS],
      modelCapabilities: overrideModels.map((model) => ({
        model,
        reasoningEfforts: overrideEfforts ?? [...CODEX_REASONING_EFFORTS],
      })),
      version,
    });
  }

  const catalog = await codexModelCatalog().catch(() => undefined);
  if (catalog) {
    const detected = detectionFromCatalog(catalog);
    return normalizeDetection({
      ...detected,
      ...(overrideDefault ? { defaultModel: overrideDefault } : {}),
      ...(overrideEfforts ? { reasoningEfforts: overrideEfforts } : {}),
      version,
    });
  }

  return normalizeDetection({
    models: [...CODEX_MODELS],
    defaultModel: overrideDefault || DEFAULT_CODEX_MODEL,
    reasoningEfforts: overrideEfforts ?? [...CODEX_REASONING_EFFORTS],
    modelCapabilities: CODEX_MODELS.map((model) => ({
      model,
      reasoningEfforts: overrideEfforts ?? [...CODEX_REASONING_EFFORTS],
    })),
    version,
  });
}

export function detectionFromCatalog(catalog: unknown): CodexModelDetection {
  const records = catalogModels(catalog);
  const listed = records.filter((model) => stringValue(model.visibility) === "list");
  const visible = listed.length > 0
    ? listed
    : records.filter((model) => stringValue(model.visibility) !== "hide");
  const sorted = [...visible].sort((left, right) => priority(left) - priority(right));
  const modelCapabilities = sorted
    .map((model): CodexModelCapability | undefined => {
      const slug = stringValue(model.slug);
      if (!slug) return undefined;
      return {
        model: slug,
        displayName: stringValue(model.display_name) || undefined,
        reasoningEfforts: reasoningEffortsFor(model),
        defaultReasoningEffort: stringValue(model.default_reasoning_level) || undefined,
      };
    })
    .filter((model): model is CodexModelCapability => !!model);
  const models = modelCapabilities.map((model) => model.model);
  return normalizeDetection({
    models,
    defaultModel: models[0] ?? DEFAULT_CODEX_MODEL,
    reasoningEfforts: uniqueNonEmpty(
      modelCapabilities.flatMap((model) => model.reasoningEfforts),
    ),
    modelCapabilities,
  });
}

function normalizeDetection(detection: Partial<CodexModelDetection>): CodexModelDetection {
  const models = uniqueNonEmpty(detection.models ?? []);
  const fallbackModels = models.length > 0 ? models : [...CODEX_MODELS];
  const reasoningEfforts = uniqueNonEmpty(detection.reasoningEfforts ?? []);
  const fallbackReasoningEfforts =
    reasoningEfforts.length > 0 ? reasoningEfforts : [...CODEX_REASONING_EFFORTS];
  const capabilities = normalizeCapabilities(
    detection.modelCapabilities,
    fallbackModels,
    fallbackReasoningEfforts,
  );
  const defaultModel = fallbackModels.includes(detection.defaultModel ?? "")
    ? detection.defaultModel!
    : fallbackModels[0]!;
  return {
    models: fallbackModels,
    defaultModel,
    reasoningEfforts: fallbackReasoningEfforts,
    modelCapabilities: capabilities,
    version: detection.version,
  };
}

function normalizeCapabilities(
  capabilities: CodexModelCapability[] | undefined,
  models: string[],
  fallbackReasoningEfforts: string[],
): CodexModelCapability[] {
  const byModel = new Map(
    (capabilities ?? []).map((capability) => [
      capability.model,
      {
        ...capability,
        reasoningEfforts: uniqueNonEmpty(capability.reasoningEfforts),
      },
    ]),
  );
  return models.map((model) => {
    const capability = byModel.get(model);
    return {
      model,
      displayName: capability?.displayName,
      defaultReasoningEffort: capability?.defaultReasoningEffort,
      reasoningEfforts: capability?.reasoningEfforts.length
        ? capability.reasoningEfforts
        : fallbackReasoningEfforts,
    };
  });
}

function detectionJson(stdout: string): unknown {
  return JSON.parse(stdout);
}

async function codexModelCatalog(): Promise<unknown> {
  return codexDebugJson(["debug", "models"]).catch(() =>
    codexDebugJson(["debug", "models", "--bundled"]),
  );
}

async function codexDebugJson(args: string[]): Promise<unknown> {
  const { stdout } = await execFileAsync("codex", args, {
    timeout: 10000,
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
  });
  return detectionJson(stdout);
}

export function parseVersion(output: string | undefined): string | undefined {
  const match = output?.match(/\b(\d+\.\d+\.\d+)\b/u);
  return match?.[1];
}

function catalogModels(catalog: unknown): CatalogModel[] {
  if (!catalog || typeof catalog !== "object") return [];
  const models = (catalog as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];
  return models.filter((model): model is CatalogModel => !!model && typeof model === "object");
}

function reasoningEffortsFor(model: CatalogModel): string[] {
  const levels = model.supported_reasoning_levels;
  if (!Array.isArray(levels)) return [];
  return uniqueNonEmpty(
    levels.map((level) => {
      if (!level || typeof level !== "object") return "";
      return stringValue((level as { effort?: unknown }).effort);
    }),
  );
}

function priority(model: CatalogModel): number {
  return typeof model.priority === "number" ? model.priority : Number.MAX_SAFE_INTEGER;
}

function parseList(value: string | undefined): string[] | undefined {
  const values = uniqueNonEmpty(value?.split(",") ?? []);
  return values.length > 0 ? values : undefined;
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

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
