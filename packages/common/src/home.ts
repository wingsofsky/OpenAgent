/**
 * The Longkeep home folder and projects.
 *
 * - The home folder is `~/.longkeep`, or LONGKEEP_HOME. Every record and all configuration live there (layout:
 *   protocol/layout.ts).
 * - A project is the folder a main agent works in. It holds no records, and Longkeep reads no configuration from it.
 * - A project may not be the filesystem root, the user's home directory, the Longkeep home folder or anything inside
 *   it, nor a folder that contains the Longkeep home folder: an agent that skips permission prompts could otherwise
 *   change the whole disk or Longkeep's own records.
 * - A project key names a project's folder under `runs/` and `snapshots/`: the folder name plus a short hash of the
 *   canonical path, readable and collision-free.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOME_ENV, LONGKEEP_DIR } from "@longkeep/protocol/layout";
import { canonicalRoot } from "./scoped.ts";

/** Path of the home folder; it may not exist yet. */
export function homePath(env: NodeJS.ProcessEnv = process.env): string {
  const custom = env[HOME_ENV];
  return custom ? path.resolve(custom) : path.join(os.homedir(), LONGKEEP_DIR);
}

/** Creates the home folder if needed and returns its canonical path. */
export function ensureHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = homePath(env);
  fs.mkdirSync(home, { recursive: true });
  return canonicalRoot(home);
}

/** Canonical path of the home folder, or null when it does not exist yet (read-only callers create nothing). */
export function existingHome(env: NodeJS.ProcessEnv = process.env): string | null {
  const home = homePath(env);
  return fs.existsSync(home) ? canonicalRoot(home) : null;
}

const isWithin = (base: string, p: string): boolean => p === base || p.startsWith(base.endsWith(path.sep) ? base : base + path.sep);

/** Canonical project folder, after refusing folders that are too broad or belong to Longkeep itself. */
export function resolveProject(dir: string, env: NodeJS.ProcessEnv = process.env): string {
  const project = canonicalRoot(path.resolve(dir));
  if (!fs.statSync(project).isDirectory()) throw new Error(`not a folder: ${dir}`);
  if (path.dirname(project) === project) throw new Error("the filesystem root cannot be a project");
  let userHome: string | null = null;
  try {
    userHome = canonicalRoot(os.homedir());
  } catch {
    /* no usable home directory */
  }
  if (userHome && project === userHome) throw new Error("your home directory cannot be a project; pick a folder inside it");
  const home = homePath(env);
  const homeReal = fs.existsSync(home) ? canonicalRoot(home) : home;
  if (isWithin(homeReal, project)) throw new Error("the Longkeep home folder cannot be a project");
  if (isWithin(project, homeReal)) throw new Error("a project cannot contain the Longkeep home folder");
  return project;
}

/** `<folder-name>-<8 hex>` for a canonical project path. */
export function projectKey(project: string): string {
  const name = path.basename(project).replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^[-.]+|-+$/g, "").slice(0, 40) || "project";
  const hash = createHash("sha256").update(project).digest("hex").slice(0, 8);
  return `${name}-${hash}`;
}
