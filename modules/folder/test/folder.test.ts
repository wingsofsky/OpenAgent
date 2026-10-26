// Folder tasks: the draft brief guard, broad folders, snapshots before the run, records outside the folder, "only new
// repositories" as one run per repository, the folder lock, and yielding to the IDE.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DRAFT_MARKER } from "@openagent/protocol/folder-brief";
import { ensureBrief, pendingProjects, runFolderTask } from "../src/folder.ts";
import { projectKey } from "@openagent/common/home";
import { openSnapshots } from "@openagent/delegate/snapshots";
import { FAKE_EXECUTOR, tempDir } from "@openagent/testkit/paths";

const FAKE = FAKE_EXECUTOR;
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));

function setup() {
  const base = tempDir("openagent-folder-");
  dirs.push(base);
  const folder = path.join(base, "work");
  fs.mkdirSync(folder);
  const env = { ...process.env, OPENAGENT_HOME: path.join(base, "home"), OPENAGENT_SEARCH_PATH: "", OPENAGENT_GROK_BIN: FAKE };
  return { base, folder, env };
}

/** Edits the draft brief the way a person would: adapt it and delete the marker line. */
function editBrief(env: NodeJS.ProcessEnv): void {
  const dir = ensureBrief(env);
  for (const name of ["task.md", "rules.md"]) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(`${DRAFT_MARKER}\n`, ""));
  }
}

describe("folder tasks", () => {
  it("refuse to run a draft brief, and create the draft on first use", async () => {
    const { folder, env } = setup();
    await expect(runFolderTask({ folder, executor: "grok", env })).rejects.toThrow(/default draft/);
    expect(fs.readFileSync(path.join(env.OPENAGENT_HOME, "folder", "brief", "task.md"), "utf8").startsWith(DRAFT_MARKER)).toBe(true);
    expect(fs.readdirSync(folder)).toEqual([]);
  });

  it("refuse the user's home directory and the filesystem root", async () => {
    const { env } = setup();
    editBrief(env);
    await expect(runFolderTask({ folder: os.homedir(), executor: "grok", env })).rejects.toThrow(/home directory/);
    await expect(runFolderTask({ folder: path.parse(os.tmpdir()).root, executor: "grok", env })).rejects.toThrow(/filesystem root/);
  });

  it("snapshot the folder first, keep records in the home folder, and leave only the agent's changes", async () => {
    const { folder, env } = setup();
    editBrief(env);
    fs.writeFileSync(path.join(folder, "existing.md"), "keep\n");
    const result = await runFolderTask({ folder, executor: "grok", env: { ...env, FAKE_EXEC_WRITE: "made-by-agent.txt" } });
    expect(result?.ok).toBe(true);
    expect(result!.runs.map((r) => r.project)).toEqual(["."]);
    const r = result!.runs[0].result!;
    expect(r.outcome).toBe("changed");
    expect(fs.readdirSync(folder).sort()).toEqual(["existing.md", "made-by-agent.txt"]);
    expect(r.recordDir.startsWith(fs.realpathSync(path.join(env.OPENAGENT_HOME, "runs")))).toBe(true);
    const snaps = await (await openSnapshots(fs.realpathSync(folder), env)).list();
    expect(snaps.length).toBeGreaterThan(0);
    const run = JSON.parse(fs.readFileSync(r.runFile, "utf8"));
    expect(run.plan.channel).toBe("folder");
    expect(run.rounds[0].snapshot).toBeTruthy();
  }, 30_000);

  it("--new-projects runs each repository not done before on its own, in turn, and starts nothing when none are left", async () => {
    const { folder, env } = setup();
    editBrief(env);
    for (const name of ["alpha", "beta"]) {
      fs.mkdirSync(path.join(folder, name));
      execFileSync("git", ["init", "-q", path.join(folder, name)]);
      fs.writeFileSync(path.join(folder, name, "README.md"), `# ${name}\n`);
    }
    fs.mkdirSync(path.join(folder, "plain"));
    expect(pendingProjects(fs.realpathSync(folder), env).map((p) => p.rel)).toEqual(["alpha", "beta"]);
    const first = await runFolderTask({ folder, executor: "grok", newProjects: true, env });
    expect(first?.ok).toBe(true);
    expect(first!.runs.map((r) => r.project)).toEqual(["alpha", "beta"]);
    const real = fs.realpathSync(folder);
    const runsDir = fs.realpathSync(path.join(env.OPENAGENT_HOME, "runs", projectKey(real)));
    for (const [i, name] of ["alpha", "beta"].entries()) {
      const r = first!.runs[i].result!;
      expect(r.workRoot).toBe(path.join(real, name));
      expect(path.dirname(r.recordDir)).toBe(runsDir);
      expect(fs.readFileSync(r.taskFile, "utf8")).toContain(`Only this repository, which is your working folder: "${name}"`);
      expect(JSON.parse(fs.readFileSync(r.runFile, "utf8")).rounds[0].snapshot).toBeTruthy();
    }
    expect(fs.readdirSync(path.join(real, "plain"))).toEqual([]);
    expect(pendingProjects(real, env)).toEqual([]);
    expect(fs.existsSync(path.join(runsDir, "folder.lock"))).toBe(false);
    expect(await runFolderTask({ folder, executor: "grok", newProjects: true, env })).toBeNull();
  }, 30_000);

  it("an executor that cannot start fails over to the configured fallback", async () => {
    const { folder, env } = setup();
    editBrief(env);
    fs.writeFileSync(path.join(env.OPENAGENT_HOME, "executors.json"), JSON.stringify({ cursor: { bin: path.join(folder, "missing-cli"), fallback: [{ executor: "grok" }] } }));
    const states: string[] = [];
    const result = await runFolderTask({ folder, executor: "cursor", env, fallbackDelayMs: 0, onState: (m) => states.push(m) });
    expect(result?.ok).toBe(true);
    expect(result!.runs[0].result?.executor).toBe("grok");
    expect(states.join("\n")).toMatch(/Switching to grok/);
  }, 30_000);

  it("one folder task per folder: a second one is refused while the first runs; a lock whose process is gone is reclaimed", async () => {
    const { folder, env } = setup();
    editBrief(env);
    const slow = runFolderTask({ folder, executor: "grok", env: { ...env, FAKE_EXEC_SLEEP_MS: "1500" } });
    const lock = path.join(env.OPENAGENT_HOME, "runs", projectKey(fs.realpathSync(folder)), "folder.lock");
    for (let i = 0; i < 100 && !fs.existsSync(lock); i++) await new Promise((r) => setTimeout(r, 20));
    await expect(runFolderTask({ folder, executor: "grok", env })).rejects.toThrow(/already running on this folder/);
    expect((await slow)?.ok).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
    fs.writeFileSync(lock, `folder task on ${folder} since 2026-10-01 10:00\npid: 2147483646\nhost: ${os.hostname()}\n`);
    expect((await runFolderTask({ folder, executor: "grok", env }))?.ok).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
  }, 30_000);

  it("yieldToIde: an open repository waits, a running one is stopped and resumed later as a new run after the pause", async () => {
    const { folder, env } = setup();
    editBrief(env);
    for (const name of ["alpha", "beta"]) {
      fs.mkdirSync(path.join(folder, name));
      execFileSync("git", ["init", "-q", path.join(folder, name)]);
      fs.writeFileSync(path.join(folder, name, "code.txt"), "old\n");
    }
    fs.writeFileSync(path.join(env.OPENAGENT_HOME, "executors.json"), JSON.stringify({ grok: { yieldToIde: true } }));
    const real = fs.realpathSync(folder);
    const alpha = path.join(real, "alpha");
    let open = false;
    const states: string[] = [];
    const asked: string[][] = [];
    const result = await runFolderTask({
      folder,
      executor: "grok",
      newProjects: true,
      env: { ...env, FAKE_EXEC_SLEEP_MS: "800" },
      ideIntervalMs: 20,
      observeIde: async (candidates) => {
        asked.push(candidates);
        return { state: "ready", projects: open ? [alpha] : [] };
      },
      onState: (m) => {
        states.push(m);
        if (m === "Working on: alpha") open = true; // the person opens alpha in the IDE right after it starts
        if (m === "Working on: beta") open = false;
      },
    });
    expect(result?.ok).toBe(true);
    expect(result!.runs.map((r) => r.project)).toEqual(["beta", "alpha"]);
    // The IDE is asked about the repositories, never about the folder around them
    expect(asked[0]).toEqual([alpha, path.join(real, "beta")]);
    expect(asked.flat().every((c) => c === alpha || c === path.join(real, "beta"))).toBe(true);
    expect(states.join("\n")).toContain("Yielding alpha to the IDE");
    expect(states.join("\n")).toContain("Resuming alpha with grok.");
    const resumed = fs.readFileSync(result!.runs[1].result!.taskFile, "utf8");
    expect(resumed).toContain("## A new run after yielding to the IDE");
    expect(resumed).toMatch(/Transcript before the pause \(reference only, not the current state\): ".+transcript\.md"/);
    expect(resumed).toContain("check the git status first");
    const records = fs.readdirSync(path.join(env.OPENAGENT_HOME, "runs", projectKey(real)), { withFileTypes: true }).filter((d) => d.isDirectory());
    expect(records).toHaveLength(3);
    expect(pendingProjects(real, env)).toEqual([]);
  }, 30_000);

  it("a repository that fails is reported and the queue goes on with the next one", async () => {
    const { folder, env } = setup();
    editBrief(env);
    for (const name of ["alpha", "beta", "gamma"]) {
      fs.mkdirSync(path.join(folder, name));
      execFileSync("git", ["init", "-q", path.join(folder, name)]);
      fs.writeFileSync(path.join(folder, name, "README.md"), `# ${name}\n`);
    }
    const task = path.join(ensureBrief(env), "task.md");
    const good = fs.readFileSync(task, "utf8");
    const result = await runFolderTask({
      folder,
      executor: "grok",
      newProjects: true,
      env,
      onState: (m) => {
        // beta finds a broken brief, gamma a good one again
        if (m === "Working on: beta") fs.writeFileSync(task, `${DRAFT_MARKER}\n${good}`);
        if (m === "Working on: gamma") fs.writeFileSync(task, good);
      },
    });
    expect(result?.ok).toBe(false);
    expect(result!.runs.map((r) => [r.project, r.ok])).toEqual([["alpha", true], ["beta", false], ["gamma", true]]);
    expect(result!.runs[1].error).toMatch(/still the default draft/);
    expect(pendingProjects(fs.realpathSync(folder), env).map((p) => p.rel)).toEqual(["beta"]);
  }, 30_000);

  it("yieldToIde says once when the folder is too large to look through completely for open projects", async () => {
    const { folder, env } = setup();
    editBrief(env);
    fs.writeFileSync(path.join(env.OPENAGENT_HOME, "executors.json"), JSON.stringify({ grok: { yieldToIde: true } }));
    const states: string[] = [];
    const result = await runFolderTask({
      folder,
      executor: "grok",
      env: { ...env, FAKE_EXEC_SLEEP_MS: "300" },
      ideIntervalMs: 20,
      observeIde: async (candidates) => ({ state: "ready", projects: [], partial: candidates }),
      onState: (m) => states.push(m),
    });
    expect(result?.ok).toBe(true);
    expect(states.filter((m) => m.includes("too large to look through"))).toEqual([
      "The folder is too large to look through completely for projects open in the IDE; one opened deep inside it is not noticed.",
    ]);
  }, 30_000);

  it("a repository whose snapshot fails, or whose executor cannot start, is reported and the queue goes on", async () => {
    const { folder, env } = setup();
    editBrief(env);
    for (const name of ["alpha", "beta"]) {
      fs.mkdirSync(path.join(folder, name));
      execFileSync("git", ["init", "-q", path.join(folder, name)]);
      fs.writeFileSync(path.join(folder, name, "README.md"), `# ${name}\n`);
    }
    const real = fs.realpathSync(folder);
    // An executor that cannot start, with no fallback: every repository is tried and reported, none is marked done
    fs.writeFileSync(path.join(env.OPENAGENT_HOME, "executors.json"), JSON.stringify({ cursor: { bin: path.join(real, "missing-cli") } }));
    const cannotStart = await runFolderTask({ folder, executor: "cursor", newProjects: true, env, fallbackDelayMs: 0 });
    expect(cannotStart!.runs.map((r) => [r.project, r.ok])).toEqual([["alpha", false], ["beta", false]]);
    expect(cannotStart!.runs.every((r) => /could start/.test(r.error ?? ""))).toBe(true);
    expect(pendingProjects(real, env).map((p) => p.rel)).toEqual(["alpha", "beta"]);
    // A file where alpha's snapshot repository belongs: its snapshot fails, beta still runs
    const shadow = path.join(env.OPENAGENT_HOME, "snapshots", projectKey(path.join(real, "alpha")));
    fs.rmSync(shadow, { recursive: true, force: true });
    fs.writeFileSync(shadow, "");
    const snapshotFails = await runFolderTask({ folder, executor: "grok", newProjects: true, env });
    expect(snapshotFails!.runs.map((r) => [r.project, r.ok])).toEqual([["alpha", false], ["beta", true]]);
    expect(snapshotFails!.runs[0].error).toMatch(/could not snapshot/);
    expect(pendingProjects(real, env).map((p) => p.rel)).toEqual(["alpha"]);
  }, 30_000);

  it("refuses a fallback that names an executor that does not exist, before anything starts", async () => {
    const { folder, env } = setup();
    editBrief(env);
    fs.writeFileSync(path.join(env.OPENAGENT_HOME, "executors.json"), JSON.stringify({ grok: { fallback: [{ executor: "nobody" }] } }));
    await expect(runFolderTask({ folder, executor: "grok", env })).rejects.toThrow(/fallback of grok .* do not exist: nobody/);
    expect(fs.existsSync(path.join(env.OPENAGENT_HOME, "runs"))).toBe(false);
  });

  it("a run that yields while waiting for its fallback resumes with the fallback, which gets its effort", async () => {
    const { folder, env } = setup();
    editBrief(env);
    for (const name of ["alpha", "beta"]) {
      fs.mkdirSync(path.join(folder, name));
      execFileSync("git", ["init", "-q", path.join(folder, name)]);
      fs.writeFileSync(path.join(folder, name, "README.md"), `# ${name}\n`);
    }
    fs.writeFileSync(
      path.join(env.OPENAGENT_HOME, "executors.json"),
      JSON.stringify({ cursor: { bin: path.join(folder, "missing-cli"), yieldToIde: true, fallback: [{ executor: "grok", effort: "high" }] } }),
    );
    const alpha = path.join(fs.realpathSync(folder), "alpha");
    let open = false;
    let opened = false;
    const states: string[] = [];
    const result = await runFolderTask({
      folder,
      executor: "cursor",
      newProjects: true,
      env,
      fallbackDelayMs: 400,
      ideIntervalMs: 20,
      observeIde: async () => ({ state: "ready", projects: open ? [alpha] : [] }),
      onState: (m) => {
        states.push(m);
        // alpha's cursor never starts; while OpenAgent waits to switch to grok, the person opens alpha
        if (m.includes("could not create a process") && !opened) open = opened = true;
        if (m === "Working on: beta") open = false;
      },
    });
    expect(result?.ok).toBe(true);
    expect(result!.runs.map((r) => [r.project, r.result?.executor])).toEqual([["beta", "grok"], ["alpha", "grok"]]);
    expect(states.join("\n")).toContain("Resuming alpha with grok.");
    // cursor was given up on twice (alpha's first try and beta), never a third time for alpha's resume
    expect(states.filter((m) => m.includes("could not create a process"))).toHaveLength(2);
    const run = JSON.parse(fs.readFileSync(result!.runs[1].result!.runFile, "utf8"));
    expect(JSON.stringify(run)).toContain("--reasoning-effort high");
  }, 30_000);
});
