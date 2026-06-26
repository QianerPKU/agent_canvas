#!/usr/bin/env node
import { spawn } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const options = parseArgs(process.argv.slice(2));
const serverPort = Number(options.serverPort ?? "4317");
const webPort = Number(options.webPort ?? "5317");
const children = [];

if (!Number.isInteger(serverPort) || serverPort <= 0) {
  throw new Error(`Invalid --server-port: ${options.serverPort}`);
}
if (!Number.isInteger(webPort) || webPort <= 0) {
  throw new Error(`Invalid --web-port: ${options.webPort}`);
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const baseEnv = {
  ...process.env,
  ...(options.projectsRoot ? { AGENT_CANVAS_PROJECTS_ROOT: options.projectsRoot } : {}),
  ...(options.projectRoot ? { AGENT_CANVAS_PROJECT_ROOT: options.projectRoot } : {}),
};

if (await isPortOpen(serverPort)) {
  console.log(`Backend port ${serverPort} is already in use; reusing the existing process.`);
} else {
  console.log(`Starting Agent Canvas backend on port ${serverPort}...`);
  children.push(
    spawn(npm, ["run", "dev", "--workspace", "apps/server"], {
      cwd: root,
      env: { ...baseEnv, PORT: String(serverPort) },
      stdio: "inherit",
      shell: false,
    }),
  );
}

await waitForHttp(`http://127.0.0.1:${serverPort}/api/health`, 45_000);

if (await isPortOpen(webPort)) {
  console.log(`Frontend port ${webPort} is already in use; reusing the existing process.`);
} else {
  console.log(`Starting Agent Canvas frontend on port ${webPort}...`);
  children.push(
    spawn(
      npm,
      [
        "run",
        "dev",
        "--workspace",
        "apps/web",
        "--",
        "--host",
        "127.0.0.1",
        "--port",
        String(webPort),
      ],
      {
        cwd: root,
        env: { ...baseEnv, SERVER_PORT: String(serverPort) },
        stdio: "inherit",
        shell: false,
      },
    ),
  );
}

const url = `http://127.0.0.1:${webPort}/`;
await waitForHttp(url, 45_000);
console.log(`Agent Canvas is ready: ${url}`);
if (!options.noBrowser) openBrowser(url);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    for (const child of children) child.kill(signal);
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}

if (children.length > 0) {
  await new Promise((resolve) => {
    let remaining = children.length;
    for (const child of children) {
      child.once("exit", () => {
        remaining -= 1;
        if (remaining === 0) resolve();
      });
    }
  });
}

function parseArgs(args) {
  const parsed = { noBrowser: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const [key, inlineValue] = arg.startsWith("--") ? arg.split("=", 2) : [arg, undefined];
    const value = inlineValue ?? args[index + 1];
    if (key === "--no-browser") {
      parsed.noBrowser = true;
    } else if (key === "--server-port") {
      parsed.serverPort = value;
      if (inlineValue === undefined) index += 1;
    } else if (key === "--web-port") {
      parsed.webPort = value;
      if (inlineValue === undefined) index += 1;
    } else if (key === "--projects-root") {
      parsed.projectsRoot = value;
      if (inlineValue === undefined) index += 1;
    } else if (key === "--project-root") {
      parsed.projectRoot = value;
      if (inlineValue === undefined) index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(500);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // wait and retry
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function openBrowser(url) {
  const command =
    process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    shell: false,
  });
  child.on("error", () => undefined);
  child.unref();
}
