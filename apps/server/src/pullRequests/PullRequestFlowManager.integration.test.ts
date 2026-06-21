import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentSettings, BranchWorkspace } from "@agent-canvas/shared";
import { AgentManager } from "../AgentManager.js";
import { AsyncMessageQueue } from "../util/AsyncMessageQueue.js";
import { WorkspaceManager } from "../workspaces/WorkspaceManager.js";
import type {
  QueryFn,
  QueryHandle,
  QueryOptions,
  SdkMessage,
  SdkUserInput,
} from "../sdk/types.js";
import { PullRequestFlowManager } from "./PullRequestFlowManager.js";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("PullRequestFlowManager integration", () => {
  it("reviews a PR across real temp git branches with multiple active agents per branch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-pr-flow-"));
    const source = path.join(root, "source-repo");
    const remote = path.join(root, "remote.git");
    const projectRoot = path.join(root, "project");

    try {
      await createTempRepo(source, remote);
      const workspaceManager = new WorkspaceManager({
        defaultSourcePath: source,
        projectRoot,
      });
      const project = await workspaceManager.connect({
        remoteUrl: remote,
        localPath: source,
        defaultBranch: "main",
      });
      const main = project.branches[0];
      if (!main) throw new Error("expected main branch workspace");
      const sourceBranch = await workspaceManager.createBranch({ branch: "feature/pr-flow" });
      const otherBranch = await workspaceManager.createBranch({ branch: "feature/other" });

      const query = makeQueryHub();
      let now = 1_000;
      const nextNow = () => ++now;
      const agentManager = new AgentManager({
        query: query.query,
        codexQuery: query.query,
        now: nextNow,
      });
      const prManager = new PullRequestFlowManager({
        host: agentManager,
        now: nextNow,
        reviewTimeoutMs: 30_000,
      });
      agentManager.onEvent((envelope) => {
        void prManager.handleAgentEvent(envelope);
      });

      const proposer = await startAgent(agentManager, query, sourceBranch, "running");
      const sourceWaiting = await startAgent(agentManager, query, sourceBranch, "waiting_input");
      const sourceRunning = await startAgent(agentManager, query, sourceBranch, "running");
      const targetWaiting = await startAgent(agentManager, query, main, "waiting_input");
      const targetRunning = await startAgent(agentManager, query, main, "running");
      const otherWaiting = await startAgent(agentManager, query, otherBranch, "waiting_input");
      const otherRunning = await startAgent(agentManager, query, otherBranch, "running");

      const flow = await prManager.create({
        proposerAgentId: proposer.id,
        targetBranch: "main",
        summary: "Complex local PR flow",
        title: "Complex PR",
        files: ["src/feature.ts", "README.md"],
      });

      await waitUntil(() => proposer.session.steered.length === 1);
      await waitUntil(() => sourceRunning.session.steered.length === 1);
      await waitUntil(() => sourceWaiting.session.inputs.length === 2);
      expect(inputText(proposer.session.steered[0])).toContain(
        "\"stage\": \"source_preflight\"",
      );
      expect(inputText(sourceRunning.session.steered[0])).toContain(
        "sourceBranch: feature/pr-flow",
      );
      expect(inputText(sourceWaiting.session.inputs.at(-1))).toContain(
        "\"stage\": \"source_preflight\"",
      );
      expect(otherWaiting.session.inputs).toHaveLength(1);
      expect(otherRunning.session.steered).toHaveLength(0);

      await approve(prManager, query, proposer, flow.id, "source_preflight");
      await approve(prManager, query, sourceWaiting, flow.id, "source_preflight");
      await approve(prManager, query, sourceRunning, flow.id, "source_preflight");

      await waitUntil(() => prManager.get(flow.id)?.status === "create_pr_authorized");
      expect(inputText(proposer.session.inputs.at(-1))).toContain(
        "authorized to prepare and create the PR",
      );

      await emitAssistantResult(
        prManager,
        query,
        proposer,
        JSON.stringify({
          agentCanvasPrEvent: "pr_created",
          flowId: flow.id,
          prNumber: 42,
          prUrl: "local://pull/42",
        }),
      );

      await waitUntil(() => prManager.get(flow.id)?.status === "target_review_collecting");
      await waitUntil(() => targetWaiting.session.inputs.length === 2);
      await waitUntil(() => targetRunning.session.steered.length === 1);
      expect(inputText(targetWaiting.session.inputs.at(-1))).toContain(
        "\"stage\": \"target_merge\"",
      );
      expect(inputText(targetRunning.session.steered[0])).toContain("PR: local://pull/42");
      expect(inputText(sourceWaiting.session.inputs.at(-1))).toContain(
        "source_preflight",
      );
      expect(otherRunning.session.steered).toHaveLength(0);

      await approve(prManager, query, targetWaiting, flow.id, "target_merge");
      await emitAssistantResult(prManager, query, targetRunning, "not valid review json");
      await waitUntil(() =>
        inputText(targetRunning.session.inputs.at(-1)).includes(
          "previous PR review response was not valid JSON",
        ),
      );
      await approve(prManager, query, targetRunning, flow.id, "target_merge");

      await waitUntil(() => prManager.get(flow.id)?.status === "merge_authorized");
      expect(inputText(proposer.session.inputs.at(-1))).toContain(
        "authorized to merge the PR",
      );

      await emitAssistantResult(
        prManager,
        query,
        proposer,
        JSON.stringify({ agentCanvasPrEvent: "merged", flowId: flow.id }),
      );
      await waitUntil(() => prManager.get(flow.id)?.status === "merged");
      expect(prManager.get(flow.id)?.pr).toMatchObject({
        prNumber: 42,
        prUrl: "local://pull/42",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

interface QuerySession {
  options?: QueryOptions;
  output: AsyncMessageQueue<SdkMessage>;
  inputs: SdkUserInput[];
  steered: SdkUserInput[];
}

interface AgentHandle {
  id: string;
  session: QuerySession;
}

function makeQueryHub(): { query: QueryFn; sessions: QuerySession[] } {
  const sessions: QuerySession[] = [];
  const query: QueryFn = ({ prompt, options }) => {
    const session: QuerySession = {
      options,
      output: new AsyncMessageQueue<SdkMessage>(),
      inputs: [],
      steered: [],
    };
    sessions.push(session);
    if (typeof prompt !== "string") {
      void (async () => {
        for await (const input of prompt) session.inputs.push(input);
      })();
    }
    const handle: QueryHandle = {
      [Symbol.asyncIterator]: () => session.output[Symbol.asyncIterator](),
      steer: async (input) => {
        session.steered.push(input);
      },
      interrupt: async () => {
        session.output.close();
      },
      terminate: async () => {
        session.output.close();
      },
    };
    return handle;
  };
  return { query, sessions };
}

async function startAgent(
  agentManager: AgentManager,
  query: { sessions: QuerySession[] },
  branch: BranchWorkspace,
  status: "running" | "waiting_input",
): Promise<AgentHandle> {
  const settings: AgentSettings = {
    provider: "codex",
    branchWorkspaceId: branch.id,
    branch: branch.branch,
    cwd: branch.worktreePath,
  };
  const runner = agentManager.create(settings);
  agentManager.startAgent(runner.id, { prompt: `start ${runner.id}` });
  const session = query.sessions.at(-1);
  if (!session) throw new Error("expected query session");
  session.output.push(systemInit(runner.id, branch.worktreePath));
  if (status === "waiting_input") session.output.push(resultMsg());
  await flush();
  await waitUntil(() => runner.getStatus() === status);
  return { id: runner.id, session };
}

async function approve(
  prManager: PullRequestFlowManager,
  query: { sessions: QuerySession[] },
  agent: AgentHandle,
  flowId: string,
  stage: "source_preflight" | "target_merge",
): Promise<void> {
  await emitAssistantResult(
    prManager,
    query,
    agent,
    JSON.stringify({
      agentCanvasPrReview: true,
      flowId,
      stage,
      decision: "approve",
      summary: `${agent.id} approved ${stage}`,
      risks: [],
      filesReviewed: ["src/feature.ts"],
      requiredChanges: [],
    }),
  );
}

async function emitAssistantResult(
  _prManager: PullRequestFlowManager,
  _query: { sessions: QuerySession[] },
  agent: AgentHandle,
  text: string,
): Promise<void> {
  agent.session.output.push({
    type: "assistant",
    session_id: `session-${agent.id}`,
    uuid: `message-${agent.id}-${Date.now()}`,
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
  agent.session.output.push(resultMsg());
  await flush();
}

function inputText(input: SdkUserInput | undefined): string {
  const content = input?.message.content;
  if (typeof content === "string") return content;
  return content
    ?.map((block) => (block.type === "text" ? String(block.text ?? "") : ""))
    .join("") ?? "";
}

function systemInit(agentId: string, cwd: string): SdkMessage {
  return {
    type: "system",
    subtype: "init",
    session_id: `session-${agentId}`,
    model: "fake-model",
    cwd,
    tools: ["Read", "Bash"],
  };
}

function resultMsg(): SdkMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: "session",
  };
}

async function waitUntil(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return;
    await flush();
  }
  throw new Error("condition was not met before timeout");
}

async function createTempRepo(source: string, remote: string): Promise<void> {
  await mkdir(source, { recursive: true });
  await runGit(["init", "--initial-branch=main"], source);
  await runGit(["config", "user.email", "agent-canvas@example.test"], source);
  await runGit(["config", "user.name", "Agent Canvas Test"], source);
  await mkdir(path.join(source, "src"), { recursive: true });
  await writeFile(path.join(source, "README.md"), "# PR flow\n", "utf-8");
  await writeFile(path.join(source, "src", "feature.ts"), "export const base = true;\n", "utf-8");
  await runGit(["add", "."], source);
  await runGit(["commit", "-m", "init"], source);
  await runGit(["init", "--bare", "--initial-branch=main", remote], path.dirname(remote));
  await runGit(["remote", "add", "origin", remote], source);
  await runGit(["push", "-u", "origin", "main"], source);

  await runGit(["checkout", "-b", "feature/pr-flow"], source);
  await writeFile(
    path.join(source, "src", "feature.ts"),
    "export const base = true;\nexport const prFlow = true;\n",
    "utf-8",
  );
  await runGit(["add", "."], source);
  await runGit(["commit", "-m", "feature pr flow"], source);
  await runGit(["push", "-u", "origin", "feature/pr-flow"], source);

  await runGit(["checkout", "main"], source);
  await runGit(["checkout", "-b", "feature/other"], source);
  await writeFile(path.join(source, "src", "other.ts"), "export const other = true;\n", "utf-8");
  await runGit(["add", "."], source);
  await runGit(["commit", "-m", "feature other"], source);
  await runGit(["push", "-u", "origin", "feature/other"], source);
  await runGit(["checkout", "main"], source);
}

async function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || error.message).trim()));
        return;
      }
      resolve(stdout.trim());
    });
  });
}
