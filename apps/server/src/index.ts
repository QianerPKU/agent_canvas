import { AgentManager } from "./AgentManager.js";
import { createServer } from "./server.js";
import { realQuery } from "./sdk/realQuery.js";

const PORT = Number(process.env.PORT ?? 4317);

const manager = new AgentManager({ query: realQuery });
const { httpServer } = createServer(manager);

httpServer.listen(PORT, () => {
  console.log(`[agent-canvas] server listening on http://localhost:${PORT}`);
  console.log(`[agent-canvas] websocket on ws://localhost:${PORT}/ws`);
});
