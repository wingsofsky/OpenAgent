import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initShadow, openSnapshots, Snapshots } from "../src/snapshots/shadow.ts";
import { assertSafeRestore, isSensitivePath } from "../src/snapshots/sensitive-paths.ts";
import cases from "./fixtures/sensitive-paths.json" with { type: "json" };
import { FILE_SYMLINK_SKIP, linkDir, linkFile } from "@openagent/testkit/links";
import { tempDir } from "@openagent/testkit/paths";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));

function setup() {
  const base = tempDir("openagent-snap-");
  dirs.push(base);
  const project = path.join(base, "project");
  const gitDir = path.join(base, "shadow");
  fs.mkdirSync(project);
  const git = (...args: string[]) => execFileSync("git", ["--git-dir", gitDir, "--work-tree", project, ...args], { encoding: "utf8" });
  return { base, project, gitDir, git };
}

describe("sensitive paths", () => {
  it.each(cases)("$path → $sensitive", ({ path: rel, sensitive }) => {
    expect(isSensitivePath(rel)).toBe(sensitive);
  });

  it("restoring through a linked folder or file alias is refused, and creates nothing", ({ annotate }) => {
    const { project } = setup();
    fs.mkdirSync(path.join(project, ".aws"));
    fs.writeFileSync(path.join(project, ".aws", "credentials"), "SYNTHETIC");
    linkDir(path.join(project, ".aws"), path.join(project, "alias"));
    const fileAlias = linkFile(path.join(project, ".aws", "credentials"), path.join(project, "ordinary.txt"));
    if (!fileAlias) void annotate(FILE_SYMLINK_SKIP, "skip");
    for (const rel of ["alias/credentials", ...(fileAlias ? ["ordinary.txt"] : []), "missing/.env", "../outside", "bad\0path"]) {
      expect(() => assertSafeRestore(project, rel), rel).toThrow();
    }
    expect(fs.existsSync(path.join(project, "missing"))).toBe(false);
    expect(() => assertSafeRestore(project, "new/document.md")).not.toThrow();
    expect(fs.existsSync(path.join(project, "new"))).toBe(false);
  });

  it("restoring into .git, directly or through a linked folder, is refused", () => {
    const { project } = setup();
    fs.mkdirSync(path.join(project, ".git", "hooks"), { recursive: true });
    linkDir(path.join(project, ".git", "hooks"), path.join(project, "hooks"));
    for (const rel of ["hooks/pre-commit", ".git/config", ".git/hooks/new-hook"]) {
      expect(() => assertSafeRestore(project, rel), rel).toThrow(/version-control metadata/);
    }
    expect(fs.existsSync(path.join(project, ".git", "hooks", "pre-commit"))).toBe(false);
  });
});

describe("snapshots", () => {
  it("live in the home folder under the project key; snapshot, list, changes, diff", async () => {
    const { base, project } = setup();
    const env = { ...process.env, OPENAGENT_HOME: path.join(base, "home") };
    fs.writeFileSync(path.join(project, "a.md"), "one\n");
    const snaps = await openSnapshots(project, env);
    expect(path.relative(path.join(base, "home"), snaps.gitDir).split(path.sep)[0]).toBe("snapshots");
    const first = await snaps.snapshot("first");
    expect(first?.label).toBe("first");
    expect(await snaps.snapshot("nothing changed")).toBeNull();
    fs.writeFileSync(path.join(project, "a.md"), "two\n");
    fs.writeFileSync(path.join(project, "b.md"), "new\n");
    expect(await snaps.diffSince(first!.id, "a.md")).toContain("+two");
    const second = await snaps.snapshot("second");
    expect(await snaps.changes(second!.id)).toEqual([
      { path: "a.md", status: "modified" },
      { path: "b.md", status: "added" },
    ]);
    expect((await snaps.list()).map((s) => s.label)).toEqual(["second", "first"]);
    expect(fs.existsSync(path.join(project, ".git"))).toBe(false);
  }, 30_000);

  it("refuses ids that are not snapshot ids", async () => {
    const { project, gitDir } = setup();
    await initShadow(gitDir, project);
    const snaps = new Snapshots(gitDir, project);
    await expect(snaps.diffSince("--output=/tmp/x")).rejects.toMatchObject({ status: 400 });
    await expect(snaps.changes("deadbeef")).rejects.toMatchObject({ status: 404 });
  });

  it("restores one file or the whole project, with a safety snapshot first", async () => {
    const { project, gitDir } = setup();
    await initShadow(gitDir, project);
    const snaps = new Snapshots(gitDir, project);
    fs.writeFileSync(path.join(project, "a.md"), "original\n");
    const base = await snaps.snapshot("base");
    fs.writeFileSync(path.join(project, "a.md"), "agent edit\n");
    fs.writeFileSync(path.join(project, "added-by-agent.md"), "x\n");
    const safety = await snaps.restoreFile(base!.id, "a.md");
    expect(safety?.label).toBe("before restoring a file");
    expect(fs.readFileSync(path.join(project, "a.md"), "utf8")).toBe("original\n");
    await snaps.restore(base!.id);
    expect(fs.existsSync(path.join(project, "added-by-agent.md"))).toBe(false);
    expect(fs.readFileSync(path.join(project, "a.md"), "utf8")).toBe("original\n");
    await expect(snaps.restoreFile(base!.id, "never-there.md")).rejects.toMatchObject({ status: 404 });
  }, 30_000);

  it("restores nothing when the safety snapshot cannot be taken", async () => {
    const { project, gitDir } = setup();
    await initShadow(gitDir, project);
    const snaps = new Snapshots(gitDir, project);
    fs.writeFileSync(path.join(project, "a.md"), "original\n");
    const base = await snaps.snapshot("base");
    fs.writeFileSync(path.join(project, "a.md"), "agent edit\n");
    fs.writeFileSync(path.join(project, "added-by-agent.md"), "x\n");
    // A held index lock makes every snapshot attempt fail
    fs.writeFileSync(path.join(gitDir, "index.lock"), "");
    await expect(snaps.restoreFile(base!.id, "a.md")).rejects.toThrow(/safety snapshot/);
    await expect(snaps.restore(base!.id)).rejects.toThrow(/safety snapshot/);
    expect(fs.readFileSync(path.join(project, "a.md"), "utf8")).toBe("agent edit\n");
    expect(fs.existsSync(path.join(project, "added-by-agent.md"))).toBe(true);
  }, 30_000);

  it("store CRLF files byte for byte, even when git defaults to autocrlf and the project asks for eol=lf", async () => {
    const { project, gitDir, git } = setup();
    await initShadow(gitDir, project);
    git("config", "core.autocrlf", "true");
    fs.writeFileSync(path.join(project, ".gitattributes"), "* text=auto eol=lf\n");
    const original = "first line\r\nsecond line\r\nthird line\r\n";
    fs.writeFileSync(path.join(project, "a.md"), original);
    const snaps = new Snapshots(gitDir, project);
    const first = await snaps.snapshot("crlf");
    expect(git("cat-file", "-p", "HEAD:a.md")).toBe(original);
    expect(await snaps.snapshot("unchanged")).toBeNull();
    fs.writeFileSync(path.join(project, "a.md"), original.replace("second line", "changed second line"));
    const diff = await snaps.diffSince(first!.id, "a.md");
    expect(diff).toContain("+changed second line");
    expect(diff).not.toContain("+first line");
  }, 30_000);

  it("snapshot nested repositories file by file and leave their git metadata alone", async () => {
    const { project, gitDir, git } = setup();
    const nested = path.join(project, "nested");
    fs.mkdirSync(nested);
    execFileSync("git", ["init", "-q", nested]);
    fs.writeFileSync(path.join(nested, "code.txt"), "before\n");
    fs.writeFileSync(path.join(nested, ".gitignore"), "ignored.txt\n");
    fs.writeFileSync(path.join(nested, "ignored.txt"), "ignored\n");
    fs.writeFileSync(path.join(nested, ".env"), "SYNTHETIC_SECRET\n");
    const metadata = () => fs.readdirSync(path.join(nested, ".git"), { recursive: true }).map(String).sort()
      .filter((p) => fs.statSync(path.join(nested, ".git", p)).isFile())
      .map((p) => [p, fs.readFileSync(path.join(nested, ".git", p), "base64")]);
    const before = metadata();
    await initShadow(gitDir, project);
    const snaps = new Snapshots(gitDir, project);
    await snaps.snapshot("nested");
    expect(git("show", "HEAD:nested/code.txt")).toBe("before\n");
    const files = git("ls-tree", "-r", "--name-only", "HEAD");
    for (const hidden of ["ignored.txt", ".env", ".git/"]) expect(files).not.toContain(hidden);
    fs.unlinkSync(path.join(nested, "code.txt"));
    await snaps.snapshot("deleted");
    expect(git("ls-tree", "-r", "--name-only", "HEAD")).not.toContain("code.txt");
    expect(metadata()).toEqual(before);
  }, 30_000);

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a folder that cannot be read is skipped, and the rest is still snapshotted", async () => {
    const { project, gitDir, git } = setup();
    fs.writeFileSync(path.join(project, "a.md"), "kept\n");
    const locked = path.join(project, "locked");
    fs.mkdirSync(locked);
    fs.writeFileSync(path.join(locked, "b.md"), "hidden\n");
    fs.chmodSync(locked, 0o000);
    try {
      await initShadow(gitDir, project);
      expect(await new Snapshots(gitDir, project).snapshot("partial")).not.toBeNull();
      expect(git("show", "HEAD:a.md")).toBe("kept\n");
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  }, 30_000);

  it("store every file of a nested repository byte for byte, whatever its name, and restore them", async () => {
    const { project, gitDir, git } = setup();
    const nested = path.join(project, "nested");
    fs.mkdirSync(path.join(nested, "deep", "er"), { recursive: true });
    execFileSync("git", ["init", "-q", nested]);
    const names = ["plain.txt", "with space.txt", `${String.fromCodePoint(0x4e2d, 0x6587)}.md`, "deep/er/crlf.txt", ...Array.from({ length: 40 }, (_, i) => `deep/f${i}.txt`)];
    const content = (rel: string) => (rel.endsWith("crlf.txt") ? "a\r\nb\r\n" : `${rel}\n`);
    for (const rel of names) fs.writeFileSync(path.join(nested, ...rel.split("/")), content(rel));
    const script = path.join(nested, "run.sh");
    fs.writeFileSync(script, "#!/bin/sh\n");
    fs.chmodSync(script, 0o755);
    await initShadow(gitDir, project);
    const snaps = new Snapshots(gitDir, project);
    const first = await snaps.snapshot("nested files");
    for (const rel of names) expect(git("cat-file", "-p", `HEAD:nested/${rel}`), rel).toBe(content(rel));
    if (process.platform !== "win32") expect(git("ls-tree", "HEAD", "nested/run.sh")).toMatch(/^100755 /);
    for (const rel of names) fs.writeFileSync(path.join(nested, ...rel.split("/")), "changed\n");
    await snaps.restore(first!.id);
    for (const rel of names) expect(fs.readFileSync(path.join(nested, ...rel.split("/")), "utf8"), rel).toBe(content(rel));
  }, 30_000);

  it("drop sensitive files that an older snapshot had, and never store new ones even if .gitignore re-includes them", async () => {
    const { project, gitDir, git } = setup();
    await initShadow(gitDir, project);
    fs.writeFileSync(path.join(project, ".env"), "SYNTHETIC_OLD");
    git("add", "-f", "--", ".env");
    git("-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-m", "older");
    const secret = "SYNTHETIC_NEW";
    for (const rel of ["credentials.json", "auth.json", "private.pem"]) fs.writeFileSync(path.join(project, rel), secret);
    fs.writeFileSync(path.join(project, ".gitignore"), "!.env\n!credentials.json\n!auth.json\n");
    fs.writeFileSync(path.join(project, "notes.md"), "keep\n");
    await new Snapshots(gitDir, project).snapshot("privacy");
    const files = git("ls-tree", "-r", "--name-only", "HEAD");
    for (const name of [".env", "credentials.json", "auth.json", "private.pem"]) expect(files).not.toContain(name);
    expect(files).toContain("notes.md");
    expect(fs.readFileSync(path.join(project, ".env"), "utf8")).toBe("SYNTHETIC_OLD");
    const blob = createHash("sha1").update(`blob ${Buffer.byteLength(secret)}\0${secret}`).digest("hex");
    expect(() => git("cat-file", "-e", blob)).toThrow();
  }, 30_000);
});

it("a first snapshot of a folder holding only empty nested repositories is simply nothing to commit", async () => {
  const base = tempDir("openagent-snap-empty-");
  dirs.push(base);
  const project = path.join(base, "project");
  fs.mkdirSync(path.join(project, "nested"), { recursive: true });
  execFileSync("git", ["init", "-q", path.join(project, "nested")]);
  const gitDir = path.join(base, "shadow");
  await initShadow(gitDir, project);
  expect(await new Snapshots(gitDir, project).snapshot("empty")).toBeNull();
}, 30_000);
