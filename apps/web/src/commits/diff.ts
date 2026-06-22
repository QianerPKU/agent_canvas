export type ParsedDiffLineKind = "meta" | "hunk" | "context" | "addition" | "deletion";

export interface ParsedDiffLine {
  kind: ParsedDiffLineKind;
  oldLine?: number;
  newLine?: number;
  prefix: string;
  content: string;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/u;

export function parseUnifiedDiff(diff: string): ParsedDiffLine[] {
  if (!diff.trim()) return [];
  const rows: ParsedDiffLine[] = [];
  let oldLine: number | undefined;
  let newLine: number | undefined;

  for (const rawLine of diff.split(/\r?\n/u)) {
    const hunk = rawLine.match(HUNK_RE);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      rows.push({ kind: "hunk", prefix: "", content: rawLine });
      continue;
    }

    if (oldLine === undefined || newLine === undefined) {
      rows.push({ kind: "meta", prefix: "", content: rawLine });
      continue;
    }

    if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
      rows.push({
        kind: "addition",
        oldLine: undefined,
        newLine,
        prefix: "+",
        content: rawLine.slice(1),
      });
      newLine++;
      continue;
    }

    if (rawLine.startsWith("-") && !rawLine.startsWith("---")) {
      rows.push({
        kind: "deletion",
        oldLine,
        newLine: undefined,
        prefix: "-",
        content: rawLine.slice(1),
      });
      oldLine++;
      continue;
    }

    if (rawLine.startsWith("\\ No newline")) {
      rows.push({ kind: "meta", prefix: "", content: rawLine });
      continue;
    }

    const content = rawLine.startsWith(" ") ? rawLine.slice(1) : rawLine;
    rows.push({
      kind: "context",
      oldLine,
      newLine,
      prefix: " ",
      content,
    });
    oldLine++;
    newLine++;
  }

  return rows;
}
