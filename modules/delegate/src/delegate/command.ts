/**
 * `openagent delegate`. It returns an exit code and prints its own output.
 *
 *   openagent delegate --to <executor> --title <title> --prompt <text> [--project <dir>] [--prompt-file <file>]
 *        [--target <path>] [--writeback handbook|<path>] [--work scratch|project] [--model <m>]
 *        [--effort minimal|low|medium|high|xhigh] [--sandbox read-only|workspace-write|danger-full-access]
 *        [--timeout <s>] [--stall <s>] [--retries <n>] [--issuer <name>] [--no-approve] [--json]
 *   openagent delegate --continue <task-id> --prompt <text>                       follow-up round
 *   openagent delegate --status [<task-id>]                                      one task, or the project's recent tasks
 *   openagent delegate --wait <task-id>                                          block until its round ends, then print it
 *   openagent delegate --review <task-id> --verdict accepted|needs_rework|rejected [--note <text>] [--issuer <name>]
 *   openagent delegate --list                                                    executors on this machine and their defaults
 *   openagent delegate --to <executor> --set model=… --set effort=…              change defaults in ~/.openagent/executors.json ("key=" removes)
 *   openagent delegate --to <executor> --reset                                   remove the whole entry
 *
 * The project defaults to the current folder. A run prints the answer on stdout (or the full result with --json) and
 * everything else on stderr. Exit codes: 0 done, 1 the delegation or the command failed, 2 bad usage.
 */
import fs from "node:fs";
import { DEFAULT_LIMITS, EFFORTS, RUN_LIMITS, SANDBOXES, SETTABLE_KEYS, type Effort, type Sandbox } from "@openagent/protocol/executors";
import { AUTHOR_RE, isOneLine } from "@openagent/protocol/task";
import { parseWhole } from "@openagent/common/args";
import { listExecutors, updateExecutorDefaults } from "../executors/registry.ts";
import { resolveProject } from "@openagent/common/home";
import { lastRoundOf } from "./records.ts";
import { delegationStatus, listDelegations, reviewDelegation, VERDICTS } from "./review.ts";
import { runDelegation } from "./prepare.ts";
import { checkTaskId } from "./types.ts";

class UsageError extends Error {}

const USAGE = [
  "Usage: openagent delegate --to <executor> --title <title> --prompt <text> [--project <dir>] [--prompt-file <file>] [--target <path>]",
  "                         [--writeback handbook|<path>] [--work scratch|project] [--model <m>] [--effort <level>] [--sandbox <s>]",
  "                         [--timeout <s>] [--stall <s>] [--retries <n>] [--issuer <name>] [--no-approve] [--json]",
  "       openagent delegate --continue <task-id> --prompt <text>",
  "       openagent delegate --status [<task-id>]",
  "       openagent delegate --wait <task-id> [--json]",
  "       openagent delegate --review <task-id> --verdict accepted|needs_rework|rejected [--note <text>] [--issuer <name>]",
  "       openagent delegate --list",
  "       openagent delegate --to <executor> --set key=value … | --reset",
].join("\n");

interface Args {
  project?: string;
  to?: string;
  title?: string;
  prompt?: string;
  promptFile?: string;
  target?: string;
  writeback?: string;
  work?: string;
  model?: string;
  effort?: string;
  sandbox?: string;
  timeout?: string;
  stall?: string;
  retries?: string;
  issuer?: string;
  continueTask?: string;
  status?: boolean;
  statusTask?: string;
  wait?: string;
  review?: string;
  verdict?: string;
  note?: string;
  sets: string[];
  reset?: boolean;
  noApprove?: boolean;
  json?: boolean;
  list?: boolean;
  help?: boolean;
}

const VALUE_OPTIONS: Record<string, keyof Args> = {
  "--project": "project",
  "--to": "to",
  "--title": "title",
  "--prompt": "prompt",
  "--prompt-file": "promptFile",
  "--target": "target",
  "--writeback": "writeback",
  "--work": "work",
  "--model": "model",
  "--effort": "effort",
  "--sandbox": "sandbox",
  "--timeout": "timeout",
  "--stall": "stall",
  "--retries": "retries",
  "--issuer": "issuer",
  "--continue": "continueTask",
  "--wait": "wait",
  "--review": "review",
  "--verdict": "verdict",
  "--note": "note",
};

function parseArgs(argv: string[]): Args {
  const a: Args = { sets: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--") continue; // pnpm on Windows passes the separator through
    const key = Object.hasOwn(VALUE_OPTIONS, k) ? VALUE_OPTIONS[k] : undefined;
    if (key) {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`${k} needs a value`);
      (a as unknown as Record<string, string>)[key] = v;
    } else if (k === "--set") {
      const v = argv[++i];
      if (v === undefined) throw new UsageError("--set needs key=value");
      a.sets.push(v);
    } else if (k === "--status") {
      a.status = true;
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) a.statusTask = argv[++i];
    } else if (k === "--reset") a.reset = true;
    else if (k === "--no-approve") a.noApprove = true;
    else if (k === "--json") a.json = true;
    else if (k === "--list") a.list = true;
    else if (k === "-h" || k === "--help") a.help = true;
    else throw new UsageError(`unknown option: ${k}`);
  }
  return a;
}

/** A whole number within [min, max]; anything else is a usage error */
function whole(v: string, name: string, [min, max]: readonly [number, number]): number {
  const n = parseWhole(v, min, max);
  if (n === null) throw new UsageError(`${name} must be a whole number from ${min} to ${max}`);
  return n;
}

const optionalWhole = (v: string | undefined, name: string, range: readonly [number, number]): number | undefined =>
  v === undefined ? undefined : whole(v, name, range);

/** A task id from the command line; a bad one is a usage error */
function taskIdArg(id: string): string {
  try {
    return checkTaskId(id);
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
}

/** The value of one `--set key=value`, checked like set_executor_defaults checks it */
function settableValue(k: string, v: string): unknown {
  if (v === "") return null;
  if (k === "timeoutMs" || k === "stallMs" || k === "retries") return whole(v, k, DEFAULT_LIMITS[k]);
  if (k === "autoApprove") {
    if (v !== "true" && v !== "false") throw new UsageError("autoApprove only accepts true | false");
    return v === "true";
  }
  if (k === "effort" && !(EFFORTS as readonly string[]).includes(v)) throw new UsageError(`effort only accepts ${EFFORTS.join(" | ")}`);
  if (k === "sandbox" && !(SANDBOXES as readonly string[]).includes(v)) throw new UsageError(`sandbox only accepts ${SANDBOXES.join(" | ")}`);
  return v;
}

function fmtDefaults(d: Record<string, unknown>): string {
  const parts = Object.entries(d).map(([k, v]) => `${k}=${String(v)}`);
  return parts.length ? parts.join(" ") : "(the CLI's own defaults)";
}

/** Outcomes of a round that ended normally; the others are failures */
const FINISHED_OUTCOMES = new Set(["changed", "no_changes", "unchecked"]);

/**
 * Blocks until the task's current round has ended, then prints it like a finished run: the answer on stdout, the
 * summary on stderr. A main agent that started the round with wait: false runs this in the background and is told
 * when it exits. Exit code 0 when the round ended normally, 1 when it failed or its process is gone.
 */
async function waitForRound(project: string, taskId: string, json: boolean): Promise<number> {
  for (;;) {
    const st = delegationStatus(project, taskId);
    if (st.running) {
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    const t = st.task;
    if (st.staleLock) {
      console.error(`[delegate] the process running task ${taskId} is gone; the round did not finish  record ${st.recordDir}`);
      return 1;
    }
    const answer = st.has.transcript ? (lastRoundOf(fs.readFileSync(st.transcript, "utf8"))?.answer ?? "") : "";
    const ok = t.status === "done" && FINISHED_OUTCOMES.has(String(t.outcome));
    if (json) console.log(JSON.stringify({ taskId, ok, status: t.status, outcome: t.outcome ?? null, acceptance: t.acceptance ?? null, executor: t.executor ?? null, session: t.session ?? null, usage: t.usage ?? null, answer, recordDir: st.recordDir, transcript: st.transcript }, null, 1));
    else {
      console.log(answer);
      console.error(`[delegate] ${ok ? "done" : "failed"} ${t.executor ?? "-"}  outcome ${t.outcome ?? "-"}  acceptance ${t.acceptance ?? "-"}  task ${taskId}  record ${st.recordDir}`);
    }
    return ok ? 0 : 1;
  }
}

/** The explicit --project, else the current folder */
function projectOf(a: Args): string {
  return resolveProject(a.project ?? process.cwd());
}

async function delegate(a: Args): Promise<number> {
  if (a.help) {
    console.log(USAGE);
    return 0;
  }
  if (a.list) {
    const rows = listExecutors();
    if (a.json) console.log(JSON.stringify(rows, null, 1));
    else
      for (const r of rows)
        console.log(
          `${r.name.padEnd(8)} ${r.bin ? `available  ${r.bin}` : `not found  ${r.installHint}`}${r.canResume ? "" : "  (no native resume)"}${r.builtin ? "" : "  [executors.json]"}${r.workRoot ? `  works in ${r.workRoot}` : ""}\n         defaults: ${fmtDefaults(r.defaults as Record<string, unknown>)}`,
        );
    return 0;
  }
  if (a.status) {
    const project = projectOf(a);
    if (a.statusTask) {
      const st = delegationStatus(project, taskIdArg(a.statusTask));
      if (a.json) console.log(JSON.stringify(st, null, 1));
      else {
        const t = st.task;
        console.log(
          `status: ${t.status}  outcome: ${t.outcome ?? "-"}  acceptance: ${t.acceptance ?? "-"}  executor: ${t.executor ?? "-"}  session: ${t.session ?? "-"}  usage: ${t.usage ?? "-"}  ${st.running ? "running" : st.staleLock ? "stale lock" : "not running"}`,
        );
        console.log(`record: ${st.recordDir}`);
        if (st.outputTail) console.log(st.outputTail);
      }
      return 0;
    }
    const rows = listDelegations(project);
    if (a.json) console.log(JSON.stringify(rows, null, 1));
    else if (!rows.length) console.log("no delegations in this project yet");
    else
      for (const r of rows)
        console.log(`${r.taskId}  ${r.running ? "running" : r.status}  ${r.executor ?? "-"}  outcome ${r.outcome ?? "-"}  acceptance ${r.acceptance ?? "-"}  ${r.title}`);
    return 0;
  }
  if (a.wait) return waitForRound(projectOf(a), taskIdArg(a.wait), !!a.json);
  if (a.review) {
    if (!a.verdict || !(VERDICTS as string[]).includes(a.verdict)) throw new UsageError(`--verdict only accepts ${VERDICTS.join(" | ")}`);
    const t = reviewDelegation(projectOf(a), taskIdArg(a.review), { verdict: a.verdict, reviewer: a.issuer ?? "claude", note: a.note });
    if (a.json) console.log(JSON.stringify(t, null, 1));
    else console.log(`acceptance: ${t.acceptance}  task ${a.review}`);
    return 0;
  }

  if (a.reset || a.sets.length > 0) {
    if (!a.to) throw new UsageError("--set / --reset need --to <executor>");
    if (a.reset) updateExecutorDefaults(a.to, null);
    else {
      const patch: Record<string, unknown> = {};
      for (const kv of a.sets) {
        const eq = kv.indexOf("=");
        if (eq === -1) throw new UsageError(`--set needs key=value: ${kv}`);
        const k = kv.slice(0, eq).trim();
        const v = kv.slice(eq + 1).trim();
        if (!(SETTABLE_KEYS as readonly string[]).includes(k)) throw new UsageError(`--set only accepts ${SETTABLE_KEYS.join(" / ")}`);
        patch[k] = settableValue(k, v);
      }
      updateExecutorDefaults(a.to, patch);
    }
    const row = listExecutors().find((r) => r.name === a.to);
    if (a.json) console.log(JSON.stringify(row ?? null, null, 1));
    else console.log(`${a.to} defaults: ${fmtDefaults((row?.defaults ?? {}) as Record<string, unknown>)}  (~/.openagent/executors.json)`);
    return 0;
  }

  const project = projectOf(a);
  if (a.continueTask) taskIdArg(a.continueTask);
  let executor = a.to;
  if (!executor && a.continueTask) executor = delegationStatus(project, a.continueTask).task.executor;
  if (!executor) throw new UsageError(`--to <executor> is missing (see --list)\n${USAGE}`);
  if (!a.title && !a.continueTask) throw new UsageError("--title is missing");
  if (a.title && !isOneLine(a.title)) throw new UsageError("--title must be one line");
  if (a.issuer !== undefined && !AUTHOR_RE.test(a.issuer)) throw new UsageError("--issuer must be 1-32 characters without spaces, colons or braces");
  let prompt = a.prompt;
  if (a.promptFile) prompt = fs.readFileSync(a.promptFile, "utf8");
  if (!prompt) throw new UsageError("--prompt or --prompt-file is missing");
  if (a.sandbox && !(SANDBOXES as readonly string[]).includes(a.sandbox)) throw new UsageError(`--sandbox only accepts ${SANDBOXES.join(" | ")}`);
  if (a.effort && !(EFFORTS as readonly string[]).includes(a.effort)) throw new UsageError(`--effort only accepts ${EFFORTS.join(" | ")}`);
  if (a.work !== undefined && a.work !== "scratch" && a.work !== "project") throw new UsageError("--work only accepts scratch | project");
  const timeout = optionalWhole(a.timeout, "--timeout", RUN_LIMITS.timeoutSeconds);
  const stall = optionalWhole(a.stall, "--stall", RUN_LIMITS.stallSeconds);
  const retries = optionalWhole(a.retries, "--retries", RUN_LIMITS.retries);

  // Ctrl+C or a kill stops the executor with its whole process tree and finishes the record as stopped. Without this,
  // on macOS and Linux the executor (its own process group) would keep running after OpenAgent exits.
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const r = await runDelegation({
    signal: abort.signal,
    project,
    executor,
    title: a.title ?? "",
    prompt,
    target: a.target,
    writeback: a.writeback,
    ...(a.work ? { work: a.work as "scratch" | "project" } : {}),
    model: a.model,
    effort: a.effort as Effort | undefined,
    sandbox: a.sandbox as Sandbox | undefined,
    timeoutMs: timeout !== undefined ? timeout * 1000 : undefined,
    stallMs: stall !== undefined ? stall * 1000 : undefined,
    retries,
    issuer: a.issuer,
    continueTask: a.continueTask,
    ...(a.noApprove ? { autoApprove: false } : {}),
  }).finally(() => {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  });
  if (a.json) console.log(JSON.stringify(r, null, 1));
  else {
    console.log(r.answer);
    console.error(
      `[delegate] ${r.ok ? "done" : "failed"} ${r.executor} round ${r.round} ${(r.elapsedMs / 1000).toFixed(1)}s  outcome ${r.outcome}  working folder ${r.workRoot}  task ${r.taskId}  record ${r.recordDir}${r.snapshot ? `  snapshot ${r.snapshot}` : ""}${r.session ? `  session ${r.session}` : ""}${r.usage !== null ? `  usage ${r.usage}` : ""}${r.error ? `  ${r.error}` : ""}`,
    );
  }
  return r.ok ? 0 : 1;
}

/** `openagent delegate` */
export async function delegateCommand(argv: string[]): Promise<number> {
  try {
    return await delegate(parseArgs(argv));
  } catch (e) {
    console.error(`openagent delegate: ${e instanceof Error ? e.message : String(e)}`);
    return e instanceof UsageError ? 2 : 1;
  }
}
