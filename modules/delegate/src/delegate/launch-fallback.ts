/**
 * Launch fallback for folder tasks: try the next executor of a chain only when the current one provably never started.
 *
 * - Only the local launcher creates the evidence: an ExecutorStartupError thrown before a process existed, or a result
 *   whose `startupFailure` is an OS error code from spawn. Text a CLI printed, its exit code, a timeout or a stall is
 *   never evidence; such a result is returned as is.
 * - No watchdog races a live attempt: a candidate is replaced only after its attempt settled. The next candidate starts
 *   no earlier than `delayMs` (five minutes in production) after the failed one started, so a flapping install does
 *   not burn through the chain; the wait can be cancelled through the signal.
 * - A result that also reports an unconfirmed stop (`stopError`) ends the chain: a process may still be running.
 */
import { setTimeout as sleep } from "node:timers/promises";
import type { Effort } from "@longkeep/protocol/executors";

export const LAUNCH_CHECK_MS = 5 * 60_000;
export const STARTUP_CODES: ReadonlySet<string> = new Set(["ENOENT", "EACCES", "EPERM", "ENOEXEC", "ENOTDIR"]);

/** Thrown by the launcher before any process exists (for example, the executable was not found) */
export class ExecutorStartupError extends Error {
  readonly code: string;
  constructor(message: string, code = "ENOENT") {
    super(message);
    this.name = "ExecutorStartupError";
    this.code = code;
  }
}

export interface FallbackCandidate {
  executor: string;
  model?: string;
  effort?: Effort;
}

interface LaunchResult {
  ok: boolean;
  startupFailure?: string;
  stopError?: string;
  error?: string;
}

/** Whether an attempt provably never started, from what it threw or the result it settled with: the one reason to move on */
export function neverStarted(attempt: { thrown: unknown } | { result: LaunchResult }): boolean {
  if ("thrown" in attempt) return attempt.thrown instanceof ExecutorStartupError && STARTUP_CODES.has(attempt.thrown.code);
  const r = attempt.result;
  return !r.ok && !!r.startupFailure && STARTUP_CODES.has(r.startupFailure) && !r.stopError;
}

export async function launchFallback<C extends FallbackCandidate, R extends LaunchResult>(x: {
  candidates: C[];
  signal: AbortSignal;
  execute: (candidate: C) => Promise<R>;
  onState: (state: { phase: "waiting" | "running"; message: string }) => void;
  delayMs?: number;
}): Promise<R> {
  const delayMs = x.delayMs ?? LAUNCH_CHECK_MS;
  const named = (c: C) => `${c.executor}${c.model ? ` (${c.model})` : ""}`;
  for (let index = 0; index < x.candidates.length; index++) {
    x.signal.throwIfAborted();
    const candidate = x.candidates[index];
    const started = performance.now();
    let failure: string | undefined;
    try {
      const result = await x.execute(candidate);
      // Success wins over every diagnostic; a failure after the process started is final too.
      if (!neverStarted({ result }) || x.signal.aborted) return result;
      failure = result.error;
    } catch (e) {
      if (!neverStarted({ thrown: e })) throw e;
      failure = (e as Error).message;
    }
    x.signal.throwIfAborted();
    if (index + 1 === x.candidates.length) throw new Error(`none of the fallback executors could start: ${failure}`);
    const next = x.candidates[index + 1];
    x.onState({
      phase: "waiting",
      message: `${candidate.executor} could not create a process: ${failure}. Switching to ${named(next)} once the ${delayMs / 60_000}-minute launch check has passed.`,
    });
    await sleep(Math.max(0, delayMs - (performance.now() - started)), undefined, { signal: x.signal });
    x.signal.throwIfAborted();
    x.onState({ phase: "running", message: `Confirmed that ${candidate.executor} did not start; replacing it with ${named(next)}.` });
  }
  throw new Error("no launch candidates");
}
