/**
 * Verdicts and progress of delegations: reviewDelegation, delegationStatus, listDelegations. Contract: the header of
 * index.ts. Read-only calls never create the home folder.
 */
import fs from "node:fs";
import { RUN_FILES } from "@longkeep/protocol/layout";
import { parseRunRecord, serializeRunRecord } from "@longkeep/protocol/runs";
import { ACCEPTANCES, ACCEPTANCE_LABEL, AUTHOR_RE, acceptanceValue, formatStamp, normalizeAcceptance, parseTask, serializeTask, type TaskDoc } from "@longkeep/protocol/task";
import { existingHome, resolveProject } from "@longkeep/common/home";
import { atomicWriteFile, resolveScoped } from "@longkeep/common/scoped";
import { recordPaths } from "./prepare.ts";
import { acquireClaimLock, readLock, releaseClaimLock } from "./process.ts";
import { LOCK_FILE, checkTaskId, runsRelOf, type RecordPaths } from "./types.ts";

export const VERDICTS = ACCEPTANCES.filter((a) => a !== "pending") as Array<Exclude<(typeof ACCEPTANCES)[number], "pending">>;
type Verdict = (typeof VERDICTS)[number];

function homeOrFail(env: NodeJS.ProcessEnv, taskId: string): string {
  const home = existingHome(env);
  if (!home) throw new Error(`no task ${taskId} in this project`);
  return home;
}

function readTaskAt(home: string, rel: string, taskId: string): TaskDoc {
  let text: string;
  try {
    text = fs.readFileSync(resolveScoped(home, `${rel}/${RUN_FILES.task}`), "utf8");
  } catch {
    throw new Error(`no task ${taskId} in this project`);
  }
  const task = parseTask(text, taskId);
  if (!task) throw new Error(`${taskId}/${RUN_FILES.task} is not a valid task file`);
  return task;
}

/**
 * The main agent's verdict after checking the diff and the tests: `acceptance: <verdict> (who, when)` in the task
 * header, a "## Review" section in the body, and the review in the last round of run.json.
 * Only finished delegations; written under the claim lock, so a running round is never overwritten. Rework is a new
 * round of the same task.
 */
export function reviewDelegation(
  project: string,
  taskId: string,
  x: { verdict: string; reviewer: string; note?: string; now?: Date; env?: NodeJS.ProcessEnv },
): TaskDoc {
  const env = x.env ?? process.env;
  const root = resolveProject(project, env);
  checkTaskId(taskId);
  const verdict = normalizeAcceptance(x.verdict);
  if (!verdict || verdict === "pending") throw new Error(`the verdict only accepts ${VERDICTS.join(" / ")}`);
  const home = homeOrFail(env, taskId);
  const rel = `${runsRelOf(root)}/${taskId}`;
  readTaskAt(home, rel, taskId);
  const reviewer = x.reviewer.trim() || "claude";
  if (!AUTHOR_RE.test(reviewer)) throw new Error(`reviewer ${JSON.stringify(reviewer)} must be 1-32 characters without spaces, colons or braces`);
  const lock = acquireClaimLock(home, rel, `${reviewer} (review)`);
  if (!lock.ok) throw new Error(`the task is running or claimed: ${lock.heldBy}`);
  try {
    const task = readTaskAt(home, rel, taskId);
    if (!task.executor) throw new Error("this task has no executor field: it is not a delegated task");
    if (task.status !== "done") throw new Error(`the task status is "${task.status}": only finished tasks can be reviewed`);
    const stamp = formatStamp(x.now ?? new Date());
    const note = x.note?.trim();
    task.acceptance = acceptanceValue(verdict, reviewer, stamp);
    task.body = `${task.body}\n\n## Review (@${reviewer}, ${stamp})\n\n${ACCEPTANCE_LABEL[verdict]}${note ? `: ${note}` : ""}`;
    atomicWriteFile(resolveScoped(home, `${rel}/${RUN_FILES.task}`), serializeTask(task));
    recordReview(home, rel, { verdict, reviewer, stamp, note: note || null });
    return task;
  } finally {
    releaseClaimLock(home, rel);
  }
}

/** The review also goes into the last round of run.json; a record without run.json only gets the task header */
function recordReview(home: string, rel: string, x: { verdict: Verdict; reviewer: string; stamp: string; note: string | null }): void {
  let runAbs: string;
  try {
    runAbs = resolveScoped(home, `${rel}/${RUN_FILES.run}`);
  } catch {
    return;
  }
  const rec = parseRunRecord(fs.readFileSync(runAbs, "utf8"));
  const last = rec?.rounds[rec.rounds.length - 1];
  if (!rec || !last) return;
  last.acceptance = x.verdict;
  last.review = { verdict: x.verdict, reviewer: x.reviewer, at: x.stamp, note: x.note };
  atomicWriteFile(runAbs, serializeRunRecord(rec));
}

const existsIn = (home: string, rel: string): boolean => {
  try {
    resolveScoped(home, rel);
    return true;
  } catch {
    return false;
  }
};

/** Progress of one delegation (the query side of an async delegation): task header and the tail of the live output */
export function delegationStatus(
  project: string,
  taskId: string,
  tailLines = 40,
  env: NodeJS.ProcessEnv = process.env,
): RecordPaths & {
  task: TaskDoc;
  running: boolean;
  /** The lock is there but its process is gone on this machine: the task stays in_progress until the lock is reclaimed */
  staleLock: boolean;
  outputTail: string;
  /** Which record files exist yet */
  has: { transcript: boolean; run: boolean };
} {
  const root = resolveProject(project, env);
  checkTaskId(taskId);
  const home = homeOrFail(env, taskId);
  const rel = `${runsRelOf(root)}/${taskId}`;
  const task = readTaskAt(home, rel, taskId);
  let running = false;
  let staleLock = false;
  try {
    const info = readLock(resolveScoped(home, `${rel}/${LOCK_FILE}`));
    staleLock = !!info?.stale;
    running = !!info && !info.stale;
  } catch {
    running = false;
  }
  let outputTail = "";
  try {
    const log = fs.readFileSync(resolveScoped(home, `${rel}/${RUN_FILES.output}`), "utf8");
    outputTail = log.split(/\r?\n/).slice(-tailLines).join("\n");
  } catch {
    outputTail = "";
  }
  return {
    ...recordPaths(home, root, taskId),
    task,
    running,
    staleLock,
    outputTail,
    has: {
      transcript: existsIn(home, `${rel}/${RUN_FILES.transcript}`),
      run: existsIn(home, `${rel}/${RUN_FILES.run}`),
    },
  };
}

export interface DelegationSummary {
  taskId: string;
  title: string;
  status: string;
  executor: string | null;
  created: string | null;
  outcome: string | null;
  acceptance: string | null;
  running: boolean;
}

/** The project's delegations, newest first (task ids start with a timestamp) */
export function listDelegations(project: string, env: NodeJS.ProcessEnv = process.env, limit = 20): DelegationSummary[] {
  const root = resolveProject(project, env);
  const home = existingHome(env);
  if (!home) return [];
  let names: string[];
  try {
    names = fs
      .readdirSync(resolveScoped(home, runsRelOf(root)), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
  const out: DelegationSummary[] = [];
  for (const name of names.sort().reverse()) {
    if (out.length >= limit) break;
    const rel = `${runsRelOf(root)}/${name}`;
    let task: TaskDoc;
    try {
      task = readTaskAt(home, rel, name);
    } catch {
      continue;
    }
    let running = false;
    try {
      const info = readLock(resolveScoped(home, `${rel}/${LOCK_FILE}`));
      running = !!info && !info.stale;
    } catch {
      running = false;
    }
    out.push({
      taskId: name,
      title: task.title,
      status: task.status,
      executor: task.executor ?? null,
      created: task.created ?? null,
      outcome: task.outcome ?? null,
      acceptance: task.acceptance ?? null,
      running,
    });
  }
  return out;
}
