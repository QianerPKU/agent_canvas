# Commit Records

`CommitManager` records commits that agents explicitly report after running `git commit`.

The manager reads commit metadata from the agent workspace with `git show`, stores the commit hash,
summary, changed files, and per-file diffs, then broadcasts the snapshot to the web app. It does not
perform commits itself; agents still decide when to run `git commit`.
