# Turn Nodes

`TurnNode` renders one agent conversation turn on the canvas.

- The tail of each conversation chain keeps the latest turn and the immediately previous completed
  turn expanded by default. Older completed turns auto-minimize once; if the user changes a node's
  minimized state manually, later refreshes respect that choice.
- New turns are positioned under the previous turn's actual canvas position. When an older turn has
  auto-minimized, the following turn sits directly under the small node with a compact gap.
- New root nodes created from the toolbar, including agent, file, and prompt nodes, start from the
  current viewport center instead of the global canvas origin.
- Derived nodes such as commit, PR, and sync nodes use the source turn as their anchor, so historical
  edges stay attached to the exact turn that produced the action.
- Completed turns with a fork anchor can fork into the current branch, another existing branch, or a
  newly created branch. The inline branch creator passes a selected base branch through to
  `/api/workspace/branches` before sending the fork request.
- Stopped and terminated turns are displayed as distinct completed visual turns (`中断` and
  `terminated`) and the chain extends a new idle tail node that can accept the next prompt.
- React Flow layout is persisted per canvas project through `/api/canvas-layout`, including node
  positions, dimensions, and minimized window state.
- Question and approval panels stop click propagation internally, so answering questions or toggling
  session-level approval memory does not open the turn history details window.
- Each real input turn can receive a backend `turn_context` event with the branch, cwd, and git HEAD
  commit captured when that turn starts. The node displays the branch and base commit, while
  minimized historical turns keep the short base hash visible.
- The turn header includes a folder shortcut that calls `/api/agents/:id/open-workspace` and opens
  the agent's current branch workspace in VS Code without triggering the history details window.
