/**
 * The working folder of a delegation and its fingerprint.
 *
 * checkWorkRoot validates a working folder that is not the record's scratch folder (the project, a `workRoot`
 * declared in executors.json, a folder task's folder): it must pass common/home resolveProject, which refuses the
 * filesystem root, the user's home directory, the OpenAgent home folder and anything inside it, and any folder that
 * contains the OpenAgent home folder (records are written there; an executor never works on them).
 *
 * rootFingerprint is taken before and after each round; different = changed (the outcome is set by OpenAgent, not what
 * the model says):
 *  - git work tree: HEAD + `git status --porcelain -uall` (untracked files included) + size and mtime of those files;
 *    GIT_OPTIONAL_LOCKS=0, the index is not refreshed
 *  - any other folder: path / size / mtime of every file, skipping .git, node_modules and `skip` (files the runner
 *    writes itself); more than 20,000 entries gives up
 * null when it cannot be taken (the outcome is then "unchecked"). It is not a lock: another task changing files in the
 * same folder at the same time counts too.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gitBinary } from "../lib/git.ts";
import { resolveProject } from "@openagent/common/home";

/** A canonical working folder, or an error that names it */
export function checkWorkRoot(dir: string, env: NodeJS.ProcessEnv = process.env): string {
  try {
    return resolveProject(dir, env);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    const status = (e as { status?: number }).status;
    if (code === "ENOENT" || status === 409) throw new Error(`working folder ${dir} does not exist or is not accessible`);
    throw new Error(`working folder ${dir}: ${(e as Error).message}`);
  }
}

export interface RootState {
  kind: "git" | "files";
  hash: string;
  /** HEAD of a git work tree; null outside git or before the first commit */
  head: string | null;
  /** `git status --porcelain` entries (at most 50); empty outside git */
  dirty: string[];
  /** Changed entries (git = status lines; folder = number of files) */
  count: number;
}

const FP_MAX_FILES = 20_000;
const FP_SKIP_DIRS = new Set([".git", "node_modules"]);

function gitOut(dir: string, args: string[]): Buffer | null {
  const r = spawnSync(gitBinary(), ["-C", dir, ...args], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30_000,
  });
  return r.status === 0 && r.stdout ? r.stdout : null;
}

export function rootFingerprint(dir: string, opts: { skip?: string[]; git?: boolean } = {}): RootState | null {
  const h = createHash("sha1");
  if (opts.git !== false) {
    const top = gitOut(dir, ["rev-parse", "--show-toplevel"])?.toString("utf8").trim();
    const status = top ? gitOut(dir, ["status", "--porcelain=v1", "-uall", "-z", "--", "."]) : null;
    if (top && status) {
      const head = gitOut(dir, ["rev-parse", "--verify", "-q", "HEAD"])?.toString("utf8").trim() || null;
      h.update(`head\0${head ?? ""}\0`);
      h.update(status);
      const fields = status.toString("utf8").split("\0").filter(Boolean);
      const dirty: string[] = [];
      let count = 0;
      for (let i = 0; i < fields.length; i++) {
        const f = fields[i];
        const rel = f.slice(3);
        if (f[0] === "R" || f[0] === "C") i++; // rename / copy: the next field is the original path
        let st: fs.Stats | null = null;
        try {
          st = fs.lstatSync(path.join(top, rel));
        } catch {
          st = null;
        }
        h.update(`${rel}\0${st ? `${st.size}\0${st.mtimeMs}` : "-"}\n`);
        if (dirty.length < 50) dirty.push(f);
        count++;
      }
      return { kind: "git", hash: h.digest("hex"), head, dirty, count };
    }
  }
  const skip = new Set(opts.skip ?? []);
  const rows: string[] = [];
  let seen = 0;
  const walk = (abs: string, rel: string): boolean => {
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return rel !== ""; // the root itself unreadable: give up; an unreadable subfolder: skip it
    }
    for (const e of ents) {
      if (FP_SKIP_DIRS.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (skip.has(r)) continue;
      if (++seen > FP_MAX_FILES) return false;
      const p = path.join(abs, e.name);
      if (e.isDirectory()) {
        if (!walk(p, r)) return false;
        continue;
      }
      try {
        const st = fs.lstatSync(p); // a link is recorded itself, never followed
        rows.push(`${r}\0${st.size}\0${st.mtimeMs}`);
      } catch {
        /* just deleted */
      }
    }
    return true;
  };
  if (!walk(dir, "")) return null;
  rows.sort();
  for (const r of rows) h.update(`${r}\n`);
  return { kind: "files", hash: h.digest("hex"), head: null, dirty: [], count: rows.length };
}
