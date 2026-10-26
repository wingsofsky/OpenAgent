/** Small shared helpers for the thin command modules: flag parsing and the project folder. */
import { resolveProject } from "./home.ts";

export interface Parsed {
  positional: string[];
  flags: Map<string, string | true>;
}

/**
 * `--name value` and `--name=value` become flags; `--name` followed by another flag or nothing is `true`.
 * `booleans` lists flags that never take a value.
 */
export function parseArgs(argv: string[], booleans: string[] = []): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq > 0) flags.set(a.slice(2, eq), a.slice(eq + 1));
    else if (booleans.includes(a.slice(2)) || i + 1 >= argv.length || argv[i + 1].startsWith("--")) flags.set(a.slice(2), true);
    else flags.set(a.slice(2), argv[++i]);
  }
  return { positional, flags };
}

export const flag = (p: Parsed, name: string): string | undefined => {
  const v = p.flags.get(name);
  return typeof v === "string" ? v : undefined;
};

/** A whole number from min to max written in plain digits, or null. */
export function parseWhole(v: string, min: number, max = Number.MAX_SAFE_INTEGER): number | null {
  if (!/^-?\d+$/.test(v.trim())) return null;
  const n = Number(v);
  return n >= min && n <= max ? n : null;
}

/** The project for a command: --project, else the current folder. Throws when it may not be a project. */
export function projectFrom(p: Parsed): string {
  return resolveProject(flag(p, "project") ?? process.cwd());
}

/** Prints a message for a person and returns the exit code for a usage error. */
export function usageError(command: string, message: string, usage: string): number {
  console.error(`openagent ${command}: ${message}\n\n${usage}`);
  return 2;
}
