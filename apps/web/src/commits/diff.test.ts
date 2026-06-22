import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "./diff.js";

describe("parseUnifiedDiff", () => {
  it("parses metadata, hunk headers, line numbers and changed rows", () => {
    const rows = parseUnifiedDiff(
      [
        "diff --git a/src/app.ts b/src/app.ts",
        "index 1111111..2222222 100644",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -3,2 +3,3 @@",
        " const keep = true;",
        "-const oldName = 1;",
        "+const newName = 1;",
        "+const added = 2;",
      ].join("\n"),
    );

    expect(rows.map((row) => row.kind)).toEqual([
      "meta",
      "meta",
      "meta",
      "meta",
      "hunk",
      "context",
      "deletion",
      "addition",
      "addition",
    ]);
    expect(rows[5]).toMatchObject({ oldLine: 3, newLine: 3, content: "const keep = true;" });
    expect(rows[6]).toMatchObject({ oldLine: 4, newLine: undefined, prefix: "-" });
    expect(rows[7]).toMatchObject({ oldLine: undefined, newLine: 4, prefix: "+" });
    expect(rows[8]).toMatchObject({ oldLine: undefined, newLine: 5, prefix: "+" });
  });
});
