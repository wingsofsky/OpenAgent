// The person-facing commands, run as a real process against a temporary home folder and project.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { CLI_ENTRY, tempDir } from "@openagent/testkit/paths";

const CLI = CLI_ENTRY;
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));

it("handbook and snapshot work end to end from a project folder; unknown commands exit 2", () => {
  const base = tempDir("openagent-commands-");
  dirs.push(base);
  const project = path.join(base, "project");
  fs.mkdirSync(project);
  const env = { ...process.env, OPENAGENT_HOME: path.join(base, "home") };
  const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { cwd: project, env, encoding: "utf8" });

  expect(run("handbook").stdout).toContain("No handbook yet");
  expect(run("handbook", "init").stdout).toContain("Created");
  expect(fs.existsSync(path.join(base, "home", "handbook.md"))).toBe(true);
  expect(run("handbook", "init").stdout).toContain("nothing was overwritten");

  fs.appendFileSync(path.join(base, "home", "handbook.md"), "\n{++@grok: a new model++}\n");
  expect(run("handbook").stdout).toMatch(/1 suggestion\(s\) waiting/);

  fs.writeFileSync(path.join(project, "d.md"), "one\n");
  expect(run("snapshot", "take", "first").stdout).toMatch(/Snapshot [0-9a-f]{10}/);
  expect(run("snapshot", "take").stdout).toContain("Nothing changed");
  expect(run("snapshot", "list").stdout).toContain("first");
  expect(fs.existsSync(path.join(project, ".git"))).toBe(false);

  for (const unknown of ["nope", "frobnicate"]) expect(run(unknown).status).toBe(2);
}, 30_000);

it("refuses the user's home directory as a project", () => {
  const base = tempDir("openagent-commands-");
  dirs.push(base);
  const r = spawnSync(process.execPath, [CLI, "snapshot", "list", "--project", process.env.HOME ?? process.env.USERPROFILE ?? "/"], {
    env: { ...process.env, OPENAGENT_HOME: path.join(base, "home") },
    encoding: "utf8",
  });
  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(/home directory|filesystem root/);
});
