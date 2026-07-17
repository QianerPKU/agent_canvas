# Sync UI

This folder renders the canvas UI for Agent Canvas sync flows:

- `SyncFlowDialog.tsx` starts either `cherry_pick` or `branch_pull` flows through `/api/sync-flows`.
- `SyncFlowNode.tsx` renders the canvas node connected to the proposer turn via `sourceTurnIndex`.
  New sync nodes use a fixed offset to the right of that source turn and may overlap existing nodes.
  Queued reviews are labeled `waiting for branch review` until the shared branch queue starts them.
- `SyncFlowDetailsWindow.tsx` shows the full request, changed files, review responses, and applied result.

The UI mirrors PR and commit nodes: nodes are draggable, resizable, minimizable, and keep their input
handle stable so historical edges do not break when the proposer conversation continues.

Tests:

- `SyncFlowDialog.test.tsx` covers creating both supported flow kinds.
- `SyncFlowNode.test.tsx` covers minimize/restore sizing, handle retention, queued status, and details opening.
