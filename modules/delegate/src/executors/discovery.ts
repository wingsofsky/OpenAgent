/**
 * Finding the executable of a local agent CLI: the only interpreter of the discovery rules, PATH lookup and resolution
 * order in `packages/protocol/src/executor-registry.json`. The executor table (registry.ts) and `openagent doctor` both
 * use it; `test/fixtures/executor-discovery.json` pins the rules.
 *
 * Resolution order: environment override (bin.env, such as OPENAGENT_CODEX_BIN) > `bin` in executors.json > PATH (plus
 * the registry's searchPath folders for this platform) > discovery rules. On Windows PATH only counts `.exe`: `.cmd` /
 * `.bat` shims do not count, nor the extension-less sh shim npm puts next to a `.cmd` for Git Bash (spawning it fails
 * with ENOENT); a name that already ends in `.exe` is looked up as is. Override values (environment, executors.json)
 * are used as given, without checking that they exist.
 *
 * OPENAGENT_SEARCH_PATH, when set (even to the empty string), replaces the registry's searchPath: people with CLIs
 * installed elsewhere can add folders. Tests set it to "" to keep PATH-like folders out; the discover rules (each CLI's
 * own install folder under the home directory) still apply, so tests that must find nothing also override HOME.
 */
import nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REGISTRY, ruleApplies, type DiscoverPick, type DiscoverRule, type RegistryEntry } from "@openagent/protocol/executor-registry";

type FsLike = Pick<typeof nodeFs, "readdirSync" | "statSync">;

interface DiscoverCtx {
  env?: NodeJS.ProcessEnv;
  platform?: string;
  /** The user's home directory (default os.homedir(), read at call time) */
  home?: string;
  fs?: FsLike;
}

interface Ctx {
  env: NodeJS.ProcessEnv;
  platform: string;
  home: string;
  fs: FsLike;
}

const ctxOf = (c: DiscoverCtx = {}): Ctx => ({
  env: c.env ?? process.env,
  platform: c.platform ?? process.platform,
  home: c.home ?? os.homedir(),
  fs: c.fs ?? nodeFs,
});

function statOk(fsImpl: FsLike, p: string): nodeFs.Stats | null {
  try {
    return fsImpl.statSync(p);
  } catch {
    return null;
  }
}
const isFile = (fsImpl: FsLike, p: string): boolean => !!statOk(fsImpl, p)?.isFile();
function readdir(fsImpl: FsLike, p: string): string[] {
  try {
    return fsImpl.readdirSync(p).map(String);
  } catch {
    return [];
  }
}

/** A rule path → absolute path on this machine (`~/`, `%LOCALAPPDATA%`, `%APPDATA%`, `{exe}`; `/` separates) */
export function expandPath(p: string, ctx: DiscoverCtx = {}): string {
  const c = ctxOf(ctx);
  const s = p.replaceAll("{exe}", c.platform === "win32" ? ".exe" : "");
  const segs = (rest: string) => rest.split("/").filter(Boolean);
  if (s === "~" || s.startsWith("~/")) return path.join(c.home, ...segs(s.slice(1)));
  const m = /^%(LOCALAPPDATA|APPDATA)%(\/.*)?$/.exec(s);
  if (m) {
    const base = c.env[m[1]] ?? path.join(c.home, "AppData", m[1] === "APPDATA" ? "Roaming" : "Local");
    return path.join(base, ...segs(m[2] ?? ""));
  }
  return s.startsWith("/") ? path.join("/", ...segs(s)) : path.join(...segs(s));
}

/** Version folder names, newest first (2.1.260 > 2.1.9; missing parts count as 0) */
function sortVersionsDesc(dirs: string[]): string[] {
  const num = (v: string) => v.split(".").map((x) => Number(x));
  return [...dirs].sort((a, b) => {
    const x = num(a);
    const y = num(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
    return 0;
  });
}

/** cursor-agent version folders: the same pattern as the official cursor-agent.ps1 (YYYY.MM.DD-commit or YYYY.MM.DD-HH-MM-SS-commit) */
const CURSOR_VERSION_DIR = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-(\d{2})-(\d{2})-(\d{2}))?-[a-f0-9]+$/;

/** Named pick rules: candidates under a base folder (existence is checked by the caller) */
function claudeVersions(fsImpl: FsLike, base: string, then: string[]): string[] {
  const out: string[] = [];
  for (const d of sortVersionsDesc(readdir(fsImpl, base).filter((d) => /^[0-9]+([.][0-9]+)*$/.test(d)))) {
    out.push(path.join(base, d, ...then));
    for (const sub of readdir(fsImpl, path.join(base, d)).sort()) out.push(path.join(base, d, sub, ...then));
  }
  return out;
}

const PICK: Record<DiscoverPick, (fsImpl: FsLike, base: string, then: string[]) => string[]> = {
  "claude-version": claudeVersions,
  "claude-data": (fsImpl, base, then) => readdir(fsImpl, base).sort().flatMap((pkg) => claudeVersions(fsImpl, path.join(base, pkg, "claude-code"), then)),
  "cursor-version": (fsImpl, base, then) => {
    const key = (d: string) =>
      CURSOR_VERSION_DIR.exec(d)!
        .slice(1, 7)
        .map((x) => (x ?? "").padStart(4, "0"))
        .join(".");
    return readdir(fsImpl, base)
      .filter((d) => CURSOR_VERSION_DIR.test(d))
      .sort((a, b) => (key(a) === key(b) ? (a < b ? 1 : -1) : key(a) < key(b) ? 1 : -1))
      .map((d) => path.join(base, d, ...then));
  },
  newest: (fsImpl, base, then) => {
    const hits: Array<{ p: string; t: number }> = [];
    for (const d of readdir(fsImpl, base)) {
      const p = path.join(base, d, ...then);
      const st = statOk(fsImpl, p);
      if (st) hits.push({ p, t: st.mtimeMs });
    }
    return hits.sort((a, b) => b.t - a.t).map((h) => h.p);
  },
};

/** Discovery rules → candidate paths in rule order (a pick rule expands to several; existence not checked) */
export function discoverCandidates(rules: DiscoverRule[] = [], ctx: DiscoverCtx = {}): string[] {
  const c = ctxOf(ctx);
  const out: string[] = [];
  for (const r of rules) {
    if (!ruleApplies(r, c.platform)) continue;
    const p = expandPath(r.path, c);
    if (!r.pick) out.push(p);
    else out.push(...PICK[r.pick](c.fs, p, (r.then ?? "").split("/").filter(Boolean)));
  }
  return out;
}

/** PATH folders (PATH / Path / path) plus this platform's searchPath folders (or OPENAGENT_SEARCH_PATH, see above) */
function searchDirs(c: Ctx): string[] {
  const raw = c.env.PATH ?? c.env.Path ?? c.env.path ?? "";
  const custom = c.env.OPENAGENT_SEARCH_PATH;
  const extra =
    custom !== undefined
      ? custom.split(path.delimiter).filter(Boolean).map((d) => expandPath(d, c))
      : REGISTRY.searchPath.filter((r) => ruleApplies(r, c.platform)).map((r) => expandPath(r.path, c));
  return [...raw.split(path.delimiter).filter(Boolean), ...extra];
}

/** PATH lookup (Windows: only .exe, see the header comment) */
export function whichOnPath(name: string, env: NodeJS.ProcessEnv = process.env, platform: string = process.platform, ctx: DiscoverCtx = {}): string | null {
  const c = ctxOf({ ...ctx, env, platform });
  const exts = platform !== "win32" ? [""] : /\.exe$/i.test(name) ? [""] : [".exe"];
  for (const d of searchDirs(c)) {
    for (const ext of exts) {
      const p = path.join(d, name + ext);
      if (isFile(c.fs, p)) return p;
    }
  }
  return null;
}

export type BinSource = "env" | "config" | "path" | "discover";

interface BinQuery {
  /** Value of the environment override */
  override?: string | null;
  /** `bin` from executors.json */
  bin?: string | null;
  /** Names to look up on PATH (a name with a path separator is checked directly) */
  names: string[];
  /** Candidates from the discovery rules */
  candidates: string[] | (() => string[]);
}

/** Finds the executable in resolution order and says which step found it; bin null when nothing was found */
export function explainBin(spec: BinQuery, ctx: DiscoverCtx = {}): { bin: string | null; source: BinSource | null } {
  const c = ctxOf(ctx);
  if (spec.override) return { bin: spec.override, source: "env" };
  if (spec.bin) return { bin: spec.bin, source: "config" };
  for (const n of spec.names) {
    if (n.includes("/") || n.includes(path.sep)) {
      if (isFile(c.fs, n)) return { bin: n, source: "path" };
      continue;
    }
    const hit = whichOnPath(n, c.env, c.platform, c);
    if (hit) return { bin: hit, source: "path" };
  }
  const cands = typeof spec.candidates === "function" ? spec.candidates() : spec.candidates;
  for (const p of cands) if (isFile(c.fs, p)) return { bin: p, source: "discover" };
  return { bin: null, source: null };
}

/** Same as explainBin for a registry entry; binOverride = this entry's `bin` from executors.json */
export function explainEntryBin(entry: RegistryEntry | undefined, binOverride: string | null = null, ctx: DiscoverCtx = {}): { bin: string | null; source: BinSource | null } {
  const c = ctxOf(ctx);
  if (!entry?.bin) return { bin: null, source: null };
  const bin = entry.bin;
  return explainBin({ override: bin.env ? c.env[bin.env] : null, bin: binOverride, names: bin.names, candidates: () => discoverCandidates(bin.discover, c) }, c);
}
