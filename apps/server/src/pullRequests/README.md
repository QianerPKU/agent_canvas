# Pull Request Flow Manager

`PullRequestFlowManager` manages PR review and authorization inside Agent Canvas. It only controls flow state, branch queueing, timeouts, review JSON validation, retries, and authorization signals. Concrete `git`/`gh` commands, conflict handling, pushing, PR creation, and merging are still performed by the proposer agent after authorization.

Flows can be created from the web PR panel or by an agent through `POST /api/pr-flows`, as described in the injected Agent Canvas workspace policy.

Each review request includes a concrete changed-file list. By default the server uses `WorkspaceManager.diffPullRequestFiles()` to compute `git diff --name-status <target>...<source>` and stores it as `changedFiles`. If the caller passes `files`, the flow reviews that explicit scope and fills in status from the resolved diff when available. If no changed files can be determined, the backend rejects the PR flow.

Before a PR flow can be created, the source branch must already include the target branch head. The server fetches the target branch and rejects the flow unless `origin/<target>` is an ancestor of the source branch, so the proposer must pull, merge, or rebase the target branch into the source branch first.

## Queueing

PR flows reserve both their `sourceBranch` and `targetBranch` while they are `queued` or active. If a new flow shares either branch with an existing queued or active flow, it enters `queued` and does not send review prompts yet.

When a flow closes (`merged`, `cancelled`, `timed_out`, `source_review_failed`, `target_review_failed`, or `blocked`), the manager scans queued flows in creation order and starts every candidate whose source and target branches are now free. This preserves FIFO ordering for flows that share a source or target branch without letting an older sync-blocked queued flow stall unrelated ready flows.

If a queued flow fails the branch readiness recheck because its source no longer includes the target branch head, it remains queued with a `failureReason`. After the proposer syncs and pushes the source branch, `POST /api/pr-flows/:id/retry` rechecks readiness and starts source review when the branches are ready.

## Flow

1. The caller creates a PR flow with proposer agent, source branch, target branch, summary, and optional file scope.
2. If the relevant branches are reserved, the flow becomes `queued`.
3. Otherwise, active agents on the source branch receive a source preflight review request.
4. Review agents must return the fixed JSON schema. Invalid JSON is retried once, then recorded as `blocked`.
5. After all source reviews approve, the proposer receives `create_pr` authorization.
6. After the proposer creates the GitHub PR, it reports `agentCanvasPrEvent: "pr_created"` or the UI calls `POST /api/pr-flows/:id/pr-created`.
7. Active agents on the target branch receive a target merge review request.
8. After all target reviews approve, the proposer receives `merge_pr` authorization.

Any review or authorization stage defaults to a 2 hour timeout. After timeout, the flow enters `timed_out`, no further authorization is granted, and the manager attempts to start the next queued flow for the affected branches.

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

`PullRequestFlowManager.test.ts` covers source review approval, PR creation, target review approval, merge authorization, invalid JSON retry failure, timeout behavior, branch queueing, queued branch reservation, and changed-file resolution.

`PullRequestFlowManager.integration.test.ts` creates a real temporary git repository and bare remote, uses `WorkspaceManager` to clone `main`, `feature/pr-flow`, and `feature/other`, starts multiple fake agents, and verifies review delivery across source and target branches.
