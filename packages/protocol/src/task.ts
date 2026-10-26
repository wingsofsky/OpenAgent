/**
 * Task file: the plain-text header and brief of one record, `runs/<project-key>/<task-id>/task.md`.
 *
 * Plain text: a task is ordinary Markdown, readable with `cat` and editable in any
 * editor; this module is its only parser and serializer.
 *
 * ```markdown
 * # Task: Fix broken links
 *
 * status: pending                ← pending | in_progress | done
 * created: 2026-08-24 10:15
 * issuer: alice
 * target: docs/guide.md
 * snapshot: a1b2c3d4e5
 * executor: codex                ← which local agent the task is delegated to
 * session: codex:<session id>    ← the executor's resume handle (for follow-up rounds)
 * usage: 1234 tokens             ← token usage reported by the executor (total over all rounds)
 * writeback: handbook            ← when done, the answer is appended to this document as a suggestion tagged with the executor's name
 * completed: 2026-08-24 22:10    ← written when the round finishes
 * outcome: no_changes            ← how the round ended, written by the runner from fingerprints (OUTCOMES)
 * acceptance: pending            ← changed only after the main agent checks (ACCEPTANCES); done ≠ accepted
 *
 * ---
 *
 * The brief (free Markdown)
 * ```
 *
 * The first non-blank line must be a `# ` title (the `Task:` prefix is optional); header lines run up to the first
 * `---`. Keys are case-insensitive; unrecognised header lines are kept as written (fields people add by hand are never
 * lost). Line endings: CRLF (Windows checkout, Notepad) and a UTF-8 BOM parse normally; serializing keeps the file's
 * line-ending style.
 */
import { detectEol, withEol } from "./eol.ts";

export const STATUSES = ["pending", "in_progress", "done"] as const;
export type TaskStatus = (typeof STATUSES)[number];

/**
 * How a delegation round ended. The three normal exits depend on whether the working folder differs before and
 * after the round (a fingerprint of files and git state, not what the model says); the rest are failure classes.
 * Recorded separately from status, which stays pending / in_progress / done.
 */
export const OUTCOMES = ["changed", "no_changes", "unchecked", "failed", "timeout", "stalled", "spawn_failed", "stopped"] as const;
export type TaskOutcome = (typeof OUTCOMES)[number];
/** Display labels for people; the file always holds the enum value */
export const OUTCOME_LABEL: Record<TaskOutcome, string> = {
  changed: "changed",
  no_changes: "no changes",
  unchecked: "changes not checked",
  failed: "failed",
  timeout: "timed out",
  stalled: "stalled",
  spawn_failed: "failed to start",
  stopped: "stopped",
};

/**
 * Acceptance: after a normal exit the runner only writes pending; the other three are written by the main agent after
 * checking the diff and tests, followed by (who, when).
 */
export const ACCEPTANCES = ["pending", "accepted", "needs_rework", "rejected"] as const;
export type TaskAcceptance = (typeof ACCEPTANCES)[number];
/** Display labels for people; the file always holds the enum value */
export const ACCEPTANCE_LABEL: Record<TaskAcceptance, string> = {
  pending: "awaiting review",
  accepted: "accepted",
  needs_rework: "needs rework",
  rejected: "rejected",
};

/** Status, outcome, acceptance verdict: normalized to the enum value; null when unknown */
export const normalizeStatus = (v: string): TaskStatus | null => known(STATUSES, v.trim());
export const normalizeOutcome = (v: string): TaskOutcome | null => known(OUTCOMES, v.trim());
export const normalizeAcceptance = (v: string): TaskAcceptance | null => known(ACCEPTANCES, v.trim());
function known<T extends string>(list: readonly T[], v: string): T | null {
  return (list as readonly string[]).includes(v) ? (v as T) : null;
}

/** The verdict part of an acceptance value: "accepted (claude, 2026-10-17 12:00)" → "accepted"; null when empty */
export function acceptanceState(v: string | undefined): string | null {
  const s = (v ?? "").split("(")[0].trim();
  return s || null;
}

/** Writes an acceptance value: verdict + (who, when) */
export function acceptanceValue(state: TaskAcceptance, reviewer: string, at: string): string {
  return `${state} (${reviewer}, ${at})`;
}

/** An issuer or reviewer name: 1–32 characters, no whitespace, colon or braces (it lands in a header line and a mark) */
export const AUTHOR_RE = /^[^\s:{}]{1,32}$/;

/** Whether a value can be one header line (the title included): a line break would start a new header field */
export const isOneLine = (v: string): boolean => !/[\r\n]/.test(v);

export interface TaskDoc {
  /** Task id (the record folder name); filled when the source is known */
  id?: string;
  title: string;
  /** One of STATUSES; a non-standard value edited in by hand is kept as is */
  status: TaskStatus | string;
  /** When the task was issued */
  created?: string;
  /** Who issued it */
  issuer?: string;
  /** Target document */
  target?: string;
  /** Baseline snapshot id */
  snapshot?: string;
  /** Executor: which local agent the task is delegated to (codex / agy / grok…) */
  executor?: string;
  /** The executor's resume handle, such as codex:<uuid> */
  session?: string;
  /** Usage reported by the executor (free text, such as "1234 tokens") */
  usage?: string;
  /** Writeback target: when done, the answer is appended to this document as a CriticMarkup suggestion */
  writeback?: string;
  /** When the round finished */
  completed?: string;
  /** How the delegation round ended (OUTCOMES) */
  outcome?: TaskOutcome | string;
  /** Acceptance (ACCEPTANCES, optionally followed by (who, when)) */
  acceptance?: string;
  /** Unrecognised header lines, written back as they were */
  extras?: string[];
  /** Set by parseTask when the file was CRLF and kept by serializeTask (an edited task file stays CRLF); default LF */
  eol?: "\r\n";
  body: string;
}

type Field = Exclude<keyof TaskDoc, "id" | "title" | "extras" | "eol" | "body">;
/** Header keys, in serialization order */
const KEYS: Field[] = [
  "status",
  "created",
  "issuer",
  "target",
  "snapshot",
  "executor",
  "session",
  "usage",
  "writeback",
  "completed",
  "outcome",
  "acceptance",
];
const KEY_SET = new Set<string>(KEYS);

// The value carries no trailing whitespace (including a leftover \r from CRLF): without multiline mode `(.*)$` cannot
// swallow the \r, and the whole line would fall into extras
const HEADER_RE = /^([^\s:]{1,12}):\s*(.*?)\s*$/;

/** Parses a task file; null when it is not a task (no `# ` first line) */
export function parseTask(src: string, id?: string): TaskDoc | null {
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1); // UTF-8 BOM (older Notepad "save as")
  const lines = src.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  const first = lines[i];
  if (first === undefined || !first.startsWith("# ")) return null;
  const title = first
    .slice(2)
    .replace(/^Task:\s*/i, "")
    .trim();
  i++;

  const t: TaskDoc = { id, title, status: "pending", body: "" };
  if (detectEol(src) === "\r\n") t.eol = "\r\n";
  const extras: string[] = [];
  let sawRule = false;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "---") {
      sawRule = true;
      i++;
      break;
    }
    if (line.trim() === "") continue;
    const m = line.match(HEADER_RE);
    const key = m ? m[1].toLowerCase() : undefined;
    if (m && key && KEY_SET.has(key)) {
      (t as unknown as Record<string, string>)[key] = m[2].trim();
    } else {
      extras.push(line);
    }
  }
  if (extras.length > 0) t.extras = extras;
  if (sawRule) {
    // Drop the first blank line after the rule and the trailing newline (both produced by serializeTask); the rest of
    // the body stays as written, so parse(serialize(t)) is a stable round trip
    if (lines[i] === "") i++;
    t.body = lines.slice(i).join("\n").replace(/\n$/, "");
  }
  return t;
}

export function serializeTask(t: TaskDoc): string {
  if (!isOneLine(t.title)) throw new Error("the task title must be one line");
  const out: string[] = [`# Task: ${t.title}`, ""];
  for (const field of KEYS) {
    const v = t[field];
    if (field !== "status" && !v) continue;
    if (!isOneLine(String(v))) throw new Error(`the task's ${field} must be one line`);
    out.push(`${field}: ${v}`);
  }
  for (const line of t.extras ?? []) out.push(line);
  out.push("", "---", "");
  out.push(t.body);
  let s = out.join("\n");
  if (!s.endsWith("\n")) s += "\n";
  // One line-ending style per task file: CRLF / LF mixed into the body is normalized to the file's style
  return withEol(s, t.eol ?? "\n");
}

/** `2026-08-24 10:15`: local time zone, written for people */
export function formatStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Task id, the name of the record folder: `20260824-101512-Fix-broken-links` (the timestamp keeps ids ordered and unique) */
export function taskId(title: string, d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const slug = [...title]
    .map((c) => (/[\\/:*?"<>|#\s.]/.test(c) ? "-" : c))
    .join("")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24);
  return `${ts}-${slug || "task"}`;
}
