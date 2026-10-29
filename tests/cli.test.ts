import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { describe, expect, it } from "vitest";

const CLI = "packages/cli/src/cli.ts";
const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });

describe("longkeep entry", () => {
  it("prints the package version", () => {
    const version = JSON.parse(fs.readFileSync("packages/cli/package.json", "utf8")).version;
    const r = run("--version");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(version);
  });

  it("prints usage with no arguments", () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Usage: longkeep <command>");
  });

  it("rejects an unknown command with exit code 2", () => {
    const r = run("nope");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('unknown command "nope"');
  });
});
