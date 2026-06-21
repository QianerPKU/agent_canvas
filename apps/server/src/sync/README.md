# Sync Flows

`SyncFlowManager` manages one-step review flows for bringing code into the current branch:

- `cherry_pick`: review and authorize cherry-picking one commit.
- `branch_pull`: review and authorize pulling/merging another branch.

The manager mirrors the PR flow delivery mechanics: active agents on the target branch review the
request, running agents receive a steer message, waiting agents receive a normal send, invalid JSON
is retried once, and a 10 minute timeout closes stale flows. The manager only grants permission; the
proposer agent still performs the actual git commands and reports completion.

## Review Contract

Reviewers must return one JSON object with `agentCanvasSyncReview: true`, `flowId`, `decision`,
`summary`, `risks`, `filesReviewed`, and `requiredChanges`. Any `reject`, `needs_changes`, or
`blocked` decision closes the flow as `review_failed`.

When all reviewers approve, the proposer receives apply authorization. After it performs the real
git operation, it reports:

```json
{
  "agentCanvasSyncEvent": "applied",
  "flowId": "sync_flow_x",
  "summary": "what was applied",
  "commitSha": "resulting commit if applicable",
  "files": ["src/example.ts"]
}
```

`sourceTurnIndex` is captured at creation time so the frontend can keep the sync node connected to
the original proposer turn after the agent continues into later turns.
