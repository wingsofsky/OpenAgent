/** `openagent folder <dir> [--executor <id>] [--new-projects]`: run a folder task and stream what the agent prints. */
import path from "node:path";
import { REGISTRY } from "@openagent/protocol/executor-registry";
import { flag, parseArgs, usageError } from "@openagent/common/args";
import { ensureBrief, runFolderTask } from "./folder.ts";

const USAGE = `openagent folder <dir> [--executor <id>] [--new-projects]
    Runs one agent CLI (default: ${REGISTRY.roles.folderTask}) on a folder, unattended, with the saved brief (~/.openagent/folder/brief/task.md and rules.md).
    The first run creates a draft brief: edit it and delete its first line, then run again.
    OpenAgent snapshots each working folder first and keeps the record, transcript and log in ~/.openagent/runs; the
    folder only gets the agent's own changes. Only one folder task runs on a folder at a time.
    --new-projects handles only sub-folders that are git repositories not done before, one task per repository, in turn.
    With "yieldToIde": true on the executor in ~/.openagent/executors.json (macOS, IntelliJ IDEA 2026.2), a repository
    open in the IDE waits, and a running one is stopped and resumed after the IDE closes it.
    agy, grok, cursor and claude run with prompts skipped (codex keeps its own sandbox); see SECURITY.md.
openagent folder --brief
    Prints where the brief is (creating the draft if needed).`;

export async function folderCommand(argv: string[]): Promise<number> {
  const p = parseArgs(argv, ["new-projects", "brief", "help"]);
  if (p.flags.has("help")) {
    console.log(USAGE);
    return 0;
  }
  if (p.flags.has("brief")) {
    console.log(ensureBrief());
    return 0;
  }
  const executor = flag(p, "executor") ?? REGISTRY.roles.folderTask;
  if (p.positional.length !== 1) return usageError("folder", "give exactly one folder", USAGE);
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    const result = await runFolderTask({
      folder: path.resolve(p.positional[0]),
      executor,
      newProjects: p.flags.has("new-projects"),
      signal: abort.signal,
      onOutput: (text) => process.stdout.write(text),
      onState: (message) => console.error(`[openagent] ${message}`),
    });
    if (result === null) {
      console.error("[openagent] No new repositories to handle; no agent was started.");
      return 0;
    }
    const several = result.runs.length > 1;
    for (const run of result.runs) {
      const r = run.result;
      if (r?.answer) console.log(`\n${several ? `## ${run.project}\n\n` : ""}${r.answer}`);
      const where = r ? ` Transcript: ${r.transcript}` : "";
      console.error(run.ok ? `[openagent] ${several ? `${run.project}: ` : ""}Done (${r?.outcome}).${where}` : `[openagent] ${several ? `${run.project}: ` : ""}Failed: ${run.error ?? r?.outcome}.${where}`);
    }
    return result.ok ? 0 : 1;
  } catch (e) {
    if (!abort.signal.aborted) throw e;
    const again = p.flags.has("new-projects") ? " A repository not recorded as done yet is offered again next time." : "";
    console.error(`[openagent] Stopped; each task's record says how far it got.${again}`);
    return 1;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
