/**
 * Commands a person uses to check and undo what agents did: `handbook` and `snapshot`.
 * Each is a thin layer over its module; output is plain text unless --json.
 */
import { formatStamp } from "@openagent/protocol/task";
import { initHandbook, readHandbook } from "../handbook/handbook.ts";
import { openSnapshots } from "../snapshots/shadow.ts";
import { flag, parseArgs, parseWhole, projectFrom, usageError } from "@openagent/common/args";

/** True (after printing the usage) when the command was asked for help. */
function help(p: ReturnType<typeof parseArgs>, usage: string): boolean {
  if (!p.flags.has("help") && p.positional[0] !== "help" && !p.flags.has("h")) return false;
  console.log(usage);
  return true;
}

const HANDBOOK_USAGE = `openagent handbook          where the agent handbook is, and how many suggestions wait for you
openagent handbook --json   also its text without undecided suggestions, and those suggestions apart
openagent handbook init     create ~/.openagent/handbook.md from the bundled preset (never overwrites)`;

export async function handbookCommand(argv: string[]): Promise<number> {
  const p = parseArgs(argv.map((a) => (a === "-h" ? "--help" : a)), ["json", "help"]);
  if (help(p, HANDBOOK_USAGE)) return 0;
  const [action] = p.positional;
  if (action === "init") {
    const r = initHandbook();
    console.log(r.action === "created" ? `Created ${r.path}` : `A handbook already exists at ${r.path}; nothing was overwritten.`);
    return 0;
  }
  if (action !== undefined) return usageError("handbook", `unknown action ${action}`, HANDBOOK_USAGE);
  const state = await readHandbook();
  if (p.flags.has("json")) console.log(JSON.stringify({ ...state, content: undefined }, null, 2));
  else if (!state.exists) console.log(`No handbook yet. Create one with "openagent handbook init" (it would be ${state.path}).`);
  else {
    console.log(`${state.path} (updated ${state.updated})`);
    if (state.pendingSuggestions) console.log(`${state.pendingSuggestions} suggestion(s) waiting in it: keep one by deleting its {++ ++} marks, delete it by deleting the block, or ask your main agent to.`);
  }
  return 0;
}

const SNAPSHOT_USAGE = `openagent snapshot list [--limit n]
openagent snapshot take [label]
openagent snapshot changes <id> [--from <id>]
openagent snapshot diff <id> [path]
openagent snapshot restore <id> [path]     the whole project, or one file; a safety snapshot is taken first
Options: --project <dir> (default: the current folder).`;

export async function snapshotCommand(argv: string[]): Promise<number> {
  const p = parseArgs(argv.map((a) => (a === "-h" ? "--help" : a)), ["json", "help"]);
  if (help(p, SNAPSHOT_USAGE)) return 0;
  const [action = "list", ...rest] = p.positional;
  const snaps = await openSnapshots(projectFrom(p));
  switch (action) {
    case "list": {
      const limit = parseWhole(flag(p, "limit") ?? "20", 1);
      if (limit === null) return usageError("snapshot", "--limit must be a whole number of at least 1", SNAPSHOT_USAGE);
      const items = await snaps.list(limit);
      if (p.flags.has("json")) console.log(JSON.stringify(items, null, 2));
      else if (!items.length) console.log("No snapshots of this project yet.");
      else for (const s of items) console.log(`${s.id}  ${formatStamp(new Date(s.time * 1000))}  ${s.filesChanged} files  ${s.label}`);
      return 0;
    }
    case "take": {
      const s = await snaps.snapshot(rest.join(" ") || "manual snapshot");
      console.log(s ? `Snapshot ${s.id}: ${s.filesChanged} files` : "Nothing changed since the last snapshot.");
      return 0;
    }
    case "changes": {
      if (!rest[0]) return usageError("snapshot", "changes needs a snapshot id", SNAPSHOT_USAGE);
      for (const c of await snaps.changes(rest[0], flag(p, "from"))) console.log(`${c.status.padEnd(8)}  ${c.path}`);
      return 0;
    }
    case "diff": {
      if (!rest[0]) return usageError("snapshot", "diff needs a snapshot id", SNAPSHOT_USAGE);
      process.stdout.write(await snaps.diffSince(rest[0], rest[1]));
      return 0;
    }
    case "restore": {
      if (!rest[0]) return usageError("snapshot", "restore needs a snapshot id", SNAPSHOT_USAGE);
      const safety = rest[1] ? await snaps.restoreFile(rest[0], rest[1]) : await snaps.restore(rest[0]);
      console.log(`Restored ${rest[1] ?? "the project"} from ${rest[0]}.${safety ? ` The state before is snapshot ${safety.id}.` : ""}`);
      return 0;
    }
    default:
      return usageError("snapshot", `unknown action ${action}`, SNAPSHOT_USAGE);
  }
}
