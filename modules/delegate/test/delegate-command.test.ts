// `openagent delegate` run in this process: options, output, exit codes, defaults in ~/.openagent/executors.json.
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { delegateCommand } from "../src/delegate/command.ts";
import { FAKE_EXECUTOR, tempDir } from "@openagent/testkit/paths";

const FAKE = FAKE_EXECUTOR;
const base = tempDir("openagent-cmd-");
afterAll(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
const home = path.join(base, "home");
const project = path.join(base, "project");
fs.mkdirSync(project);
const VARS = { OPENAGENT_HOME: home, OPENAGENT_SEARCH_PATH: "", OPENAGENT_AGY_BIN: FAKE, OPENAGENT_GROK_BIN: FAKE };

/** Runs `openagent delegate <args>` with the test's environment, capturing what it prints */
async function delegate(args: string[], extra: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  const vars = { ...VARS, ...extra };
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const code = await delegateCommand(args);
    return { code, out: log.mock.calls.flat().join("\n"), err: err.mock.calls.flat().join("\n") };
  } finally {
    log.mockRestore();
    err.mockRestore();
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe("openagent delegate", () => {
  it("usage: --help exits 0; unknown options and bad values exit 2", async () => {
    expect((await delegate(["--help"])).out).toContain("Usage: openagent delegate");
    for (const args of [["--nope"], ["--to"], ["--to", "agy", "--title", "t", "--prompt", "p", "--project", project, "--effort", "max"], ["--to", "agy", "--title", "t", "--prompt", "p", "--project", project, "--work", "elsewhere"], ["--to", "agy", "--title", "t", "--prompt", "p", "--project", project, "--timeout", "-1"], ["--to", "agy", "--title", "t", "--prompt", "p", "--project", project, "--timeout", "0"], ["--to", "agy", "--title", "t", "--prompt", "p", "--project", project, "--retries", "1.5"], ["--to", "agy", "--title", "t", "--prompt", "p", "--project", project, "--stall", "abc"], ["--project", project, "--status", "../x"], ["--to", "agy", "--title", "t\nstatus: done", "--prompt", "p", "--project", project], ["--to", "agy", "--title", "t", "--prompt", "p", "--project", project, "--issuer", "a\nwriteback: handbook"], ["--project", project, "--continue", "../x", "--prompt", "p"], ["--project", project, "--prompt", "p"]]) {
      const r = await delegate(args);
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.err).toMatch(/^openagent delegate: /);
    }
  });

  let taskId = "";
  it("a run prints the answer on stdout and the summary on stderr; a follow-up takes the executor from the task", async () => {
    const r = await delegate(["--project", project, "--to", "agy", "--title", "From the CLI", "--prompt", "say hello"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe("fake answer: say hello");
    expect(r.err).toMatch(/^\[delegate\] done agy round 1 .* outcome no_changes .* task \d{8}-\d{6}-From-the-CLI /);
    taskId = /task (\S+)/.exec(r.err)![1];
    const next = await delegate(["--project", project, "--continue", taskId, "--prompt", "say more", "--json"]);
    expect(next.code).toBe(0);
    const result = JSON.parse(next.out);
    expect(result).toMatchObject({ ok: true, executor: "agy", round: 2, taskId, answer: "fake answer: say more" });
  });

  it("--prompt-file, --work project and a failing executor (exit 1)", async () => {
    const file = path.join(base, "prompt.txt");
    fs.writeFileSync(file, "from a file\n");
    const r = await delegate(["--project", project, "--to", "grok", "--title", "In the project", "--prompt-file", file, "--work", "project", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ answer: "fake answer: from a file", workRoot: project });
    const failed = await delegate(["--project", project, "--to", "grok", "--title", "Fails", "--prompt", "x"], { FAKE_EXEC_FAIL: "1" });
    expect(failed.code).toBe(1);
    expect(failed.err).toContain("[delegate] failed grok round 1");
    const refused = await delegate(["--project", project, "--to", "grok", "--title", "No handbook", "--prompt", "x", "--writeback", "handbook"]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("there is no agent handbook yet");
  });

  it("--status with a task id shows one task; without one lists the project's tasks", async () => {
    const one = await delegate(["--project", project, "--status", taskId]);
    expect(one.code).toBe(0);
    expect(one.out).toMatch(/^status: done {2}outcome: no_changes {2}acceptance: pending/);
    expect(one.out).toContain("record: ");
    const all = await delegate(["--project", project, "--status", "--json"]);
    expect(JSON.parse(all.out).map((t: { taskId: string }) => t.taskId)).toContain(taskId);
    expect((await delegate(["--project", project, "--status", "20990101-000000-none"])).code).toBe(1);
  });

  it("--review records the verdict; a bad verdict is a usage error", async () => {
    expect((await delegate(["--project", project, "--review", taskId, "--verdict", "fine"])).code).toBe(2);
    const r = await delegate(["--project", project, "--review", taskId, "--verdict", "rejected", "--note", "wrong file", "--issuer", "alice"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^acceptance: rejected \(alice, .*\) {2}task /);
  });

  it("--set / --reset change ~/.openagent/executors.json and never a project file; --list shows the defaults", async () => {
    const set = await delegate(["--project", project, "--to", "agy", "--set", "model=gemini-x", "--set", "timeoutMs=1000"]);
    expect(set.code).toBe(0);
    expect(set.out).toContain("agy defaults: model=gemini-x timeoutMs=1000");
    expect(JSON.parse(fs.readFileSync(path.join(home, "executors.json"), "utf8"))).toEqual({ agy: { model: "gemini-x", timeoutMs: 1000 } });
    expect((await delegate(["--project", project, "--to", "agy", "--set", "model=project-x", "--scope", "project"])).code).toBe(2);
    expect(fs.existsSync(path.join(project, ".openagent"))).toBe(false);
    const list = await delegate(["--project", project, "--list", "--json"]);
    const agy = JSON.parse(list.out).find((r: { name: string }) => r.name === "agy");
    expect(agy).toMatchObject({ bin: FAKE, defaults: { model: "gemini-x" }, configured: true });
    expect((await delegate(["--project", project, "--to", "agy", "--set", "workRoot=/x"])).code).toBe(2);
    expect((await delegate(["--project", project, "--to", "agy", "--set", "model"])).code).toBe(2);
    for (const bad of ["autoApprove=yes", "timeoutMs=abc", "timeoutMs=0", "timeoutMs=3000000000", "stallMs=-1", "retries=9", "effort=max"]) expect((await delegate(["--project", project, "--to", "agy", "--set", bad])).code, bad).toBe(2);
    expect((await delegate(["--project", project, "--to", "agy", "--set", "autoApprove=false"])).out).toContain("autoApprove=false");
    expect((await delegate(["--project", project, "--to", "agy", "--reset"])).code).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(home, "executors.json"), "utf8"))).toEqual({});
    const text = await delegate(["--project", project, "--list"]);
    expect(text.out).toMatch(/agy {6}available {2}/);
  });
});
