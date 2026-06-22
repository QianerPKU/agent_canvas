# SDK Adapters

This folder adapts provider-specific CLI or SDK streams into the internal `QueryHandle` interface.

- `realQuery.ts` wraps Claude Agent SDK sessions.
- `codexAppServerQuery.ts` wraps `codex app-server --stdio` JSON-RPC sessions.
- `QueryHandle.steer` means same-turn guidance for an active run. Codex requires `turn/steer`
  requests to include `threadId`, `expectedTurnId`, and `input`; `expectedTurnId` must match the
  currently active turn id returned by `turn/start`.
- When a provider has no native `steer`, `AgentRunner` falls back to interrupting the active turn and
  putting the guidance text at the front of the next queued input.
