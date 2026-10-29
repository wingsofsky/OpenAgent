/**
 * `longkeep import-sessions`: turns the local chat transcripts of agent CLIs into readable Markdown archives in the
 * Longkeep home folder, `<home>/sessions/imported/<project>/` (layout: HOME_LAYOUT.importedSessions; archive format:
 * convert.ts). Usage, options and the filing rules are in USAGE below (`--help` prints it).
 *
 * Contract:
 * - Transcripts are read from the CLIs' own folders under the user's home directory (os.homedir(), so HOME /
 *   USERPROFILE move it); every read and write under the Longkeep home folder goes through common/scoped.
 * - By default only sessions whose working folder is the project are imported; an unknown working folder never counts
 *   as consent to mix projects. `--file` and `--all-projects` are the user's deliberate choice.
 * - Idempotent: an archive is matched to its transcript by the original transcript path, then by session id.
 * - A session that continued after import is refreshed in place; an archive a person edited (checksum line no longer
 *   matches) is left alone and listed; a refresh never loses text it cannot account for.
 * - `--list` and `--index` never create the home folder.
 * - No model, no network.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { HOME_LAYOUT } from "@longkeep/protocol/layout";
import { parseWhole } from "@longkeep/common/args";
import { ensureHome, existingHome, homePath } from "@longkeep/common/home";
import { atomicWriteFile, resolveScoped, resolveWritePathCreating } from "@longkeep/common/scoped";
import {
  archiveUntouched,
  BUCKET_DELEGATION,
  type BucketContext,
  buildPromptBooks,
  detectFormat,
  isDelegationSession,
  isSubsetSession,
  parseSession,
  projectBucket,
  redactText,
  renderMarkdown,
  type Session,
  type SessionMeta,
  suggestFileName,
  withChecksum,
} from "./convert.ts";
import { DELEGATION_PROMPT_FIRST_LINE } from "@longkeep/protocol/delegation-prompt";

const MAX_RAW = 256 * 1024 * 1024; // larger transcripts are skipped with a note
const OUT = HOME_LAYOUT.importedSessions;
const INDEX = "index.md";
const PROMPTS_DIR = "_prompts";
const PREVIOUS_DIR = "_previous";

interface Args {
  source: string;
  project: string;
  file?: string;
  limit: number;
  redact: boolean;
  list?: boolean;
  indexOnly?: boolean;
  reorganize?: boolean;
  force?: boolean;
  sidechains?: boolean;
  allProjects?: boolean;
  prompts?: boolean;
  help?: boolean;
}

const SOURCES = ["auto", "claude-code", "codex", "gemini", "grok", "agy", "cursor", "file"];

function parseArgs(argv: string[]): Args | number {
  const a: Args = { source: "auto", project: process.cwd(), limit: Infinity, redact: true };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--project" || k === "--source" || k === "--file") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) {
        console.error(`${k} needs a value (see --help)`);
        return 2;
      }
      if (k === "--project") a.project = v;
      else if (k === "--file") a.file = v;
      else if (!SOURCES.includes(v)) {
        console.error(`--source must be one of ${SOURCES.join(", ")} (see --help)`);
        return 2;
      } else a.source = v;
    }
    else if (k === "--limit") {
      const n = parseWhole(argv[++i] ?? "", 1);
      if (n === null) {
        console.error("--limit must be a whole number of at least 1 (see --help)");
        return 2;
      }
      a.limit = n;
    }
    else if (k === "--list") a.list = true;
    else if (k === "--index") a.indexOnly = true;
    else if (k === "--reorganize") a.reorganize = true;
    else if (k === "--force") a.force = true;
    else if (k === "--sidechains") a.sidechains = true;
    else if (k === "--all-projects") a.allProjects = true;
    else if (k === "--prompts") a.prompts = true;
    else if (k === "--no-redact") a.redact = false;
    else if (k === "--help" || k === "-h") a.help = true;
    else {
      console.error(`unknown option: ${k} (see --help)`);
      return 2;
    }
  }
  return a;
}

interface Entry {
  file: string;
  source: string;
  mtime: number;
  size: number;
  meta?: SessionMeta | null;
}

/** Claude Code's project folder slug: every character of the absolute path outside [A-Za-z0-9-] becomes '-'. */
const ccSlug = (abs: string): string =>
  abs
    .split("")
    .map((c) => (/[a-zA-Z0-9-]/.test(c) ? c : "-"))
    .join("");

const readdirSafe = (d: string): string[] => {
  try {
    return fs.readdirSync(d);
  } catch {
    return [];
  }
};
const readdirEntries = (d: string): fs.Dirent[] => {
  try {
    return fs.readdirSync(d, { withFileTypes: true });
  } catch {
    return [];
  }
};
const readJson = (file: string): any => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

function discover(source: string, project: string, allProjects = false): Entry[] {
  const home = os.homedir();
  const found: Entry[] = [];
  const push = (file: string, src: string, meta: SessionMeta | null = null): void => {
    try {
      const st = fs.statSync(file);
      if (st.isFile()) found.push({ file, source: src, mtime: st.mtimeMs, size: st.size, meta });
    } catch {
      /* not there */
    }
  };

  if (source === "auto" || source === "claude-code") {
    const base = path.join(home, ".claude", "projects");
    const dirs = allProjects ? readdirSafe(base) : [ccSlug(path.resolve(project))];
    for (const d of dirs)
      for (const f of readdirSafe(path.join(base, d))) {
        if (f.endsWith(".jsonl")) push(path.join(base, d, f), "claude-code", allProjects ? null : { cwd: path.resolve(project) });
      }
  }
  if (source === "auto" || source === "codex") {
    const walk = (d: string, depth: number): void => {
      if (depth > 4) return;
      for (const e of readdirEntries(d)) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else if (e.name.endsWith(".jsonl")) push(p, "codex");
      }
    };
    walk(path.join(home, ".codex", "sessions"), 0);
    walk(path.join(home, ".codex", "archived_sessions"), 0);
  }
  if (source === "auto" || source === "gemini") {
    const base = path.join(home, ".gemini", "tmp");
    for (const h of readdirSafe(base)) {
      const chats = path.join(base, h, "chats");
      for (const f of readdirSafe(chats)) if (f.endsWith(".json")) push(path.join(chats, f), "gemini");
    }
  }
  // Grok Build: one percent-encoded folder per cwd, one folder per session below; chat_history.jsonl is the
  // conversation, summary.json the metadata.
  if (source === "auto" || source === "grok") {
    const base = path.join(home, ".grok", "sessions");
    for (const d of readdirEntries(base)) {
      if (!d.isDirectory()) continue;
      const cwdDir = path.join(base, d.name);
      for (const sd of readdirEntries(cwdDir)) {
        if (!sd.isDirectory()) continue;
        push(path.join(cwdDir, sd.name, "chat_history.jsonl"), "grok", grokMeta(path.join(cwdDir, sd.name, "summary.json"), sd.name, d.name));
      }
    }
  }
  // Antigravity: brain/<session id>/.system_generated/logs/transcript_full.jsonl. Working folder and title:
  // conversation_summaries.db (one row per session) is the most complete; when it cannot be read,
  // cache/last_conversations.json (only the latest session per cwd).
  if (source === "auto" || source === "agy") {
    const base = path.join(home, ".gemini", "antigravity-cli");
    const metaOf = agyConversationMeta(base);
    const last = readJson(path.join(base, "cache", "last_conversations.json"));
    if (last && typeof last === "object") {
      for (const [cwd, id] of Object.entries(last)) {
        if (typeof id === "string" && !metaOf.get(id)?.cwd) metaOf.set(id, { ...(metaOf.get(id) ?? {}), cwd });
      }
    }
    for (const id of readdirSafe(path.join(base, "brain"))) {
      const logs = path.join(base, "brain", id, ".system_generated", "logs");
      const full = path.join(logs, "transcript_full.jsonl");
      push(fs.existsSync(full) ? full : path.join(logs, "transcript.jsonl"), "agy", { id, cwd: null, ...(metaOf.get(id) ?? {}) });
    }
  }
  // Cursor Agent: projects/<slug>/agent-transcripts/<id>/<id>.jsonl; cwd and start / end ms in chats/<hash>/<id>/meta.json
  if (source === "auto" || source === "cursor") {
    const base = path.join(home, ".cursor");
    const metaOf = new Map<string, SessionMeta>();
    for (const h of readdirSafe(path.join(base, "chats"))) {
      const hd = path.join(base, "chats", h);
      for (const id of readdirSafe(hd)) {
        const m = readJson(path.join(hd, id, "meta.json"));
        if (!m) continue;
        metaOf.set(id, {
          id,
          cwd: typeof m.cwd === "string" ? m.cwd : null,
          startedAt: typeof m.createdAtMs === "number" ? new Date(m.createdAtMs).toISOString() : null,
          endedAt: typeof m.updatedAtMs === "number" ? new Date(m.updatedAtMs).toISOString() : null,
        });
      }
    }
    for (const p of readdirSafe(path.join(base, "projects"))) {
      const td = path.join(base, "projects", p, "agent-transcripts");
      for (const id of readdirSafe(td)) push(path.join(td, id, `${id}.jsonl`), "cursor", metaOf.get(id) ?? { id });
    }
  }
  return found.sort((x, y) => y.mtime - x.mtime);
}

/** summary.json next to a grok session → meta (without the file: only the id and the cwd decoded from the folder name). */
function grokMeta(summaryFile: string, id: string | null, encodedCwd: string | null): SessionMeta {
  const j = readJson(summaryFile);
  let cwd: string | null = j?.info?.cwd ?? null;
  if (!cwd && encodedCwd) {
    try {
      cwd = decodeURIComponent(encodedCwd);
    } catch {
      /* not percent-encoded */
    }
  }
  const model = j?.current_model_id ? `${j.current_model_id}${j.reasoning_effort ? ` · reasoning ${j.reasoning_effort}` : ""}` : null;
  return {
    id: j?.info?.id ?? id ?? null,
    cwd,
    startedAt: j?.created_at ?? null,
    endedAt: j?.updated_at ?? j?.last_active_at ?? null,
    title: j?.generated_title || j?.session_summary || null,
    model,
  };
}

/** file:///d%3A/x → D:\x; file:///Users/a/x → /Users/a/x */
function fileUriToPath(uri: unknown): string | null {
  if (typeof uri !== "string" || !uri.startsWith("file://")) return null;
  let p: string;
  try {
    p = decodeURIComponent(uri.slice("file://".length));
  } catch {
    return null;
  }
  const drive = /^\/?([A-Za-z]):[\\/]?(.*)$/.exec(p);
  if (drive) return path.win32.normalize(`${drive[1].toUpperCase()}:\\${drive[2]}`);
  return p || null;
}

/** agy's conversation summary database (sqlite, read only) → Map(id → {cwd, title, endedAt}); empty when it cannot be read. */
function agyConversationMeta(base: string): Map<string, SessionMeta> {
  const out = new Map<string, SessionMeta>();
  const file = path.join(base, "conversation_summaries.db");
  if (!fs.existsSync(file)) return out;
  const emit = process.emitWarning;
  process.emitWarning = ((w: unknown, ...rest: unknown[]) =>
    String((w as Error)?.message ?? w).includes("SQLite") ? undefined : (emit as (...x: unknown[]) => void).call(process, w, ...rest)) as typeof process.emitWarning;
  let db: import("node:sqlite").DatabaseSync | undefined;
  try {
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    db = new DatabaseSync(file, { readOnly: true });
    for (const r of db.prepare("SELECT conversation_id, title, preview, workspace_uris, last_modified_time FROM conversation_summaries").all()) {
      let uris: unknown = [];
      try {
        uris = JSON.parse(String(r.workspace_uris || "[]"));
      } catch {
        /* malformed */
      }
      out.set(String(r.conversation_id), {
        id: String(r.conversation_id),
        cwd: Array.isArray(uris) && uris.length > 0 ? fileUriToPath(String(uris[0])) : null,
        title: String(r.title || r.preview || "").trim() || null,
        endedAt: r.last_modified_time ? String(r.last_modified_time) : null,
      });
    }
  } catch {
    // database locked or schema changed: fall back to last_conversations.json
  } finally {
    try {
      db?.close();
    } catch {
      /* best effort */
    }
    process.emitWarning = emit;
  }
  return out;
}

const FORMAT_OF_SOURCE: Record<string, string> = {
  "claude-code": "claude-code",
  codex: "codex",
  gemini: "gemini-history",
  grok: "grok",
  agy: "antigravity",
  cursor: "cursor",
};

function convertOne(entry: Entry, opts: { sidechains?: boolean }): Session | null {
  const raw = fs.readFileSync(entry.file, "utf8");
  const format = FORMAT_OF_SOURCE[entry.source] ?? detectFormat(raw);
  if (!format) return null;
  let meta = entry.meta ?? null;
  // A grok chat_history.jsonl named with --file: read the summary.json next to it as well
  if (!meta && format === "grok") meta = grokMeta(path.join(path.dirname(entry.file), "summary.json"), null, null);
  const s = parseSession(raw, format, { ...opts, meta: meta ?? undefined });
  if (!s.id) s.id = path.basename(entry.file).replace(/\.[^.]+$/, "");
  // cursor sub-agent transcripts have no meta.json; the parent writes the working folder on the first line
  if (!s.cwd && s.source === "cursor") {
    const first = s.turns.find((t) => t.role === "user")?.text ?? "";
    const m = /^Working directory: (\S.*?)\s*$/m.exec(first.split("\n")[0]);
    if (m && (path.win32.isAbsolute(m[1]) || m[1].startsWith("/"))) s.cwd = m[1];
  }
  return s;
}

/** Matching key of an original transcript path (Windows paths ignore case and slash direction). */
const originKey = (p: string): string => (/^[A-Za-z]:[\\/]|^\\\\/.test(p) ? path.win32.normalize(p).toLowerCase() : path.posix.normalize(p));

const gitRootCache = new Map<string, string | null>();
/** Walks up from dir to a folder holding .git (existing paths on this machine only; null when there is none). */
function gitRootOf(dir: string): string | null {
  const cached = gitRootCache.get(dir);
  if (cached !== undefined) return cached;
  if (/^\\\\|^\/\//.test(dir)) return null; // UNC / network paths: a disconnected share can stall every stat
  let found: string | null = null;
  let cur = dir;
  for (let i = 0; i < 32; i++) {
    try {
      if (fs.existsSync(path.join(cur, ".git"))) {
        found = cur;
        break;
      }
    } catch {
      /* unreadable */
    }
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  gitRootCache.set(dir, found);
  return found;
}

const bucketContext = (): BucketContext => ({
  home: os.homedir(),
  tmpDir: os.tmpdir(),
  runsDir: path.join(existingHome() ?? homePath(), HOME_LAYOUT.runs),
  gitRoot: gitRootOf,
});

/** Session → archive folder (delegated tasks first, the rest by cwd). */
const bucketOf = (s: Session, ctx: BucketContext): string => (isDelegationSession(s) ? BUCKET_DELEGATION : projectBucket(s.cwd, ctx));

interface ArchiveHead {
  source: string | null;
  id: string | null;
  turns: number | null;
  ended: string | null;
  importedAt: string | null;
  origin: string | null;
  project: string | null;
}

/** Header fields used for matching (freshly rendered and on-disk archives are parsed the same way, so they compare fairly). */
function parseArchiveHead(text: string): ArchiveHead {
  const src = /^- source: (\S+)(?: · id `([^`]+)`)?/m.exec(text);
  const turns = /turns: (\d+) user \/ (\d+) assistant/.exec(text);
  const time = /^- time: (.+?) → (.+?) · /m.exec(text);
  const imp = /^- imported: (\d{4}-\d\d-\d\d \d\d:\d\d)(?: · original transcript: `([^`]+)`)?/m.exec(text);
  const proj = /^- project: (.+?)(?: \(branch .*\))?$/m.exec(text);
  return {
    source: src?.[1] ?? null,
    id: src?.[2] ?? null,
    turns: turns ? Number(turns[1]) + Number(turns[2]) : null,
    ended: time?.[2]?.trim() ?? null,
    importedAt: imp?.[1] ?? null,
    origin: imp?.[2] ?? null,
    project: proj?.[1]?.trim() ?? null,
  };
}

interface Archive extends ArchiveHead {
  rel: string;
  name: string;
  dir: string;
  mtimeMs: number;
}

/** Archives in the archive folder: its top level plus one level of project folders (not _prompts; links not followed). */
function scanArchives(root: string, outRel: string): Archive[] {
  const out: Archive[] = [];
  const visit = (relDir: string, depth: number): void => {
    let ents: fs.Dirent[] = [];
    try {
      ents = fs.readdirSync(resolveScoped(root, relDir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const rel = `${relDir}/${e.name}`;
      if (e.isDirectory()) {
        if (depth === 0 && e.name !== PROMPTS_DIR) visit(rel, 1);
        continue;
      }
      if (!e.isFile() || !e.name.endsWith(".md") || e.name === INDEX) continue;
      try {
        const abs = resolveScoped(root, rel);
        const fd = fs.openSync(abs, "r");
        const buf = Buffer.alloc(4096);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);
        out.push({ rel, name: e.name, dir: relDir, mtimeMs: fs.statSync(abs).mtimeMs, ...parseArchiveHead(buf.toString("utf8", 0, n)) });
      } catch {
        /* unreadable: left out */
      }
    }
  };
  visit(outRel, 0);
  return out;
}

/** Whether an archive is unchanged since import: by its checksum line; without one, mtime no later than import + 10 minutes. */
function archiveIsPristine(root: string, arch: Archive): boolean {
  let text: string;
  try {
    text = fs.readFileSync(resolveScoped(root, arch.rel), "utf8");
  } catch {
    return false;
  }
  const verdict = archiveUntouched(text);
  if (verdict !== null) return verdict;
  if (!arch.importedAt) return false;
  const [d, t] = arch.importedAt.split(" ");
  const [y, mo, da] = d.split("-").map(Number);
  const [h, mi] = t.split(":").map(Number);
  const imported = new Date(y, mo - 1, da, h, mi).getTime();
  return arch.mtimeMs <= imported + 10 * 60 * 1000;
}

/** Archive body (after the header's rule). */
const bodyOf = (md: string): string => {
  const t = md.replace(/\r\n/g, "\n");
  const i = t.indexOf("\n---\n");
  return i === -1 ? t : t.slice(i + 5);
};
/**
 * Whether a new rendering may replace an old archive: the old body except its last turn must be a verbatim prefix of
 * the new body (the last turn may still be growing), and the new body is not shorter. When the transcript was
 * rewritten, compacted or truncated upstream, or the redaction rules changed, they do not match: the old archive is
 * kept, rather not refreshed than text lost.
 */
function coversArchive(oldMd: string, newMd: string): boolean {
  const a = bodyOf(oldMd);
  const b = bodyOf(newMd);
  if (a === b) return true;
  const lastTurn = a.lastIndexOf("\n## ");
  const stable = lastTurn > 0 ? a.slice(0, lastTurn) : "";
  if (!b.startsWith(stable) || b.length < a.length) return false;
  // The start of the last turn's text must still be there. Skip the heading line (its time may change) and the
  // [tools] tally (the counts grow with the turn, and continued text is inserted before it).
  const lastBody = a
    .slice(lastTurn + 1)
    .split("\n")
    .slice(1)
    .filter((l) => !l.startsWith("> [tools] "))
    .join("\n")
    .trim()
    .slice(0, 400);
  return lastBody === "" || b.slice(stable.length).includes(lastBody);
}

/** A name that is free in its folder: on a clash, a short hash of the original path goes before .md. */
function freeName(root: string, dirRel: string, name: string, origin: string | null, taken: Set<string>): string {
  const busy = (n: string): boolean => {
    if (taken.has(`${dirRel}/${n}`)) return true;
    try {
      resolveScoped(root, `${dirRel}/${n}`);
      return true;
    } catch {
      return false;
    }
  };
  if (!busy(name)) return name;
  let h = 0;
  for (const c of String(origin ?? name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const tag = h.toString(16).padStart(8, "0").slice(0, 6);
  for (let i = 0; i < 100; i++) {
    const n = name.replace(/\.md$/, `-${tag}${i ? `-${i}` : ""}.md`);
    if (!busy(n)) return n;
  }
  throw new Error(`cannot find a free archive name: ${dirRel}/${name}`);
}

const localStamp = (): string => {
  const now = new Date();
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}`;
};

/** First line of the first user messages of an archive (the index's first message, and the delegation check). */
function firstUserLines(text: string, n = 3): string[] {
  const out: string[] = [];
  let i = text.indexOf("\n## User");
  while (i !== -1 && out.length < n) {
    const after = text
      .slice(i)
      .split("\n")
      .slice(1)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    if (after[0]) out.push(after[0]);
    i = text.indexOf("\n## User", i + 1);
  }
  return out;
}

/** Whether an archive that cannot be re-rendered is a delegated task, judged by its body. */
const archiveLooksDelegated = (text: string): boolean => firstUserLines(text).some((l) => l.startsWith(DELEGATION_PROMPT_FIRST_LINE));

/** A table cell: cut first, then escape `|`, so a cut never leaves half an escape. */
const cell = (s: string, max: number): string => s.slice(0, max).replace(/\|/g, "\\|");

/**
 * Session index across agents: reads the header of every archive (title, source, time, turns, first user message)
 * and writes `<out>/index.md` (projects, then every archive newest first) plus an `index.md` in each project folder.
 * An agent looking for past work scans this page first, then searches the archives.
 */
function buildSessionIndex(root: string, outRel: string): { path: string; count: number; groups: number } | null {
  try {
    resolveScoped(root, outRel);
  } catch {
    return null;
  }
  interface Row {
    name: string;
    bucket: string;
    time: string;
    source: string;
    title: string;
    turns: string;
    used: string;
    mix: string;
    first: string;
  }
  const rows: Row[] = [];
  for (const arch of scanArchives(root, outRel)) {
    let full = "";
    try {
      full = fs.readFileSync(resolveScoped(root, arch.rel), "utf8").slice(0, 8 * 1024 * 1024);
    } catch {
      continue;
    }
    const text = full.slice(0, 8000); // header fields are at the start
    // Models of the sub-agent dispatches: every [dispatch] <type>/<model> line of the whole archive
    const mix = new Map<string, number>();
    for (const m of full.matchAll(/^> \[dispatch\] ([^/\n]+)\/([^\s·\n]+)/gm)) {
      const model = m[2].trim();
      if (model) mix.set(model, (mix.get(model) ?? 0) + 1);
    }
    const bucket = arch.dir === outRel ? "" : arch.dir.slice(outRel.length + 1);
    rows.push({
      name: arch.name,
      bucket,
      time: (/^- time: ([^·\n]+)/m.exec(text)?.[1] ?? "").trim().split(" → ")[0] || arch.name.slice(0, 13),
      source: (/^- source: ([^·\n]+)/m.exec(text)?.[1] ?? "?").trim(),
      title: cell((/^# Session: (.*)$/m.exec(text)?.[1] ?? arch.name).trim(), 60),
      turns: (/turns: ([^·\n]+)/m.exec(text)?.[1] ?? "").trim(),
      used: /^- main-agent usage: (\d+) tokens/m.exec(text)?.[1] ?? "—",
      mix:
        [...mix.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => `${k}×${v}`)
          .join(" · ") || "—",
      // Redacted here too: an archive written with --no-redact must not carry a secret into the index
      first: cell(redactText(firstUserLines(text, 1)[0] ?? "").text, 80),
    });
  }
  // Newest first: archive names start with YYYYMMDD-HHMM; same minute → by project, then name, stably
  rows.sort((x, y) => y.name.slice(0, 13).localeCompare(x.name.slice(0, 13)) || x.bucket.localeCompare(y.bucket) || y.name.localeCompare(x.name));
  const row = (r: Row, href: string, withBucket: boolean): string =>
    `| ${r.time} | ${r.source} | [${r.title}](${href}) | ${r.turns} | ${r.used} | ${r.mix} | ${r.first} |${withBucket ? ` ${r.bucket || "—"} |` : ""}`;

  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    if (!groups.has(r.bucket)) groups.set(r.bucket, []);
    groups.get(r.bucket)!.push(r);
  }
  const named = [...groups.entries()].filter(([b]) => b !== "");
  // Projects: real projects with the most archives first, special folders (leading underscore) last
  named.sort((x, y) => Number(x[0].startsWith("_")) - Number(y[0].startsWith("_")) || y[1].length - x[1].length || x[0].localeCompare(y[0]));
  const sourcesOf = (list: Row[]): string => {
    const m = new Map<string, number>();
    for (const r of list) m.set(r.source, (m.get(r.source) ?? 0) + 1);
    return [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v}`)
      .join(" · ");
  };
  const unfiled = groups.get("");
  const md = [
    "# Session index",
    "",
    `Conversations with every agent CLI, archived (${rows.length} archives, ${named.length} project folders; rebuilt by longkeep import-sessions, do not edit). To find what was said when: scan this page or a project folder's ${INDEX}, then search the archives for a keyword and open the hit. "Main-agent tokens" is what the main agent itself newly processed (input + output + cache creation, without the cache reads counted again every turn); "Sub-agent dispatches" is the models it handed work to.`,
    "",
    "## By project",
    "",
    "| Project | Archives | Latest | Sources |",
    "|---|---|---|---|",
    ...named.map(([b, list]) => `| [${b}](${b}/${INDEX}) | ${list.length} | ${list[0].time} | ${sourcesOf(list)} |`),
    ...(unfiled ? [`| (not filed; run --reorganize) | ${unfiled.length} | ${unfiled[0].time} | ${sourcesOf(unfiled)} |`] : []),
    "",
    `Special folders: \`${BUCKET_DELEGATION}\` = tasks delegated through Longkeep (their records are in the Longkeep home folder's ${HOME_LAYOUT.runs}/); \`_temp\` = sessions started in a temp folder; \`_misc\` = not in a project (drive root, home directory, app data); \`_unknown\` = the transcript has no working folder.`,
    "",
    "## All (newest first)",
    "",
    "| Time | Source | Title | Turns | Main-agent tokens | Sub-agent dispatches | First message | Project |",
    "|---|---|---|---|---|---|---|---|",
    ...rows.map((r) => row(r, r.bucket ? `${r.bucket}/${r.name}` : r.name, true)),
    "",
  ].join("\n");
  atomicWriteFile(resolveWritePathCreating(root, `${outRel}/${INDEX}`), md);
  for (const [b, list] of named) {
    const sub = [
      `# Session index · ${b}`,
      "",
      `${list.length} archives, newest first; rebuilt by longkeep import-sessions, do not edit. [← all projects](../${INDEX})`,
      "",
      "| Time | Source | Title | Turns | Main-agent tokens | Sub-agent dispatches | First message |",
      "|---|---|---|---|---|---|---|",
      ...list.map((r) => row(r, r.name, false)),
      "",
    ].join("\n");
    atomicWriteFile(resolveWritePathCreating(root, `${outRel}/${b}/${INDEX}`), sub);
  }
  return { path: `${outRel}/${INDEX}`, count: rows.length, groups: named.length };
}

const forkHeader = (forkOf: string[]): string => `⚠ possible fork or subset of → ${forkOf.join(", ")} (both are kept; a person decides)`;

/**
 * Tidies existing archives: files them into project folders; an archive whose transcript still exists and that
 * nobody edited is re-rendered with the current parser (title, project, turns, checksum follow); an edited one, or
 * one whose transcript is gone, only moves. The new location is written before the old one is removed, so no step
 * can lose an archive.
 */
function reorganize(root: string, a: Args, ctx: BucketContext): void {
  const archives = scanArchives(root, OUT);
  const byOrigin = new Map<string, Entry>();
  for (const e of discover("auto", a.project, true)) byOrigin.set(originKey(e.file), e);
  const stamp = localStamp();
  interface Plan {
    arch: Archive;
    entry: Entry | undefined;
    session: Session | null;
    bucket: string;
    file: string;
    forkOf?: string[];
  }
  const plans: Plan[] = [];
  for (const arch of archives) {
    const entry = arch.origin ? byOrigin.get(originKey(arch.origin)) : undefined;
    let session: Session | null = null;
    if (entry && entry.size <= MAX_RAW && archiveIsPristine(root, arch)) {
      try {
        const s = convertOne(entry, { sidechains: a.sidechains });
        if (s && s.turns.length > 0) session = s;
      } catch {
        /* cannot re-render: moved only */
      }
    }
    let bucket: string;
    if (session) bucket = bucketOf(session, ctx);
    else {
      let text = "";
      try {
        text = fs.readFileSync(resolveScoped(root, arch.rel), "utf8").slice(0, 64 * 1024);
      } catch {
        /* unreadable */
      }
      bucket = archiveLooksDelegated(text) ? BUCKET_DELEGATION : projectBucket(arch.project, ctx);
    }
    plans.push({ arch, entry, session, bucket, file: session ? suggestFileName(session) : arch.name });
  }
  // Fork flags are recomputed among re-renderable sessions only
  const live = plans.filter((p) => p.session);
  for (const x of live) for (const y of live) if (x !== y && isSubsetSession(x.session!, y.session!)) (x.forkOf ??= []).push(y.file);

  const taken = new Set<string>();
  let moved = 0;
  let rerendered = 0;
  let kept = 0;
  const diverged: string[] = [];
  const redactionTally = new Map<string, number>();
  for (const p of plans) {
    // Render before naming: when the transcript no longer matches the archive, move only; no rename, no new content
    let md: string | null = null;
    if (p.session && p.entry) {
      const rendered = renderMarkdown(p.session, {
        importedAt: p.arch.importedAt ?? stamp, // "imported" is the first import, a refresh keeps it
        originPath: p.entry.file,
        extraHeader: p.forkOf ? [forkHeader(p.forkOf)] : [],
      });
      const red = a.redact ? redactText(rendered) : { text: rendered, redactions: [] };
      let old = "";
      try {
        old = fs.readFileSync(resolveScoped(root, p.arch.rel), "utf8");
      } catch {
        /* unreadable */
      }
      if (coversArchive(old, red.text)) {
        md = red.text;
        for (const { type } of red.redactions) redactionTally.set(type, (redactionTally.get(type) ?? 0) + 1);
      } else {
        diverged.push(p.arch.rel);
        p.file = p.arch.name;
      }
    }
    const dirRel = `${OUT}/${p.bucket}`;
    const sameDir = p.arch.dir === dirRel;
    let name = p.file;
    if (!(sameDir && name === p.arch.name)) name = freeName(root, dirRel, name, p.arch.origin, taken);
    const rel = `${dirRel}/${name}`;
    taken.add(rel);
    if (md !== null) {
      atomicWriteFile(resolveWritePathCreating(root, rel), withChecksum(md));
      rerendered++;
      if (rel !== p.arch.rel) {
        fs.unlinkSync(resolveScoped(root, p.arch.rel)); // unlinkSync for single files (rmSync can crash Node 24 on Windows)
        moved++;
      }
    } else if (rel !== p.arch.rel) {
      const src = resolveScoped(root, p.arch.rel);
      const dst = resolveWritePathCreating(root, rel);
      fs.renameSync(src, dst);
      moved++;
    } else kept++;
  }
  // Remove project folders that were emptied (empty folders only)
  for (const e of readdirEntries(resolveScoped(root, OUT))) {
    if (!e.isDirectory() || e.name === PROMPTS_DIR) continue;
    try {
      const dirAbs = resolveScoped(root, `${OUT}/${e.name}`);
      const left = fs.readdirSync(dirAbs).filter((n) => n !== INDEX);
      if (left.length === 0) {
        try {
          fs.unlinkSync(resolveScoped(root, `${OUT}/${e.name}/${INDEX}`));
        } catch {
          /* no index */
        }
        fs.rmdirSync(dirAbs);
      }
    } catch {
      /* not empty or not accessible */
    }
  }
  const r = buildSessionIndex(root, OUT);
  console.log(`Reorganized ${archives.length} archives: re-rendered ${rerendered}, moved or renamed ${moved}, kept as they were ${kept}.`);
  if (redactionTally.size > 0) console.log(`Redacted ${[...redactionTally.values()].reduce((x, y) => x + y, 0)} items while re-rendering.`);
  if (diverged.length > 0) {
    console.log(
      `⚠ ${diverged.length} transcripts no longer match the start of their archive (rewritten or compacted upstream, or the redaction rules changed); moved only, content kept:`,
    );
    for (const d of diverged) console.log(`  - ${d}`);
  }
  if (r) console.log(`Rebuilt ${r.path} (${r.count} archives, ${r.groups} project folders)`);
}

const USAGE = `longkeep import-sessions: turns the local chat transcripts of agent CLIs into readable Markdown archives
in the Longkeep home folder (~/.longkeep, or LONGKEEP_HOME): ${OUT}/<project>/.

  longkeep import-sessions [--project <dir>] [--source auto] [--list]

Options:
  --project <dir>   import only sessions that worked in this folder (default: the current folder; sessions with an
                    unknown working folder are skipped)
  --all-projects    import the sessions of every project on this machine, including those with no known folder;
                    mind what one project should see of another
  --source <s>      auto | claude-code | codex | gemini | grok | agy | cursor | file (default auto: whatever is found)
                    where each CLI keeps them: claude-code ~/.claude/projects/<project slug>/*.jsonl (per --project);
                    codex ~/.codex/sessions/** and archived_sessions; gemini ~/.gemini/tmp/<hash>/chats;
                    grok ~/.grok/sessions/<encoded cwd>/<id>/chat_history.jsonl (+ summary.json);
                    agy ~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript_full.jsonl;
                    cursor ~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl (+ ~/.cursor/chats/<hash>/<id>/meta.json)
  --file <path>     import one transcript file (name its format with --source, or let it be detected)
  --list            list the sessions that would be imported; write nothing
  --index           only rebuild the indexes (${OUT}/${INDEX} and each project folder's ${INDEX})
  --reorganize      tidy existing archives: file them into project folders and re-render, with the current parser,
                    those nobody edited (title, project and turns follow)
  --limit <N>       import at most N archives (newest first)
  --force           rewrite archives that were already imported, including edited ones
  --sidechains      include sub-agent transcripts (skipped by default)
  --prompts         also write three distilled books: ${PROMPTS_DIR}/USER_PROMPTS.md (user messages verbatim),
                    AGENT_PROMPTS.md (dispatch prompts), USER_RULES.md (rule paragraphs by regex: a hit, not a summary;
                    a person judges them)
  --no-redact       turn redaction off (on by default: allowlisted patterns, high-entropy tokens on keyword lines, a
                    list of suspects)

Filing: archives go to ${OUT}/<project>/ (the git root's folder name, or the project-level folder; worktrees go
  back to their main repository; tasks delegated through Longkeep → ${BUCKET_DELEGATION}, temp folders → _temp, drive root /
  home directory / app data → _misc, no working folder → _unknown).
Idempotent: an archive is matched by its original transcript path (forked threads with the same session id are
  separate archives), and by session id when the archive has no path.
Continued sessions: when a session grew after import (more turns or a later end), its archive is refreshed in place.
  The checksum line in the header proves the archive was not edited since; an edited archive is not overwritten
  but listed (--force overwrites it).
Fork detection: when one session's user messages are a strict subset of another's, its header says so; both stay.
Redaction is best effort: review the suspects before sharing anything, and rotate any key that slipped through.`;

export async function importSessions(argv: string[]): Promise<number> {
  const a = parseArgs(argv);
  if (typeof a === "number") return a;
  if (a.help) {
    console.log(USAGE);
    return 0;
  }
  const ctx = bucketContext();

  if (a.indexOnly) {
    const existing = existingHome();
    const r = existing ? buildSessionIndex(existing, OUT) : null;
    console.log(r ? `Rebuilt ${r.path} (${r.count} archives, ${r.groups} project folders)` : `No ${OUT}/ folder in the Longkeep home folder.`);
    return 0;
  }
  if (a.reorganize) {
    const existing = existingHome();
    let present = false;
    try {
      if (existing) present = Boolean(resolveScoped(existing, OUT));
    } catch {
      /* no archive folder */
    }
    if (!existing || !present) {
      console.log(`No ${OUT}/ folder in the Longkeep home folder.`);
      return 0;
    }
    reorganize(existing, a, ctx);
    return 0;
  }

  const entries: Entry[] = a.file
    ? [{ file: path.resolve(a.file), source: a.source === "auto" || a.source === "file" ? "file" : a.source, mtime: 0, size: fs.statSync(path.resolve(a.file)).size }]
    : discover(a.source, a.project, a.allProjects);

  if (entries.length === 0) {
    console.log("No sessions found to import (is --project the folder the agent worked in?).");
    return 0;
  }

  // Phase one: parse everything (fork detection needs the user-message hashes of every session)
  interface Converted {
    entry: Entry;
    session: Session;
    file: string;
    forkOf?: string[];
    /** The session's archive relative to the archive folder (`<project>/<name>.md`), once known. */
    archived?: string;
  }
  const converted: Converted[] = [];
  let skipped = 0;
  let skippedProject = 0;
  const normalizeProject = (value: string): string =>
    /^[A-Za-z]:[\\/]/.test(value) ? path.win32.normalize(value).replace(/[\\/]+$/, "").toLowerCase() : path.resolve(value);
  for (const e of entries) {
    if (e.size > MAX_RAW) {
      console.log(`Skipped (over ${MAX_RAW / 1024 / 1024} MB): ${e.file}`);
      skipped++;
      continue;
    }
    try {
      const s = convertOne(e, { sidechains: a.sidechains });
      // Discovery spans the whole account; an unknown cwd never means consent to mix projects.
      // An explicit --file or --all-projects is the user's deliberate choice of sources.
      if (s && !a.file && !a.allProjects && (!s.cwd || normalizeProject(s.cwd) !== normalizeProject(a.project))) {
        skippedProject++;
        skipped++;
        continue;
      }
      if (s && s.turns.length > 0) converted.push({ entry: e, session: s, file: suggestFileName(s) });
      else skipped++;
    } catch (err) {
      console.error(`Could not parse ${e.file}: ${err instanceof Error ? err.message : String(err)}`);
      skipped++;
    }
  }

  // Fork flags: A ⊊ B ⇒ A's header says "possible fork or subset"; both are kept
  for (const x of converted) {
    for (const y of converted) {
      if (x !== y && isSubsetSession(x.session, y.session)) (x.forkOf ??= []).push(y.file);
    }
  }

  // --list writes nothing, so it does not create the home folder either
  const root = a.list ? existingHome() : ensureHome();

  // Matching: existing archives are claimed by original transcript path (forked threads with the same session id
  // are different transcript files, one archive each); an archive without a path falls back to the session id.
  // Comparing only the 8 id characters of file names would mistake time-ordered UUIDv7 ids for imported ones.
  const archives = root ? scanArchives(root, OUT) : [];
  const archByOrigin = new Map<string, Archive>();
  const archById = new Map<string, Archive[]>();
  for (const arch of archives) {
    if (arch.origin) archByOrigin.set(originKey(arch.origin), arch);
    if (arch.id) {
      if (!archById.has(arch.id)) archById.set(arch.id, []);
      archById.get(arch.id)!.push(arch);
    }
  }
  const baseOf = (p: string): string => (p.replace(/\\/g, "/").split("/").pop() ?? "").toLowerCase();
  /** Same original path, else same id and (no recorded path / same file name in another folder, as when codex archives a rollout / original gone). */
  const findArchive = (x: Converted): Archive | undefined => {
    const hit = archByOrigin.get(originKey(x.entry.file));
    if (hit) return hit;
    const base = baseOf(x.entry.file);
    return (x.session.id ? (archById.get(x.session.id) ?? []) : []).find((c) => !c.origin || baseOf(c.origin) === base || !fs.existsSync(c.origin));
  };

  // Phase two: render + redact + write (new sessions into their project folder; grown sessions refreshed in place)
  const stamp = localStamp();
  const redactionTally = new Map<string, number>();
  const allSuspects: string[] = [];
  const taken = new Set<string>();
  const touched: string[] = [];
  const diverged: string[] = [];
  const versioned: string[] = [];
  let indexDirty = false;
  let done = 0;
  let refreshed = 0;
  for (const x of converted) {
    if (done >= a.limit) break;
    const arch = findArchive(x);
    if (arch) x.archived = arch.rel.slice(OUT.length + 1);
    if (a.list || !root) {
      const fork = x.forkOf ? `  ⚠ possible fork → ${x.forkOf[0]}` : "";
      const state = arch ? `  [archived ${arch.rel.slice(OUT.length + 1)}]` : `  [new → ${bucketOf(x.session, ctx)}]`;
      console.log(`${x.file}  ← ${x.entry.source}  ${x.session.turns.length} turns  ${x.entry.file}${fork}${state}`);
      done++;
      continue;
    }
    let md = renderMarkdown(x.session, {
      importedAt: arch?.importedAt ?? stamp, // "imported" is the first import; a refresh keeps it
      originPath: x.entry.file,
      extraHeader: x.forkOf ? [forkHeader(x.forkOf)] : [],
    });
    const fresh = parseArchiveHead(md);
    const red = a.redact ? redactText(md) : { text: md, redactions: [], suspects: [] };
    md = red.text;
    let rel: string;
    if (arch) {
      const grown =
        (fresh.turns ?? 0) > (arch.turns ?? 0) ||
        (fresh.turns === arch.turns && fresh.ended && arch.ended && fresh.ended !== "?" && fresh.ended > arch.ended);
      if (!a.force && !grown) {
        skipped++;
        continue;
      }
      if (!a.force && !archiveIsPristine(root, arch)) {
        touched.push(`${arch.rel} (archive ${arch.turns ?? "?"} turns, transcript now ${fresh.turns} turns)`);
        skipped++;
        continue;
      }
      if (!a.force) {
        let old = "";
        try {
          old = fs.readFileSync(resolveScoped(root, arch.rel), "utf8");
        } catch {
          /* unreadable */
        }
        if (!coversArchive(old, md)) {
          // The start no longer matches (most likely rewritten or compacted upstream): when the transcript has more
          // turns it wins and the old archive moves to _previous/ in the same folder; a changed end time alone
          // changes nothing.
          if ((fresh.turns ?? 0) <= (arch.turns ?? 0)) {
            diverged.push(`${arch.rel} (archive ${arch.turns ?? "?"} turns, transcript ${fresh.turns} turns, the start does not match)`);
            skipped++;
            continue;
          }
          const keepDir = `${arch.dir}/${PREVIOUS_DIR}`;
          const keep = `${keepDir}/${freeName(root, keepDir, arch.name, arch.origin, taken)}`;
          fs.renameSync(resolveScoped(root, arch.rel), resolveWritePathCreating(root, keep));
          taken.add(keep);
          versioned.push(`${arch.rel} (${arch.turns ?? "?"} → ${fresh.turns} turns; previous archive → ${keep.slice(OUT.length + 1)})`);
        }
      }
      rel = arch.rel; // refreshed in place, never moved (moving is --reorganize's job)
    } else {
      const dirRel = `${OUT}/${bucketOf(x.session, ctx)}`;
      rel = `${dirRel}/${freeName(root, dirRel, x.file, x.entry.file, taken)}`;
    }
    for (const { type } of red.redactions) redactionTally.set(type, (redactionTally.get(type) ?? 0) + 1);
    for (const s of red.suspects) allSuspects.push(`${rel.slice(OUT.length + 1)}: ${s}`);
    atomicWriteFile(resolveWritePathCreating(root, rel), withChecksum(md));
    taken.add(rel);
    x.archived = rel.slice(OUT.length + 1);
    if (arch) {
      refreshed++;
      console.log(`Refreshed: ${rel} (${arch.turns ?? "?"} → ${fresh.turns} turns)`);
    } else console.log(`Imported: ${rel} (${x.session.turns.length} turns)`);
    indexDirty = true;
    done++;
  }

  // Distilled books cover every parsed session, not only the ones imported now: the books are a full view
  if (a.prompts && !a.list && root && converted.length > 0) {
    // Links point at each archive's real path (project folder included); sessions past --limit may have none
    for (const x of converted) x.archived ??= findArchive(x)?.rel.slice(OUT.length + 1);
    const books = buildPromptBooks(converted.map((x) => ({ session: x.session, file: x.archived ?? null })));
    const write = (name: string, content: string): void => {
      const body = a.redact ? redactText(content) : { text: content, redactions: [], suspects: [] };
      for (const { type } of body.redactions) redactionTally.set(type, (redactionTally.get(type) ?? 0) + 1);
      for (const s of body.suspects) allSuspects.push(`${PROMPTS_DIR}/${name}: ${s}`);
      atomicWriteFile(resolveWritePathCreating(root, `${OUT}/${PROMPTS_DIR}/${name}`), body.text);
      console.log(`Wrote: ${OUT}/${PROMPTS_DIR}/${name}`);
    };
    write("USER_PROMPTS.md", books.userPromptsMd);
    write("AGENT_PROMPTS.md", books.agentPromptsMd);
    write("USER_RULES.md", books.rulesMd);
    console.log(`Distilled: ${books.counts.user} user prompts · ${books.counts.agent} dispatches · ${books.counts.rules} rule paragraphs`);
  }

  if (indexDirty && !a.list && root) {
    const r = buildSessionIndex(root, OUT);
    if (r) console.log(`Rebuilt ${r.path} (${r.count} archives, ${r.groups} project folders)`);
  }
  console.log(`Done: ${a.list ? `listed ${done}` : `imported ${done - refreshed}, refreshed ${refreshed}`}, skipped ${skipped}.`);
  if (touched.length > 0) {
    console.log(
      `⚠ ${touched.length} archives were edited after import; their sessions have new content but were not overwritten (--force overwrites them; or move your edits elsewhere first):`,
    );
    for (const t of touched.slice(0, 20)) console.log(`  - ${t}`);
  }
  if (versioned.length > 0) {
    console.log(`${versioned.length} sessions were rewritten by the CLI that keeps them but have more content: refreshed from the transcript, previous archives kept in ${PREVIOUS_DIR}/:`);
    for (const t of versioned.slice(0, 20)) console.log(`  - ${t}`);
  }
  if (diverged.length > 0) {
    console.log(
      `⚠ ${diverged.length} sessions no longer match the start of their archive and are not longer than it (rewritten or compacted upstream, or the redaction rules changed); archives kept unrefreshed (--force rewrites them from the transcript):`,
    );
    for (const t of diverged.slice(0, 20)) console.log(`  - ${t}`);
  }
  if (skippedProject)
    console.log(`${skippedProject} of the skipped belong to other projects or have no known project. To import one, name it with --file; --all-projects includes every project.`);
  if (a.redact && !a.list) {
    if (redactionTally.size > 0) {
      const parts = [...redactionTally.entries()].map(([t, n]) => `${t}×${n}`);
      console.log(`Redacted ${[...redactionTally.values()].reduce((x, y) => x + y, 0)} items (${parts.join(" · ")}).`);
    } else console.log("Redaction: no allowlist or keyword-line hits.");
    if (allSuspects.length > 0) {
      console.log(`⚠ ${allSuspects.length} possible high-entropy tokens (not replaced; review them before sharing anything):`);
      for (const s of allSuspects.slice(0, 20)) console.log(`  - ${s}`);
    }
  }
  return 0;
}
