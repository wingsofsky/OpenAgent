// Where a delegation works and what it records about it: scratch, the project, declared working folders, folder tasks;
// snapshots before a round; outcomes from fingerprints; reviews; the follow-up contract; writeback.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { acceptanceState, parseTask } from "@openagent/protocol/task";
import { BUILTIN_EXECUTORS } from "../src/executors/registry.ts";
import { prepareDelegation, reviewDelegation, runDelegation } from "../src/delegate/index.ts";
import { acquireClaimLock, releaseClaimLock } from "../src/delegate/process.ts";
import { lastRoundOf } from "../src/delegate/records.ts";
import { checkWorkRoot, rootFingerprint } from "../src/delegate/work-root.ts";
import { projectKey } from "@openagent/common/home";
import { linkDir } from "@openagent/testkit/links";
import { FAKE_EXECUTOR, tempDir } from "@openagent/testkit/paths";

const FAKE = FAKE_EXECUTOR;
const dirs: string[] = [];
afterAll(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));

function setup() {
  const base = tempDir("openagent-work-");
  dirs.push(base);
  const home = path.join(base, "home");
  const project = path.join(base, "project");
  fs.mkdirSync(project);
  const env = { ...process.env, OPENAGENT_HOME: home, OPENAGENT_SEARCH_PATH: "" };
  const folder = (name: string) => {
    const d = path.join(base, name);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };
  const writeExecutors = (o: Record<string, unknown>) => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "executors.json"), JSON.stringify(o));
  };
  return { base, home, project, env, folder, writeExecutors };
}

const readTask = (file: string) => parseTask(fs.readFileSync(file, "utf8"))!;
const samePath = (a: string, b: string) => (process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));
/** The working folder the prompt names, and the cwd the fake executor reports (JSON cwd field / codex workdir line) */
const roots = (md: string) => {
  const said = /Working folder: (.+?)\. (?:Create|Change|Source)/.exec(md)?.[1] ?? "";
  const json = md.split("\n").find((l) => l.startsWith('{"type":"result"'));
  const actual: string = json ? JSON.parse(json).cwd : (/^workdir: (.+)$/m.exec(md)?.[1] ?? "");
  return { said, actual };
};
function gitRepo(dir: string) {
  const git = (...a: string[]) => {
    const r = spawnSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
  };
  git("init", "-q");
  fs.writeFileSync(path.join(dir, "a.txt"), "1\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "init");
}

describe("working folders", () => {
  it("a declared workRoot: all five built-ins work there, the prompt names it, the record stays in the home folder", async () => {
    const { project, env, folder, writeExecutors } = setup();
    const ext = folder("worktree");
    writeExecutors(Object.fromEntries(["codex", "agy", "grok", "cursor", "claude"].map((n) => [n, { workRoot: ext }])));
    for (const name of ["codex", "agy", "grok", "cursor", "claude"]) {
      const r = await runDelegation({ project, executor: name, title: `root-${name}`, prompt: "have a look", bin: FAKE, env });
      expect(r.ok, name).toBe(true);
      expect(samePath(r.workRoot, ext), name).toBe(true);
      const md = fs.readFileSync(r.transcript, "utf8");
      const { said, actual } = roots(md);
      expect(samePath(said, ext), `${name} prompt ${said}`).toBe(true);
      expect(samePath(actual, ext), `${name} actual cwd ${actual}`).toBe(true);
      expect(md).toContain(`Record folder for this run: ${r.recordDir}.`);
      expect(fs.existsSync(path.join(r.recordDir, "work"))).toBe(false);
    }
    expect(fs.readdirSync(ext)).toEqual([]); // records, plans and logs never go into the working folder
    expect(fs.readdirSync(project)).toEqual([]);
  });

  it("a -C / --workspace hard-coded in a custom template counts as declared; a template with only {cwd} works in scratch", async () => {
    const { project, env, folder, writeExecutors } = setup();
    const pinC = folder("pin-c");
    const pinW = folder("pin-w");
    writeExecutors({
      pinc: { command: FAKE, args: ["exec", "--skip-git-repo-check", "-C", pinC, "-o", "{outFile}", "{prompt}"], answer: "outFile" },
      pinw: { command: FAKE, args: ["-p", "{prompt}", "--output-format", "json", "--workspace", pinW] },
      tpl: { command: FAKE, args: ["-p", "{prompt}", "--output-format", "json", "--cwd", "{cwd}"] },
    });
    for (const [name, want] of [
      ["pinc", pinC],
      ["pinw", pinW],
    ] as const) {
      const r = await runDelegation({ project, executor: name, title: `pin-${name}`, prompt: "have a look", env });
      expect(r.ok, name).toBe(true);
      const { said, actual } = roots(fs.readFileSync(r.transcript, "utf8"));
      expect(samePath(said, want), `${name} prompt ${said}`).toBe(true);
      expect(samePath(actual, want), `${name} actual cwd ${actual}`).toBe(true);
    }
    const t = await runDelegation({ project, executor: "tpl", title: "template", prompt: "have a look", env });
    const { said, actual } = roots(fs.readFileSync(t.transcript, "utf8"));
    expect(samePath(said, path.join(t.recordDir, "work"))).toBe(true);
    expect(samePath(actual, said)).toBe(true);
    await expect(runDelegation({ project, executor: "pinw", title: "x", prompt: "x", work: "project", env })).rejects.toThrow(/declares its working folder/);
  });

  it("declared working folders are checked like projects: missing, a file, the home folder, inside it or around it are refused", async () => {
    const { base, home, project, env, folder, writeExecutors } = setup();
    fs.writeFileSync(path.join(base, "f.txt"), "x");
    const inside = folder("home/inside");
    for (const [workRoot, why] of [
      [path.join(base, "missing"), /does not exist/],
      [path.join(base, "f.txt"), /not a folder/],
      [home, /home folder cannot be a project/],
      [inside, /home folder cannot be a project/],
      [base, /cannot contain the OpenAgent home folder/],
    ] as const) {
      writeExecutors({ codex: { workRoot } });
      await expect(runDelegation({ project, executor: "codex", title: "x", prompt: "x", bin: FAKE, env }), workRoot).rejects.toThrow(why);
    }
    expect(fs.existsSync(path.join(home, "runs"))).toBe(false);
    expect(samePath(checkWorkRoot(project, env), project)).toBe(true);
    expect(() => checkWorkRoot(os.homedir(), env)).toThrow(/home directory/);
  });

  it("work: project in a git project: a snapshot before each round, outcomes from fingerprints, rework clears the old verdict", async () => {
    const { home, project, env } = setup();
    gitRepo(project);
    const r1 = await runDelegation({ project, executor: "codex", title: "No changes", prompt: "change nothing", work: "project", bin: FAKE, env });
    expect(r1.ok).toBe(true);
    expect(samePath(r1.workRoot, project)).toBe(true);
    expect([r1.outcome, r1.changed, r1.acceptance]).toEqual(["no_changes", false, "pending"]);
    expect(r1.snapshot).toMatch(/^[0-9a-f]{10}$/);
    const t1 = readTask(r1.taskFile);
    expect([t1.status, t1.outcome, t1.acceptance, t1.snapshot]).toEqual(["done", "no_changes", "pending", r1.snapshot]);
    expect(t1.body).toContain("> Outcome: no changes (the working folder ");
    const md1 = fs.readFileSync(r1.transcript, "utf8");
    expect(md1).toMatch(/changes: none \(HEAD [0-9a-f]{7} -> [0-9a-f]{7}; 0 uncommitted, 0 before the round\)/);
    expect(md1).toContain(`snapshot: ${r1.snapshot}`);
    expect(md1).toContain(`Record folder for this run: ${r1.recordDir}.`);
    const run1 = JSON.parse(fs.readFileSync(r1.runFile, "utf8"));
    expect(run1.plan).toMatchObject({ execRoot: project, snapshot: r1.snapshot });
    expect(run1.rounds[0].snapshot).toBe(r1.snapshot);
    // The shadow repository lives in the home folder; the project's own .git is untouched
    expect(fs.existsSync(path.join(home, "snapshots", projectKey(project), "HEAD"))).toBe(true);
    expect(fs.readdirSync(project).sort()).toEqual([".git", "a.txt"]);

    // Round 2: the executor creates a file in the project (untracked counts)
    const r2 = await runDelegation({ project, executor: "codex", title: "", prompt: "add a file", bin: FAKE, continueTask: r1.taskId, env: { ...env, FAKE_EXEC_WRITE: "new.txt" } });
    expect([r2.round, r2.outcome]).toEqual([2, "changed"]);
    expect(samePath(r2.workRoot, project)).toBe(true);
    expect(r2.snapshot).toBe(r1.snapshot); // nothing changed between the rounds: the latest snapshot is the baseline
    expect(fs.existsSync(path.join(project, "new.txt"))).toBe(true);
    const md2 = fs.readFileSync(r1.transcript, "utf8");
    expect(md2).toContain("1 uncommitted, 0 before the round");
    expect(md2).toContain("?? new.txt");

    // The main agent's verdict
    const reviewed = reviewDelegation(project, r1.taskId, { verdict: "needs_rework", reviewer: "claude", note: "tests missing", now: new Date(2026, 9, 17, 9, 30, 0), env });
    expect(reviewed.acceptance).toBe("needs_rework (claude, 2026-10-17 09:30)");
    expect(acceptanceState(reviewed.acceptance)).toBe("needs_rework");
    const t2 = readTask(r1.taskFile);
    expect([t2.status, t2.acceptance]).toEqual(["done", "needs_rework (claude, 2026-10-17 09:30)"]);
    expect(t2.body).toContain("## Review (@claude, 2026-10-17 09:30)\n\nneeds rework: tests missing");

    // Rework round: its own outcome, acceptance pending again, a new snapshot that holds new.txt
    const r3 = await runDelegation({ project, executor: "codex", title: "", prompt: "add tests", bin: FAKE, continueTask: r1.taskId, env });
    expect(r3.round).toBe(3);
    expect(r3.snapshot).not.toBe(r1.snapshot);
    const t3 = readTask(r1.taskFile);
    expect([t3.outcome, t3.acceptance, t3.snapshot]).toEqual(["no_changes", "pending", r3.snapshot]);
    const run = JSON.parse(fs.readFileSync(r1.runFile, "utf8"));
    expect(run.rounds.map((x: { snapshot?: string }) => x.snapshot)).toEqual([r1.snapshot, r1.snapshot, r3.snapshot]);
    expect(run.rounds.filter((x: { ruling?: string }) => x.ruling).map((x: { ruling: string }) => x.ruling)).toEqual(["add a file", "add tests"]);
  });

  it("without git the round runs without a snapshot and the transcript says so", async () => {
    const { project, env } = setup();
    fs.writeFileSync(path.join(project, "a.txt"), "x");
    const saved = process.env.OPENAGENT_GIT;
    process.env.OPENAGENT_GIT = path.join(project, "no-such-git");
    try {
      const r = await runDelegation({ project, executor: "agy", title: "No git", prompt: "x", work: "project", bin: FAKE, env });
      expect(r.ok).toBe(true);
      expect(r.snapshot).toBeNull();
      expect(readTask(r.taskFile).snapshot).toBeUndefined();
      expect(fs.readFileSync(r.transcript, "utf8")).toContain("snapshot: none (git is not installed; continued without a snapshot)");
      expect(JSON.parse(fs.readFileSync(r.runFile, "utf8")).rounds[0].snapshot).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.OPENAGENT_GIT;
      else process.env.OPENAGENT_GIT = saved;
    }
  });
});

describe("the follow-up contract", () => {
  it("an executor that cannot resume, pinned to a folder: three rounds replay, each with the folder, the brief, the rulings and the previous answer", async () => {
    const { project, env, folder, writeExecutors } = setup();
    const pin = folder("replay");
    writeExecutors({ plain: { command: FAKE, args: ["-p", "{prompt}", "--output-format", "json", "--workspace", pin] } });
    const r1 = await runDelegation({ project, executor: "plain", title: "Three rounds", prompt: "step one: scaffold", env });
    const r2 = await runDelegation({ project, executor: "plain", title: "", prompt: "step two: add tests", continueTask: r1.taskId, env });
    const r3 = await runDelegation({ project, executor: "plain", title: "", prompt: "step three: fix the docs", continueTask: r1.taskId, env });
    expect([r1.round, r2.round, r3.round]).toEqual([1, 2, 3]);
    expect([r1.resumeMode, r2.resumeMode, r3.resumeMode]).toEqual(["fresh", "replay", "replay"]);
    expect(r3.answer).toBe("fake answer: step three: fix the docs");
    const md = fs.readFileSync(r1.transcript, "utf8");
    const third = md.slice(md.indexOf("## Round 3 ("));
    const { said, actual } = roots(third);
    expect(samePath(said, pin), `round 3 prompt ${said}`).toBe(true);
    expect(samePath(actual, pin), `round 3 actual cwd ${actual}`).toBe(true);
    expect(third).toContain("resume: replay of the previous answer");
    expect(third).toContain("This is round 3 of the same task");
    expect(third).toContain(`The full record of earlier rounds is in ${r1.transcript}.`);
    expect(third).toContain("Original brief:\nstep one: scaffold");
    expect(third).toContain("Ruling of round 2:\nstep two: add tests");
    expect(third).toContain("Your previous answer:\nfake answer: step two: add tests");
    expect(third).toContain("Task for this round (continues the previous one):\nstep three: fix the docs");
    const run = JSON.parse(fs.readFileSync(r1.runFile, "utf8"));
    expect(run.plan.brief).toBe("step one: scaffold");
    expect(run.rounds.filter((x: { ruling?: string }) => x.ruling).map((x: { n: number; ruling: string }) => [x.n, x.ruling])).toEqual([
      [2, "step two: add tests"],
      [3, "step three: fix the docs"],
    ]);
    expect(run.rounds.map((x: { resume: string }) => x.resume)).toEqual(["fresh", "replay", "replay"]);
    expect(lastRoundOf(md)).toEqual({ prompt: "step three: fix the docs", answer: "fake answer: step three: fix the docs" });
  });

  it("a record without a valid run.json cannot be continued", async () => {
    const { project, env } = setup();
    const r = await runDelegation({ project, executor: "agy", title: "Broken", prompt: "x", bin: FAKE, env });
    fs.writeFileSync(r.runFile, "{ broken");
    await expect(runDelegation({ project, executor: "agy", title: "", prompt: "y", bin: FAKE, continueTask: r.taskId, env })).rejects.toThrow(/no valid run.json/);
  });

  it("the runner failing itself (the answer parser throws) still releases the lock and records an internal error", async () => {
    const { project, env } = setup();
    const bad = { ...BUILTIN_EXECUTORS.agy, extractAnswer: () => { throw new Error("parser exploded"); } };
    const prep = await prepareDelegation({ project, executor: "agy", title: "Explode", prompt: "x", bin: FAKE, env, executors: { agy: bad } });
    expect(fs.existsSync(path.join(prep.recordDir, "claim.lock"))).toBe(true);
    await expect(prep.run()).rejects.toThrow(/parser exploded/);
    expect(fs.existsSync(path.join(prep.recordDir, "claim.lock"))).toBe(false);
    const t = readTask(prep.taskFile);
    expect([t.status, t.outcome]).toEqual(["pending", "failed"]);
    expect(t.body).toContain("Internal runner error: parser exploded");
  });
});

describe("reviews", () => {
  it("only finished delegations; a held lock is refused; no executor field is refused; only the three verdicts", async () => {
    const { home, project, env } = setup();
    const r = await runDelegation({ project, executor: "codex", title: "Review me", prompt: "x", bin: FAKE, env });
    const text = fs.readFileSync(r.taskFile, "utf8");
    fs.writeFileSync(r.taskFile, text.replace("status: done", "status: in_progress"));
    expect(() => reviewDelegation(project, r.taskId, { verdict: "accepted", reviewer: "claude", env })).toThrow(/only finished tasks/);
    fs.writeFileSync(r.taskFile, text);
    const rel = `runs/${projectKey(project)}/${r.taskId}`;
    expect(acquireClaimLock(fs.realpathSync(home), rel, "codex")).toEqual({ ok: true });
    expect(() => reviewDelegation(project, r.taskId, { verdict: "accepted", reviewer: "claude", env })).toThrow(/running or claimed/);
    releaseClaimLock(fs.realpathSync(home), rel);
    expect(() => reviewDelegation(project, r.taskId, { verdict: "approved", reviewer: "claude", env })).toThrow(/verdict only accepts accepted \/ needs_rework \/ rejected/);
    expect(() => reviewDelegation(project, r.taskId, { verdict: "pending", reviewer: "claude", env })).toThrow(/verdict only accepts/);
    const t = reviewDelegation(project, r.taskId, { verdict: "accepted", reviewer: "claude", now: new Date(2026, 9, 17, 12, 0, 0), env });
    expect([t.outcome, t.acceptance]).toEqual(["no_changes", "accepted (claude, 2026-10-17 12:00)"]);
    expect(fs.existsSync(path.join(r.recordDir, "claim.lock"))).toBe(false);
    fs.writeFileSync(r.taskFile, text.replace(/^executor: .*\n/m, ""));
    expect(() => reviewDelegation(project, r.taskId, { verdict: "accepted", reviewer: "claude", env })).toThrow(/not a delegated task/);
    expect(() => reviewDelegation(project, "20990101-000000-none", { verdict: "accepted", reviewer: "claude", env })).toThrow(/no task/);
    expect(() => reviewDelegation(project, "../x", { verdict: "accepted", reviewer: "claude", env })).toThrow(/invalid task id/);
  });
});

describe("fingerprints", () => {
  it("a files fingerprint skips the runner's own files and sees the executor's; an unreadable folder gives null", () => {
    const { base } = setup();
    const d = path.join(base, "fp");
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, "f.txt"), "x");
    const opts = { git: false, skip: [".final-answer.txt"] };
    const a = rootFingerprint(d, opts)!;
    expect(a.kind).toBe("files");
    fs.writeFileSync(path.join(d, ".final-answer.txt"), "written by the runner");
    expect(rootFingerprint(d, opts)!.hash).toBe(a.hash);
    fs.writeFileSync(path.join(d, "g.txt"), "written by the executor");
    expect(rootFingerprint(d, opts)!.hash).not.toBe(a.hash);
    expect(rootFingerprint(path.join(d, "missing"), { git: false })).toBeNull();
  });
});

describe("writeback", () => {
  it("handbook: refused before anything is created when there is none; appended to the home handbook as a suggestion tagged with the executor's name, never to a project copy", async () => {
    const { home, project, env } = setup();
    await expect(runDelegation({ project, executor: "grok", title: "x", prompt: "x", writeback: "handbook", bin: FAKE, env })).rejects.toThrow(/no agent handbook yet/);
    expect(fs.existsSync(path.join(home, "runs"))).toBe(false);
    fs.writeFileSync(path.join(home, "handbook.md"), "# Handbook\n");
    const r = await runDelegation({ project, executor: "grok", title: "New model", prompt: "what is new", writeback: "handbook", bin: FAKE, env });
    expect(r.ok).toBe(true);
    expect(readTask(r.taskFile).writeback).toBe("handbook");
    const hb = fs.readFileSync(path.join(home, "handbook.md"), "utf8");
    expect(hb.startsWith("# Handbook\n")).toBe(true);
    expect(hb).toContain("{++@grok: \n## New model (");
    expect(hb).toContain("fake answer: what is new\n++}");
    // A project cannot bring its own handbook: writeback still goes to the home folder's
    fs.mkdirSync(path.join(project, ".openagent"));
    fs.writeFileSync(path.join(project, ".openagent", "handbook.md"), "# Project handbook\n");
    await runDelegation({ project, executor: "agy", title: "Project note", prompt: "note this", writeback: "handbook", bin: FAKE, env });
    expect(fs.readFileSync(path.join(project, ".openagent", "handbook.md"), "utf8")).toBe("# Project handbook\n");
    expect(fs.readFileSync(path.join(home, "handbook.md"), "utf8")).toContain("{++@agy: \n## Project note (");
  });

  it("a project document: must exist and stay inside the project; the follow-up round writes back to it again; effort is passed per executor", async () => {
    const { home, project, env, writeExecutors } = setup();
    fs.mkdirSync(path.join(project, "docs"));
    fs.writeFileSync(path.join(project, "docs", "notes.md"), "# Notes\n");
    for (const [wb, why] of [
      ["docs/missing.md", /does not exist in the project/],
      ["../outside.md", /leaves its folder/],
    ] as const)
      await expect(runDelegation({ project, executor: "agy", title: "x", prompt: "x", writeback: wb, bin: FAKE, env })).rejects.toThrow(why);
    expect(fs.existsSync(path.join(home, "runs"))).toBe(false);
    writeExecutors({ agy: { effort: "xhigh" } });
    const r = await runDelegation({ project, executor: "agy", title: "Explain", prompt: "explain it", writeback: "docs/notes.md", bin: FAKE, env });
    expect(r.ok).toBe(true);
    // The fake executor echoes argv: agy takes xhigh as is
    expect(fs.readFileSync(r.transcript, "utf8")).toContain('"--effort","xhigh"');
    await runDelegation({ project, executor: "agy", title: "", prompt: "and more", continueTask: r.taskId, bin: FAKE, env });
    const notes = fs.readFileSync(path.join(project, "docs", "notes.md"), "utf8");
    expect(notes.match(/\{\+\+@agy: /g)).toHaveLength(2);
    expect(notes).toContain("fake answer: and more");
  });
});

describe("folder tasks", () => {
  it("work in the folder with strict wording, records under the folder's key, a snapshot first, no follow-up rounds", async () => {
    const { home, env, folder } = setup();
    const target = folder("workspace");
    fs.writeFileSync(path.join(target, "readme.md"), "# projects\n");
    await expect(runDelegation({ project: target, kind: "folder", work: "scratch", executor: "grok", title: "x", prompt: "x", bin: FAKE, env })).rejects.toThrow(/always works in its folder/);
    const r = await runDelegation({ project: target, kind: "folder", executor: "grok", title: "Folder run", prompt: "work through it", bin: FAKE, retries: 0, env });
    expect(r.ok).toBe(true);
    expect(samePath(r.workRoot, target)).toBe(true);
    expect(r.recordDir.startsWith(path.join(fs.realpathSync(home), "runs", projectKey(target)) + path.sep)).toBe(true);
    expect(r.snapshot).toMatch(/^[0-9a-f]{10}$/);
    const md = fs.readFileSync(r.transcript, "utf8");
    expect(md).toContain(`Working folder: ${target}. Source changes stay inside this folder`);
    expect(md).toContain(`Record and build output folder for this run: ${r.recordDir}.`);
    expect(JSON.parse(fs.readFileSync(r.runFile, "utf8")).plan.channel).toBe("folder");
    expect(fs.readdirSync(target)).toEqual(["readme.md"]);
    await expect(runDelegation({ project: target, kind: "folder", executor: "grok", title: "", prompt: "again", continueTask: r.taskId, bin: FAKE, env })).rejects.toThrow(/no follow-up rounds/);
    await expect(runDelegation({ project: target, executor: "grok", title: "", prompt: "again", continueTask: r.taskId, bin: FAKE, env })).rejects.toThrow(/no follow-up rounds/);
    await expect(runDelegation({ project: os.homedir(), kind: "folder", executor: "grok", title: "x", prompt: "x", bin: FAKE, env })).rejects.toThrow(/home directory/);
  });
});

describe("path attacks", () => {
  it("a runs folder linked outside the home folder, absolute and NUL paths: refused, nothing written outside", async () => {
    const { base, home, project, env } = setup();
    fs.mkdirSync(path.join(project, "docs"));
    fs.writeFileSync(path.join(project, "docs", "a.md"), "# A\n");
    const outside = path.join(base, "outside");
    fs.mkdirSync(outside);
    fs.mkdirSync(home);
    linkDir(outside, path.join(home, "runs"));
    await expect(runDelegation({ project, executor: "agy", title: "x", prompt: "x", bin: FAKE, env })).rejects.toThrow(/escapes the root/);
    expect(fs.readdirSync(outside)).toEqual([]);
    fs.unlinkSync(path.join(home, "runs"));
    for (const target of [path.join(project, "docs", "a.md"), "docs/a.md\0x"])
      await expect(runDelegation({ project, executor: "agy", title: "x", prompt: "x", target, bin: FAKE, env }), target).rejects.toThrow(/target/);
    for (const id of ["a\0b", "..", "a/b", "a\\b"])
      await expect(runDelegation({ project, executor: "agy", title: "", prompt: "x", continueTask: id, bin: FAKE, env }), id).rejects.toThrow(/invalid task id/);
    expect(fs.existsSync(path.join(home, "runs"))).toBe(false);
  });
});
