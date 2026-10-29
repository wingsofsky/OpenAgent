import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureHome, existingHome, homePath, projectKey, resolveProject } from "../src/home.ts";
import { tempDir } from "@longkeep/testkit/paths";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));

function setup() {
  const base = tempDir("longkeep-home-");
  dirs.push(base);
  const env = { ...process.env, LONGKEEP_HOME: path.join(base, "home") };
  const project = path.join(base, "project");
  fs.mkdirSync(project);
  return { base, env, project };
}

describe("home folder", () => {
  it("defaults to ~/.longkeep and follows LONGKEEP_HOME", () => {
    expect(homePath({})).toBe(path.join(os.homedir(), ".longkeep"));
    const { env, base } = setup();
    expect(homePath(env)).toBe(path.join(base, "home"));
  });

  it("is created on demand, never by read-only callers", () => {
    const { env } = setup();
    expect(existingHome(env)).toBeNull();
    expect(fs.existsSync(homePath(env))).toBe(false);
    const home = ensureHome(env);
    expect(existingHome(env)).toBe(home);
  });
});

describe("projects", () => {
  it("accepts an ordinary folder and returns its canonical path", () => {
    const { env, project } = setup();
    expect(resolveProject(project, env)).toBe(fs.realpathSync.native(project));
  });

  it("refuses the filesystem root, the user's home directory, and the Longkeep home folder", () => {
    const { env, base } = setup();
    const home = ensureHome(env);
    expect(() => resolveProject(path.parse(base).root, env)).toThrow(/filesystem root/);
    expect(() => resolveProject(os.homedir(), env)).toThrow(/home directory/);
    expect(() => resolveProject(home, env)).toThrow(/Longkeep home folder cannot be a project/);
    fs.mkdirSync(path.join(home, "runs"));
    expect(() => resolveProject(path.join(home, "runs"), env)).toThrow(/Longkeep home folder cannot be a project/);
    expect(() => resolveProject(base, env)).toThrow(/cannot contain the Longkeep home folder/);
  });

  it("keys are readable, stable, and differ for same-named folders", () => {
    const { base } = setup();
    const a = path.join(base, "x", "My Project");
    const b = path.join(base, "y", "My Project");
    expect(projectKey(a)).toMatch(/^My-Project-[0-9a-f]{8}$/);
    expect(projectKey(a)).toBe(projectKey(a));
    expect(projectKey(a)).not.toBe(projectKey(b));
    expect(projectKey(path.join(base, "..."))).toMatch(/^project-[0-9a-f]{8}$/);
  });
});
