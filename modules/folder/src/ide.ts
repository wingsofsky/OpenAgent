/**
 * Which projects IntelliJ IDEA has open, for folder tasks that yield to the IDE (`yieldToIde` in executors.json).
 *
 * - macOS and IntelliJ IDEA 2026.2 only (Ultimate or Community): `ps` finds IDEA processes, `lsof` lists the files they
 *   hold, and each open project shows up as a held `projects/<name>.<hash>/indexingStamp/indexingStamp.dat`, where the
 *   hash is Java's String.hashCode of the project path. No plugin, nothing written to the IDE's settings. On other
 *   platforms, or with no IDEA running, nothing is open.
 * - Whatever cannot be confirmed (an IDEA version other than 2026.2, `ps` or `lsof` failing) is "unknown", and unknown
 *   blocks every project: a folder task waits rather than edit files a person may have open. Looking for a project
 *   opened inside a candidate is bounded instead: level by level, so the shallow folders where projects are opened come
 *   first, dependency and build folders skipped, a few levels deep, a folder limit. A folder that cannot be read means
 *   "nothing open below here", never "unknown", so one large repository cannot stall the whole queue; a candidate whose
 *   search stopped at the folder limit is reported (`partial`), so the folder task can say so.
 * - Only the folder task's own candidates enter the result; other paths the IDE holds never reach a prompt or a log.
 *   A hash collision can only cause extra waiting; it never grants anything.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { resolveScoped } from "@longkeep/common/scoped";

const exec = promisify(execFile);

export interface IdeObservation {
  state: "ready" | "unknown";
  /** Candidates (absolute paths) that are open in the IDE, sit inside an open project, or contain one */
  projects: string[];
  /** Candidates whose search for an open project inside them stopped at the folder limit */
  partial?: string[];
  message?: string;
}

async function ideaProcesses(): Promise<number[]> {
  const { stdout } = await exec("/bin/ps", ["-axo", "pid=,comm="], { timeout: 4000, maxBuffer: 4 * 1024 * 1024 });
  return stdout.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    return match && /\/Contents\/MacOS\/idea$/.test(match[2]) ? [Number(match[1])] : [];
  });
}

async function ideaOpenFiles(pids: number[]): Promise<string[]> {
  const { stdout } = await exec("/usr/sbin/lsof", ["-a", "-p", pids.join(","), "-Fpn0"], { timeout: 4000, maxBuffer: 8 * 1024 * 1024 });
  const fields = stdout.split("\0").map((s) => s.replace(/^\n/, ""));
  if (pids.some((pid) => !fields.includes(`p${pid}`))) throw new Error("the IDE processes changed while being read");
  return fields.filter((s) => s.startsWith("n")).map((s) => s.slice(1));
}

/** Java's String.hashCode of a path (UTF-16 code units) in hex, as IntelliJ names its per-project folders */
export function ideaPathHash(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = (Math.imul(hash, 31) + value.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(16);
}

/** Folders that hold dependencies, build output, caches or IDE state: nobody opens a project inside them */
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "bower_components",
  ".pnpm-store",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".cache",
  ".next",
  "Pods",
  ".gradle",
  ".idea",
  ".Trash",
  "coverage",
  "target",
  "dist",
  "build",
]);

/** How far the search below a candidate goes: levels below it, and folders looked at in all */
export interface SearchLimits {
  depth: number;
  folders: number;
}
const LIMITS: SearchLimits = { depth: 4, folders: 20_000 };

/**
 * Whether root, one of its parents, or a folder inside it is an open project. Inside, level by level in name order:
 * links are not followed, SKIP_DIRS are skipped, an unreadable folder means "not here"; `partial` when the folder
 * limit stopped the search.
 */
async function overlapsOpenProject(root: string, hashes: Set<string>, limits: SearchLimits): Promise<{ open: boolean; partial: boolean }> {
  for (let ancestor = root; ; ancestor = path.dirname(ancestor)) {
    if (hashes.has(ideaPathHash(ancestor))) return { open: true, partial: false };
    if (ancestor === path.dirname(ancestor)) break;
  }
  let level = [""];
  let count = 0;
  for (let depth = 1; depth <= limits.depth && level.length; depth++) {
    const next: string[] = [];
    for (const rel of level) {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(resolveScoped(root, rel), { withFileTypes: true });
      } catch {
        continue;
      }
      const names = entries.filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name)).map((e) => e.name);
      for (const name of names.sort()) {
        if (++count > limits.folders) return { open: false, partial: true };
        const child = rel ? `${rel}/${name}` : name;
        if (hashes.has(ideaPathHash(path.join(root, child)))) return { open: true, partial: false };
        next.push(child);
      }
    }
    level = next;
  }
  return { open: false, partial: false };
}

export async function readIntellijProjects(opts: {
  platform?: NodeJS.Platform;
  processes?: () => Promise<number[]>;
  openFiles?: (pids: number[]) => Promise<string[]>;
  candidates?: string[];
  limits?: Partial<SearchLimits>;
} = {}): Promise<IdeObservation> {
  const { platform = process.platform, processes = ideaProcesses, openFiles = ideaOpenFiles, candidates = [] } = opts;
  const limits = { ...LIMITS, ...opts.limits };
  if (platform !== "darwin") return { state: "ready", projects: [] };
  try {
    const pids = await processes();
    if (!pids.length) return { state: "ready", projects: [] };
    const files = await openFiles(pids);
    // Only IDEA 2026.2's layout is known; any other version counts as unknown.
    const versions = files.flatMap((file) => file.match(/\/JetBrains\/(IntelliJIdea[^/]+|IdeaIC[^/]+)\//)?.slice(1) ?? []);
    if (!versions.length || versions.some((v) => !/^(IntelliJIdea|IdeaIC)2026\.2$/.test(v))) throw new Error("an IntelliJ IDEA version or setup that is not supported (2026.2 is)");
    const hashes = new Set(files.flatMap((file) => file.match(/\/projects\/[^/]+\.([0-9a-f]+)\/indexingStamp\/indexingStamp\.dat(?: \(deleted\))?$/)?.slice(1) ?? []));
    if (!hashes.size) return { state: "ready", projects: [] };
    const projects: string[] = [];
    const partial: string[] = [];
    for (const root of candidates) {
      const found = await overlapsOpenProject(root, hashes, limits);
      if (found.open) projects.push(root);
      else if (found.partial) partial.push(root);
    }
    return { state: "ready", projects, ...(partial.length ? { partial } : {}) };
  } catch {
    return {
      state: "unknown",
      projects: [],
      message: "Cannot tell which projects IntelliJ IDEA has open, so the folder task waits; check the IDE version (2026.2 is supported), or quit the IDE and try again.",
    };
  }
}

/** Whether an observation keeps a folder task off cwd: unknown blocks everything; an open project blocks itself, its parents and its folders */
export function blocksProject(observation: IdeObservation, cwd: string): boolean {
  return observation.state !== "ready" || observation.projects.some((p) => p === cwd || p.startsWith(cwd + path.sep) || cwd.startsWith(p + path.sep));
}
