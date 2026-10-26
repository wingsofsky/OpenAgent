/**
 * One delegation: prepareDelegation (validate, decide the working folder, snapshot, write the record, take the claim
 * lock) and run() (launch with retries, parse, fingerprint, write transcript / run.json / task header,
 * writeback). Contract: the header of index.ts.
 *
 * The run kind is decided here, once:
 *  - delegate: the working folder is the record's `work/` (scratch, default), the project itself (`work: "project"`),
 *    or a working folder the executor declares in executors.json
 *  - folder: the folder given by the folder module, or one sub-project of it (`folderRoot`), is the working folder;
 *    stricter prompt wording, no follow-up rounds, extra child environment, and on macOS grok / cursor / claude are
 *    stopped together with their descendants
 * Records always go to `<home>/runs/<projectKey(project)>/<task-id>/`.
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { effortFor } from "@openagent/protocol/executors";
import { RUN_FILES } from "@openagent/protocol/layout";
import {
  lastRawTokens,
  normalizeArgs,
  parseRunRecord,
  roundElapsed,
  roundTokens,
  rulingsOf,
  serializeRunRecord,
  type Attempt,
  type ExitClass,
  type ResumeMode,
  type Round,
  type RunRecord,
} from "@openagent/protocol/runs";
import { formatStamp, isOneLine, parseTask, serializeTask, taskId as makeTaskId, type TaskDoc, type TaskOutcome } from "@openagent/protocol/task";
import { declaredWorkRoot, loadExecutors, resolveExecutorBin, type ExecutorSpec, type Invocation, type Sandbox } from "../executors/registry.ts";
import { appendSuggestion, resolveWriteback } from "../handbook/handbook.ts";
import { ensureHome, resolveProject } from "@openagent/common/home";
import { atomicWriteFile, insideVcsMetadata, resolveScoped, resolveWritePathCreating } from "@openagent/common/scoped";
import { hasGit, openSnapshots } from "../snapshots/shadow.ts";
import { ExecutorStartupError } from "./launch-fallback.ts";
import { acquireClaimLock, commandLineProblem, dbg, releaseClaimLock, spawnOnce, type SpawnOutcome } from "./process.ts";
import { RESUME_LABEL, composePrompt, countRounds } from "./prompt.ts";
import { describeCommand, lastRoundOf, roundMarkdown, transcriptHeader, type RoundRecord } from "./records.ts";
import {
  ANSWER_FILE,
  WORK_DIR,
  checkTaskId,
  runsRelOf,
  type DelegationRequest,
  type DelegationResult,
  type PreparedDelegation,
  type RecordPaths,
} from "./types.ts";
import { checkWorkRoot, rootFingerprint, type RootState } from "./work-root.ts";

type RoundEntry = Round;

interface RunKind {
  kind: "delegate" | "folder";
  env: NodeJS.ProcessEnv;
  stopDescendants: (executor: string) => boolean;
  stopMessage: string;
}
const DELEGATE_KIND: RunKind = { kind: "delegate", env: {}, stopDescendants: () => false, stopMessage: "the delegation was stopped" };
const FOLDER_KIND: RunKind = {
  kind: "folder",
  env: { GIT_OPTIONAL_LOCKS: "0", NO_OPEN_BROWSER: "1" },
  stopDescendants: (executor) => process.platform === "darwin" && ["grok", "cursor", "claude"].includes(executor),
  stopMessage: "the folder task was stopped",
};

const within = (base: string, p: string): boolean => p === base || p.startsWith(base.endsWith(path.sep) ? base : base + path.sep);

/** Creates (if needed) a folder under the home folder through the path gate and returns its path */
function ensureDir(home: string, rel: string): string {
  return path.dirname(resolveWritePathCreating(home, `${rel}/.openagent-dir`));
}

/** A path under the home folder that is appended to: the leaf must not be a link (appendFileSync would follow it) */
function appendTarget(home: string, rel: string): string {
  const abs = resolveWritePathCreating(home, rel);
  try {
    if (fs.lstatSync(abs).isSymbolicLink()) throw new Error(`${rel} is a link; refusing to append through it`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  return abs;
}

/** Claims a new record folder: `<id>`, `<id>-2`, … created exclusively, so two runs never share one */
function createRecordDir(home: string, runsRel: string, base: string): { id: string; rel: string } {
  for (let i = 0; i < 100; i++) {
    const id = i === 0 ? base : `${base}-${i + 1}`;
    const rel = `${runsRel}/${id}`;
    const abs = resolveWritePathCreating(home, rel);
    try {
      fs.mkdirSync(abs);
      return { id, rel };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  throw new Error("too many tasks with the same title in the same second");
}

export function recordPaths(home: string, project: string, taskId: string): RecordPaths {
  const recordDir = resolveScoped(home, `${runsRelOf(project)}/${checkTaskId(taskId)}`);
  const at = (name: string) => path.join(recordDir, name);
  return {
    taskId,
    project,
    recordDir,
    taskFile: at(RUN_FILES.task),
    transcript: at(RUN_FILES.transcript),
    runFile: at(RUN_FILES.run),
    outputLog: at(RUN_FILES.output),
  };
}

/** One project of a folder task: an existing folder inside the task's folder (links that leave it are refused) */
function subFolder(project: string, rel: string): string {
  let abs: string;
  try {
    abs = resolveScoped(project, rel);
  } catch (e) {
    throw new Error(`sub-project ${rel}: ${(e as Error).message}`);
  }
  if (!fs.statSync(abs).isDirectory()) throw new Error(`sub-project ${rel} is not a folder`);
  return abs;
}

function targetPath(project: string, rel: string): string {
  let real: string;
  try {
    real = resolveScoped(project, rel);
  } catch (e) {
    if ((e as { status?: number }).status === 404) throw new Error(`target ${rel} does not exist in the project`);
    throw new Error(`target ${rel}: ${(e as Error).message}`);
  }
  if (insideVcsMetadata(project, real)) throw new Error(`target ${rel} is inside version-control metadata (.git and the like)`);
  return real;
}

/** A request that passed every check that needs no file to be created */
interface Checked {
  env: NodeJS.ProcessEnv;
  kind: RunKind;
  folder: boolean;
  project: string;
  spec: ExecutorSpec;
  binPath: string;
  title: string;
  promptText: string;
  issuer: string;
}

/** The task, record and transcript of a follow-up round */
interface Existing {
  id: string;
  rel: string;
  task: TaskDoc;
  record: RunRecord;
  transcript: string;
  resumeSession?: string;
}

type WorkMode = "scratch" | "project" | "declared" | "folder";

function checkRequest(req: DelegationRequest): Checked {
  const env = req.env ?? process.env;
  const kind = req.kind === "folder" ? FOLDER_KIND : DELEGATE_KIND;
  const folder = kind.kind === "folder";
  if (req.kind !== undefined && req.kind !== "delegate" && req.kind !== "folder") throw new Error(`unknown run kind: ${String(req.kind)}`);
  if (req.work !== undefined && req.work !== "scratch" && req.work !== "project") throw new Error(`work only accepts scratch | project, not ${String(req.work)}`);
  if (folder && req.continueTask) throw new Error("folder tasks have no follow-up rounds; run the folder task again");
  if (folder && req.work !== undefined) throw new Error("a folder task always works in its folder; do not pass work");
  if (!folder && req.folderRoot !== undefined) throw new Error("folderRoot is only for folder tasks");

  const project = resolveProject(req.project, env);
  const table = req.executors ?? loadExecutors(env);
  const spec = Object.hasOwn(table, req.executor) ? table[req.executor] : undefined;
  if (!spec) throw new Error(`unknown executor: ${String(req.executor)} (available: ${Object.keys(table).join(" / ")})`);
  const bin = req.bin ?? resolveExecutorBin(spec, env);
  if (!bin) throw new ExecutorStartupError(spec.installHint);
  if (/\.(cmd|bat)$/i.test(bin))
    throw new Error(`${spec.name} resolved to ${bin}: .cmd / .bat shims are not accepted; point ${spec.binEnv ?? "bin in executors.json"} at an .exe or a .js entry point`);
  // A relative path is resolved against the runner's cwd (the child's cwd is the working folder)
  const binPath = bin.includes("/") || bin.includes(path.sep) ? path.resolve(bin) : bin;
  const title = req.title.trim();
  const promptText = req.prompt.trim();
  if (!title && !req.continueTask) throw new Error("the task title is empty");
  if (!promptText) throw new Error("the prompt is empty");
  // These land in header lines of task.md; a line break would forge another field
  if (!isOneLine(title)) throw new Error("the task title must be one line");
  const issuer = req.issuer ?? "claude";
  for (const [name, v] of [["target", req.target], ["writeback", req.writeback], ["issuer", issuer]] as const) if (v !== undefined && !isOneLine(v)) throw new Error(`${name} must be one line`);
  return { env, kind, folder, project, spec, binPath, title, promptText, issuer };
}

/** Reads the task a follow-up round continues; throws when this executor cannot continue it */
function readExisting(home: string, runsRel: string, taskId: string, spec: ExecutorSpec): Existing {
  const id = checkTaskId(taskId);
  const rel = `${runsRel}/${id}`;
  let taskText: string;
  try {
    taskText = fs.readFileSync(resolveScoped(home, `${rel}/${RUN_FILES.task}`), "utf8");
  } catch {
    throw new Error(`no task ${id} in this project`);
  }
  const task = parseTask(taskText, id);
  if (!task) throw new Error(`${id}/${RUN_FILES.task} is not a valid task file`);
  if (!task.executor) throw new Error(`task ${id} has no executor field: it is not a delegated task`);
  if (task.executor !== spec.name) throw new Error(`the executor of task ${id} is ${task.executor}; a follow-up round cannot switch to ${spec.name}`);
  let record: RunRecord | null = null;
  try {
    record = parseRunRecord(fs.readFileSync(resolveScoped(home, `${rel}/${RUN_FILES.run}`), "utf8"));
  } catch {
    record = null;
  }
  if (!record) throw new Error(`task ${id} has no valid ${RUN_FILES.run}; start a new delegation instead`);
  if (record.plan.channel === "folder") throw new Error("folder tasks have no follow-up rounds; run the folder task again");
  let transcript = "";
  try {
    transcript = fs.readFileSync(resolveScoped(home, `${rel}/${RUN_FILES.transcript}`), "utf8");
  } catch {
    transcript = "";
  }
  let resumeSession: string | undefined;
  if (task.session) {
    const [prefix, ...rest] = task.session.split(":");
    if (prefix === spec.name && rest.length) resumeSession = rest.join(":");
  }
  return { id, rel, task, record, transcript, resumeSession };
}

/** The working folder, decided once: null means the record's scratch folder */
function decideWorkFolder(c: Checked, req: DelegationRequest, existing: Existing | null, home: string): { mode: WorkMode; fixedRoot: string | null } {
  if (c.folder) return { mode: "folder", fixedRoot: req.folderRoot ? subFolder(c.project, req.folderRoot) : c.project };
  if (existing) {
    const stored = existing.record.plan.execRoot;
    if (!stored) throw new Error(`task ${existing.id} has no working folder in ${RUN_FILES.run}`);
    const recordAbs = resolveScoped(home, existing.rel);
    let mode: WorkMode = "scratch";
    let fixedRoot: string | null = null;
    if (!(within(recordAbs, stored) || within(stored, recordAbs))) {
      fixedRoot = checkWorkRoot(stored, c.env);
      mode = fixedRoot === c.project ? "project" : "declared";
    }
    if (req.work !== undefined && (req.work === "scratch") !== (mode === "scratch"))
      throw new Error(`task ${existing.id} works in ${stored}: the working folder is decided in the first round`);
    return { mode, fixedRoot };
  }
  const declared = declaredWorkRoot(c.spec);
  if (declared) {
    if (req.work !== undefined) throw new Error(`${c.spec.name} declares its working folder ${declared} in executors.json; do not pass work`);
    return { mode: "declared", fixedRoot: checkWorkRoot(declared, c.env) };
  }
  if (req.work === "project") return { mode: "project", fixedRoot: c.project };
  return { mode: "scratch", fixedRoot: null };
}

/** Snapshots a real working folder before the round; a note says why there is no snapshot */
async function snapshotBefore(fixedRoot: string | null, env: NodeJS.ProcessEnv, label: string): Promise<{ snapshot: string | null; snapshotNote: string | null }> {
  if (!fixedRoot) return { snapshot: null, snapshotNote: null };
  if (!(await hasGit())) return { snapshot: null, snapshotNote: "none (git is not installed; continued without a snapshot)" };
  try {
    const snaps = await openSnapshots(fixedRoot, env);
    const info = (await snaps.snapshot(label)) ?? (await snaps.list(1))[0] ?? null;
    return info ? { snapshot: info.id, snapshotNote: null } : { snapshot: null, snapshotNote: "none (the working folder has nothing to snapshot)" };
  } catch (e) {
    throw new Error(`could not snapshot ${fixedRoot} before the round: ${(e as Error).message}`);
  }
}

/** Why an attempt failed, or undefined when it produced an answer */
function attemptError(o: SpawnOutcome, answer: string, x: { signal?: AbortSignal; kind: RunKind; timeoutMs: number; stallMs: number }): string | undefined {
  if (o.stopError) return o.stopError;
  if (x.signal?.aborted) return x.signal.reason instanceof Error && x.signal.reason.name !== "AbortError" ? x.signal.reason.message : x.kind.stopMessage;
  if (o.timedOut) return `not finished after ${Math.round(x.timeoutMs / 1000)}s; the process was killed`;
  if (o.stalled) return `no output for ${Math.round(x.stallMs / 1000)}s; killed as stalled`;
  if (o.exitCode !== 0) return `executor exit code ${o.exitCode ?? "none"}${o.stderr.trim() ? `: ${o.stderr.trim().split(/\r?\n/).slice(-3).join(" / ")}` : ""}`;
  if (!answer.trim()) return "the executor produced no answer";
  return undefined;
}

/** How one attempt ended, for run.json */
function exitClassOf(o: SpawnOutcome, error: string | undefined, signal?: AbortSignal): ExitClass {
  if (o.startupFailure) return "spawn_failed";
  if (o.stopError || signal?.aborted) return "stopped";
  if (o.timedOut) return "timeout";
  if (o.stalled) return "stalled";
  return error ? "error" : "ok";
}

/** How the round ended, for the task header: set by OpenAgent, never a verdict */
function roundOutcome(ok: boolean, changed: boolean | null, o: SpawnOutcome, signal?: AbortSignal): TaskOutcome {
  if (ok) return changed === true ? "changed" : changed === false ? "no_changes" : "unchecked";
  if (o.startupFailure) return "spawn_failed";
  if (o.stopError || signal?.aborted) return "stopped";
  if (o.timedOut) return "timeout";
  if (o.stalled) return "stalled";
  return "failed";
}

interface Launch {
  spec: ExecutorSpec;
  kind: RunKind;
  binPath: string;
  args: string[];
  command: string;
  cwd: string;
  childEnv: NodeJS.ProcessEnv;
  timeoutMs: number;
  stallMs: number;
  retries: number;
  logAbs: string;
  outFile: string | null;
  signal?: AbortSignal;
  onOutput?: DelegationRequest["onOutput"];
  /** run.json's attempts of this round, appended to */
  tries: Attempt[];
}

/** Launches the executor, retrying only a non-zero exit, and records every attempt */
async function launchWithRetries(l: Launch): Promise<{ outcome: SpawnOutcome; attempts: number; answer: string; error?: string }> {
  let outcome: SpawnOutcome | null = null;
  let attempts = 0;
  let answer = "";
  let error: string | undefined;
  let backoffMs = 0;
  for (attempts = 1; attempts <= l.retries + 1; attempts++) {
    dbg(`launch (attempt ${attempts}): ${l.command}`);
    const startedAt = new Date().toISOString();
    outcome = await spawnOnce({
      bin: l.binPath,
      args: l.args,
      cwd: l.cwd,
      env: l.childEnv,
      timeoutMs: l.timeoutMs,
      stallMs: l.stallMs,
      logAbs: l.logAbs,
      signal: l.signal,
      onOutput: l.onOutput,
      stopDescendants: l.kind.stopDescendants(l.spec.name),
    });
    dbg(`executor exited ${outcome.exitCode}, stdout ${outcome.stdout.length} chars${outcome.timedOut ? ", timed out" : outcome.stalled ? ", stalled" : ""}`);
    answer = outcome.timedOut || outcome.stalled ? "" : l.spec.extractAnswer(outcome.stdout, l.outFile);
    error = attemptError(outcome, answer, { signal: l.signal, kind: l.kind, timeoutMs: l.timeoutMs, stallMs: l.stallMs });
    const attemptTokens = l.spec.extractUsage(`${outcome.stdout}\n${outcome.stderrHead}\n${outcome.stderr}`);
    l.tries.push({
      n: attempts,
      startedAt,
      elapsedMs: outcome.elapsedMs,
      backoffMs,
      exit: exitClassOf(outcome, error, l.signal),
      exitCode: outcome.exitCode,
      usage: attemptTokens === null ? null : { tokens: attemptTokens, scope: l.spec.usageScope ?? "round" },
      error: error ?? null,
    });
    // Only a non-zero exit is retried: a normal exit (even without an answer) is not rerun, a timeout / stall would only take longer
    const retryable = !!error && outcome.exitCode !== 0 && !outcome.timedOut && !outcome.stalled && attempts <= l.retries;
    if (!error || !retryable || l.signal?.aborted || outcome.stopError) break;
    dbg(`retryable failure: ${error}`);
    backoffMs = 2000 * attempts;
    await new Promise((r) => setTimeout(r, backoffMs));
  }
  return { outcome: outcome!, attempts, answer, error };
}

/**
 * Writes how the round ended into task.md: status, outcome, session, usage, and a summary or the failure. The file is
 * read again first, because a person may have added a note while the round ran.
 */
function finishTaskFile(x: {
  home: string;
  recordRel: string;
  id: string;
  fallback: TaskDoc;
  taskAbs: string;
  executor: string;
  round: number;
  session: string | null;
  usage: number | null;
  result: TaskOutcome;
  ok: boolean;
  answer: string;
  error?: string;
  attempts: number;
  changed: boolean | null;
  scratch: boolean;
  cwd: string;
}): { current: TaskDoc; done: string } {
  const current = parseTask(fs.readFileSync(resolveScoped(x.home, `${x.recordRel}/${RUN_FILES.task}`), "utf8"), x.id) ?? x.fallback;
  const done = formatStamp(new Date());
  if (x.session) current.session = x.session;
  if (x.usage !== null) {
    const prevTotal = Number((current.usage ?? "").replace(/[^\d]/g, "")) || 0;
    current.usage = `${prevTotal + x.usage} tokens`;
  }
  current.outcome = x.result;
  const tag = x.round === 1 ? "Completion summary" : `Round ${x.round} completion summary`;
  if (x.ok) {
    current.status = "done";
    current.completed = done;
    current.acceptance = "pending";
    const excerpt = x.answer.length > 2000 ? x.answer.slice(0, 2000) + "\n... (full text in the transcript)" : x.answer;
    // Only a real working folder gets the reminder: a task answered in the scratch folder is not expected to change files
    const note = x.result === "no_changes" && !x.scratch ? `> Outcome: no changes (the working folder ${x.cwd} did not change during this round). Awaiting review by the main agent.\n\n` : "";
    current.body = `${current.body}\n\n## ${tag} (@${x.executor})\n\n${note}${excerpt}`;
  } else {
    current.status = "pending";
    current.acceptance = undefined;
    const sideEffect = x.changed === true ? "\n\nNote: the working folder changed during this round; check the diff before delegating again." : "";
    current.body = `${current.body}\n\n## Execution failed (@${x.executor}, ${done}${x.attempts > 1 ? `, retried ${x.attempts - 1} times` : ""})\n\n${x.error}${sideEffect}\n\nFix the cause and delegate again; details are in the transcript.`;
  }
  atomicWriteFile(x.taskAbs, serializeTask(current));
  dbg(`task updated to ${current.status} (${x.result})`);
  return { current, done };
}

/** A round with no timeout of its own, or from its executor, may run this long: deep research and multi-file changes often need well over ten minutes */
const DEFAULT_TIMEOUT_MS = 30 * 60_000;

/** Run settings: the request first, then the executor's defaults */
function runSettings(req: DelegationRequest, spec: ExecutorSpec): { timeoutMs: number; stallMs: number; autoApprove: boolean; sandbox: Sandbox; retries: number } {
  const timeoutMs = req.timeoutMs ?? spec.defaults.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const stallMs = req.stallMs ?? spec.defaults.stallMs ?? 0;
  const autoApprove = req.autoApprove ?? spec.autoApproveDefault;
  const sandbox = req.sandbox ?? spec.defaults.sandbox ?? "workspace-write";
  // A round that may write (prompts skipped, or a writable sandbox) is not retried by default: a rerun repeats its side effects
  const retries = req.retries ?? spec.defaults.retries ?? (autoApprove || sandbox !== "read-only" ? 0 : 1);
  return { timeoutMs, stallMs, autoApprove, sandbox, retries };
}

/** The executor's command line for one round, or why it cannot be passed */
function buildCommand(x: {
  spec: ExecutorSpec;
  kind: RunKind;
  env: NodeJS.ProcessEnv;
  binPath: string;
  req: DelegationRequest;
  promptText: string;
  cwd: string;
  outFile: string | null;
  targetRel: string | undefined;
  targetAbs: string | undefined;
  recordDir: string | undefined;
  folder: boolean;
  round: number;
  brief: string;
  rulings: ReturnType<typeof rulingsOf>;
  transcript: string | undefined;
  previousAnswer: string | undefined;
  resumeSession: string | undefined;
  sandbox: Sandbox;
  timeoutMs: number;
  autoApprove: boolean;
}): { inv: Invocation; args: string[]; childEnv: NodeJS.ProcessEnv; command: string; argsHash: string } | { problem: string } {
  const { spec } = x;
  const inv: Invocation = {
    prompt: composePrompt({
      spec,
      prompt: x.promptText,
      cwd: x.cwd,
      targetRel: x.targetRel,
      targetAbs: x.targetAbs,
      recordDir: x.recordDir,
      folder: x.folder,
      round: x.round,
      brief: x.brief,
      rulings: x.rulings,
      transcriptAbs: x.transcript,
      previousAnswer: x.previousAnswer,
    }),
    cwd: x.cwd,
    outFile: x.outFile,
    model: x.req.model ?? spec.defaults.model,
    effort: effortFor(spec.name, x.req.effort ?? spec.defaults.effort),
    sandbox: x.sandbox,
    timeoutMs: x.timeoutMs,
    autoApprove: x.autoApprove,
    resumeSession: x.resumeSession,
    newSession: randomUUID(),
  };
  const args = spec.buildArgs(inv);
  const childEnv: NodeJS.ProcessEnv = { ...x.env, NO_COLOR: "1", TERM: "dumb", CI: x.env.CI ?? "1", ...x.kind.env };
  const problem = commandLineProblem(x.binPath, args, childEnv);
  if (problem) return { problem };
  const command = describeCommand(x.binPath, args, inv.prompt);
  const argsHash = createHash("sha256")
    .update(JSON.stringify(normalizeArgs(args, { prompt: inv.prompt, outFile: inv.outFile, newSession: inv.newSession })))
    .digest("hex");
  return { inv, args, childEnv, command, argsHash };
}

/** task.md for a starting round: in_progress, and a new round clears the previous outcome and acceptance */
function startTaskDoc(x: {
  existing: Existing | null;
  round: number;
  created: string;
  promptText: string;
  title: string;
  issuer: string;
  targetRel: string | undefined;
  executor: string;
  writeback: string | undefined;
  cwd: string;
  snapshot: string | null;
}): TaskDoc {
  const task: TaskDoc = x.existing
    ? { ...x.existing.task, completed: undefined, body: `${x.existing.task.body}\n\n## Round ${x.round} task (${x.created})\n\n${x.promptText}` }
    : {
        title: x.title,
        status: "in_progress",
        created: x.created,
        issuer: x.issuer,
        target: x.targetRel,
        executor: x.executor,
        writeback: x.writeback,
        body: `${x.promptText}\n\nWorking folder: ${x.cwd}\nTranscript: ${RUN_FILES.transcript}\nLive output: ${RUN_FILES.output}`,
      };
  task.status = "in_progress";
  task.outcome = undefined;
  task.acceptance = undefined;
  if (x.snapshot) task.snapshot = x.snapshot;
  return task;
}

/** Everything one round needs once the record, the lock and the command line are ready */
interface RoundContext {
  launch: Launch;
  inv: Invocation;
  fingerprint: () => RootState | null;
  task: TaskDoc;
  resumeMode: ResumeMode;
  previousRound: Round | undefined;
  round: number;
  created: string;
  snapshot: string | null;
  snapshotLine: string | null;
  scratch: boolean;
  project: string;
  env: NodeJS.ProcessEnv;
  home: string;
  recordRel: string;
  id: string;
  paths: RecordPaths;
  taskAbs: string;
  transcriptAbs: string;
  roundEntry: Round;
  writeRun: () => void;
  /** Called once task.md holds how the round ended, so a later failure does not overwrite it */
  onFinished: () => void;
}

/** Runs one round: launch, compare the working folder, then write the transcript, run.json, task.md and any writeback */
async function runRound(r: RoundContext): Promise<DelegationResult> {
  const { launch: l, inv, round, created, roundEntry } = r;
  const spec = l.spec;
  const before = r.fingerprint();
  const { outcome: o, attempts, answer, error } = await launchWithRetries(l);
  const ok = !error;
  const after = r.fingerprint();
  const changed = before && after ? before.hash !== after.hash : null;
  const result = roundOutcome(ok, changed, o, l.signal);
  // Session and usage may be printed on stderr (codex prints its header and footer there)
  const combined = `${o.stdout}\n${o.stderrHead}\n${o.stderr}`;
  const sessionRaw = o.timedOut || o.stalled ? null : spec.extractSession(combined, inv);
  const session = sessionRaw ? `${spec.name}:${sessionRaw}` : (r.task.session ?? null);
  const { tokens: usage } = roundTokens(l.tries, {
    resume: r.resumeMode,
    previous: r.previousRound ? { tokensRaw: lastRawTokens(r.previousRound), session: r.previousRound.session ?? null } : null,
    session,
  });
  const elapsedMs = roundElapsed(l.tries);
  if (l.outFile) {
    try {
      fs.unlinkSync(l.outFile); // never fs.rmSync on a single file (Node 24 on Windows can crash)
    } catch {
      /* missing, or harmless to keep */
    }
  }

  const roundRecord: RoundRecord = {
    round,
    created,
    command: l.command,
    attempts,
    elapsedMs,
    exitCode: o.exitCode,
    timedOut: o.timedOut,
    stalled: o.stalled,
    session,
    usage,
    prompt: inv.prompt,
    answer,
    stdout: o.stdout,
    stderrTail: o.stderr.trim(),
    error,
    resumeMode: r.resumeMode,
    workRoot: l.cwd,
    snapshot: r.snapshotLine,
    outcome: result,
    before,
    after,
  };
  fs.appendFileSync(r.transcriptAbs, (round === 1 ? "" : "\n") + roundMarkdown(roundRecord));
  Object.assign(roundEntry, { session, tokens: usage, changed, outcome: result, acceptance: ok ? "pending" : null });
  r.writeRun();

  const { current, done } = finishTaskFile({
    home: r.home,
    recordRel: r.recordRel,
    id: r.id,
    fallback: r.task,
    taskAbs: r.taskAbs,
    executor: spec.name,
    round,
    session,
    usage,
    result,
    ok,
    answer,
    error,
    attempts,
    changed,
    scratch: r.scratch,
    cwd: l.cwd,
  });
  r.onFinished();
  if (ok && current.writeback) {
    try {
      const wb = resolveWriteback(r.project, current.writeback, r.env);
      appendSuggestion(wb.root, wb.rel, { title: current.title, executor: spec.name, answer, stamp: done });
      dbg(`writeback suggestion appended to ${wb.display}`);
    } catch (e) {
      console.error(`[delegate] writeback failed (the answer is still in the transcript): ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return {
    ...r.paths,
    ok,
    executor: spec.name,
    round,
    answer,
    session,
    usage,
    elapsedMs,
    exitCode: o.exitCode,
    timedOut: o.timedOut,
    stalled: o.stalled,
    attempts,
    ...(o.startupFailure ? { startupFailure: o.startupFailure } : {}),
    ...(o.stopError ? { stopError: o.stopError } : {}),
    ...(error ? { error } : {}),
    command: l.command,
    outcome: result,
    acceptance: ok ? "pending" : null,
    changed,
    workRoot: l.cwd,
    snapshot: r.snapshot,
    resumeMode: r.resumeMode,
  };
}

/** Prepares a delegation (record, lock, snapshot) and returns a handle; run() launches the executor */
export async function prepareDelegation(req: DelegationRequest): Promise<PreparedDelegation> {
  // ---- everything is validated before anything is created ----
  const c = checkRequest(req);
  const { env, kind, folder, project, spec, binPath, title, promptText, issuer } = c;
  const now = req.now ?? new Date();
  const created = formatStamp(now);
  const home = ensureHome(env);
  const runsRel = runsRelOf(project);
  const existing = req.continueTask ? readExisting(home, runsRel, req.continueTask, spec) : null;
  const writeback = existing ? existing.task.writeback : req.writeback?.trim() || undefined;
  if (writeback) resolveWriteback(project, writeback, env);
  const targetRel = req.target ?? existing?.task.target;
  const targetAbs = targetRel ? targetPath(project, targetRel) : undefined;
  const { mode, fixedRoot } = decideWorkFolder(c, req, existing, home);

  // ---- claim the record and its lock ----
  const fresh = !existing;
  const { id, rel: recordRel } = existing ?? createRecordDir(home, runsRel, makeTaskId(title, now));
  const lock = acquireClaimLock(home, recordRel, spec.name);
  if (!lock.ok) throw new Error(`task ${id} is claimed: ${lock.heldBy}`);
  if (lock.reclaimed) dbg(`reclaimed a stale lock (holder ${lock.reclaimed.heldBy}, process ${lock.reclaimed.pid} is gone)`);
  const record: RunRecord = existing?.record ?? { version: 2, id, plan: { title, executor: spec.name, brief: promptText }, rounds: [] };
  const lastN = record.rounds.reduce((m, r) => Math.max(m, r.n), 0);
  const round = existing ? Math.max(countRounds(existing.transcript), lastN) + 1 : 1;
  /** Undo what this call created (the lock; for a new task the record folder) and rethrow */
  const giveUp: (e: unknown) => never = (e) => {
    releaseClaimLock(home, recordRel);
    if (fresh) {
      try {
        fs.rmSync(resolveScoped(home, recordRel), { recursive: true, force: true });
      } catch {
        /* best effort: an empty record folder is harmless */
      }
    }
    throw e;
  };
  const guard = async <T>(fn: () => T | Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      return giveUp(e);
    }
  };

  const { snapshot, snapshotNote } = await guard(() => snapshotBefore(fixedRoot, env, `before ${id} round ${round}`));
  const files = await guard(() => ({
    cwd: fixedRoot ?? ensureDir(home, `${recordRel}/${WORK_DIR}`),
    paths: recordPaths(home, project, id),
    taskAbs: resolveWritePathCreating(home, `${recordRel}/${RUN_FILES.task}`),
    transcriptAbs: appendTarget(home, `${recordRel}/${RUN_FILES.transcript}`),
    runAbs: resolveWritePathCreating(home, `${recordRel}/${RUN_FILES.run}`),
    logAbs: appendTarget(home, `${recordRel}/${RUN_FILES.output}`),
    outFile: spec.needsOutFile ? resolveWritePathCreating(home, `${recordRel}/${ANSWER_FILE}`) : null,
  }));
  const { cwd, paths, taskAbs, transcriptAbs, runAbs, logAbs, outFile } = files;
  if (fresh) {
    record.plan = {
      title,
      executor: spec.name,
      brief: promptText,
      issuer,
      createdAt: created,
      execRoot: cwd,
      recordDir: recordRel,
      ...(targetRel ? { target: targetRel } : {}),
      ...(writeback ? { writeback } : {}),
      channel: folder ? "folder" : "local",
      ...(snapshot ? { snapshot } : {}),
    };
  }

  // ---- the command line ----
  const resumeMode: ResumeMode = !existing ? "fresh" : spec.canResume && existing.resumeSession ? "native" : "replay";
  const previousAnswer = resumeMode === "replay" ? (lastRoundOf(existing!.transcript)?.answer ?? "") : undefined;
  const rulingsBefore = rulingsOf(record);
  const previousRound = record.rounds[record.rounds.length - 1];
  const { timeoutMs, stallMs, autoApprove, sandbox, retries } = runSettings(req, spec);
  const scratch = mode === "scratch";
  const built = buildCommand({
    spec,
    kind,
    env,
    binPath,
    req,
    promptText,
    cwd,
    outFile,
    targetRel,
    targetAbs,
    recordDir: scratch ? undefined : paths.recordDir,
    folder,
    round,
    brief: record.plan.brief,
    rulings: rulingsBefore,
    transcript: round > 1 ? paths.transcript : undefined,
    previousAnswer,
    resumeSession: existing?.resumeSession,
    sandbox,
    timeoutMs,
    autoApprove,
  });
  if ("problem" in built) {
    const what = round > 1 ? "the follow-up prompt (it repeats the first brief and the previous answer)" : "the brief";
    giveUp(new Error(`${what} is too long to pass on a command line: ${built.problem}. Shorten it, or put long material in a file and name the file in the brief.`));
  }
  const { inv, args, childEnv, command, argsHash } = built;
  const roundEntry: RoundEntry = {
    n: round,
    at: created,
    ...(existing ? { ruling: promptText } : {}),
    resume: resumeMode,
    executor: spec.name,
    model: inv.model ?? null,
    effort: inv.effort ?? null,
    sandbox,
    autoApprove,
    timeoutMs,
    stallMs,
    retries,
    argsHash,
    command,
    ...(fixedRoot ? { snapshot } : {}),
    attempts: [],
    session: null,
    tokens: null,
    changed: null,
    outcome: null,
    acceptance: null,
  };
  record.rounds.push(roundEntry);
  const writeRun = () => atomicWriteFile(runAbs, serializeRunRecord(record));
  // The scratch folder only holds what the executor wrote; a project or declared folder is fingerprinted with git or by files
  const fingerprint = (): RootState | null => (scratch ? rootFingerprint(cwd, { git: false, skip: [ANSWER_FILE] }) : rootFingerprint(cwd));
  const snapshotLine = fixedRoot ? (snapshot ?? snapshotNote) : null;

  const task = startTaskDoc({ existing, round, created, promptText, title, issuer, targetRel, executor: spec.name, writeback, cwd, snapshot });
  await guard(() => {
    atomicWriteFile(taskAbs, serializeTask(task));
    if (fresh) atomicWriteFile(transcriptAbs, transcriptHeader({ title, spec, issuer, created, project, target: targetRel }));
    writeRun();
  });
  try {
    fs.appendFileSync(logAbs, `\n===== Round ${round} ${created} =====\n`);
  } catch {
    /* a failed log never stops the run */
  }
  dbg(`task written to ${paths.taskFile} (round ${round}, ${RESUME_LABEL[resumeMode]}); executor ${binPath}; working folder ${cwd}`);

  let finalized = false;
  const runThisRound = () =>
    runRound({
      launch: { spec, kind, binPath, args, command, cwd, childEnv, timeoutMs, stallMs, retries, logAbs, outFile, signal: req.signal, onOutput: req.onOutput, tries: roundEntry.attempts! },
      inv,
      fingerprint,
      task,
      resumeMode,
      previousRound,
      round,
      created,
      snapshot,
      snapshotLine,
      scratch,
      project,
      env,
      home,
      recordRel,
      id,
      paths,
      taskAbs,
      transcriptAbs,
      roundEntry,
      writeRun,
      onFinished: () => {
        finalized = true;
      },
    });

  /** The runner itself failed (writing the transcript, reading the task file …): mark the task failed if not done yet; always release the lock */
  const run = async (): Promise<DelegationResult> => {
    try {
      return await runThisRound();
    } catch (e) {
      if (!finalized) {
        try {
          const cur = parseTask(fs.readFileSync(resolveScoped(home, `${recordRel}/${RUN_FILES.task}`), "utf8"), id) ?? task;
          cur.status = "pending";
          cur.outcome = "failed";
          cur.acceptance = undefined;
          cur.body = `${cur.body}\n\n## Execution failed (@${spec.name}, ${formatStamp(new Date())})\n\nInternal runner error: ${e instanceof Error ? e.message : String(e)}\n\nFix the cause and delegate again; details are in the transcript and the output log.`;
          atomicWriteFile(taskAbs, serializeTask(cur));
          roundEntry.outcome = "failed";
          writeRun();
        } catch {
          /* the task file cannot be written either: at least the lock is released */
        }
      }
      throw e;
    } finally {
      releaseClaimLock(home, recordRel);
    }
  };

  return { ...paths, round, workRoot: cwd, snapshot, run };
}

/** Prepares and runs a delegation */
export async function runDelegation(req: DelegationRequest): Promise<DelegationResult> {
  return (await prepareDelegation(req)).run();
}
