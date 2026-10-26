// A working folder past the Windows path length limit makes spawn fail, and the pipes then emit ENOTCONN.
// The command must record the round as spawn_failed instead of crashing.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { CLI_ENTRY, FAKE_EXECUTOR, tempDir } from "@openagent/testkit/paths";

const CLI = CLI_ENTRY;
const FAKE = FAKE_EXECUTOR;
const base = tempDir("openagent-long-");
afterAll(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

it.skipIf(process.platform !== "win32")("a scratch folder past the path length limit is recorded as spawn_failed", () => {
  let home = path.join(base, "home");
  while (home.length < 250) home = path.join(home, "abcdefghijklmnopqrstuvwxyz");
  const project = path.join(base, "project");
  fs.mkdirSync(project);
  const r = spawnSync(process.execPath, [CLI, "delegate", "--to", "grok", "--project", project, "--title", "Long path", "--prompt", "hi", "--retries", "0"], {
    env: { ...process.env, OPENAGENT_HOME: home, OPENAGENT_SEARCH_PATH: "", OPENAGENT_GROK_BIN: FAKE },
    encoding: "utf8",
  });
  expect(r.stderr).not.toMatch(/ENOTCONN/);
  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(/outcome spawn_failed/);
  expect(r.stderr).toMatch(/Windows cannot start a process in a folder whose path is 260 or longer/);
}, 30_000);
