# Commit Nodes

Commit nodes are created from backend `AgentCommitSnapshot` records. Agents report commits by calling
the Agent Canvas commit report endpoint after `git commit`; the backend reads the commit metadata and
diffs from git and broadcasts the snapshot.

Edges use `sourceTurnIndex`, so a commit remains connected to the exact conversation turn that
reported it even after the agent continues and that turn becomes historical.

New commit nodes are placed to the right of their source turn. Placement uses the full restored turn
width even when the source turn is auto-minimized, so the commit node does not overlap the next turn
that appears below the minimized node.

Commit details parse each file's unified diff and render it as an IDE-style table with old/new line
number gutters, hunk headers, and green/red highlighting for added and deleted rows. The parser lives
in `diff.ts` so the same view can be reused by PR or sync details later.
