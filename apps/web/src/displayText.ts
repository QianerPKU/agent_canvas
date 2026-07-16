interface CommitDisplayInput {
  shortSha: string;
  subject: string;
  summary: string;
}

interface FlowDisplayInput {
  id: string;
  title?: string;
  summary: string;
  sourceBranch?: string;
  targetBranch: string;
  commitSha?: string;
  pr?: {
    title?: string;
    summary?: string;
  };
  applied?: {
    summary?: string;
  };
}

export function isLikelyEncodingDamage(value: string | undefined): boolean {
  const text = value?.trim();
  if (!text) return false;
  const characters = Array.from(text).filter((character) => !/\s/u.test(character));
  const replacementCharacters = characters.filter((character) => character === "\uFFFD").length;
  if (replacementCharacters > 0) return true;

  const questionMarkRuns = text.match(/\?+/gu) ?? [];
  const questionMarkCount = questionMarkRuns.reduce((total, run) => total + run.length, 0);
  if (questionMarkCount === characters.length) return true;
  if (questionMarkRuns.some((run) => run.length >= 4)) return true;

  const repeatedRuns = questionMarkRuns.filter((run) => run.length >= 2);
  return (
    repeatedRuns.length >= 2 &&
    questionMarkCount >= 4 &&
    questionMarkCount / characters.length >= 0.2
  );
}

export function readableCanvasText(value: string | undefined, fallback: string): string {
  const text = value?.trim();
  return !text || isLikelyEncodingDamage(text) ? fallback : text;
}

export function commitDisplayText(commit: CommitDisplayInput): {
  subject: string;
  summary: string;
} {
  const subject = readableCanvasText(commit.subject, commit.shortSha);
  return {
    subject,
    summary: readableCanvasText(commit.summary, subject),
  };
}

export function flowDisplayText(flow: FlowDisplayInput): {
  title: string;
  summary: string;
} {
  const source = readableCanvasText(
    flow.sourceBranch,
    readableCanvasText(flow.commitSha, "source"),
  );
  const target = readableCanvasText(flow.targetBranch, "target");
  const route = `${source} → ${target}`;
  return {
    title: readableCanvasText(flow.title, readableCanvasText(flow.pr?.title, flow.id)),
    summary: readableCanvasText(
      flow.summary,
      readableCanvasText(flow.pr?.summary, readableCanvasText(flow.applied?.summary, route)),
    ),
  };
}
