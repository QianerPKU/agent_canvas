# Pull Request Flow Manager

`PullRequestFlowManager` manages PR review and authorization inside Agent Canvas. It only controls flow state, branch queueing, timeouts, review callback validation, retries, and authorization signals. Concrete `git`/`gh` commands, conflict handling, pushing, PR creation, and merging are still performed by the proposer agent after authorization.

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

When persisted canvas state is restored, an in-progress review is converted back to `queued`, its old deadline is discarded, and its previous request remains as audit history. Each queued stage persists an authoritative sequence allocated when that stage enters the shared queue. Deferred activation, a later request timestamp, equal timestamps, and wall-clock rollback therefore cannot change PR/sync FIFO order across reloads. Older snapshots without a sequence remain loadable: all restored legacy jobs are normalized together by immutable stage admission time, then by natural numeric flow order for recoverable same-owner ties, before receiving distinct sequences. Exact legacy cross-owner ties use a stable natural job-id fallback because their original order was never recorded. The server first restores agents, prompts, and layout, then atomically rebuilds the PR and sync portions of the shared queue. An eligible head starts with a fresh request and deadline; a head without an active reviewer stays queued instead of being vacuously approved. This also ensures no review prompt or partial state save occurs while project restoration is incomplete. Capability tokens are intentionally not persisted: restored reviews receive new tokens, and an unexpired restored create/merge authorization is re-delivered with a new completion token.

## Flow

1. The caller creates a PR flow with proposer agent, source branch, target branch, summary, and optional file scope.
2. Its source preflight stage enters the shared queue for `sourceBranch` and starts when it reaches the head of that branch's queue.
3. Active agents on the source branch receive the review request. Each agent submits its decision through `POST /api/pr-flows/:id/reviews` as an intermediate tool call, then continues its existing reply. A legacy final-result JSON response is still accepted; invalid legacy JSON is retried once, then recorded as `blocked`.
4. Source approval releases `sourceBranch` and grants `create_pr` authorization. Failure, timeout, or cancellation also releases the branch without granting authorization.
5. After the proposer creates the GitHub PR, it calls `POST /api/pr-flows/:id/pr-created` as an intermediate tool call. Legacy `agentCanvasPrEvent: "pr_created"` result JSON remains accepted.
6. The target merge stage enters the shared queue for `targetBranch`; active target-branch agents receive the request only after that stage acquires the branch.
7. Target approval releases `targetBranch` and grants `merge_pr` authorization. The actual merge and its `POST /api/pr-flows/:id/merged` callback happen after the queue slot has already been released.

An active review or authorization stage defaults to a 2 hour timeout. Queue waiting time is excluded from review timeout accounting, and a review-stage timeout releases the occupied branch before the next queued stage starts.

## Agent Callback Protocol

Callbacks are tool calls inside an agent's existing response. The agent waits for the HTTP response and then continues its previous work in the same reply; the callback body is not printed as the final assistant response.

Create, review, and completion endpoints return after validating and persisting the immediate transition; they do not wait for review-queue advancement, authorization delivery, or closure delivery to another agent. The returned snapshot can therefore still be `queued` or collecting while tracked background work advances the flow. Callers observe later transitions through the normal flow snapshot/WebSocket updates. Closing delivery waits only for earlier work from the same flow, so it neither lifts a freeze before a stale prompt settles nor waits for an unrelated PR.

Review callback: `POST /api/pr-flows/pr_flow_1/reviews`

```json
{
  "agentId": "agent_1",
  "reviewToken": "private token copied from this agent's review prompt",
  "stage": "source_preflight",
  "decision": "approve",
  "summary": "review summary",
  "risks": [],
  "filesReviewed": [],
  "requiredChanges": []
}
```

`stage` is `source_preflight` or `target_merge`, and `decision` is `approve`, `reject`, `needs_changes`, or `blocked`. The manager creates an unpredictable `reviewToken` for each request/reviewer pair and verifies that it is bound to the submitted flow, request, stage, and agent. Tokens are delivered only in that reviewer's prompt and retained by the manager's private in-memory capability map; they never enter a flow snapshot. Newly issued tokens use the reserved `agent_canvas_cap_` prefix so public REST/WebSocket history and agent snapshots, plus persisted canvas agent state, can redact both named token fields and a token echoed as bare text. Retrying an identical callback remains idempotent after stage authorization while the flow is open; a conflicting second submission is rejected.

PR-created callback: `POST /api/pr-flows/pr_flow_1/pr-created`

```json
{
  "agentId": "agent_1",
  "completionToken": "private pr_created token from the authorization prompt",
  "prNumber": 12,
  "prUrl": "https://github.com/OWNER/REPO/pull/12",
  "files": ["src/example.ts"],
  "fileChanges": [{ "status": "M", "path": "src/example.ts" }]
}
```

Merge-complete callback: `POST /api/pr-flows/pr_flow_1/merged`

```json
{
  "agentId": "agent_1",
  "completionToken": "private merged token from the authorization prompt"
}
```

Completion tokens are separately bound to the proposer, flow, and exact action (`pr_created` or `merged`), so a review token, another agent's token, or the token for the other completion action cannot authorize a callback. An accepted callback keeps a private in-memory receipt until the next import: the same token and payload return the current flow after a lost HTTP response, while a changed payload is rejected. Import clears all tokens and receipts; cancellation, timeout, failure, blocking, and merge completion clear active capabilities. Nothing is added to the snapshot.

For compatibility with agents running older prompts, final assistant result JSON containing `agentCanvasPrReview`, `agentCanvasPrEvent: "pr_created"`, or `agentCanvasPrEvent: "merged"` is still parsed. New prompts use the callbacks above so review and PR bookkeeping no longer force the agent's reply to end.

## Read-only Flow Freezes

- Every source and target reviewer stays read-only from receipt of its review request until that flow reaches `merged`, `source_review_failed`, `target_review_failed`, `cancelled`, `timed_out`, or `blocked`. A successful review callback does not release the freeze. Read-only status, diff, log, and file inspection remain allowed.
- The proposer is read-only from successful flow creation until closure, except for the narrowly scoped action granted by a create or merge authorization.
- Create authorization lifts the freeze only to create that flow's PR from the exact reviewed, already-pushed source head; it does not permit file edits, commits, pushes, or branch rewrites. After the `pr-created` callback succeeds, the proposer becomes fully read-only again until merge authorization or failure.
- Merge authorization lifts the freeze only for operations required to merge that flow's PR. When the flow closes, the manager best-effort sends a release to the proposer and every requested reviewer; delivery failure cannot reverse the closed state. The release uses the same flow-specific automation key and replaces any unconsumed review/retry/authorization for that flow. Failed release delivery is retried when the participant becomes active again and then deduplicated. The release applies only to that flow, so freezes from any other active PR or sync flow remain in force.

If a provider cannot steer an active turn, its review prompt is emitted as queued input for the next turn. A result from the older turn is ignored while that exact flow/stage prompt remains queued, so it does not consume the review's retry budget. Parsing begins only after history records the prompt's actual non-queued or steer delivery.

## Tests

`PullRequestFlowManager.test.ts` covers private callback capabilities, impersonation rejection, validation and idempotency, restored authorization token rotation, queued-input result isolation, all-reviewer freezes and close releases, legacy result JSON compatibility, source review approval, PR creation, target review approval, merge authorization, invalid JSON retry failure, timeout behavior, per-stage branch queueing, blocked-delivery cancellation and timeout, zero-reviewer deferral, FIFO release, persistence recovery, and changed-file resolution.

`PullRequestFlowManager.integration.test.ts` creates a real temporary git repository and bare remote, uses `WorkspaceManager` to clone `main`, `feature/pr-flow`, and `feature/other`, starts multiple fake agents, and verifies review delivery across source and target branches.
