import path from "node:path";
import { AgentManager } from "./AgentManager.js";
import { createServer } from "./server.js";
import { FileManager } from "./files/FileManager.js";
import { PromptManager } from "./prompts/PromptManager.js";
import { realQuery } from "./sdk/realQuery.js";
import { realCodexQuery } from "./sdk/codexAppServerQuery.js";

const PORT = Number(process.env.PORT ?? 4317);
const WORKSPACE_ROOT = path.resolve(
  process.env.AGENT_CANVAS_WORKSPACE_ROOT ?? process.env.INIT_CWD ?? process.cwd(),
);

const manager = new AgentManager({
  query: realQuery,
  codexQuery: realCodexQuery,
  defaultCwd: WORKSPACE_ROOT,
});
const fileManager = new FileManager({
  workspaceRoot: WORKSPACE_ROOT,
  resolveAgentCwd: (agentId) => manager.configOf(agentId)?.cwd,
});
const promptManager = new PromptManager({ workspaceRoot: WORKSPACE_ROOT });
const { httpServer } = createServer(manager, fileManager, {
  defaultCwd: WORKSPACE_ROOT,
  promptManager,
});

httpServer.listen(PORT, () => {
  console.log(`[agent-canvas] server listening on http://localhost:${PORT}`);
  console.log(`[agent-canvas] websocket on ws://localhost:${PORT}/ws`);
  console.log(`[agent-canvas] default cwd ${WORKSPACE_ROOT}`);
});
