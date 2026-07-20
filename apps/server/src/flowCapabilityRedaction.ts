export const REDACTED_FLOW_CAPABILITY = "[redacted]";

// Capability values are currently UUID-shaped, but the whole reserved prefix is treated as
// secret. Matching the broader non-delimiter suffix prevents a user-controlled flow field from
// bypassing redaction with a future token format or with a deliberately malformed echo.
const FLOW_CAPABILITY_PATTERN = /agent_canvas_cap_[^\s"'`<>{}\[\](),;]*/giu;
const FLOW_CAPABILITY_FIELDS = new Set([
  "reviewToken",
  "completionToken",
  "callbackToken",
]);

export function redactFlowCapabilityText(text: string): string {
  return text.replace(FLOW_CAPABILITY_PATTERN, REDACTED_FLOW_CAPABILITY);
}

/**
 * Returns a redacted JSON-like copy suitable for flow state, persistence, and public transport.
 * Dedicated callback capabilities are added to private agent prompts only after their flow
 * payload has passed through this boundary.
 */
export function redactFlowCapabilities<T>(value: T, field?: string): T {
  if (field && FLOW_CAPABILITY_FIELDS.has(field)) {
    return REDACTED_FLOW_CAPABILITY as T;
  }
  if (typeof value === "string") return redactFlowCapabilityText(value) as T;
  if (Array.isArray(value)) {
    return value.map((item) => redactFlowCapabilities(item)) as T;
  }
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      redactFlowCapabilityText(key),
      redactFlowCapabilities(item, key),
    ]),
  ) as T;
}
