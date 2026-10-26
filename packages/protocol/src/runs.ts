/**
 * The run record: `run.json` in a record folder.
 *
 * One delegation = one run. The first round fixes the RunPlan (the single decision point: executor, brief, working
 * folder, record folder, channel); every later round appends a Round, and every launch of the executor is an Attempt
 * inside its Round. The task file (`task.md`, task.ts) is what people read: the outcome / acceptance / usage in its
 * header are derived from this record and use the same enums (defined in task.ts).
 *
 * ```json
 * {
 *   "version": 2,
 *   "id": "20261018-120000-compute",
 *   "plan": { "title": "compute", "executor": "codex", "brief": "…", "issuer": "claude", "createdAt": "2026-10-18 12:00",
 *             "execRoot": "/abs/wt", "recordDir": "runs/<project-key>/20261018-120000-compute", "channel": "local" },
 *   "rounds": [
 *     { "n": 1, "at": "2026-10-18 12:00", "resume": "fresh", "executor": "codex", "model": null, "effort": null,
 *       "sandbox": "workspace-write", "autoApprove": false, "timeoutMs": 600000, "stallMs": 300000, "retries": 0,
 *       "argsHash": "…", "command": "codex exec … <prompt, 812 chars>",
 *       "attempts": [ { "n": 1, "startedAt": "…", "elapsedMs": 4210, "backoffMs": 0, "exit": "ok", "exitCode": 0,
 *                       "usage": { "tokens": 1234, "scope": "round" }, "error": null } ],
 *       "session": "codex:…", "tokens": 1234, "changed": true, "outcome": "changed", "acceptance": "pending" }
 *   ]
 * }
 * ```
 *
 * English keys and English enum values; display labels come from task.ts (OUTCOME_LABEL / ACCEPTANCE_LABEL).
 * Pure functions, no dependencies, no IO: hashes are computed by the CLI (normalizeArgs only normalizes).
 */
import { RUN_FILES } from "./layout.ts";
import type { TaskAcceptance, TaskOutcome } from "./task.ts";

export const RUN_FILE = RUN_FILES.run;

export type ResumeMode = "fresh" | "native" | "replay";
export type UsageScope = "round" | "cumulative";
/** How a launch ended: ok = exit code 0 with an answer; error = every other normal exit (non-zero exit, no answer) */
export const EXIT_CLASSES = ["ok", "error", "timeout", "stalled", "spawn_failed", "stopped"] as const;
export type ExitClass = (typeof EXIT_CLASSES)[number];

export interface AttemptUsage {
  /** What the executor reported this time (the session total under cumulative scope); null when unreadable, never 0 */
  tokens: number | null;
  scope: UsageScope;
}

export interface Attempt {
  n: number;
  startedAt: string;
  elapsedMs: number;
  /** Backoff wait before this attempt */
  backoffMs: number;
  exit: ExitClass;
  exitCode: number | null;
  usage: AttemptUsage | null;
  error: string | null;
}

export interface Review {
  verdict: Exclude<TaskAcceptance, "pending">;
  reviewer: string;
  at: string;
  note: string | null;
}

export interface Round {
  n: number;
  at: string;
  /** From round 2 on: the task the main agent gave for this round (its ruling) */
  ruling?: string;
  /** Snapshot of the working folder taken before this round (null when the executor worked in its scratch folder or git was missing) */
  snapshot?: string | null;
  resume?: ResumeMode;
  executor?: string;
  model?: string | null;
  effort?: string | null;
  sandbox?: string;
  autoApprove?: boolean;
  timeoutMs?: number;
  stallMs?: number;
  retries?: number;
  /** sha256 of the normalized arguments (computed by the CLI): compared when replaying a past run */
  argsHash?: string;
  /** Command line for display (the prompt replaced by its length) */
  command?: string;
  attempts?: Attempt[];
  session?: string | null;
  /** Usage of this round (cumulative scope already converted to this round's delta); null when unreadable */
  tokens?: number | null;
  /** Whether the working folder differs before and after this round; null when no fingerprint could be taken */
  changed?: boolean | null;
  /** null while still running */
  outcome?: TaskOutcome | null;
  acceptance?: TaskAcceptance | null;
  review?: Review;
}

export interface RunPlan {
  title: string;
  executor: string;
  /** Brief of the first round */
  brief: string;
  issuer?: string;
  createdAt?: string;
  /** Working folder (the actual cwd, absolute path) */
  execRoot?: string;
  /** Record folder, relative to the home folder, such as runs/<project-key>/<task-id> */
  recordDir?: string;
  target?: string;
  writeback?: string;
  /** Who started it: local = a delegation on this machine (CLI or MCP); folder = a folder task */
  channel?: "local" | "folder";
  snapshot?: string;
}

export interface RunRecord {
  version: 2;
  id: string;
  plan: RunPlan;
  rounds: Round[];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Parses run.json; returns null when it is not a run record of the current format (broken JSON, missing plan / rounds) */
export function parseRunRecord(text: string): RunRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return null;
  }
  if (!isObj(raw) || raw.version !== 2 || typeof raw.id !== "string" || !isObj(raw.plan) || !Array.isArray(raw.rounds)) return null;
  const plan = raw.plan;
  if (typeof plan.title !== "string" || typeof plan.executor !== "string" || typeof plan.brief !== "string") return null;
  if (!raw.rounds.every((r) => isObj(r) && typeof r.n === "number")) return null;
  return raw as unknown as RunRecord;
}

export function serializeRunRecord(r: RunRecord): string {
  return JSON.stringify(r, null, 2) + "\n";
}

/** Rulings of the earlier rounds (used when composing the prompt) */
export function rulingsOf(r: RunRecord): Array<{ round: number; text: string }> {
  return r.rounds.filter((x) => x.ruling !== undefined).map((x) => ({ round: x.n, text: x.ruling as string }));
}

/** Total time of this round's launches (failed ones included): every attempt plus its backoff */
export const roundElapsed = (attempts: Attempt[]): number => attempts.reduce((s, a) => s + a.elapsedMs + a.backoffMs, 0);

/**
 * Usage of this round: taken from the last attempt that reported a number. Under cumulative scope (resumed sessions
 * report the session total) and a native resume, the total the same session reported in the previous round is
 * subtracted. When the previous round has no number, the session changed, or the delta is negative (the executor reset
 * its counter), the value is recorded as is: better to over-count than to invent. Round scope is recorded as is.
 */
export function roundTokens(
  attempts: Attempt[],
  x: { resume: ResumeMode; previous?: { tokensRaw: number | null; session: string | null } | null; session: string | null },
): { tokens: number | null; raw: number | null } {
  const last = [...attempts].reverse().find((a) => a.usage && a.usage.tokens !== null);
  const raw = last?.usage?.tokens ?? null;
  if (raw === null) return { tokens: null, raw: null };
  const scope = last?.usage?.scope ?? "round";
  const prev = x.previous;
  if (scope === "cumulative" && x.resume === "native" && prev && prev.tokensRaw !== null && prev.session === x.session && raw >= prev.tokensRaw)
    return { tokens: raw - prev.tokensRaw, raw };
  return { tokens: raw, raw };
}

/** Raw value reported in the previous round (for the cumulative conversion): the last attempt with a number */
export function lastRawTokens(round: Round | undefined): number | null {
  const a = [...(round?.attempts ?? [])].reverse().find((t) => t.usage && t.usage.tokens !== null);
  return a?.usage?.tokens ?? null;
}

/**
 * Normalized arguments, compared when replaying a past run. The prompt becomes `<prompt>`, this launch's temporary
 * answer file becomes `<outFile>`, and a session id we generated ourselves becomes `<newSession>`; everything else stays
 * (model, effort, working folder and resume handle are facts of this call and must be compared).
 */
export function normalizeArgs(args: string[], x: { prompt: string; outFile?: string | null; newSession?: string }): string[] {
  return args.map((a) => {
    if (a === x.prompt) return "<prompt>";
    let s = a;
    if (x.outFile) s = s.split(x.outFile).join("<outFile>");
    if (x.newSession) s = s.split(x.newSession).join("<newSession>");
    return s;
  });
}

/** Total usage over all rounds (the task header's usage:); null when no round reported a number */
export function totalTokens(r: RunRecord): number | null {
  let sum: number | null = null;
  for (const x of r.rounds) if (typeof x.tokens === "number") sum = (sum ?? 0) + x.tokens;
  return sum;
}
