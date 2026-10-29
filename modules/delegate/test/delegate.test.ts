// Delegation runs against the fake executor: records in the home folder, the five CLI shapes, follow-up rounds,
// retries, timeouts and stalls, async status, and what is refused before anything is created.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { parseTask } from "@longkeep/protocol/task";
import { BUILTIN_EXECUTORS } from "../src/executors/registry.ts";
import { delegationStatus, listDelegations, prepareDelegation, runDelegation } from "../src/delegate/index.ts";
import { acquireClaimLock, releaseClaimLock } from "../src/delegate/process.ts";
import { projectKey } from "@longkeep/common/home";
import { FAKE_EXECUTOR, tempDir } from "@longkeep/testkit/paths";

const FAKE = FAKE_EXECUTOR;
const dirs: string[] = [];
afterAll(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));

function setup() {
  const base = tempDir("longkeep-dlg-");
  dirs.push(base);
  const home = path.join(base, "home");
  const project = path.join(base, "project");
  fs.mkdirSync(path.join(project, "docs"), { recursive: true });
  fs.writeFileSync(path.join(project, "docs", "a.md"), "# A\n");
  const env = { ...process.env, LONGKEEP_HOME: home, LONGKEEP_SEARCH_PATH: "" };
  return { base, home, project, env };
}

const readTask = (file: string) => parseTask(fs.readFileSync(file, "utf8"))!;

describe("a delegation run against the fake executor", () => {
  const { base, home, project, env } = setup();

  it("codex shape: in_progress → done, session and usage in the header, round 1 in the transcript, output in the scratch folder, lock released", async () => {
    const r = await runDelegation({
      project,
      executor: "codex",
      title: "Compute 2^100",
      prompt: "Sum the digits of 2 to the power of 100",
      target: "docs/a.md",
      issuer: "claude",
      bin: FAKE,
      now: new Date(2026, 8, 4, 12, 0, 0),
      env: { ...env, FAKE_EXEC_WRITE: "artifact.txt" },
    });
    expect(r.ok).toBe(true);
    expect(r.round).toBe(1);
    expect(r.answer).toBe("fake answer: Sum the digits of 2 to the power of 100");
    expect(r.session).toBe("codex:11111111-2222-3333-4444-555555555555");
    expect(r.usage).toBe(12);
    expect(r.attempts).toBe(1);
    expect(r.taskId).toBe("20260904-120000-Compute-2^100");
    // The record lives in the home folder, nothing in the project
    expect(r.recordDir).toBe(path.join(fs.realpathSync(home), "runs", projectKey(project), r.taskId));
    expect(fs.readdirSync(project)).toEqual(["docs"]);
    expect(fs.readdirSync(r.recordDir).sort()).toEqual(["output.log", "run.json", "task.md", "transcript.md", "work"]);
    expect(r.workRoot).toBe(path.join(r.recordDir, "work"));
    expect(fs.readdirSync(r.workRoot)).toEqual(["artifact.txt"]);
    expect(fs.readFileSync(r.outputLog, "utf8")).toContain("tokens used");
    const task = readTask(r.taskFile);
    expect(task.status).toBe("done");
    expect(task.executor).toBe("codex");
    expect(task.target).toBe("docs/a.md");
    expect(task.session).toBe("codex:11111111-2222-3333-4444-555555555555");
    expect(task.usage).toBe("12 tokens");
    expect(task.snapshot).toBeUndefined();
    expect(task.body).toContain("## Completion summary (@codex)");
    // The outcome comes from the fingerprints (artifact.txt was written by the executor); acceptance only pending
    expect([r.outcome, r.changed, r.acceptance, r.resumeMode, r.snapshot]).toEqual(["changed", true, "pending", "fresh", null]);
    expect([task.outcome, task.acceptance]).toEqual(["changed", "pending"]);
    const run = JSON.parse(fs.readFileSync(r.runFile, "utf8"));
    expect(run).toMatchObject({ version: 2, id: r.taskId, plan: { brief: "Sum the digits of 2 to the power of 100", executor: "codex", channel: "local", execRoot: r.workRoot, target: "docs/a.md" } });
    expect(run.plan.recordDir).toBe(`runs/${projectKey(project)}/${r.taskId}`);
    expect(run.rounds).toMatchObject([{ n: 1, resume: "fresh", outcome: "changed", acceptance: "pending", tokens: 12, attempts: [{ n: 1, exit: "ok", exitCode: 0, backoffMs: 0 }] }]);
    expect(run.rounds[0].argsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(run.rounds[0].snapshot).toBeUndefined();
    const md = fs.readFileSync(r.transcript, "utf8");
    expect(md).toContain("# Delegation: Compute 2^100");
    expect(md).toContain(`project: ${project}`);
    expect(md).toContain("## Round 1 (2026-09-04 12:00)");
    expect(md).toContain("resume: first round");
    expect(md).toContain("outcome: changed");
    expect(md).toContain("changes: yes (");
    expect(md).toContain("session: codex:11111111");
    expect(md).toContain("usage: 12 tokens");
    expect(md).toContain(`Target document (read only; docs/a.md in the project): ${path.join(project, "docs", "a.md")}`);
    expect(r.command).toContain("<prompt, ");
  });

  it("follow-up: codex resumes with exec resume, round 2 is appended, cumulative usage is not added twice; same second and title get a suffix", async () => {
    const now = new Date(2026, 8, 4, 12, 1, 0);
    const first = await runDelegation({ project, executor: "codex", title: "Resume me", prompt: "first question", bin: FAKE, now, env });
    const dup = await runDelegation({ project, executor: "codex", title: "Resume me", prompt: "another one", bin: FAKE, now, env });
    expect(dup.taskId).toBe("20260904-120100-Resume-me-2");
    const second = await runDelegation({ project, executor: "codex", title: "", prompt: "second question", bin: FAKE, continueTask: first.taskId, env });
    expect(second.ok).toBe(true);
    expect(second.round).toBe(2);
    expect(second.taskId).toBe(first.taskId);
    expect(second.answer).toBe("resumed: fake answer: second question");
    expect(second.command).toContain("exec resume 11111111-2222-3333-4444-555555555555");
    expect(second.resumeMode).toBe("native");
    expect(second.workRoot).toBe(first.workRoot);
    const task = readTask(first.taskFile);
    expect(task.status).toBe("done");
    // codex reports the session total (usage.scope cumulative): both rounds report 12, so the total stays 12
    expect(task.usage).toBe("12 tokens");
    expect(task.body).toContain("## Round 2 task");
    expect(task.body).toContain("## Round 2 completion summary (@codex)");
    const md = fs.readFileSync(first.transcript, "utf8");
    expect(md.indexOf("## Round 1 (")).toBeLessThan(md.indexOf("## Round 2 ("));
    expect(md).toContain("resume: native resume");
    expect(md).toContain("Original brief:\nfirst question");
    expect(JSON.parse(fs.readFileSync(first.runFile, "utf8")).rounds).toMatchObject([{ n: 1, resume: "fresh" }, { n: 2, ruling: "second question", resume: "native" }]);
    await expect(runDelegation({ project, executor: "agy", title: "", prompt: "x", bin: FAKE, continueTask: first.taskId, env })).rejects.toThrow(/cannot switch to agy/);
    await expect(runDelegation({ project, executor: "codex", title: "", prompt: "x", bin: FAKE, continueTask: "20990101-000000-nope", env })).rejects.toThrow(/no task/);
    await expect(runDelegation({ project, executor: "codex", title: "", prompt: "x", bin: FAKE, continueTask: "../escape", env })).rejects.toThrow(/invalid task id/);
    await expect(runDelegation({ project, executor: "codex", title: "", prompt: "x", bin: FAKE, continueTask: first.taskId, work: "project", env })).rejects.toThrow(/decided in the first round/);
  });

  it("agy shape: JSON answer, session from session_id, usage input + output; follow-up with --conversation", async () => {
    const r = await runDelegation({ project, executor: "agy", title: "Explain", prompt: "Explain the Fourier transform in plain words", bin: FAKE, env });
    expect(r.ok).toBe(true);
    expect(r.answer).toBe("fake answer: Explain the Fourier transform in plain words");
    expect(r.session).toBe("agy:fake-session");
    expect(r.usage).toBe(42);
    const r2 = await runDelegation({ project, executor: "agy", title: "", prompt: "simpler", bin: FAKE, continueTask: r.taskId, env });
    expect(r2.ok).toBe(true);
    expect(r2.round).toBe(2);
    expect(r2.answer).toBe("fake answer: simpler");
    expect(r2.command).toContain("--conversation fake-session");
    expect(r2.session).toBe("agy:fake-session");
  });

  it("grok shape: our own -s in the first round, the handle goes into the header, the follow-up resumes the same id", async () => {
    const r = await runDelegation({ project, executor: "grok", title: "Search", prompt: "search for it", bin: FAKE, env });
    expect(r.ok).toBe(true);
    expect(r.session).toMatch(/^grok:[0-9a-f-]{36}$/);
    expect(r.command).toContain(`-s ${r.session!.slice(5)}`);
    const r2 = await runDelegation({ project, executor: "grok", title: "", prompt: "search again", bin: FAKE, continueTask: r.taskId, env });
    expect(r2.ok).toBe(true);
    expect(r2.session).toBe(r.session);
    expect(r2.resumeMode).toBe("native");
    expect(r2.command).toContain(`--resume ${r.session!.slice(5)}`);
    expect(r2.command).not.toContain(" -s ");
  });

  it("failures: executors with prompts skipped are not retried by default; explicit retries retry non-zero exits; a failure goes back to pending", async () => {
    const r0 = await runDelegation({ project, executor: "grok", title: "No retry by default", prompt: "search", bin: FAKE, env: { ...env, FAKE_EXEC_FAIL: "1" } });
    expect([r0.ok, r0.attempts, r0.outcome, r0.acceptance]).toEqual([false, 1, "failed", null]);
    const r = await runDelegation({ project, executor: "grok", title: "Search it", prompt: "search", bin: FAKE, retries: 1, env: { ...env, FAKE_EXEC_FAIL: "1" } });
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(3);
    expect(r.attempts).toBe(2);
    expect(r.error).toContain("exit code 3");
    expect(r.error).toContain("boom");
    const task = readTask(r.taskFile);
    expect(task.status).toBe("pending");
    expect(task.body).toContain("## Execution failed (@grok");
    expect(task.body).toContain("retried 1 times");
    expect(task.outcome).toBe("failed");
    expect(task.acceptance).toBeUndefined();
    expect(fs.existsSync(path.join(r.recordDir, "claim.lock"))).toBe(false);
    const r2 = await runDelegation({ project, executor: "grok", title: "Transient", prompt: "search", bin: FAKE, retries: 1, env: { ...env, FAKE_EXEC_FAIL_ONCE: "1" } });
    expect([r2.ok, r2.attempts]).toEqual([true, 2]);
    const r3 = await runDelegation({ project, executor: "grok", title: "No retry", prompt: "search", bin: FAKE, retries: 0, env: { ...env, FAKE_EXEC_FAIL_ONCE: "1" } });
    expect([r3.ok, r3.attempts]).toEqual([false, 1]);
    // A read-only sandbox without auto-approval is retried once by default
    const r4 = await runDelegation({ project, executor: "codex", title: "Read only", prompt: "compute", bin: FAKE, sandbox: "read-only", env: { ...env, FAKE_EXEC_FAIL_ONCE: "1" } });
    expect([r4.ok, r4.attempts]).toEqual([true, 2]);
    // Three real 2s backoffs plus eight process spawns: well past the 5s default under full-suite load.
  }, 60_000);

  it("timeouts and stalls kill the process tree, are not retried, and send the task back to pending", async () => {
    const t = await runDelegation({ project, executor: "agy", title: "Slow", prompt: "slow", bin: FAKE, timeoutMs: 400, stallMs: 60_000, env: { ...env, FAKE_EXEC_SLEEP_MS: "5000" } });
    expect([t.ok, t.timedOut, t.attempts, t.outcome]).toEqual([false, true, 1, "timeout"]);
    expect(t.error).toContain("not finished");
    expect(t.elapsedMs).toBeLessThan(4000);
    const s = await runDelegation({ project, executor: "agy", title: "Stuck", prompt: "stuck", bin: FAKE, timeoutMs: 60_000, stallMs: 400, env: { ...env, FAKE_EXEC_SLEEP_MS: "5000" } });
    expect([s.ok, s.stalled, s.outcome]).toEqual([false, true, "stalled"]);
    expect(s.error).toContain("no output");
    expect(s.elapsedMs).toBeLessThan(4000);
    expect(readTask(s.taskFile).status).toBe("pending");
    // JSON-mode executors have no stall detection by default: 1.5 s of silence is fine
    expect(BUILTIN_EXECUTORS.agy.defaults.stallMs).toBe(0);
    expect(BUILTIN_EXECUTORS.codex.defaults.stallMs).toBe(300_000);
    const quiet = await runDelegation({ project, executor: "grok", title: "Quiet", prompt: "quiet", bin: FAKE, timeoutMs: 10_000, env: { ...env, FAKE_EXEC_SLEEP_MS: "1500" } });
    expect([quiet.ok, quiet.stalled]).toEqual([true, false]);
  }, 30_000);

  it("async: prepare writes the record first (in_progress + lock), the status shows running, run() releases it", async () => {
    const prep = await prepareDelegation({ project, executor: "codex", title: "Background", prompt: "take your time", bin: FAKE, env: { ...env, FAKE_EXEC_SLEEP_MS: "600" } });
    const before = delegationStatus(project, prep.taskId, 40, env);
    expect(before.task.status).toBe("in_progress");
    expect(before.running).toBe(true);
    expect(listDelegations(project, env).find((d) => d.taskId === prep.taskId)?.running).toBe(true);
    const r = await prep.run();
    expect(r.ok).toBe(true);
    const after = delegationStatus(project, prep.taskId, 5, env);
    expect(after.task.status).toBe("done");
    expect(after.running).toBe(false);
    expect(after.outputTail).toContain("fake answer");
    expect(after.transcript).toBe(prep.transcript);
    expect(after.has).toEqual({ transcript: true, run: true });
    expect(r.outcome).toBe("no_changes");
    expect(after.task.outcome).toBe("no_changes");
    // A task answered in the scratch folder is not expected to change files: no reminder
    expect(after.task.body).not.toContain("> Outcome: no changes");
  });

  it("listDelegations: newest first, limited; an unknown project lists nothing", () => {
    const rows = listDelegations(project, env, 3);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.taskId)).toEqual([...rows.map((r) => r.taskId)].sort().reverse());
    const other = setup();
    expect(listDelegations(other.project, other.env)).toEqual([]);
  });

  it("the claim lock is exclusive; a second claimant learns the holder; after release it can be taken again", async () => {
    const r = await runDelegation({ project, executor: "agy", title: "Lock", prompt: "x", bin: FAKE, env });
    const rel = `runs/${projectKey(project)}/${r.taskId}`;
    const realHome = fs.realpathSync(home);
    expect(acquireClaimLock(realHome, rel, "a1")).toEqual({ ok: true });
    const second = acquireClaimLock(realHome, rel, "a2");
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.heldBy).toContain("a1");
    await expect(runDelegation({ project, executor: "agy", title: "", prompt: "again", bin: FAKE, continueTask: r.taskId, env })).rejects.toThrow(/claimed: a1/);
    releaseClaimLock(realHome, rel);
    expect(acquireClaimLock(realHome, rel, "a2")).toEqual({ ok: true });
    releaseClaimLock(realHome, rel);
  });

  it("an empty answer fails; bad targets, shims, unknown executors and bad projects are refused before anything is created", async () => {
    // A normal exit without an answer is not rerun, even with retries
    const r = await runDelegation({ project, executor: "agy", title: "Empty", prompt: "empty", bin: FAKE, retries: 2, env: { ...env, FAKE_EXEC_EMPTY: "1" } });
    expect([r.ok, r.exitCode, r.attempts, r.outcome]).toEqual([false, 0, 1, "failed"]);
    expect(r.error).toContain("produced no answer");
    const runs = path.join(home, "runs", projectKey(project));
    const count = () => fs.readdirSync(runs).length;
    const before = count();
    await expect(runDelegation({ project, executor: "agy", title: "x", prompt: "x", target: "../etc/passwd", bin: FAKE, env })).rejects.toThrow(/target/);
    await expect(runDelegation({ project, executor: "agy", title: "x", prompt: "x", target: "docs/missing.md", bin: FAKE, env })).rejects.toThrow(/does not exist in the project/);
    await expect(runDelegation({ project, executor: "agy", title: "x", prompt: "x", bin: "C:/x/agy.cmd", env })).rejects.toThrow(/shims/);
    await expect(runDelegation({ project, executor: "nope", title: "x", prompt: "x", bin: FAKE, env })).rejects.toThrow(/unknown executor/);
    await expect(runDelegation({ project, executor: "agy", title: "", prompt: "x", bin: FAKE, env })).rejects.toThrow(/title is empty/);
    await expect(runDelegation({ project, executor: "agy", title: "x", prompt: " ", bin: FAKE, env })).rejects.toThrow(/the prompt is empty/);
    await expect(runDelegation({ project, executor: "agy", title: "x", prompt: "x", work: "elsewhere" as never, bin: FAKE, env })).rejects.toThrow(/scratch \| project/);
    await expect(runDelegation({ project: path.parse(project).root, executor: "agy", title: "x", prompt: "x", bin: FAKE, env })).rejects.toThrow(/filesystem root/);
    await expect(runDelegation({ project: path.join(home, "runs"), executor: "agy", title: "x", prompt: "x", bin: FAKE, env })).rejects.toThrow(/home folder/);
    expect(count()).toBe(before);
  });

  it("a missing executable is a startup error that names the install hint", async () => {
    // Discovery also looks under the home directory: point it at the temporary folder so no installed CLI is found
    const spy = vi.spyOn(os, "homedir").mockReturnValue(base);
    try {
      await expect(
        runDelegation({ project, executor: "codex", title: "x", prompt: "x", env: { ...env, PATH: "", LONGKEEP_CODEX_BIN: "", LOCALAPPDATA: base, APPDATA: base } }),
      ).rejects.toMatchObject({ name: "ExecutorStartupError", message: expect.stringContaining("codex not found") });
    } finally {
      spy.mockRestore();
    }
  });
});
