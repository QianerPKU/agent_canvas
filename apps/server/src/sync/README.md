# Sync Flows

`SyncFlowManager` manages one-step review flows for bringing code into the current branch:

- `cherry_pick`: review and authorize cherry-picking one commit.
- `branch_pull`: review and authorize pulling/merging another branch.

The manager mirrors the PR flow delivery mechanics: active agents on the target branch review the
request, running agents receive a steer message, waiting agents receive a normal send, and a 2 hour
timeout matching PR reviews closes stale flows. Reviews are normally submitted through the manager's
`submitReview()` capability callback API, exposed by HTTP as `POST /api/sync-flows/:id/reviews`; legacy sessions
that end a turn with the old review JSON remain supported and receive one callback-oriented retry if
their output cannot be parsed. The manager only grants permission; the proposer agent still performs
the actual git commands and reports completion through the capability-checked `submitApplied()` path
at `POST /api/sync-flows/:id/applied`. `recordApplied()` is retained for trusted internal legacy and
browser-origin-and-project-header-validated UI callers; it is not the raw agent callback entry point.

Create, review, applied, cancel, and timeout transitions never keep the originating HTTP callback
waiting for downstream queue advancement, authorization delivery, or closure delivery. They return
the immediately persisted snapshot and run those deliveries as tracked background work, so a create
response may still be `queued`. Closing delivery waits only for older work from the same flow; it
cannot release the freeze ahead of a blocked prompt or wait on an unrelated sync.

## Shared Branch Review Queue

Sync and PR reviews use one shared queue keyed by the branch being reviewed. Every sync review uses
its `targetBranch` (the proposer's current branch); its `sourceBranch`, when present, does not occupy
a review slot. A PR source review uses its `sourceBranch`, and a PR target review uses its
`targetBranch`. Consequently, pulling into a branch is serialized with a PR source or target review
for that same branch.

Only one review may run on a branch at a time. Reviews for the same branch start in FIFO order, while
reviews for different branches may run in parallel. A queued sync flow has no active review request
or review deadline, so queue waiting time does not count toward its 2 hour review timeout. The
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
a distinct normalized position based on immutable stage admission time and natural numeric flow order
before either queue owner drains. Agents, prompts, and layout are restored before the
shared PR/sync queue is rebuilt and drained. The head starts with a fresh request and deadline only
when the target branch has an active agent; otherwise it remains queued and is retried automatically
when an agent becomes active or a waiting agent switches onto that branch. This prevents zero-reviewer
auto-approval and premature prompt delivery during project reload.

Review and apply callback tokens are private, in-memory capabilities. They are bound to the exact
flow, review request/action, and agent, and are included only in that agent's prompt. Tokens never
enter a flow snapshot. Newly issued values use the reserved `agent_canvas_cap_` prefix so public
REST/WebSocket history and agent snapshots, plus persisted canvas agent state, redact both named
token fields and bare token echoes. Import clears all old capabilities. When an
unexpired imported flow is already `apply_authorized`, activation issues a fresh apply token and
best-effort redelivers the authorization prompt; deferred imports do not do so before activation.

## Review Contract

Reviewers submit an actual intermediate callback instead of ending their reply with JSON:

```http
POST /api/sync-flows/sync_flow_x/reviews
Content-Type: application/json
```

```json
{
  "agentId": "agent_1",
  "reviewToken": "private token copied from this review prompt",
  "decision": "approve",
  "summary": "safe for my current work",
  "risks": [],
  "filesReviewed": ["src/example.ts"],
  "requiredChanges": []
}
```

The token must match the current flow/request/reviewer binding, the agent must be a pending reviewer,
`decision` must be `approve`, `reject`, `needs_changes`, or `blocked`, and `summary` must be non-empty.
An identical retry is idempotent while the review capability remains active; a conflicting retry is
rejected. Review capabilities expire when the flow closes. Any non-approval decision closes the flow
as `review_failed`. Result-boundary JSON with `agentCanvasSyncReview: true` is retained only as a
trusted compatibility fallback. If a no-native-steer runner recorded the current review prompt only
as `user_input mode=queued`, the preceding turn's result is ignored until the same prompt is actually
delivered; it does not consume the malformed-response retry.

Repository inspection and review callback submission are read-only. Every requested reviewer,
including the proposer, must keep the entire workspace, Git state, and PR state read-only from receipt
of the review request through `applied`, `review_failed`, `cancelled`, `timed_out`, or `blocked`.
Submitting a callback does not release that freeze. Apply authorization grants only the proposer a
limited write exception for the changes required by the authorized sync flow; all other reviewers and
all unrelated state remain read-only. On closure the manager best-effort sends a release notice to the
proposer plus every reviewer accumulated across review attempts and reloads. The flow-specific keyed
release replaces any unconsumed review/retry/authorization from that flow; failed delivery is retried
when the participant becomes active again and successful delivery is deduplicated. Delivery failure
cannot reopen the flow, and the notice makes clear that it releases only this flow, not any concurrent
PR/sync freeze.

When all reviewers approve, the target-branch review slot is released and the proposer receives
apply authorization in the active turn when steering is available. After it performs the real git
operation, it records completion with another intermediate callback:

```http
POST /api/sync-flows/sync_flow_x/applied
Content-Type: application/json
```

```json
{
  "callbackToken": "private token copied from the authorization prompt",
  "summary": "what was applied",
  "commitSha": "resulting commit if applicable",
  "files": ["src/example.ts"]
}
```

The callback token is bound to this flow, the proposer, and the `applied` action. An identical
successful completion retry is idempotent; different data with the same accepted token is rejected.
The callback does not itself end the agent reply. Legacy final JSON with
`agentCanvasSyncEvent: "applied"` remains accepted through the manager's trusted internal path for
restored/in-flight sessions.

`sourceTurnIndex` is captured at creation time so the frontend can keep the sync node connected to
the original proposer turn after the agent continues into later turns.
