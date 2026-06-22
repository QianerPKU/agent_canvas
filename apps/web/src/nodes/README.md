# Turn Nodes

`TurnNode` renders one agent conversation turn on the canvas.

- When a finished turn becomes historical because a new turn is created, the canvas auto-minimizes
  that old turn once. If the user restores it manually, later refreshes respect that choice.
- New turns are positioned under the previous turn's actual canvas position. When the previous turn
  has auto-minimized, the next turn sits directly under the small node with a compact gap.
- New root nodes created from the toolbar, including agent, file, and prompt nodes, start from the
  current viewport center instead of the global canvas origin.
- Derived nodes such as commit, PR, and sync nodes use the source turn as their anchor, so historical
  edges stay attached to the exact turn that produced the action.
- React Flow layout is persisted per canvas project through `/api/canvas-layout`, including node
  positions, dimensions, and minimized window state.
- Each real input turn can receive a backend `turn_context` event with the branch, cwd, and git HEAD
  commit captured when that turn starts. The node displays the branch and base commit, while
  minimized historical turns keep the short base hash visible.
