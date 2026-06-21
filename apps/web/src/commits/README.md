# Commit Nodes

Commit nodes are created from backend `AgentCommitSnapshot` records. Agents report commits by calling
the Agent Canvas commit report endpoint after `git commit`; the backend reads the commit metadata and
diffs from git and broadcasts the snapshot.

Edges use `sourceTurnIndex`, so a commit remains connected to the exact conversation turn that
reported it even after the agent continues and that turn becomes historical.
