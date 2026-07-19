import { describe, expect, it } from "vitest";
import {
  REDACTED_FLOW_CAPABILITY,
  redactFlowCapabilities,
  redactFlowCapabilityText,
} from "./flowCapabilityRedaction.js";

describe("flow capability redaction", () => {
  it("redacts every reserved-prefix echo without assuming the current UUID format", () => {
    expect(
      redactFlowCapabilityText(
        "one=agent_canvas_cap_11111111-2222-4333-8444-555555555555 " +
          "two=AGENT_CANVAS_CAP_future.token/value; literal=agent_canvas_cap_*",
      ),
    ).toBe(
      `one=${REDACTED_FLOW_CAPABILITY} two=${REDACTED_FLOW_CAPABILITY}; ` +
        `literal=${REDACTED_FLOW_CAPABILITY}`,
    );
  });

  it("redacts nested flow payloads without mutating the private source value", () => {
    const source = {
      summary: "echo agent_canvas_cap_secret",
      nested: [{ path: "src/agent_canvas_cap_path-token.ts" }],
      "header-agent_canvas_cap_key-token": "key is user-controlled too",
      callbackToken: "legacy-token-without-reserved-prefix",
      safe: "unchanged",
    };

    const redacted = redactFlowCapabilities(source);

    expect(redacted).toEqual({
      summary: `echo ${REDACTED_FLOW_CAPABILITY}`,
      nested: [{ path: `src/${REDACTED_FLOW_CAPABILITY}` }],
      [`header-${REDACTED_FLOW_CAPABILITY}`]: "key is user-controlled too",
      callbackToken: REDACTED_FLOW_CAPABILITY,
      safe: "unchanged",
    });
    expect(source.summary).toContain("agent_canvas_cap_secret");
    expect(redacted).not.toBe(source);
    expect(redacted.nested).not.toBe(source.nested);
  });
});
