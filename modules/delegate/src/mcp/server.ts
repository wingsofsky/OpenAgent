/**
 * `openagent mcp`: the stdio MCP server a main agent registers, for example (before the npm package exists)
 *   claude mcp add openagent -- node <repo>/packages/cli/src/cli.ts mcp --project <project>
 * `--project` defaults to the folder the server starts in; it may not be the filesystem root, the user's home
 * directory, the OpenAgent home folder or a folder that contains it. The server offers the delegation tools only.
 * stdout belongs to JSON-RPC: every log line goes to stderr.
 */
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveProject } from "@openagent/common/home";
import { ANNOTATIONS, instructions, type ToolScope } from "./kit.ts";
import { registerDelegationTools } from "./delegation-tools.ts";

const version = (): string => JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;

/** Builds a server for a project (exported for tests). */
export function buildServer(project: string, env: NodeJS.ProcessEnv = process.env, life: { signal?: AbortSignal; running?: Set<Promise<unknown>> } = {}): McpServer {
  const server = new McpServer({ name: "openagent", version: version() }, { instructions: instructions() });
  const register = ((name: string, config: Record<string, unknown>, handler: unknown) => {
    const withAnnotations = ANNOTATIONS[name] ? { annotations: ANNOTATIONS[name], ...config } : config;
    return (server.registerTool as unknown as (n: string, c: unknown, h: unknown) => unknown)(name, withAnnotations, handler);
  }) as unknown as McpServer["registerTool"];
  const scope: ToolScope = { register, project, env, ...life };
  registerDelegationTools(scope);
  return server;
}

export async function mcpCommand(argv: string[]): Promise<number> {
  let projectArg = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--project") projectArg = argv[++i] ?? "";
    else if (a === "--help" || a === "-h") {
      console.error("openagent mcp [--project <dir>]\nstdio MCP server for a main agent: the delegation tools; see the CLI guide.");
      return 0;
    } else {
      console.error(`openagent mcp: unknown option ${a}`);
      return 2;
    }
  }
  const project = resolveProject(projectArg);
  // A client that closes stdin lets running rounds finish. One that sends SIGTERM or SIGINT (the MCP SDK's client
  // does, two seconds after closing stdin) stops them: each executor's process tree is ended and its round recorded
  // as stopped before the server exits. A second signal ends the server at once.
  const stop = new AbortController();
  const running = new Set<Promise<unknown>>();
  const onSignal = () => {
    stop.abort();
    void Promise.allSettled([...running]).then(() => process.exit(0));
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  await buildServer(project, process.env, { signal: stop.signal, running }).connect(new StdioServerTransport());
  console.error(`[openagent mcp] ready: ${project}`);
  await new Promise<void>((resolve) => process.stdin.on("close", resolve));
  return 0;
}
