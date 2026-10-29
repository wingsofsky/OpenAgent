#!/usr/bin/env node
// Clean install of each module on its own, the way INSTALL.md does it: a sparse clone with only the module's paths,
// `pnpm install --prod`, then its commands run for real against a temporary home folder. With --tests it also adds the
// test helpers, installs the development tools and runs the module's own tests in that clone.
//
// It clones the files of the current working tree (tracked files, committed or not), so it checks what would be published.
// Usage: node scripts/check-module-install.mjs [--tests] [module …]
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const withTests = args.includes("--tests");
const manifest = (root, name) => JSON.parse(fs.readFileSync(path.join(root, "modules", name, "module.json"), "utf8"));
const all = fs.readdirSync(path.join(REPO, "modules")).filter((n) => fs.existsSync(path.join(REPO, "modules", n, "module.json")));
const chosen = args.filter((a) => !a.startsWith("--"));
for (const name of chosen) if (!all.includes(name)) throw new Error(`unknown module: ${name}`);

const WIN = process.platform === "win32";
const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
/** pnpm is a .cmd shim on Windows, which only a shell can start; the arguments here are fixed words. */
function pnpm(cwd, ...a) {
  const r = WIN
    ? spawnSync(`pnpm ${a.join(" ")}`, { cwd, encoding: "utf8", shell: true, stdio: ["ignore", "pipe", "pipe"] })
    : spawnSync("pnpm", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (r.status !== 0) throw new Error(`pnpm ${a.join(" ")} failed in ${cwd}:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "longkeep-install-"));

// The tracked files of the working tree as a commit, built in a temporary index (the refs, index and files of this
// checkout are left alone), pushed to a scratch bare repository that the clones come from.
function workingTreeCommit() {
  const env = { ...process.env, GIT_INDEX_FILE: path.join(tmp, "index") };
  const files = git(REPO, "ls-files", "-z", "--cached").split("\0").filter((f) => f && fs.existsSync(path.join(REPO, f)));
  const r = spawnSync("git", ["update-index", "--add", "-z", "--stdin"], { cwd: REPO, env, input: files.join("\0") + "\0", encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git update-index: ${r.stderr}`);
  const tree = execFileSync("git", ["write-tree"], { cwd: REPO, env, encoding: "utf8" }).trim();
  return git(REPO, "-c", "user.name=check", "-c", "user.email=check@example.invalid", "commit-tree", tree, "-m", "module install check");
}
const rev = workingTreeCommit();
const source = path.join(tmp, "source.git");
git(tmp, "init", "-q", "--bare", source);
git(REPO, "push", "-q", source, `${rev}:refs/heads/main`);

/** Every module this one needs, itself included. */
const closure = (name) => [name, ...manifest(REPO, name).requires.flatMap(closure)];

/** A sparse clone with the module's paths, plus `extra` paths (the test helpers for a development checkout). */
function cloneModule(name, folder = name, extra = []) {
  const dir = path.join(tmp, folder);
  git(tmp, "clone", "-q", "--no-checkout", "--filter=blob:none", `file://${source.replaceAll("\\", "/")}`, dir);
  git(dir, "sparse-checkout", "set", "--cone", ...manifest(REPO, name).paths, ...extra);
  git(dir, "checkout", "-q", "main");
  return dir;
}

function cli(dir, env, ...a) {
  const r = spawnSync(process.execPath, [path.join(dir, "packages/cli/src/cli.ts"), ...a], { cwd: dir, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
function expectOk(r, what) {
  if (r.code !== 0) throw new Error(`${what} exited ${r.code}:\n${r.out}\n${r.err}`);
  return r;
}
const check = (ok, what) => {
  if (!ok) throw new Error(what);
};

/** A fresh home folder, user home and git project for one module's checks. */
function sandbox(name) {
  const base = fs.mkdtempSync(path.join(tmp, `${name}-run-`));
  const home = path.join(base, "user");
  const project = path.join(base, "project");
  fs.mkdirSync(home);
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "README.md"), "# demo\n");
  git(project, "init", "-q");
  git(project, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "add", "README.md");
  git(project, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init");
  const env = { ...process.env, HOME: home, USERPROFILE: home, LONGKEEP_HOME: path.join(base, "longkeep-home") };
  for (const k of Object.keys(env)) if (k.startsWith("LONGKEEP_") && k !== "LONGKEEP_HOME") delete env[k];
  return { home, project, env, longkeepHome: env.LONGKEEP_HOME };
}

/** An executor that answers "pong" without being an agent, declared in the home folder like any custom executor. */
function echoExecutor(longkeepHome) {
  fs.mkdirSync(longkeepHome, { recursive: true });
  const executors = { echo: { label: "Echo", command: process.execPath, args: ["-e", "process.stdout.write('pong')"], answer: "stdout" } };
  fs.writeFileSync(path.join(longkeepHome, "executors.json"), JSON.stringify(executors, null, 2));
}

const SMOKE = {
  context(dir) {
    for (const lang of ["en", "zh-CN"]) check(fs.existsSync(path.join(dir, "modules/context", lang, "longkeep-context/SKILL.md")), `${lang} skill missing`);
    check(!fs.existsSync(path.join(dir, "packages")), "a module without code downloaded packages/");
  },
  sessions(dir) {
    const s = sandbox("sessions");
    const sessions = path.join(s.home, ".codex", "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    const recs = [
      { type: "session_meta", timestamp: "2026-10-01T08:00:00Z", payload: { id: "11111111-2222-3333-4444-555555555555", cwd: s.project } },
      { type: "response_item", timestamp: "2026-10-01T08:01:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Plan the demo" }] } },
      { type: "response_item", timestamp: "2026-10-01T08:02:00Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Here is a plan." }] } },
    ];
    fs.writeFileSync(path.join(sessions, "rollout-demo.jsonl"), recs.map((r) => JSON.stringify(r)).join("\n"));
    expectOk(cli(dir, s.env, "import-sessions", "--project", s.project), "import-sessions");
    const archived = fs.readdirSync(path.join(s.longkeepHome, "sessions", "imported"), { recursive: true }).map(String);
    check(archived.some((f) => f.endsWith(".md") && !f.endsWith("index.md")), `no archive written: ${archived.join(", ")}`);
  },
  delegate(dir) {
    const s = sandbox("delegate");
    echoExecutor(s.longkeepHome);
    expectOk(cli(dir, s.env, "delegate", "--list"), "delegate --list");
    expectOk(cli(dir, s.env, "handbook", "init"), "handbook init");
    check(fs.existsSync(path.join(s.longkeepHome, "handbook.md")), "handbook not created");
    const r = expectOk(cli(dir, s.env, "delegate", "--to", "echo", "--title", "Install check", "--prompt", "Say pong", "--project", s.project), "delegate");
    check(r.out.includes("pong"), `delegate answered: ${r.out}`);
    expectOk(cli(dir, s.env, "snapshot", "take", "check", "--project", s.project), "snapshot take");
  },
  folder(dir) {
    const s = sandbox("folder");
    echoExecutor(s.longkeepHome);
    expectOk(cli(dir, s.env, "folder", "--brief"), "folder --brief");
    const brief = path.join(s.longkeepHome, "folder", "brief");
    for (const f of ["task.md", "rules.md"]) {
      const file = path.join(brief, f);
      fs.writeFileSync(file, fs.readFileSync(file, "utf8").split("\n").slice(1).join("\n"));
    }
    expectOk(cli(dir, s.env, "folder", s.project, "--executor", "echo"), "folder task");
  },
};

const results = [];
try {
  for (const name of chosen.length ? chosen : all) {
    const dir = cloneModule(name);
    const m = manifest(dir, name);
    const expectedModules = [...new Set(closure(name))].sort();
    const present = fs.readdirSync(path.join(dir, "modules")).sort();
    check(JSON.stringify(present) === JSON.stringify(expectedModules), `${name}: modules present ${present} , expected ${expectedModules}`);
    if (Object.keys(m.commands).length) {
      pnpm(dir, "install", "--prod", "--frozen-lockfile", "--prefer-offline");
      const help = expectOk(cli(dir, process.env, "--help"), "--help").out;
      const listed = [...help.matchAll(/^ {2}([a-z][a-z-]*) {2,}\S/gm)].map((x) => x[1]).sort();
      const expected = expectedModules.flatMap((n) => Object.keys(manifest(dir, n).commands)).sort();
      check(JSON.stringify(listed) === JSON.stringify(expected), `${name}: --help lists ${listed}, expected ${expected}`);
    }
    SMOKE[name]?.(dir);
    let tests = "";
    if (withTests && fs.existsSync(path.join(dir, "modules", name, "test"))) {
      const dev = cloneModule(name, `${name}-dev`, ["packages/testkit"]);
      pnpm(dev, "install", "--frozen-lockfile", "--prefer-offline");
      const out = pnpm(dev, "exec", "vitest", "run", `modules/${name}`);
      tests = out.match(/Tests\s+[^\n]+/)?.[0] ?? "";
    }
    results.push(`${name}: ok${tests ? ` (${tests.replace(/\s+/g, " ")})` : ""}`);
    console.log(results.at(-1));
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
