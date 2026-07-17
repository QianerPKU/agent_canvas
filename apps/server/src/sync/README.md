# Sync Flows

`SyncFlowManager` manages one-step review flows for bringing code into the current branch:

- `cherry_pick`: review and authorize cherry-picking one commit.
- `branch_pull`: review and authorize pulling/merging another branch.

The manager mirrors the PR flow delivery mechanics: active agents on the target branch review the
request, running agents receive a steer message, waiting agents receive a normal send, invalid JSON
is retried once, and a 10 minute timeout closes stale flows. The manager only grants permission; the
proposer agent still performs the actual git commands and reports completion.

## Shared Branch Review Queue

Sync and PR reviews use one shared queue keyed by the branch being reviewed. Every sync review uses
its `targetBranch` (the proposer's current branch); its `sourceBranch`, when present, does not occupy
a review slot. A PR source review uses its `sourceBranch`, and a PR target review uses its
`targetBranch`. Consequently, pulling into a branch is serialized with a PR source or target review
for that same branch.

Only one review may run on a branch at a time. Reviews for the same branch start in FIFO order, while
reviews for different branches may run in parallel. A queued sync flow has no active review request
or review deadline, so queue waiting time does not count toward its 10 minute review timeout. The
deadline starts when the review actually begins.

Approval, rejection, timeout, or cancellation invalidates the target-branch slot. If a prompt
delivery is still in flight, the reservation is retained until that delivery settles, preventing a
blocked `steer` from overlapping the next same-branch review. Approval otherwise releases the slot
when apply authorization is issued; the queue does not wait for the proposer to finish the git
operation or report `applied`.

When persisted canvas state is restored, an in-progress sync review is requeued and its old deadline
is discarded. An authoritative queue-wide sequence is persisted when each current PR or sync review
stage is admitted, preserving total FIFO order across deferred activation, later request timestamps,
equal timestamps, wall-clock rollback, and manager import order. Legacy snapshots without it receive
a deterministic position from their immutable stage admission time. Agents, prompts, and layout are restored before the
shared PR/sync queue is rebuilt and drained. The head starts with a fresh request and deadline only
when the target branch has an active agent; otherwise it remains queued and is retried automatically
when an agent becomes active or a waiting agent switches onto that branch. This prevents zero-reviewer
auto-approval and premature prompt delivery during project reload.

## Review Contract

Reviewers must return one JSON object with `agentCanvasSyncReview: true`, `flowId`, `decision`,
`summary`, `risks`, `filesReviewed`, and `requiredChanges`. Any `reject`, `needs_changes`, or
`blocked` decision closes the flow as `review_failed`.

When all reviewers approve, the target-branch review slot is released and the proposer receives
apply authorization. After it performs the real git operation, it reports:

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
