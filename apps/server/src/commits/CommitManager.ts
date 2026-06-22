import { execFile } from "node:child_process";
import type {
  AgentCommitSnapshot,
  AgentStartConfig,
  CommitChangedFile,
  ReportAgentCommitInput,
} from "@agent-canvas/shared";

export interface GitRunner {
  (args: string[], options?: { cwd?: string }): Promise<string>;
}

export interface CommitManagerOptions {
  now?: () => number;
  runGit?: GitRunner;
}

export type CommitListener = (commit: AgentCommitSnapshot) => void;

const FIELD = "\x1f";

export class CommitManager {
  private readonly now: () => number;
  private readonly runGit: GitRunner;
  private readonly commits = new Map<string, AgentCommitSnapshot>();
  private readonly byAgentAndSha = new Map<string, string>();
  private readonly listeners = new Set<CommitListener>();
  private counter = 0;

  constructor(options: CommitManagerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.runGit = options.runGit ?? defaultRunGit;
  }

  onCommit(listener: CommitListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(): AgentCommitSnapshot[] {
    return [...this.commits.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  exportState(): AgentCommitSnapshot[] {
    return this.list();
  }

  importState(commits: AgentCommitSnapshot[] | undefined): void {
    this.commits.clear();
    this.byAgentAndSha.clear();
    for (const commit of commits ?? []) {
      this.commits.set(commit.id, commit);
      this.byAgentAndSha.set(`${commit.agentId}:${commit.commitSha}`, commit.id);
    }
    this.counter = maxNumericSuffix([...this.commits.keys()]);
  }

  get(id: string): AgentCommitSnapshot | undefined {
    return this.commits.get(id);
  }

  async recordFromAgent(
    agentId: string,
    config: Pick<AgentStartConfig, "cwd" | "branch"> | undefined,
    sourceTurnIndex: number,
    input: ReportAgentCommitInput = {},
  ): Promise<AgentCommitSnapshot> {
    const cwd = config?.cwd?.trim();
    if (!cwd) throw new Error("agent 没有可用工作目录，无法记录 commit");
    const ref = input.commit?.trim() || "HEAD";
    const commitSha = await this.runGit(["rev-parse", "--verify", ref], { cwd });
    const existingId = this.byAgentAndSha.get(`${agentId}:${commitSha}`);
    if (existingId) return this.commits.get(existingId)!;

    const metadata = await this.readMetadata(cwd, commitSha);
    const branch = await this.currentBranch(cwd, config?.branch);
    const nameStatus = await this.runGit(
      ["show", "--format=", "--name-status", "--find-renames", commitSha],
      { cwd },
    );
    const fullDiff = await this.runGit(
      ["show", "--format=", "--patch", "--find-renames", "--no-ext-diff", commitSha],
      { cwd },
    );
    const files = attachDiffs(parseNameStatus(nameStatus), fullDiff);
    const commit: AgentCommitSnapshot = {
      id: `commit_${++this.counter}`,
      agentId,
      sourceTurnIndex,
      commitSha,
      shortSha: metadata.shortSha,
      branch,
      cwd,
      authorName: metadata.authorName,
      authorEmail: metadata.authorEmail,
      authoredAt: metadata.authoredAt,
      committedAt: metadata.committedAt,
      subject: metadata.subject,
      body: metadata.body,
      summary: input.summary?.trim() || metadata.subject,
      files,
      createdAt: this.now(),
    };
    this.commits.set(commit.id, commit);
    this.byAgentAndSha.set(`${agentId}:${commitSha}`, commit.id);
    this.emit(commit);
    return commit;
  }

  private async readMetadata(cwd: string, commitSha: string): Promise<CommitMetadata> {
    const output = await this.runGit(
      [
        "show",
        "-s",
        `--format=%H${FIELD}%h${FIELD}%an${FIELD}%ae${FIELD}%aI${FIELD}%cI${FIELD}%s${FIELD}%b`,
        commitSha,
      ],
      { cwd },
    );
    const [sha, shortSha, authorName, authorEmail, authoredAt, committedAt, subject, ...body] =
      output.split(FIELD);
    return {
      sha: sha || commitSha,
      shortSha: shortSha || commitSha.slice(0, 7),
      authorName: authorName || undefined,
      authorEmail: authorEmail || undefined,
      authoredAt: authoredAt || undefined,
      committedAt: committedAt || undefined,
      subject: subject || "(no subject)",
      body: body.join(FIELD).trim() || undefined,
    };
  }

  private async currentBranch(cwd: string, fallback: string | undefined): Promise<string | undefined> {
    try {
      return (await this.runGit(["branch", "--show-current"], { cwd })) || fallback;
    } catch {
      return fallback;
    }
  }

  private emit(commit: AgentCommitSnapshot): void {
    for (const listener of this.listeners) {
      try {
        listener(commit);
      } catch {
        // 单个 UI 订阅者异常不影响 commit 记录。
      }
    }
  }
}

interface CommitMetadata {
  sha: string;
  shortSha: string;
  authorName?: string;
  authorEmail?: string;
  authoredAt?: string;
  committedAt?: string;
  subject: string;
  body?: string;
}

interface ParsedNameStatus {
  status: string;
  path: string;
  oldPath?: string;
}

async function defaultRunGit(args: string[], options: { cwd?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: options.cwd, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || error.message).trim()));
        return;
      }
      resolve(stdout.trimEnd());
    });
  });
}

function parseNameStatus(output: string): ParsedNameStatus[] {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.includes("\t") ? line.split("\t") : line.split(/\s+/u);
      const status = parts[0] ?? "?";
      if ((status.startsWith("R") || status.startsWith("C")) && parts[1] && parts[2]) {
        return { status, oldPath: parts[1], path: parts[2] };
      }
      return { status, path: parts.slice(1).join(" ") };
    })
    .filter((file) => file.path);
}

function attachDiffs(files: ParsedNameStatus[], fullDiff: string): CommitChangedFile[] {
  const chunks = splitDiff(fullDiff);
  return files.map((file, index) => {
    const diff = chunks.byPath.get(file.path) ?? chunks.byPath.get(file.oldPath ?? "") ?? chunks.list[index] ?? "";
    return {
      ...file,
      additions: countChangedLines(diff, "+"),
      deletions: countChangedLines(diff, "-"),
      diff,
    };
  });
}

function splitDiff(fullDiff: string): { list: string[]; byPath: Map<string, string> } {
  const list: string[] = [];
  const byPath = new Map<string, string>();
  const lines = fullDiff.split(/\r?\n/u);
  let current: string[] = [];
  const flush = () => {
    if (current.length === 0) return;
    const chunk = current.join("\n");
    list.push(chunk);
    const path = pathFromDiffHeader(current[0] ?? "");
    if (path) byPath.set(path, chunk);
    current = [];
  };
  for (const line of lines) {
    if (line.startsWith("diff --git ")) flush();
    if (line || current.length > 0) current.push(line);
  }
  flush();
  return { list, byPath };
}

function pathFromDiffHeader(line: string): string | undefined {
  const match = line.match(/^diff --git a\/(.+) b\/(.+)$/u);
  if (!match) return undefined;
  return match[2];
}

function countChangedLines(diff: string, marker: "+" | "-"): number {
  return diff
    .split(/\r?\n/u)
    .filter((line) => {
      if (!line.startsWith(marker)) return false;
      if (marker === "+" && line.startsWith("+++")) return false;
      if (marker === "-" && line.startsWith("---")) return false;
      return true;
    }).length;
}

function maxNumericSuffix(ids: string[]): number {
  let max = 0;
  for (const id of ids) {
    const match = id.match(/_(\d+)$/u);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max;
}
