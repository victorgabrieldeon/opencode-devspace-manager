import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DevSpaceManager } from "./manager.js";
import { discoverProjects } from "./projects.js";

const manager = new DevSpaceManager();
const server = new McpServer(
  { name: "devspace-manager", version: "0.1.0" },
  { capabilities: { tools: {} }, instructions: "Discover and manage local DevSpace development sessions." },
);
const directoryInput = { directory: z.string().trim().min(1).describe("Absolute project directory containing devspace.yaml or devspace.yml") };

server.registerTool("list_projects", {
  description: "Find DevSpace projects below local code roots. Defaults to ~/code.",
  inputSchema: {
    roots: z.array(z.string().trim().min(1)).max(20).optional().describe("Absolute directories to scan"),
    maxDepth: z.number().int().min(0).max(8).default(4),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ roots, maxDepth }) => textResult(await discoverProjects(roots, maxDepth)));

server.registerTool("status", {
  description: "Read config detection, process state, PID, service links, message, and recent DevSpace logs for one project.",
  inputSchema: directoryInput,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ directory }) => textResult(await manager.status(directory)));

server.registerTool("start", {
  description: "Start `devspace dev --no-colors` for one project. Returns immediately with current state.",
  inputSchema: directoryInput,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}, async ({ directory }) => textResult(await manager.start(directory)));

server.registerTool("stop", {
  description: "Stop the DevSpace session started by this plugin for one project, including its port forwards.",
  inputSchema: directoryInput,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
}, async ({ directory }) => textResult(await manager.stop(directory)));

server.registerTool("restart", {
  description: "Stop then start the DevSpace session for one project.",
  inputSchema: directoryInput,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
}, async ({ directory }) => textResult(await manager.restart(directory)));

server.registerTool("open_url", {
  description: "Open an HTTP or HTTPS DevSpace service URL in the system browser.",
  inputSchema: { url: z.url().describe("HTTP or HTTPS service URL returned by status") },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, async ({ url }) => textResult({ opened: await manager.openUrl(url) }));

await server.connect(new StdioServerTransport());

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await manager.shutdown();
  await server.close();
}

function requestShutdown(): void {
  void shutdown().finally(() => process.exit(0));
}

process.stdin.once("close", requestShutdown);
process.stdin.once("end", requestShutdown);
process.once("SIGINT", requestShutdown);
process.once("SIGTERM", requestShutdown);

function textResult(value: unknown): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}
