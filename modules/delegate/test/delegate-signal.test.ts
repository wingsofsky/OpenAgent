// Ctrl+C on `openagent delegate` stops the executor too. On macOS and Linux the executor runs in its own process
// group, so without the handler it would outlive the command. Windows has no SIGINT to send to another process.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { CLI_ENTRY, FAKE_EXECUTOR, tempDir } from "@openagent/testkit/paths";

const CLI = CLI_ENTRY;
const FAKE = FAKE_EXECUTOR;
const base = tempDir("openagent-signal-");
afterAll(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

it.skipIf(process.platform === "win32")("SIGINT stops the executor and records the round as stopped", async () => {
  const project = path.join(base, "project");
  fs.mkdirSync(project);
  const child = spawn(process.execPath, [CLI, "delegate", "--to", "grok", "--project", project, "--work", "project", "--title", "Long run", "--prompt", "wait", "--retries", "0"], {
    env: { ...process.env, OPENAGENT_HOME: path.join(base, "home"), OPENAGENT_SEARCH_PATH: "", OPENAGENT_GROK_BIN: FAKE, FAKE_EXEC_SLEEP_MS: "4000", FAKE_EXEC_WRITE: "late.txt" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  await new Promise((r) => setTimeout(r, 1500));
  child.kill("SIGINT");
  const code = await new Promise<number | null>((r) => child.on("exit", r));
  expect(code).toBe(1);
  expect(err).toMatch(/outcome stopped/);
  // The fake executor writes late.txt after its sleep; if it had survived, the file would appear
  await new Promise((r) => setTimeout(r, 4000));
  expect(fs.existsSync(path.join(project, "late.txt"))).toBe(false);
}, 30_000);
