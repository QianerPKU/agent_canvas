# Sync UI

This folder renders the canvas UI for Agent Canvas sync flows:

- `SyncFlowDialog.tsx` starts either `cherry_pick` or `branch_pull` flows through `/api/sync-flows`.
- `SyncFlowNode.tsx` renders the canvas node connected to the proposer turn via `sourceTurnIndex`.
  New sync nodes are positioned to the right of that source turn and avoid existing nodes.
- `SyncFlowDetailsWindow.tsx` shows the full request, changed files, review responses, and applied result.

The UI mirrors PR and commit nodes: nodes are draggable, resizable, minimizable, and keep their input
handle stable so historical edges do not break when the proposer conversation continues.

Tests:

- `SyncFlowDialog.test.tsx` covers creating both supported flow kinds.
- `SyncFlowNode.test.tsx` covers minimize/restore sizing, handle retention, and details opening.
