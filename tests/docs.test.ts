// The public docs claim only what exists: every `openagent <command>` they name is a registered command, every
// snake_case name in backticks that is not a known parameter or value is an MCP tool in ANNOTATIONS, and every relative
// Markdown link resolves to a file.
// A module's docs describe only what that module can do, and work in a sparse checkout of it: they name only the
// commands and MCP tools of the module and the modules it requires, and link only to files in its module.json paths or
// at the repository root.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ACCEPTANCES, OUTCOMES, STATUSES } from "../packages/protocol/src/task.ts";
import { ANNOTATIONS } from "../modules/delegate/src/mcp/kit.ts";

/** The public docs are the tracked Markdown files */
function trackedMarkdown(): string[] {
  const r = spawnSync("git", ["ls-files", "-z", "--", "*.md"], { encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.split("\0").filter((f) => f && fs.existsSync(f));
}

const DOCS = trackedMarkdown();
/** The decision log is history: it names commands and tools that were removed since, so it describes no current one. */
const CURRENT_DOCS = DOCS.filter((f) => f !== "DECISIONS.md");
const read = (file: string): string => fs.readFileSync(file, "utf8");

/** Commands as `openagent --help` lists them: two spaces, the name, two or more spaces, the description. */
function registeredCommands(): Set<string> {
  const r = spawnSync(process.execPath, ["packages/cli/src/cli.ts", "--help"], { encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  return new Set([...r.stdout.matchAll(/^ {2}([a-z][a-z-]*) {2,}\S/gm)].map((m) => m[1]));
}

const TOOLS = new Set<string>(Object.keys(ANNOTATIONS));

/** snake_case names the MCP tool modules use as parameters or result fields (`task_id`, `pending_suggestions`, …). */
function mcpFieldNames(): Set<string> {
  const names = new Set<string>();
  const dir = "modules/delegate/src/mcp";
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
    for (const m of read(path.join(dir, f)).matchAll(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\s*:/g)) names.add(m[1]);
  }
  return names;
}

/** Field values of the task format (`no_changes`, `needs_rework`, …). */
const FORMAT_VALUES = new Set<string>([...STATUSES, ...OUTCOMES, ...ACCEPTANCES]);

/** Other snake_case names the docs may show in backticks, with the reason. */
const NOT_TOOLS: Record<string, string> = {
  node_modules: "the dependency folder that folder tasks skip when checking the IDE",
  workspace_readwrite: "a Cursor Agent sandbox mode, in its own settings file",
  workspace_readonly: "a Cursor Agent sandbox mode, in its own settings file",
};

describe("docs", () => {
  it("are found", () => {
    expect(DOCS).toEqual(expect.arrayContaining(["README.md", "INSTALL.md", "modules/delegate/README.md", "modules/context/README.md"]));
    expect(DOCS.some((d) => d.endsWith("/SKILL.md"))).toBe(true);
  });

  it("name only registered openagent commands", () => {
    const commands = registeredCommands();
    expect(commands.size).toBeGreaterThan(5);
    const bad: string[] = [];
    for (const file of CURRENT_DOCS) {
      read(file).split("\n").forEach((line, i) => {
        for (const m of line.matchAll(/(?<![\w.@/-])openagent ([a-z][a-z-]*)/g)) {
          if (!commands.has(m[1])) bad.push(`${file}:${i + 1}: openagent ${m[1]}`);
        }
      });
    }
    expect(bad).toEqual([]);
  });

  it("name only MCP tools that exist", () => {
    for (const name of Object.keys(NOT_TOOLS)) expect(TOOLS.has(name), `${name} is an MCP tool; remove it from NOT_TOOLS`).toBe(false);
    const known = new Set([...TOOLS, ...mcpFieldNames(), ...FORMAT_VALUES, ...Object.keys(NOT_TOOLS)]);
    const bad: string[] = [];
    for (const file of CURRENT_DOCS) {
      read(file).split("\n").forEach((line, i) => {
        for (const m of line.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)(?:\([^`]*\))?`/g)) {
          if (!known.has(m[1])) bad.push(`${file}:${i + 1}: ${m[1]}`);
        }
      });
    }
    expect(bad).toEqual([]);
  });

  it("link only to files that exist", () => {
    const bad: string[] = [];
    for (const file of DOCS) {
      for (const { target, rel } of links(file)) {
        if (!fs.existsSync(path.join(path.dirname(file), rel))) bad.push(`${file}: ${target}`);
      }
    }
    expect(bad).toEqual([]);
  });

  describe("of each module", () => {
    interface Manifest {
      requires: string[];
      paths: string[];
      commands: Record<string, unknown>;
    }
    const manifest = (name: string): Manifest => JSON.parse(read(path.join("modules", name, "module.json")));
    const modules = fs.readdirSync("modules").filter((n) => fs.existsSync(path.join("modules", n, "module.json")));
    const ownerOf = new Map(modules.flatMap((m) => Object.keys(manifest(m).commands).map((c) => [c, m] as const)));
    const reach = (name: string): Set<string> => new Set([name, ...manifest(name).requires.flatMap((r) => [...reach(r)])]);

    for (const name of modules) {
      const docs = DOCS.filter((d) => d.startsWith(`modules/${name}/`));
      const allowed = reach(name);

      it(`${name}: names only its own commands and MCP tools`, () => {
        expect(docs.length).toBeGreaterThan(0);
        const bad: string[] = [];
        for (const file of docs) {
          read(file).split("\n").forEach((line, i) => {
            for (const m of line.matchAll(/(?<![\w.@/-])openagent ([a-z][a-z-]*)/g)) {
              const owner = ownerOf.get(m[1]);
              if (owner && !allowed.has(owner)) bad.push(`${file}:${i + 1}: openagent ${m[1]} (module ${owner})`);
            }
            for (const m of line.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)(?:\([^`]*\))?`/g)) {
              if (TOOLS.has(m[1]) && !allowed.has("delegate")) bad.push(`${file}:${i + 1}: ${m[1]} (an MCP tool of delegate)`);
            }
          });
        }
        expect(bad).toEqual([]);
      });

      it(`${name}: links only to files a sparse checkout of it has`, () => {
        const paths = manifest(name).paths;
        const bad: string[] = [];
        for (const file of docs) {
          for (const { target, rel } of links(file)) {
            const repoPath = path.posix.normalize(path.posix.join(path.posix.dirname(file), rel));
            const inside = !repoPath.includes("/") || paths.some((p) => repoPath === p || repoPath.startsWith(`${p}/`));
            if (!inside) bad.push(`${file}: ${target}`);
          }
        }
        expect(bad).toEqual([]);
      });
    }
  });
});

/** Relative Markdown links outside code blocks: the link as written, and its path part decoded. */
function links(file: string): { target: string; rel: string }[] {
  const text = read(file).replace(/^(```|~~~)[\s\S]*?^\1/gm, "");
  return [...text.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)]
    .map((m) => m[1])
    .filter((target) => !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith("#"))
    .map((target) => ({ target, rel: decodeURIComponent(target.split("#")[0]) }));
}
