import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentSettings, BranchWorkspace } from "@agent-canvas/shared";
import { AgentManager } from "../AgentManager.js";
import { AsyncMessageQueue } from "../util/AsyncMessageQueue.js";
import { WorkspaceManager } from "../workspaces/WorkspaceManager.js";
import { SyncFlowManager } from "../sync/SyncFlowManager.js";
import type {
  QueryFn,
  QueryHandle,
  QueryOptions,
  SdkMessage,
  SdkUserInput,
} from "../sdk/types.js";
import { PullRequestFlowManager } from "./PullRequestFlowManager.js";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function removeTempRoot(target: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EBUSY" || attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

describe("PullRequestFlowManager integration", () => {
  it("reviews a PR across real temp git branches with multiple active agents per branch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-canvas-pr-flow-"));
    const source = path.join(root, "source-repo");
    const remote = path.join(root, "remote.git");
    const projectRoot = path.join(root, "project");
    const documentationMounts: string[] = [];

    try {
      await createTempRepo(source, remote);
      const workspaceManager = new WorkspaceManager({
        defaultSourcePath: source,
        projectRoot,
        projectsRoot: path.join(root, "projects"),
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
      documentationMounts.push(
        path.join(main.worktreePath, ".agent-shared-docs"),
        path.join(sourceBranch.worktreePath, ".agent-shared-docs"),
        path.join(otherBranch.worktreePath, ".agent-shared-docs"),
      );

      const query = makeQueryHub();
      let now = 1_000;
      const nextNow = () => ++now;
      const agentManager = new AgentManager({
        query: query.query,
        codexQuery: query.query,
        now: nextNow,
        resolveTurnContext: async (config) => ({
          branch: config?.branch,
          cwd: config?.cwd,
        }),
      });
      agentManager.setFileAccessResolver((agentId) =>
        workspaceManager.accessForAgent(agentManager.configOf(agentId), {
          workDocumentationEnabled: true,
        }),
      );
      agentManager.setFileAccessPreparer(async (agentId) => {
        await workspaceManager.prepareAgentWorkspace(
          agentId,
          agentManager.configOf(agentId),
          { workDocumentationEnabled: true },
        );
      });
      const prManager = new PullRequestFlowManager({
        host: agentManager,
        now: nextNow,
        reviewTimeoutMs: 30_000,
        resolveChangedFiles: async ({ sourceBranch, targetBranch }) =>
          (await workspaceManager.diffPullRequestFiles(sourceBranch, targetBranch))?.files ?? [],
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
      });
      expect(flow.files).toEqual(["src/feature.ts"]);
      expect(flow.fileChanges).toEqual([{ status: "M", path: "src/feature.ts" }]);

      await waitUntil(() => prManager.get(flow.id)?.status === "source_review_collecting");
      await waitUntil(() => proposer.session.steered.length === 1);
      await waitUntil(() => sourceRunning.session.steered.length === 1);
      await waitUntil(() => sourceWaiting.session.inputs.length === 2);
      expect(inputText(proposer.session.steered[0])).toContain(
        "\"stage\": \"source_preflight\"",
      );
      expect(inputText(sourceRunning.session.steered[0])).toContain(
        "sourceBranch: feature/pr-flow",
      );
      expect(inputText(sourceRunning.session.steered[0])).toContain(
        "changedFiles (git diff --name-status):\n- M src/feature.ts",
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
      await waitUntil(() =>
        inputText(proposer.session.inputs.at(-1)).includes(
          "authorized to create the PR for this flow from the reviewed source head",
        ),
      );
      expect(inputText(proposer.session.inputs.at(-1))).toContain(
        "authorized to create the PR for this flow from the reviewed source head",
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
      await waitUntil(() =>
        inputText(proposer.session.inputs.at(-1)).includes("authorized to merge the PR"),
      );
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

      // The close release starts this source reviewer naturally. Keep it running so the next
      // PR review exercises native steer, while the other source agents exercise direct send.
      await waitUntil(() =>
        inputText(sourceRunning.session.inputs.at(-1)).includes("Agent Canvas PR flow closed"),
      );
      await waitUntil(() => agentManager.get(sourceRunning.id)?.getStatus() === "running");
      const proposerInputCount = proposer.session.inputs.length;
      const waitingInputCount = sourceWaiting.session.inputs.length;
      const runningSteerCount = sourceRunning.session.steered.length;

      const sharedMount = path.join(sourceBranch.worktreePath, ".agent-shared-docs");
      const outside = path.join(root, "tampered-shared-docs");
      await mkdir(outside, { recursive: true });
      await rm(sharedMount, { force: true });
      await symlink(outside, sharedMount, process.platform === "win32" ? "junction" : "dir");

      const blocked = await prManager.create({
        proposerAgentId: proposer.id,
        targetBranch: "main",
        summary: "Tampered documentation mount must block direct automation dispatch",
        title: "Blocked PR",
      });

      expect(blocked.status).toBe("queued");
      await waitUntil(() => prManager.get(blocked.id)?.status === "source_review_failed");
      const blockedFinal = prManager.get(blocked.id);
      expect(blockedFinal?.failureReason).toContain("Failed to deliver review request");
      expect(proposer.session.inputs).toHaveLength(proposerInputCount);
      expect(sourceWaiting.session.inputs).toHaveLength(waitingInputCount);
      expect(sourceRunning.session.steered).toHaveLength(runningSteerCount);
      await waitUntil(() => !prManager.hasPendingOperations());
      await agentManager.clear();
      await rm(sharedMount, { force: true });
    } finally {
      for (const mount of documentationMounts) {
        await rm(mount, { force: true }).catch(() => undefined);
      }
      await removeTempRoot(root);
    }
  }, 30_000);

  it("delivers concurrent PR and sync authorizations across Codex turn transitions", async () => {
    const query = makeQueryHub();
    let now = 10_000;
    const agentManager = new AgentManager({
      query: query.query,
      codexQuery: query.query,
      now: () => ++now,
    });
    const prManager = new PullRequestFlowManager({ host: agentManager, now: () => ++now });
    const syncManager = new SyncFlowManager({ host: agentManager, now: () => ++now });
    agentManager.onEvent((envelope) => {
      if (envelope.event.kind === "result") {
        void Promise.all([
          prManager.handleAgentEvent(envelope),
          syncManager.handleAgentEvent(envelope),
        ]);
      }
    });

    const runner = agentManager.create({
      provider: "codex",
      branch: "feature/atomic-delivery",
      cwd: process.cwd(),
    });
    await agentManager.startAgent(runner.id, { prompt: "start review agent" });
    const session = query.sessions.at(-1);
    if (!session) throw new Error("expected query session");
    session.output.push(systemInit(runner.id, process.cwd()));
    await waitUntil(() => runner.getStatus() === "running");
    await waitUntil(() => session.turnActive);

    const prFlow = await prManager.create({
      proposerAgentId: runner.id,
      targetBranch: "main",
      title: "Atomic delivery",
      summary: "Exercise result-time authorization delivery",
      files: ["src/pr.ts"],
    });
    const syncFlow = await syncManager.create({
      kind: "branch_pull",
      proposerAgentId: runner.id,
      sourceBranch: "main",
      targetBranch: "feature/atomic-delivery",
      summary: "Catch up with main",
      reason: "Exercise concurrent authorization delivery",
      files: ["src/sync.ts"],
    });
    await waitUntil(() => session.steered.length === 2);
    expect(session.steered).toHaveLength(2);

    await runner.send("ordinary queued input");
    session.pauseTurnActivation = true;
    session.output.push({
      type: "assistant",
      session_id: `session-${runner.id}`,
      uuid: "combined-review",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: [
              JSON.stringify({
                agentCanvasPrReview: true,
                flowId: prFlow.id,
                stage: "source_preflight",
                decision: "approve",
                summary: "PR approved",
                risks: [],
                filesReviewed: ["src/pr.ts"],
                requiredChanges: [],
              }),
              JSON.stringify({
                agentCanvasSyncReview: true,
                flowId: syncFlow.id,
                decision: "approve",
                summary: "Sync approved",
                risks: [],
                filesReviewed: ["src/sync.ts"],
                requiredChanges: [],
              }),
            ].join("\n"),
          },
        ],
      },
    });
    completeTurn(session);

    await waitUntil(() => prManager.get(prFlow.id)?.status === "create_pr_authorized");
    await waitUntil(() => syncManager.get(syncFlow.id)?.status === "apply_authorized");
    expect(session.steered).toHaveLength(2);
    expect(session.inputs.map(inputText)).toEqual(["start review agent", "ordinary queued input"]);

    completeTurn(session);
    await waitUntil(() => session.inputs.length === 3);
    completeTurn(session);
    await waitUntil(() => session.inputs.length === 4);
    const delivered = session.inputs.map(inputText);
    expect(
      delivered.filter((text) =>
        text.includes("authorized to create the PR for this flow from the reviewed source head"),
      ),
    ).toHaveLength(1);
    expect(
      delivered.filter((text) =>
        text.includes("authorized to pull/merge the requested source branch"),
      ),
    ).toHaveLength(1);
    expect(prManager.get(prFlow.id)?.failureReason).toBeUndefined();
    expect(syncManager.get(syncFlow.id)?.failureReason).toBeUndefined();
    await waitUntil(
      () => !prManager.hasPendingOperations() && !syncManager.hasPendingOperations(),
    );
    await agentManager.clear();
  });
});

interface QuerySession {
  options?: QueryOptions;
  output: AsyncMessageQueue<SdkMessage>;
  inputs: SdkUserInput[];
  steered: SdkUserInput[];
  turnActive: boolean;
  pauseTurnActivation: boolean;
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
      turnActive: false,
      pauseTurnActivation: false,
    };
    sessions.push(session);
    if (typeof prompt !== "string") {
      void (async () => {
        for await (const input of prompt) {
          session.inputs.push(input);
          if (!session.pauseTurnActivation) session.turnActive = true;
        }
      })();
    }
    const handle: QueryHandle = {
      [Symbol.asyncIterator]: () => session.output[Symbol.asyncIterator](),
      steer: async (input) => {
        if (!session.turnActive) throw new Error("Codex turn is not active");
        session.steered.push(input);
      },
      canSteerNow: () => session.turnActive,
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
  await agentManager.startAgent(runner.id, { prompt: `start ${runner.id}` });
  const session = query.sessions.at(-1);
  if (!session) throw new Error("expected query session");
  session.output.push(systemInit(runner.id, branch.worktreePath));
  if (status === "waiting_input") completeTurn(session);
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
  completeTurn(agent.session);
  await flush();
}

function completeTurn(session: QuerySession): void {
  session.turnActive = false;
  session.output.push(resultMsg());
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

async function waitUntil(check: () => boolean, timeoutMs = 5_000): Promise<void> {
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
