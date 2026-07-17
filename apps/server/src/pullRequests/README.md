# Pull Request Flow Manager

`PullRequestFlowManager` manages PR review and authorization inside Agent Canvas. It only controls flow state, branch queueing, timeouts, review JSON validation, retries, and authorization signals. Concrete `git`/`gh` commands, conflict handling, pushing, PR creation, and merging are still performed by the proposer agent after authorization.

Flows can be created from the web PR panel or by an agent through `POST /api/pr-flows`, as described in the injected Agent Canvas workspace policy.

Each review request includes a concrete changed-file list. By default the server uses `WorkspaceManager.diffPullRequestFiles()` to compute `git diff --name-status <target>...<source>` and stores it as `changedFiles`. If the caller passes `files`, the flow reviews that explicit scope and fills in status from the resolved diff when available. If no changed files can be determined, the backend rejects the PR flow.

Before a PR flow can be created, the source branch must already include the target branch head. The server fetches the target branch and rejects the flow unless `origin/<target>` is an ancestor of the source branch, so the proposer must pull, merge, or rebase the target branch into the source branch first.

## Shared Branch Review Queue

PR and sync reviews use one shared, review-stage queue. A PR does not reserve both branches for its entire lifetime. Instead, each review stage occupies only the branch whose agents must review it:

- `source_preflight` uses the PR's `sourceBranch`.
- `target_merge` uses the PR's `targetBranch`.
- A sync review uses its `targetBranch`, so a pull into a PR source branch is serialized with that PR's source review.

Only one review stage may run on a branch at a time. Stages waiting for the same branch start in FIFO order, while stages for different branches may run in parallel. This prevents a new review prompt from steering an agent away from an earlier review on the same branch without unnecessarily serializing unrelated work.

The branch slot is invalidated as soon as the review stage approves, fails, times out, or is cancelled. If a review prompt is still being delivered, the slot remains reserved until that delivery settles; only then can the next same-branch stage start. This prevents a blocked `steer` from overlapping the next review. Source review still does not retain the slot while the proposer creates the PR, and target review does not retain it while the proposer performs the merge.

A queued stage has no review deadline, so time spent waiting does not count toward the review timeout. Its deadline and timer start only when the stage actually begins collecting responses. A stage also remains queued when its branch has no running or waiting agent; an agent transition back to an active status, or a waiting agent switching onto the branch, retries the head automatically. If a queued source stage fails the branch readiness recheck because its source no longer includes the target branch head, it remains queued with a `failureReason`. After the proposer syncs and pushes the source branch, `POST /api/pr-flows/:id/retry` rechecks readiness.

When persisted canvas state is restored, an in-progress review is converted back to `queued`, its old deadline is discarded, and its previous request remains as audit history. Each queued stage persists an authoritative sequence allocated when that stage enters the shared queue. Deferred activation, a later request timestamp, equal timestamps, and wall-clock rollback therefore cannot change PR/sync FIFO order across reloads. Older snapshots without a sequence remain loadable and receive a deterministic migration position from their immutable stage admission time; exact legacy cross-owner ties use a stable fallback because their original order was never recorded. The server first restores agents, prompts, and layout, then atomically rebuilds the PR and sync portions of the shared queue. An eligible head starts with a fresh request and deadline; a head without an active reviewer stays queued instead of being vacuously approved. This also ensures no review prompt or partial state save occurs while project restoration is incomplete.

## Flow

1. The caller creates a PR flow with proposer agent, source branch, target branch, summary, and optional file scope.
2. Its source preflight stage enters the shared queue for `sourceBranch` and starts when it reaches the head of that branch's queue.
3. Active agents on the source branch receive the review request. Review agents must return the fixed JSON schema; invalid JSON is retried once, then recorded as `blocked`.
4. Source approval releases `sourceBranch` and grants `create_pr` authorization. Failure, timeout, or cancellation also releases the branch without granting authorization.
5. After the proposer creates the GitHub PR, it reports `agentCanvasPrEvent: "pr_created"` or the UI calls `POST /api/pr-flows/:id/pr-created`.
6. The target merge stage enters the shared queue for `targetBranch`; active target-branch agents receive the request only after that stage acquires the branch.
7. Target approval releases `targetBranch` and grants `merge_pr` authorization. The actual merge and its `merged` report happen after the queue slot has already been released.

An active review or authorization stage defaults to a 2 hour timeout. Queue waiting time is excluded from review timeout accounting, and a review-stage timeout releases the occupied branch before the next queued stage starts.

## Agent Output Protocol

Review output:

```json
{
  "agentCanvasPrReview": true,
  "flowId": "pr_flow_1",
  "stage": "source_preflight",
  "decision": "approve",
  "summary": "review summary",
  "risks": [],
  "filesReviewed": [],
  "requiredChanges": []
}
```

PR-created output:

```json
{
  "agentCanvasPrEvent": "pr_created",
  "flowId": "pr_flow_1",
  "prNumber": 12,
  "prUrl": "https://github.com/OWNER/REPO/pull/12",
  "files": ["src/example.ts"],
  "fileChanges": [{ "status": "M", "path": "src/example.ts" }]
}
```

Merge-complete output:

```json
{
  "agentCanvasPrEvent": "merged",
  "flowId": "pr_flow_1"
}
```

## Tests

`PullRequestFlowManager.test.ts` covers source review approval, PR creation, target review approval, merge authorization, invalid JSON retry failure, timeout behavior, per-stage branch queueing, blocked-delivery cancellation and timeout, zero-reviewer deferral, FIFO release, persistence recovery, and changed-file resolution.

`PullRequestFlowManager.integration.test.ts` creates a real temporary git repository and bare remote, uses `WorkspaceManager` to clone `main`, `feature/pr-flow`, and `feature/other`, starts multiple fake agents, and verifies review delivery across source and target branches.
