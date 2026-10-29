// run.json v2 as the runner writes it (one attempt each, time includes backoff, usage by scope, the review in the
// record), the claim lock (pid and host; a lock whose process is gone is reclaimed), output decoding and command line
// limits.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseRunRecord } from "@longkeep/protocol/runs";
import { parseTask } from "@longkeep/protocol/task";
import { BUILTIN_EXECUTORS } from "../src/executors/registry.ts";
import { delegationStatus, reviewDelegation, runDelegation } from "../src/delegate/index.ts";
import { acquireLockFile, commandLineProblem, readLock, spawnOnce } from "../src/delegate/process.ts";
import { FAKE_EXECUTOR, tempDir } from "@longkeep/testkit/paths";

const FAKE = FAKE_EXECUTOR;
const base = tempDir("longkeep-record-");
afterAll(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
const project = path.join(base, "project");
fs.mkdirSync(project);
const env = { ...process.env, LONGKEEP_HOME: path.join(base, "home"), LONGKEEP_SEARCH_PATH: "" };
const runOf = (file: string) => parseRunRecord(fs.readFileSync(file, "utf8"))!;

/** A process id that has already exited */
function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  return Number(r.stdout);
}

describe("run record v2", () => {
  it("cumulative scope: a native resume of the same session records the difference; the header total is not added twice", async () => {
    const executors = { codex: { ...BUILTIN_EXECUTORS.codex, usageScope: "cumulative" as const } };
    const first = await runDelegation({ project, executor: "codex", title: "Cumulative", prompt: "one", bin: FAKE, executors, env: { ...env, FAKE_EXEC_TOKENS: "100" } });
    expect(first.usage).toBe(100);
    const second = await runDelegation({ project, executor: "codex", title: "", prompt: "two", bin: FAKE, executors, continueTask: first.taskId, env: { ...env, FAKE_EXEC_TOKENS: "130" } });
    expect(second.resumeMode).toBe("native");
    expect(second.usage).toBe(30);
    expect(parseTask(fs.readFileSync(first.taskFile, "utf8"))!.usage).toBe("130 tokens");
    const run = runOf(first.runFile);
    expect(run.rounds.map((r) => r.tokens)).toEqual([100, 30]);
    expect(run.rounds[1].attempts![0].usage).toEqual({ tokens: 130, scope: "cumulative" });
  });

  it("round scope adds up round by round", async () => {
    const executors = { codex: { ...BUILTIN_EXECUTORS.codex, usageScope: "round" as const } };
    const first = await runDelegation({ project, executor: "codex", title: "Per round", prompt: "one", bin: FAKE, executors, env: { ...env, FAKE_EXEC_TOKENS: "100" } });
    await runDelegation({ project, executor: "codex", title: "", prompt: "two", bin: FAKE, executors, continueTask: first.taskId, env: { ...env, FAKE_EXEC_TOKENS: "130" } });
    expect(parseTask(fs.readFileSync(first.taskFile, "utf8"))!.usage).toBe("230 tokens");
  });

  it("retries: one entry per attempt, backoff counts towards the time", async () => {
    const r = await runDelegation({ project, executor: "agy", title: "Retry", prompt: "x", bin: FAKE, retries: 1, autoApprove: false, sandbox: "read-only", env: { ...env, FAKE_EXEC_FAIL_ONCE: "1" } });
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(2);
    const round = runOf(r.runFile).rounds[0];
    expect(round.attempts!.map((a) => [a.n, a.exit, a.exitCode, a.backoffMs])).toEqual([
      [1, "error", 5, 0],
      [2, "ok", 0, 2000],
    ]);
    expect(round.attempts![0].error).toMatch(/exit code 5/);
    expect(r.elapsedMs).toBeGreaterThanOrEqual(2000);
    expect(round.outcome).not.toBeNull();
  }, 20_000);

  it("a failure: outcome failed, no acceptance; arguments, timeouts and other decisions are kept in the round", async () => {
    const r = await runDelegation({ project, executor: "grok", title: "Failure", prompt: "x", bin: FAKE, model: "m1", effort: "minimal", timeoutMs: 30_000, env: { ...env, FAKE_EXEC_FAIL: "1" } });
    expect(r.ok).toBe(false);
    const round = runOf(r.runFile).rounds[0];
    expect(round).toMatchObject({ outcome: "failed", acceptance: null, executor: "grok", model: "m1", effort: "low", timeoutMs: 30_000, retries: 0, autoApprove: true });
    expect(round.attempts).toMatchObject([{ exit: "error", exitCode: 3 }]);
  });

  it("the review goes into the last round of run.json too", async () => {
    const r = await runDelegation({ project, executor: "agy", title: "Review", prompt: "x", bin: FAKE, env });
    reviewDelegation(project, r.taskId, { verdict: "needs_rework", reviewer: "claude", note: "tests missing", now: new Date(2026, 9, 18, 20, 0), env });
    const round = runOf(r.runFile).rounds[0];
    expect(round.acceptance).toBe("needs_rework");
    expect(round.review).toEqual({ verdict: "needs_rework", reviewer: "claude", at: "2026-10-18 20:00", note: "tests missing" });
  });

  it("the same call gives the same normalized-argument hash, whatever the prompt and the generated session id", async () => {
    const a = await runDelegation({ project, executor: "claude", title: "Hash one", prompt: "alpha", bin: FAKE, env });
    const b = await runDelegation({ project, executor: "claude", title: "Hash two", prompt: "beta", bin: FAKE, env });
    const c = await runDelegation({ project, executor: "claude", title: "Hash three", prompt: "beta", bin: FAKE, model: "opus", env });
    const h = (file: string) => runOf(file).rounds[0].argsHash;
    expect(h(a.runFile)).toBe(h(b.runFile));
    expect(h(c.runFile)).not.toBe(h(a.runFile));
  });
});

describe("the claim lock", () => {
  it("a new lock records holder, pid and host; while the holder lives nobody else gets it", () => {
    const abs = path.join(base, "a.lock");
    expect(acquireLockFile(abs, "codex")).toEqual({ ok: true });
    const info = readLock(abs)!;
    expect(info.heldBy).toMatch(/^codex since \d{4}-\d\d-\d\d \d\d:\d\d$/);
    expect(info).toMatchObject({ pid: process.pid, host: os.hostname(), stale: false });
    expect(acquireLockFile(abs, "grok")).toEqual({ ok: false, heldBy: info.heldBy });
  });

  it("a holder that is gone on this machine makes the lock stale: it is reclaimed", () => {
    const abs = path.join(base, "b.lock");
    const pid = deadPid();
    fs.writeFileSync(abs, `codex since 2026-10-18 10:00\npid: ${pid}\nhost: ${os.hostname()}\n`);
    expect(readLock(abs)!.stale).toBe(true);
    const r = acquireLockFile(abs, "grok");
    expect(r.ok).toBe(true);
    expect(r.ok && r.reclaimed).toMatchObject({ heldBy: "codex since 2026-10-18 10:00", pid, stale: true });
    expect(readLock(abs)!.heldBy).toMatch(/^grok since /);
  });

  it("what cannot be judged counts as held: no pid, or another host", () => {
    const old = path.join(base, "c.lock");
    fs.writeFileSync(old, "codex since 2026-10-01 10:00\n");
    expect(readLock(old)).toMatchObject({ pid: null, stale: false });
    expect(acquireLockFile(old, "grok").ok).toBe(false);
    const remote = path.join(base, "d.lock");
    fs.writeFileSync(remote, `codex since 2026-10-01 10:00\npid: ${deadPid()}\nhost: another-machine\n`);
    expect(readLock(remote)!.stale).toBe(false);
    expect(acquireLockFile(remote, "grok").ok).toBe(false);
  });

  it("a stale lock of a record: the status says so without calling it running, and a review reclaims it", async () => {
    const r = await runDelegation({ project, executor: "agy", title: "Stale lock", prompt: "x", bin: FAKE, env });
    fs.writeFileSync(path.join(r.recordDir, "claim.lock"), `agy since 2026-10-18 10:00\npid: ${deadPid()}\nhost: ${os.hostname()}\n`);
    const st = delegationStatus(project, r.taskId, 40, env);
    expect([st.running, st.staleLock]).toEqual([false, true]);
    expect(st.runFile).toBe(r.runFile);
    expect(reviewDelegation(project, r.taskId, { verdict: "accepted", reviewer: "claude", env }).acceptance).toMatch(/^accepted \(claude, /);
    expect(fs.existsSync(path.join(r.recordDir, "claim.lock"))).toBe(false);
  });
});

describe("output decoding", () => {
  it("a multi-byte character split across two chunks stays whole in stdout, stderr and the log", async () => {
    // U+4E2D is E4 B8 AD in UTF-8: the first byte goes out alone, the rest after a pause, so they arrive as separate chunks
    const script = path.join(base, "split-utf8.mjs");
    fs.writeFileSync(
      script,
      "for (const s of [process.stdout, process.stderr]) s.write(Buffer.from([0xe4]));\n" +
        "setTimeout(() => { for (const s of [process.stdout, process.stderr]) s.write(Buffer.from([0xb8, 0xad, 0x0a])); }, 100);\n",
    );
    const logAbs = path.join(base, "split-utf8.log");
    const out = await spawnOnce({ bin: script, args: [], cwd: base, env: process.env, timeoutMs: 10_000, stallMs: 0, logAbs });
    expect(out.stdout).toBe("\u4e2d\n");
    expect(out.stderr).toBe("\u4e2d\n");
    expect(fs.readFileSync(logAbs, "utf8")).not.toContain("�");
  });
});

describe("a grandchild that keeps the output pipes open", () => {
  // The executor starts a detached helper that inherits stdout and stderr, then either exits or hangs
  const helper = (name: string, exitAfter: boolean) => {
    const script = path.join(base, `${name}.mjs`);
    const pidFile = path.join(base, `${name}.pid`);
    fs.writeFileSync(
      script,
      'import { spawn } from "node:child_process";\nimport fs from "node:fs";\n' +
        'const c = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: ["ignore", "inherit", "inherit"], detached: true });\n' +
        `c.unref();\nfs.writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));\nconsole.log("answer");\n` +
        (exitAfter ? "" : "setInterval(() => {}, 1000);\n"),
    );
    const cleanup = () => {
      try {
        process.kill(Number(fs.readFileSync(pidFile, "utf8")));
      } catch {
        /* already gone */
      }
    };
    return { script, cleanup };
  };

  it("does not hold the round after the executor exits", async () => {
    const { script, cleanup } = helper("leaves-helper", true);
    try {
      const out = await spawnOnce({ bin: script, args: [], cwd: base, env: process.env, timeoutMs: 60_000, stallMs: 0, logAbs: path.join(base, "leaves-helper.log") });
      expect(out.exitCode).toBe(0);
      expect(out.timedOut).toBe(false);
      expect(out.stdout).toContain("answer");
      expect(out.elapsedMs).toBeLessThan(15_000);
    } finally {
      cleanup();
    }
  }, 30_000);

  it("a timeout still ends the round", async () => {
    const { script, cleanup } = helper("hangs-with-helper", false);
    try {
      const out = await spawnOnce({ bin: script, args: [], cwd: base, env: process.env, timeoutMs: 2000, stallMs: 0, logAbs: path.join(base, "hangs-with-helper.log") });
      expect(out.timedOut).toBe(true);
      expect(out.elapsedMs).toBeLessThan(15_000);
    } finally {
      cleanup();
    }
  }, 30_000);
});

describe("command line limits", () => {
  it("each platform's limit is checked before launch", () => {
    const env = { PATH: "/usr/bin" };
    expect(commandLineProblem("agent", ["-p", "x".repeat(32_000)], env, "win32")).toBeNull();
    expect(commandLineProblem("agent", ["-p", "x".repeat(33_000)], env, "win32")).toMatch(/Windows allows 32767/);
    // quotes are escaped on Windows, so they count twice
    expect(commandLineProblem("agent", ["-p", '"'.repeat(17_000)], env, "win32")).toMatch(/Windows/);
    expect(commandLineProblem("agent", ["-p", "x".repeat(100_000)], env, "linux")).toBeNull();
    expect(commandLineProblem("agent", ["-p", "x".repeat(140_000)], env, "linux")).toMatch(/Linux allows/);
    expect(commandLineProblem("agent", ["-p", "x".repeat(140_000)], env, "darwin")).toBeNull();
    expect(commandLineProblem("agent", ["-p", "x".repeat(1_100_000)], env, "darwin")).toMatch(/arguments and environment/);
  });

  it("a brief too long for the command line fails before launch and leaves no record", async () => {
    const runs = path.join(base, "home", "runs");
    const before = fs.existsSync(runs) ? fs.readdirSync(runs, { recursive: true }).length : 0;
    await expect(runDelegation({ project, executor: "agy", title: "Too long", prompt: "x".repeat(1_100_000), bin: FAKE, env })).rejects.toThrow(
      /the brief is too long to pass on a command line/,
    );
    const after = fs.existsSync(runs) ? fs.readdirSync(runs, { recursive: true }).length : 0;
    expect(after).toBe(before);
  });
});
