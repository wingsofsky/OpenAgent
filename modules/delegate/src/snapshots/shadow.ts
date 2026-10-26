/**
 * Snapshots of a project in a shadow git repository: `<home>/snapshots/<project-key>/`, a bare repository whose
 * work tree is the project. The project's own `.git` is never read or written; nested repositories inside the
 * project are snapshotted file by file, their metadata untouched.
 *
 * Byte-exact by construction: every git call disables autocrlf, and info/attributes turns off text conversion,
 * ident, filters and working-tree encodings, so a CRLF file is stored and restored as written and a diff marks only
 * the lines that changed. Sensitive paths (sensitive-paths.ts) are excluded on every snapshot, even when a project's
 * .gitignore tries to re-include them, and are removed from the index if an older snapshot had them.
 *
 * Writes (snapshot, restore) to one repository are queued inside this process; two processes snapshotting at once
 * retry once on index.lock.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { HOME_LAYOUT } from "@openagent/protocol/layout";
import { ensureHome, projectKey } from "@openagent/common/home";
import { gitBinary } from "../lib/git.ts";
import { atomicWriteFile, resolveScoped, resolveWritePathCreating } from "@openagent/common/scoped";
import { SENSITIVE_PATH_PATTERNS, assertSafeRestore, isSensitivePath } from "./sensitive-paths.ts";

const execFileP = promisify(execFile);

/** Folders never snapshotted (besides sensitive paths). */
const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__", ".venv", ".pnpm-store", ".Trash", "target", "dist"]);
const GIT_CONFIG = ["-c", "core.autocrlf=false", "-c", "core.longpaths=true", "-c", "core.quotepath=false"];
const ATTRIBUTES = "* -text -ident -filter -working-tree-encoding\n";
/** A snapshot id: a hex prefix, optionally `~N`. Nothing else is accepted, so an id can never become a git option. */
const REV = /^[0-9a-f]{4,40}(~\d+)?$/i;

export interface SnapshotInfo {
  id: string;
  time: number;
  label: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export interface FileChange {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "other";
}

async function git(args: string[]): Promise<string> {
  const { stdout } = await execFileP(gitBinary(), [...GIT_CONFIG, ...args], { maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  return stdout;
}

export async function hasGit(): Promise<boolean> {
  try {
    await git(["--version"]);
    return true;
  } catch {
    return false;
  }
}

/** Creates the shadow repository if needed and rewrites its recipe (work tree, excludes, attributes) every time. */
export async function initShadow(gitDir: string, project: string): Promise<void> {
  fs.mkdirSync(gitDir, { recursive: true });
  if (!fs.existsSync(path.join(gitDir, "HEAD"))) {
    await git(["init", "--bare", "--initial-branch=main", gitDir]);
    await git(["--git-dir", gitDir, "config", "core.bare", "false"]);
  }
  await git(["--git-dir", gitDir, "config", "core.worktree", project]);
  await git(["--git-dir", gitDir, "config", "core.autocrlf", "false"]);
  fs.mkdirSync(path.join(gitDir, "info"), { recursive: true });
  // A pattern with a slash would be anchored to the root in git's syntax; `**/` makes it match at any depth too
  const exclude = [...[...SKIP_DIRS].map((d) => `${d}/`), ".DS_Store", ...SENSITIVE_PATH_PATTERNS.map((p) => (p.includes("/") ? `**/${p}` : p))];
  fs.writeFileSync(path.join(gitDir, "info", "exclude"), exclude.join("\n") + "\n");
  fs.writeFileSync(path.join(gitDir, "info", "attributes"), ATTRIBUTES);
}

/** Opens (creating if needed) the shadow repository of a canonical project path. */
export async function openSnapshots(project: string, env: NodeJS.ProcessEnv = process.env): Promise<Snapshots> {
  const gitDir = path.join(ensureHome(env), ...HOME_LAYOUT.snapshots.split("/"), projectKey(project));
  await initShadow(gitDir, project);
  return new Snapshots(gitDir, project);
}

// Excludes cannot be overridden by a project's .gitignore negation. An exact file name is turned into a one-character
// class (`.en[v]`) so git treats it as a glob and does not fail on an explicitly named ignored path.
const PATHSPECS = [
  ".",
  ...SENSITIVE_PATH_PATTERNS.flatMap((p) => {
    const pattern = p.includes("*") ? p : p.replace(/(.)$/, "[$1]");
    const glob = `**/${pattern}`;
    return [`:(exclude,glob,icase)${glob}`, `:(exclude,glob,icase)${glob}/**`];
  }),
];

const queues = new Map<string, Promise<unknown>>();

export class Snapshots {
  readonly gitDir: string;
  readonly project: string;

  constructor(gitDir: string, project: string) {
    this.gitDir = gitDir;
    this.project = project;
  }

  private g(...args: string[]): Promise<string> {
    return git(["--git-dir", this.gitDir, "--work-tree", this.project, ...args]);
  }

  /** Like g, with `input` on stdin; `okCodes` are exit codes that still count as success. */
  private gStdin(args: string[], input: string, okCodes: number[] = []): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const child = execFile(
        gitBinary(),
        [...GIT_CONFIG, "--git-dir", this.gitDir, "--work-tree", this.project, ...args],
        { maxBuffer: 64 * 1024 * 1024, windowsHide: true },
        (error, stdout) => (error && !okCodes.includes(Number(error.code)) ? reject(error) : resolve(stdout)),
      );
      child.stdin?.on("error", () => {});
      child.stdin?.end(input);
    });
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = (queues.get(this.gitDir) ?? Promise.resolve()).then(fn, fn);
    const tail = next.catch(() => undefined);
    queues.set(this.gitDir, tail);
    void tail.then(() => {
      if (queues.get(this.gitDir) === tail) queues.delete(this.gitDir);
    });
    return next;
  }

  private async commitOf(id: string): Promise<string> {
    if (typeof id !== "string" || !REV.test(id)) throw Object.assign(new Error(`invalid snapshot id: ${id}`), { status: 400 });
    try {
      return (await this.g("rev-parse", "--verify", "--quiet", `${id}^{commit}`)).trim();
    } catch {
      throw Object.assign(new Error(`no snapshot ${id}`), { status: 404 });
    }
  }

  async list(limit = 20): Promise<SnapshotInfo[]> {
    let log: string;
    try {
      log = await this.g("log", "-n", String(limit), "--format=%H|%ct|%s");
    } catch {
      return [];
    }
    const out: SnapshotInfo[] = [];
    for (const line of log.split("\n").filter(Boolean)) {
      const [sha, time, ...label] = line.split("|");
      let files = 0;
      let insertions = 0;
      let deletions = 0;
      try {
        for (const row of (await this.g("diff-tree", "--no-commit-id", "--numstat", "--root", "-r", sha)).split("\n").filter(Boolean)) {
          const [added, removed] = row.split("\t");
          files++;
          insertions += Number(added) || 0;
          deletions += Number(removed) || 0;
        }
      } catch {
        /* statistics are optional */
      }
      out.push({ id: sha.slice(0, 10), time: Number(time), label: label.join("|"), filesChanged: files, insertions, deletions });
    }
    return out;
  }

  /** Commits a snapshot when anything changed; returns null when nothing did. */
  snapshot(label: string): Promise<SnapshotInfo | null> {
    return this.exclusive(() => this.snapshotRetrying(label));
  }

  private async snapshotRetrying(label: string): Promise<SnapshotInfo | null> {
    try {
      return await this.snapshotOnce(label);
    } catch (e) {
      if (!String(e).includes("index.lock")) throw e;
      await new Promise((r) => setTimeout(r, 500));
      return this.snapshotOnce(label);
    }
  }

  private async snapshotOnce(label: string): Promise<SnapshotInfo | null> {
    await this.stage();
    try {
      await this.g("rev-parse", "--verify", "HEAD");
      try {
        await this.g("diff", "--cached", "--quiet");
        return null;
      } catch {
        /* there are changes */
      }
    } catch {
      // No snapshot yet: commit only when something was staged. `git status` would also list folders that were
      // deliberately not staged (nested repositories with no files yet) and lead to an empty commit that git refuses.
      if (!(await this.g("ls-files", "--cached", "-z")).length) return null;
    }
    await this.g("-c", "user.name=OpenAgent", "-c", "user.email=openagent@localhost", "commit", "-m", label || "snapshot");
    return (await this.list(1))[0] ?? null;
  }

  /**
   * Stages the project: drops sensitive paths and nested repositories from an older index, adds everything else
   * through the excluding pathspecs, then adds files of nested repositories one by one (git would otherwise record
   * a nested repository as a gitlink and skip its files).
   */
  private async stage(): Promise<void> {
    const tracked = (await this.g("ls-files", "--stage", "-z")).split("\0").filter(Boolean).map((line) => {
      const tab = line.indexOf("\t");
      return { mode: line.slice(0, 6), rel: line.slice(tab + 1) };
    });
    const nested: string[] = [];
    const nestedFiles: string[] = [];
    const walk = (rel: string, inNested: boolean): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(resolveScoped(this.project, rel), { withFileTypes: true });
      } catch (e) {
        // A folder this user cannot read (or one that vanished meanwhile) is left out, as git add leaves it out
        console.error(`[snapshot] skipped ${rel || "."}: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      const isNested = inNested || (!!rel && entries.some((e) => e.name === ".git"));
      if (isNested && !inNested) nested.push(rel);
      for (const e of entries) {
        const child = rel ? `${rel}/${e.name}` : e.name;
        if (e.isSymbolicLink() || SKIP_DIRS.has(e.name) || isSensitivePath(child)) continue;
        if (e.isDirectory()) walk(child, isNested);
        else if (isNested && e.isFile()) nestedFiles.push(child);
      }
    };
    walk("", false);
    const insideNested = (rel: string) => nested.some((dir) => rel === dir || rel.startsWith(dir + "/"));
    const remove = tracked.filter(({ mode, rel }) => mode === "160000" || isSensitivePath(rel) || insideNested(rel)).map(({ rel }) => rel);
    for (let i = 0; i < remove.length; i += 100) await this.g("update-index", "--force-remove", "--", ...remove.slice(i, i + 100));
    await this.g("add", "-A", "--", ...PATHSPECS, ...nested.map((rel) => `:(exclude,literal)${rel}`));
    if (!nestedFiles.length) return;
    // Files ignored by a nested repository's own .gitignore stay out, as they would in that repository.
    const ignored = await this.gStdin(["check-ignore", "--no-index", "--stdin", "-z"], nestedFiles.join("\0") + "\0", [1]);
    const excluded = new Set(ignored.split("\0"));
    const files = nestedFiles.filter((p) => !excluded.has(p)).map((rel) => {
      const abs = resolveScoped(this.project, rel);
      const stat = fs.lstatSync(abs);
      if (!stat.isFile()) throw new Error(`a file changed while it was being snapshotted: ${rel}`);
      return { rel, abs, mode: stat.mode & 0o111 ? "100755" : "100644" };
    });
    // Two git processes for all the files, not two per file. --stdin-paths reads one path per line, so a name with a
    // line break is hashed on its own.
    const oneLine = files.filter((f) => !/[\r\n]/.test(f.abs));
    const oids = oneLine.length ? (await this.gStdin(["hash-object", "-w", "--stdin-paths"], oneLine.map((f) => f.abs).join("\n") + "\n")).split("\n").filter(Boolean) : [];
    if (oids.length !== oneLine.length) throw new Error(`git hash-object returned ${oids.length} ids for ${oneLine.length} files`);
    const entries = oneLine.map((f, i) => ({ ...f, oid: oids[i] }));
    for (const f of files.filter((x) => /[\r\n]/.test(x.abs))) entries.push({ ...f, oid: (await this.g("hash-object", "-w", "--", f.abs)).trim() });
    if (entries.length) await this.gStdin(["update-index", "-z", "--index-info"], entries.map((f) => `${f.mode} ${f.oid}\t${f.rel}\0`).join(""));
  }

  /** Files changed from `from` to `id`; without `from`, compared with the snapshot before `id`. */
  async changes(id: string, from?: string): Promise<FileChange[]> {
    const to = await this.commitOf(id);
    const text = from
      ? await this.g("diff-tree", "--name-status", "-r", await this.commitOf(from), to)
      : await this.g("diff-tree", "--no-commit-id", "--name-status", "--root", "-r", to);
    return text.split("\n").filter(Boolean).map((line) => {
      const [code, ...rest] = line.split("\t");
      const status = code === "A" ? "added" : code === "M" ? "modified" : code === "D" ? "deleted" : code.startsWith("R") ? "renamed" : "other";
      return { path: rest[rest.length - 1], status } satisfies FileChange;
    });
  }

  /** Unified diff from a snapshot to the files as they are now, for the whole project or one path. */
  async diffSince(id: string, rel?: string): Promise<string> {
    const commit = await this.commitOf(id);
    return this.g("diff", "--no-color", commit, ...(rel === undefined ? [] : ["--", rel]));
  }

  /** The snapshot taken before a restore. When it cannot be taken, nothing is restored: the current files would be lost. */
  private async safetySnapshot(label: string): Promise<SnapshotInfo | null> {
    try {
      return await this.snapshotRetrying(label);
    } catch (e) {
      throw new Error(`could not take the safety snapshot, so nothing was restored: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Restores one file from a snapshot. A safety snapshot is taken first (returned; null when nothing changed). */
  restoreFile(id: string, rel: string): Promise<SnapshotInfo | null> {
    return this.exclusive(async () => {
      assertSafeRestore(this.project, rel);
      const commit = await this.commitOf(id);
      const spec = `${commit}:${rel.replaceAll("\\", "/")}`;
      let type = "";
      try {
        type = (await this.g("cat-file", "-t", spec)).trim();
      } catch {
        /* not in that snapshot */
      }
      if (type !== "blob") throw Object.assign(new Error(`${rel} is not in snapshot ${id}`), { status: 404 });
      const safety = await this.safetySnapshot("before restoring a file");
      const { stdout } = await execFileP(
        gitBinary(),
        [...GIT_CONFIG, "--git-dir", this.gitDir, "--work-tree", this.project, "cat-file", "blob", spec],
        { maxBuffer: 256 * 1024 * 1024, windowsHide: true, encoding: "buffer" },
      );
      atomicWriteFile(resolveWritePathCreating(this.project, rel), stdout);
      return safety;
    });
  }

  /**
   * Restores the whole project to a snapshot: files in the snapshot are written back, files the safety snapshot has
   * but the target does not are deleted. Excluded files (credentials, node_modules, …) and untracked files that were
   * never snapshotted are left alone.
   */
  restore(id: string): Promise<SnapshotInfo | null> {
    return this.exclusive(async () => {
      const commit = await this.commitOf(id);
      const target = (await this.g("ls-tree", "-r", "-z", "--name-only", commit)).split("\0").filter(Boolean);
      for (const rel of target) assertSafeRestore(this.project, rel);
      const safety = await this.safetySnapshot("before restoring the project");
      await this.g("checkout", commit, "--", ".");
      const keep = new Set(target);
      let current: string[] = [];
      try {
        current = (await this.g("ls-tree", "-r", "-z", "--name-only", "HEAD")).split("\0").filter(Boolean);
      } catch {
        /* no HEAD yet */
      }
      for (const rel of current) {
        if (keep.has(rel)) continue;
        try {
          // Delete the entry itself: its parent passes the path gate, the leaf is not followed. unlinkSync only
          // (fs.rmSync on a single file can crash Node 24 on Windows).
          const dir = path.posix.dirname(rel);
          const abs = path.join(resolveScoped(this.project, dir === "." ? "" : dir), path.posix.basename(rel));
          const st = fs.lstatSync(abs);
          if (st.isFile() || st.isSymbolicLink()) fs.unlinkSync(abs);
        } catch {
          /* already gone */
        }
      }
      return safety;
    });
  }
}
