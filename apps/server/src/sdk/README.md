# SDK Adapters

This folder adapts provider-specific CLI or SDK streams into the internal `QueryHandle` interface.

- `realQuery.ts` wraps Claude Agent SDK sessions.
- `codexAppServerQuery.ts` wraps `codex app-server --stdio` JSON-RPC sessions.
- Claude question support uses the SDK `AskUserQuestion` tool. When Agent Canvas has a
  `requestUserInput` handler, the adapter adds `AskUserQuestion` to `allowedTools` even if no other
  auto-allowed tools were configured.
- `QueryHandle.steer` means same-turn guidance for an active run. Codex requires `turn/steer`
  requests to include `threadId`, `expectedTurnId`, and `input`; `expectedTurnId` must match the
  currently active turn id returned by `turn/start`.
- Codex `QueryHandle.interrupt` sends `turn/interrupt` for the active turn without closing the
  app-server process. `QueryHandle.terminate` is the only adapter-level operation that closes and
  kills the app-server child process.
- `QueryHandle.setModel(model)` switches the model used by later responses. Claude delegates to the
  SDK session handle's `setModel`; Codex stores the value locally and sends it on later `turn/start`
  requests because app-server exposes per-turn model overrides rather than a separate set-model RPC.
- Automation delivery never interrupts an active provider turn. When native `steer` is unavailable,
  `AgentRunner` queues the message for the next natural turn boundary. Explicit user-triggered
  `steer` keeps its interrupt-and-prioritize fallback because it represents an intentional request
  to redirect the current work.
- Flow automation carries a stable per-flow queue key. A closure release atomically removes every
  still-queued message with that key before it is sent or steered, including when replacement path
  preparation later fails; other flows and ordinary user input retain their order.
