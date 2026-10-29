/**
 * Launching an executor: output caps, killing the process tree, the claim lock, one spawn.
 *
 * - stdin is always closed (codex waits for more input on stdin; agy hangs on Windows without a TTY); `.js` / `.mjs`
 *   entry points run with the current Node.
 * - A timeout, a stall (no output for stallMs) or the abort signal kills the whole tree: `taskkill /T` on Windows, the
 *   process group elsewhere; folder tasks on macOS stop descendants through lib/stop-tree.ts, which verifies with `ps`.
 * - `startupFailure` is only set from an OS error before a process existed, never from CLI output or exit code.
 * - The claim lock (`claim.lock` in the record folder) is created exclusively. Its first line says who holds it and
 *   since when, followed by `pid:` and `host:`. A lock whose process is gone on this machine is stale and reclaimed
 *   once; a lock without a pid or from another host cannot be judged and counts as held.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { formatStamp } from "@longkeep/protocol/task";
import { stopTree } from "../lib/stop-tree.ts";
import { resolveWritePathCreating } from "@longkeep/common/scoped";
import { STARTUP_CODES } from "./launch-fallback.ts";
import { LOCK_FILE } from "./types.ts";

const STDOUT_CAP = 4 * 1024 * 1024;
// Past the cap, the end of stdout is kept as well: the answer of a CLI that streams events is in its last lines
const STDOUT_TAIL_KEEP = 1024 * 1024;
export const TRANSCRIPT_CAP = 64 * 1024;
const STDERR_KEEP = 8 * 1024;
const STDERR_HEAD_KEEP = 4 * 1024;
/** How long close may lag behind the executor's exit (or its stop) before the pipes are dropped */
const CLOSE_GRACE_MS = 3000;

/** With LONGKEEP_DELEGATE_DEBUG=1 every step of the runner goes to stderr (for executors that hang or die) */
export const dbg = (msg: string): void => {
  if (process.env.LONGKEEP_DELEGATE_DEBUG) console.error(`[delegate] ${msg}`);
};

export function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/** A Markdown code fence longer than any backtick run inside s */
export function fence(s: string): string {
  let ticks = "```";
  while (s.includes(ticks)) ticks += "`";
  return ticks;
}

/* ------------------------------------------------------------------ */
/* Locks                                                               */
/* ------------------------------------------------------------------ */

interface LockInfo {
  heldBy: string;
  pid: number | null;
  host: string | null;
  /** The holding process is gone on this machine */
  stale: boolean;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = the process exists but belongs to someone else
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readLock(abs: string): LockInfo | null {
  let text: string;
  try {
    text = fs.readFileSync(abs, "utf8");
  } catch {
    return null;
  }
  const first = text.split(/\r?\n/)[0].trim();
  const pidM = /^pid:\s*(\d+)\s*$/m.exec(text);
  const hostM = /^host:\s*(.+?)\s*$/m.exec(text);
  const pid = pidM ? Number(pidM[1]) : null;
  const host = hostM ? hostM[1] : null;
  return { heldBy: first || "(unknown)", pid, host, stale: pid !== null && host === os.hostname() && !pidAlive(pid) };
}

type LockResult = { ok: true; reclaimed?: LockInfo } | { ok: false; heldBy: string };

export function acquireLockFile(abs: string, holder: string): LockResult {
  let reclaimed: LockInfo | undefined;
  for (let i = 0; i < 2; i++) {
    try {
      const fd = fs.openSync(abs, "wx");
      fs.writeSync(fd, `${holder} since ${formatStamp(new Date())}\npid: ${process.pid}\nhost: ${os.hostname()}\n`);
      fs.closeSync(fd);
      return reclaimed ? { ok: true, reclaimed } : { ok: true };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const info = readLock(abs);
      if (!info) continue; // just removed: try once more
      if (!info.stale || i > 0) return { ok: false, heldBy: info.heldBy };
      reclaimed = info;
      try {
        fs.unlinkSync(abs);
      } catch {
        /* someone else reclaimed it first */
      }
    }
  }
  return { ok: false, heldBy: "(unknown)" };
}

/** The claim lock of a record (`<recordRel>/claim.lock` under the home folder) */
export function acquireClaimLock(home: string, recordRel: string, holder: string): LockResult {
  return acquireLockFile(resolveWritePathCreating(home, `${recordRel}/${LOCK_FILE}`), holder);
}

export function releaseClaimLock(home: string, recordRel: string): void {
  try {
    fs.unlinkSync(resolveWritePathCreating(home, `${recordRel}/${LOCK_FILE}`));
  } catch {
    /* no lock is fine */
  }
}

/* ------------------------------------------------------------------ */
/* One launch                                                          */
/* ------------------------------------------------------------------ */

const viaNodeBin = (bin: string): boolean => /\.(m?js|cjs)$/i.test(bin);
/** CreateProcess limit for the whole command line */
const WIN_COMMAND_LINE_MAX = 32_767;
/** Linux MAX_ARG_STRLEN: one argument, terminating NUL included */
const LINUX_ARG_MAX = 128 * 1024;
/** Arguments plus environment; the smallest common ARG_MAX (macOS), so a conservative bound elsewhere too */
const POSIX_ARGS_ENV_MAX = 1024 * 1024;

/**
 * Why this command line cannot be started on the platform, or null. Prompts travel as arguments, so a long brief, or
 * a follow-up round that replays the previous answer, can exceed what the OS accepts; the spawn would then fail with
 * an error that looks like a broken CLI.
 */
export function commandLineProblem(bin: string, args: string[], env: NodeJS.ProcessEnv, platform: string = process.platform): string | null {
  const all = viaNodeBin(bin) ? [process.execPath, bin, ...args] : [bin, ...args];
  if (platform === "win32") {
    // Node quotes every argument and escapes quotes and backslashes: count those generously
    const length = all.reduce((n, a) => n + a.length + 3 + (a.match(/["\\]/g)?.length ?? 0), 0);
    return length > WIN_COMMAND_LINE_MAX ? `the command line would be about ${length} characters; Windows allows ${WIN_COMMAND_LINE_MAX}` : null;
  }
  const bytes = all.map((a) => Buffer.byteLength(a) + 1);
  const longest = Math.max(...bytes);
  if (platform === "linux" && longest > LINUX_ARG_MAX) return `one argument would be ${longest} bytes; Linux allows ${LINUX_ARG_MAX}`;
  const envBytes = Object.entries(env).reduce((n, [k, v]) => n + Buffer.byteLength(`${k}=${v ?? ""}`) + 1, 0);
  const total = bytes.reduce((n, b) => n + b, 0) + envBytes;
  return total > POSIX_ARGS_ENV_MAX ? `arguments and environment would be ${total} bytes; the limit is about ${POSIX_ARGS_ENV_MAX}` : null;
}

export interface SpawnOutcome {
  startupFailure?: string;
  stopError?: string;
  stdout: string;
  /** Last 8 KB of stderr */
  stderr: string;
  /** First 4 KB of stderr: codex prints the session id and other header lines there */
  stderrHead: string;
  exitCode: number | null;
  timedOut: boolean;
  stalled: boolean;
  elapsedMs: number;
}

export function spawnOnce(x: {
  /** Stop descendants through lib/stop-tree.ts (folder tasks on macOS) */
  stopDescendants?: boolean;
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  stallMs: number;
  logAbs: string;
  signal?: AbortSignal;
  onOutput?: (text: string) => void;
}): Promise<SpawnOutcome> {
  const viaNode = viaNodeBin(x.bin);
  const started = Date.now();
  let stdout = "";
  let stdoutTail = "";
  let stderr = "";
  let stderrHead = "";
  let timedOut = false;
  let stalled = false;
  let lastActivity = Date.now();
  let stopError: string | undefined;
  let startupFailure: string | undefined;
  const log = (s: string) => {
    x.onOutput?.(s);
    try {
      fs.appendFileSync(x.logAbs, s);
    } catch {
      /* a failed log never stops the run */
    }
  };
  return new Promise<SpawnOutcome>((resolve) => {
    if (x.signal?.aborted) {
      resolve({ stdout, stderr, stderrHead, exitCode: null, timedOut, stalled, elapsedMs: 0 });
      return;
    }
    const child = spawn(viaNode ? process.execPath : x.bin, viaNode ? [x.bin, ...x.args] : x.args, {
      cwd: x.cwd,
      env: x.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    let stopping = false;
    let spawned = false;
    let settled = false;
    let exitCode: number | null = null;
    let grace: NodeJS.Timeout | undefined;
    // close waits for every holder of the output pipes. A grandchild that inherited them (a dev server, a detached
    // helper) can keep them open long after the executor exits, and on Windows taskkill /T no longer reaches it once
    // its parent is gone. So after the executor exits, or after it is stopped, give close a short grace period, then
    // drop the pipes and finish with what was read.
    const finishSoon = () => {
      if (settled || grace) return;
      grace = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(exitCode);
      }, CLOSE_GRACE_MS);
    };
    child.once("spawn", () => {
      spawned = true;
    });
    const abort = () => {
      if (stopping) return;
      stopping = true;
      if (x.stopDescendants && child.pid) stopError = stopTree(child.pid);
      else killTree(child);
      finishSoon();
    };
    x.signal?.addEventListener("abort", abort, { once: true });
    if (x.signal?.aborted) abort();
    const timer = setTimeout(() => {
      timedOut = true;
      abort();
    }, x.timeoutMs);
    // stallMs <= 0 turns stall detection off (CLIs in a single-JSON mode print only when they finish)
    const stallTimer = setInterval(() => {
      if (x.stallMs > 0 && Date.now() - lastActivity > x.stallMs) {
        stalled = true;
        abort();
      }
    }, 250);
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      clearInterval(stallTimer);
      x.signal?.removeEventListener("abort", abort);
      const kept = stdoutTail ? `${stdout}\n${stdoutTail}` : stdout;
      resolve({ stdout: kept, stderr, stderrHead, exitCode: code, timedOut, stalled, elapsedMs: Date.now() - started, stopError, startupFailure });
    };
    // Decode as streams: a multi-byte character split across two chunks stays whole
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (s: string) => {
      lastActivity = Date.now();
      if (stdout.length < STDOUT_CAP) stdout += s;
      else stdoutTail = (stdoutTail + s).slice(-STDOUT_TAIL_KEEP);
      log(s);
    });
    child.stderr.on("data", (s: string) => {
      lastActivity = Date.now();
      if (stderrHead.length < STDERR_HEAD_KEEP) stderrHead = (stderrHead + s).slice(0, STDERR_HEAD_KEEP);
      stderr = (stderr + s).slice(-STDERR_KEEP);
      log(s.replace(/^/gm, "[stderr] "));
    });
    // When spawn fails (on Windows, for example, a working folder past the path length limit), the pipes emit
    // ENOTCONN as well; unhandled, that error would end this process. The child's own error event reports the cause.
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});
    child.on("error", (e: NodeJS.ErrnoException) => {
      if (!spawned && !child.pid && e.code && STARTUP_CODES.has(e.code)) startupFailure = e.code;
      const longPath = process.platform === "win32" && e.code === "ENOENT" && x.cwd.length >= 260 ? ` (the working folder path is ${x.cwd.length} characters; Windows cannot start a process in a folder whose path is 260 or longer)` : "";
      stderr = (stderr + `\n[spawn failed] ${e.message}${longPath}`).slice(-STDERR_KEEP);
      // Node emits close after error: keep waiting until all stdio is closed.
    });
    child.on("exit", (code) => {
      exitCode = code;
      finishSoon();
    });
    child.on("close", finish);
  });
}
