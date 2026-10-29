#!/usr/bin/env node
/**
 * `longkeep` command entry. The commands come from the modules present in this checkout: each `modules/<name>/module.json`
 * lists its commands, and a module left out of a sparse checkout simply has none. A command's module is loaded only
 * when it runs, so `--help` stays fast and one broken module cannot stop the others from starting.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MODULES = path.join(import.meta.dirname, "..", "..", "..", "modules");

interface Command {
  about: string;
  /** Loads the command's module on demand and runs it; resolves to the exit code. */
  run: (args: string[]) => Promise<number>;
}

interface Manifest {
  commands?: Record<string, { entry: string; export: string; about: string }>;
}

function loadCommands(): Map<string, Command> {
  const commands = new Map<string, Command>();
  const names = existsSync(MODULES) ? readdirSync(MODULES, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : [];
  for (const name of names.sort()) {
    const file = path.join(MODULES, name, "module.json");
    if (!existsSync(file)) continue;
    const manifest = JSON.parse(readFileSync(file, "utf8")) as Manifest;
    for (const [command, spec] of Object.entries(manifest.commands ?? {})) {
      const entry = pathToFileURL(path.join(MODULES, name, spec.entry)).href;
      commands.set(command, {
        about: spec.about,
        run: async (args) => ((await import(entry)) as Record<string, (a: string[]) => Promise<number>>)[spec.export](args),
      });
    }
  }
  return commands;
}

const version = (): string => JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

function usage(commands: Map<string, Command>): string {
  const width = Math.max(0, ...[...commands.keys()].map((n) => n.length));
  const rows = [...commands].map(([name, c]) => `  ${name.padEnd(width)}  ${c.about}`);
  return [
    `longkeep ${version()}`,
    "",
    "Usage: longkeep <command> [options]",
    "",
    rows.length ? rows.join("\n") : "  (no module with commands in this checkout; INSTALL.md says how to add one)",
  ].join("\n");
}

async function main(argv: string[]): Promise<number> {
  const commands = loadCommands();
  const [name, ...rest] = argv;
  if (name === undefined || name === "--help" || name === "-h" || name === "help") {
    console.log(usage(commands));
    return 0;
  }
  if (name === "--version" || name === "-v") {
    console.log(version());
    return 0;
  }
  const command = commands.get(name);
  if (!command) {
    console.error(`longkeep: unknown command "${name}". "longkeep --help" lists the commands of the modules in this checkout; INSTALL.md says how to add a module.`);
    return 2;
  }
  return command.run(rest);
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`longkeep: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);
