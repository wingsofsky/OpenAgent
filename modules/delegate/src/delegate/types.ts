/**
 * Delegation types, the record-folder names that are not part of RUN_FILES, and where a project's records live.
 * Contract: the header of index.ts.
 */
import { HOME_LAYOUT } from "@openagent/protocol/layout";
import type { TaskOutcome } from "@openagent/protocol/task";
import type { ResumeMode } from "@openagent/protocol/runs";
import type { Effort, ExecutorSpec, Sandbox } from "../executors/registry.ts";
import { projectKey } from "@openagent/common/home";

/** `runs/<project-key>`, relative to the home folder (project: canonical path) */
export const runsRelOf = (project: string): string => `${HOME_LAYOUT.runs}/${projectKey(project)}`;

/** A task id names one record folder: a single plain path segment */
export function checkTaskId(id: string): string {
  if (typeof id !== "string" || !id || id === "." || id === ".." || /[\\/\0]/.test(id)) throw new Error(`invalid task id: ${String(id)}`);
  return id;
}

/** Claim lock of a record, next to RUN_FILES in `runs/<project-key>/<task-id>/` */
export const LOCK_FILE = "claim.lock";
/** Scratch working folder inside a record */
export const WORK_DIR = "work";
/** Where an outFile executor (codex -o) writes its answer, inside the record; deleted after the round */
export const ANSWER_FILE = ".final-answer.txt";

/** Where the executor works: the record's scratch folder (default) or the project itself */
export type WorkMode = "scratch" | "project";

export interface DelegationRequest {
  /**
   * The project folder (any path; checked with common/home resolveProject). Records go to
   * `<home>/runs/<projectKey(project)>/`. For a folder task it is the folder the agent works through.
   */
  project: string;
  executor: string;
  title: string;
  prompt: string;
  /** delegate (default) or folder: a folder task works in `project` itself, with stricter wording and no follow-up rounds */
  kind?: "delegate" | "folder";
  /** folder only: the sub-folder of `project` this run works in (one project of a folder task's queue); records stay under `project` */
  folderRoot?: string;
  /** Working folder of a delegation (first round only; later rounds keep it). Default scratch. */
  work?: WorkMode;
  signal?: AbortSignal;
  onOutput?: (text: string) => void;
  /** The document the task is about: project-relative, must exist */
  target?: string;
  /** Writeback target: `handbook` (the agent handbook) or a project-relative document that exists */
  writeback?: string;
  /** Who issued the task */
  issuer?: string;
  model?: string;
  effort?: Effort;
  sandbox?: Sandbox;
  timeoutMs?: number;
  /** No output for this long counts as stalled; 0 = off (default from the executor: codex 5 minutes, JSON-mode CLIs off) */
  stallMs?: number;
  /** Retries after a non-zero exit (default: 0 when the run may write, 1 for a read-only sandbox) */
  retries?: number;
  autoApprove?: boolean;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  /** Overrides the executable */
  bin?: string;
  /** Follow-up round of an existing task (its task id) */
  continueTask?: string;
  /** Overrides the executor table (tests); default: built-ins plus the home folder's executors.json */
  executors?: Record<string, ExecutorSpec>;
}

/** Paths of one record, all absolute */
export interface RecordPaths {
  taskId: string;
  /** Canonical project folder */
  project: string;
  recordDir: string;
  taskFile: string;
  transcript: string;
  runFile: string;
  outputLog: string;
}

export interface DelegationResult extends RecordPaths {
  /** OS error before a process existed; never derived from CLI output or exit code */
  startupFailure?: string;
  stopError?: string;
  ok: boolean;
  executor: string;
  /** Round number (first round 1) */
  round: number;
  answer: string;
  /** Session handle with the executor prefix, such as codex:<uuid> */
  session: string | null;
  /** Usage of this round */
  usage: number | null;
  elapsedMs: number;
  exitCode: number | null;
  timedOut: boolean;
  stalled: boolean;
  attempts: number;
  error?: string;
  /** Command line for display (the prompt replaced by its length) */
  command: string;
  outcome: TaskOutcome;
  /** pending after a normal exit; null after a failure */
  acceptance: string | null;
  /** Whether the working folder changed during this round; null when no fingerprint could be taken */
  changed: boolean | null;
  /** Working folder (the actual cwd) */
  workRoot: string;
  /** Snapshot taken before this round (project or declared working folder); null otherwise */
  snapshot: string | null;
  resumeMode: ResumeMode;
}

/** A delegation written to disk and waiting to run: the task is in_progress; run() launches the executor */
export interface PreparedDelegation extends RecordPaths {
  round: number;
  workRoot: string;
  snapshot: string | null;
  run: () => Promise<DelegationResult>;
}
