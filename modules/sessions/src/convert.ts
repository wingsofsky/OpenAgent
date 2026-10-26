/**
 * Session transcripts → readable Markdown archives. Pure functions, no IO (the command is import.ts).
 *
 * What is kept:
 *  - User messages verbatim, never paraphrased or truncated: they are the primary material for learning from past work.
 *  - Assistant messages keep their text only; ordinary tool calls fold into one tally line; thinking and tool output
 *    are never archived.
 *  - Sub-agent dispatches (Claude Code's Agent / Task tool) are the exception: the full prompt and the final reply
 *    (truncated) are kept, because a dispatch is an instruction worth keeping.
 *  - A record that cannot be recognised is dropped rather than guessed: an archive is a record, not a reconstruction.
 *
 * Supported transcripts: Claude Code, Codex, Gemini CLI (history checkpoints), Grok Build, Antigravity (agy),
 * Cursor Agent, plus generic JSON / JSONL with role + content.
 *
 * Archive format (one session per file, UTF-8, LF; `·` is U+00B7, `→` is U+2192):
 *
 *     # Session: <title>
 *
 *     - source: <claude-code|codex|gemini|grok|agy|cursor|generic>[ · id `<session id>`]
 *     - project: <working folder>[ (branch <git branch>)]                      (only when known)
 *     - model: <model>                                                         (only when known)
 *     - time: <start> → <end> · turns: <n> user / <n> assistant · tools <n> · dispatches <n>
 *     - main-agent usage: <n> tokens (fresh = input + output + cache creation; <n> cache-read tokens are counted
 *       again every turn and left out)                                        (one line; Claude Code only)
 *     - imported: <YYYY-MM-DD HH:MM>[ · original transcript: `<absolute path>`]
 *     - checksum: sha256:<16 hex>
 *     - ⚠ possible fork or subset of → <file>, <file> (both are kept; a person decides)   (only when detected)
 *
 *     > Imported by openagent import-sessions. …
 *
 *     ---
 *
 *     ## User · <MM-DD HH:MM>
 *
 *     <verbatim text>
 *
 *     ## Assistant · <MM-DD HH:MM>
 *
 *     <text>
 *
 *     > [dispatch] <subagent type>/<model>[ · <description>]
 *
 *     <details><summary>Dispatch prompt and reply</summary>
 *     ```text … prompt … ```   Reply:   ```text … reply … ```                 (``` inside is written as ˋˋˋ)
 *     </details>
 *
 *     > [tools] Read ×2 · Bash
 *
 * Times are local `YYYY-MM-DD HH:MM` (`?` when unknown); a turn heading has no time when it is unknown.
 * The checksum is the first 16 hex digits of the sha256 of the archive with LF line ends and without the checksum
 * line itself: it tells whether a person edited the archive after import (archiveUntouched).
 *
 * Index files (written by import.ts): `index.md` in the archive folder and in every project folder, tables with the
 * columns Time | Source | Title | Turns | Main-agent tokens | Sub-agent dispatches | First message (| Project).
 *
 * Distilled books (`--prompts`): USER_PROMPTS.md (every user message verbatim), AGENT_PROMPTS.md (dispatch
 * prompts), USER_RULES.md (paragraphs that match rule markers: a regex hit, not a summary; a person judges them).
 * Fork detection: one session's set of user-message hashes strictly inside another's; flagged, never deleted.
 *
 * Redaction (redactText): allowlisted secret patterns are replaced, high-entropy tokens on lines with a keyword
 * (key, token, password, …) are replaced, and other long mixed tokens are only listed as suspects. An allowlist
 * always misses something: a person reviews the suspects before anything is shared.
 * Titles are always redacted, also under --no-redact (a derived title is redacted before it is cut to 40
 * characters), and the file-name slug additionally turns any remaining key-like token into `redacted`: titles
 * reach file names, the index and listings.
 */
import crypto from "node:crypto";
import path from "node:path";
import { DELEGATION_FOLLOW_UP_HEADING, DELEGATION_PROMPT_FIRST_LINE, DELEGATION_TASK_HEADING } from "@openagent/protocol/delegation-prompt";

/** A parsed transcript record: untyped JSON written by another tool. */
type Rec = any;

interface AgentDispatch {
  id: string | null;
  description: string;
  subagentType: string;
  model: string;
  prompt: string;
  reply: string | null;
}

export interface Turn {
  role: "user" | "assistant";
  at: string | null;
  text: string;
  tools: Map<string, number>;
  agents: AgentDispatch[];
}

interface Usage {
  fresh: number;
  cached: number;
}

interface Parsed {
  source: string;
  id: string | null;
  title: string | null;
  cwd: string | null;
  branch: string | null;
  startedAt: string | null;
  endedAt: string | null;
  model: string | null;
  turns: Turn[];
  usage?: Usage;
}

export interface Session extends Parsed {
  title: string;
  /** md5 of every user message, for fork detection. */
  userHashes: Set<string>;
}

const META_KEYS = ["id", "title", "cwd", "branch", "startedAt", "endedAt", "model"] as const;
export type SessionMeta = Partial<Record<(typeof META_KEYS)[number], string | null>>;

type Format = "claude-code" | "codex" | "gemini-history" | "grok" | "antigravity" | "cursor" | "generic-jsonl" | "generic-json";

const CC_SKIP_TYPES = new Set([
  "attachment",
  "last-prompt",
  "atis-latch",
  "bridge-session",
  "queue-operation",
  "mode",
  "frame-link",
  "system",
  "summary",
  "ai-title",
  "custom-title",
]);

const AGENT_TOOL_NAMES = new Set(["Agent", "Task"]);
const AGENT_REPLY_CAP = 12000;
const AGENT_PROMPT_CAP = 20000;

/** Harness noise (slash command expansion, local command echo): not something a person typed. */
const CC_NOISE_RE = /^\s*(<command-name>|<local-command-stdout>|<local-command-stderr>|Caveat: )/;
/** A message that is only an injected system reminder is skipped; mixed with real text it is kept whole. */
const REMINDER_ONLY_RE = /^\s*<system-reminder>[\s\S]*<\/system-reminder>\s*$/;

/**
 * Words in other languages that users type, built from code points so the source stays English-only.
 * Chinese, in order: forbid, don't, not allowed, cannot, must, without exception, forever, remember, from now on,
 * red line, rule, note, never again, not permitted, only, by all means, constant, default, priority, convention,
 * may not, be sure to, must (formal), redo.
 */
const words = (...codes: number[][]): string[] => codes.map((c) => String.fromCodePoint(...c));
const ZH_RULE_MARKERS = words(
  [0x7981, 0x7528],
  [0x4e0d, 0x8981],
  [0x4e0d, 0x8bb8],
  [0x4e0d, 0x80fd],
  [0x5fc5, 0x987b],
  [0x4e00, 0x5f8b],
  [0x6c38, 0x8fdc],
  [0x8bb0, 0x4f4f],
  [0x4ee5, 0x540e],
  [0x7ea2, 0x7ebf],
  [0x89c4, 0x5219],
  [0x6ce8, 0x610f],
  [0x522b, 0x518d],
  [0x4e0d, 0x5141, 0x8bb8],
  [0x53ea, 0x80fd],
  [0x5343, 0x4e07],
  [0x6052, 0x5b9a],
  [0x9ed8, 0x8ba4],
  [0x4f18, 0x5148, 0x7ea7],
  [0x53e3, 0x5f84],
  [0x4e0d, 0x5f97],
  [0x5207, 0x8bb0],
  [0x52a1, 0x5fc5],
  [0x8fd4, 0x5de5],
);
/** Chinese for credential and secret key (redaction keywords). */
const ZH_SECRET_KEYWORDS = words([0x51ed, 0x636e], [0x5bc6, 0x94a5]);
/** Chinese names of Desktop, Documents and Downloads (project containers under the home directory). */
const ZH_HOME_CONTAINERS = words([0x684c, 0x9762], [0x6587, 0x6863], [0x4e0b, 0x8f7d]);

/** Rule paragraph markers (a regex hit, not a summary): English markers plus a Chinese list. */
const RULE_MARK_RE = new RegExp(
  [
    "\\b(?:never|always|must|mustn't|don't|do not|remember|from now on|going forward|rule|important|make sure|be sure to|not allowed|forbidden|by default|priority|redo)\\b",
    ...ZH_RULE_MARKERS,
  ].join("|"),
  "i",
);

const lines = (raw: string): string[] => raw.split(/\r?\n/).filter((l) => l.trim() !== "");

const parseJson = (l: string): Rec => {
  try {
    return JSON.parse(l);
  } catch {
    return null;
  }
};

const md5 = (s: string): string => crypto.createHash("md5").update(s, "utf8").digest("hex");

export function detectFormat(raw: string): Format | null {
  const t = raw.trimStart();
  if (t === "") return null;
  if (t.startsWith("{") && !t.includes("\n{")) {
    const obj = parseJson(raw.trim());
    if (obj && Array.isArray(obj.history)) return "gemini-history";
    if (obj && (Array.isArray(obj.messages) || Array.isArray(obj.chat) || Array.isArray(obj.turns))) return "generic-json";
  }
  const sample: Rec[] = lines(raw).slice(0, 50).map(parseJson).filter(Boolean);
  if (sample.length === 0) return null;
  if (sample.some((o) => o.sessionId && (o.type === "user" || o.type === "assistant" || o.aiTitle || o.customTitle))) return "claude-code";
  if (sample.some((o) => o.type === "session_meta" || o.type === "response_item" || o.type === "event_msg")) return "codex";
  if (
    sample.some(
      (o) =>
        o.type === "backend_tool_call" ||
        (o.type === "tool_result" && o.tool_call_id) ||
        (o.type === "assistant" && o.model_id) ||
        (o.type === "reasoning" && o.encrypted_content),
    )
  )
    return "grok";
  if (sample.some((o) => typeof o.step_index === "number" && typeof o.source === "string" && typeof o.type === "string")) return "antigravity";
  if (
    sample.some(
      (o) => o.type === "turn_ended" || (o.role && Array.isArray(o.message?.content) && o.message.content.some((p: Rec) => p?.type === "tool_use")),
    )
  )
    return "cursor";
  if (sample.some((o) => o.role || o.type === "message")) return "generic-jsonl";
  return null;
}

const newTurn = (role: Turn["role"], at: string | null | undefined): Turn => ({ role, at: at ?? null, text: "", tools: new Map(), agents: [] });

const pushText = (turn: Turn, text: string | null | undefined): void => {
  if (!text) return;
  turn.text = turn.text === "" ? text : `${turn.text}\n\n${text}`;
};

const tallyTool = (turn: Turn, name: string | null | undefined): void => {
  if (!name) return;
  turn.tools.set(name, (turn.tools.get(name) ?? 0) + 1);
};

/** Plain text of a string or of an array of content blocks (text blocks joined). */
const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("\n\n");
  return "";
};

/**
 * The main agent's own token usage: `fresh = input + output + cache creation`; cache reads are kept apart. A cache
 * read counts the whole context again every turn, so a long session reaches tens of millions that were never new
 * work; both numbers are kept, the headline is fresh.
 */
function addUsage(acc: Usage, usage: unknown): Usage {
  if (!usage || typeof usage !== "object") return acc;
  const u = usage as Record<string, unknown>;
  const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  acc.fresh += n(u.input_tokens) + n(u.output_tokens) + n(u.cache_creation_input_tokens);
  acc.cached += n(u.cache_read_input_tokens);
  return acc;
}

const cap = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}\n…(truncated; original length ${s.length} characters)` : s);

function parseClaudeCode(raw: string, opts: { sidechains?: boolean } = {}): Parsed {
  const turns: Turn[] = [];
  let title: string | null = null;
  let aiTitle: string | null = null;
  let id: string | null = null;
  let cwd: string | null = null;
  let branch: string | null = null;
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  /** Dispatch id → record, to stitch the reply from the tool_result back in. */
  const dispatches = new Map<string, AgentDispatch>();
  const usage: Usage = { fresh: 0, cached: 0 };

  for (const l of lines(raw)) {
    const o = parseJson(l);
    if (!o || typeof o.type !== "string") continue;
    if (o.customTitle) title = String(o.customTitle);
    if (o.aiTitle) aiTitle = String(o.aiTitle);
    if (CC_SKIP_TYPES.has(o.type)) continue;
    if (o.isSidechain === true && !opts.sidechains) continue;
    if (o.timestamp) {
      startedAt ??= o.timestamp;
      endedAt = o.timestamp;
    }
    id ??= o.sessionId ?? null;

    if (o.type === "user") {
      if (o.isMeta === true) continue;
      cwd ??= o.cwd ?? null;
      branch ??= o.gitBranch ?? null;
      const content = o.message?.content;
      // Tool output comes back on user lines: not a person speaking, no turn; but dispatch replies are stitched back.
      if (Array.isArray(content) && content.every((b: Rec) => b?.type === "tool_result")) {
        for (const b of content) {
          const d = b.tool_use_id ? dispatches.get(b.tool_use_id) : null;
          if (d && d.reply === null) {
            const replyText = typeof b.content === "string" ? b.content : textOf(b.content);
            if (replyText) d.reply = cap(replyText, AGENT_REPLY_CAP);
          }
        }
        continue;
      }
      const text = textOf(content);
      if (text === "" || CC_NOISE_RE.test(text) || REMINDER_ONLY_RE.test(text)) continue;
      const t = newTurn("user", o.timestamp);
      t.text = text; // verbatim: the user side is never processed
      turns.push(t);
      continue;
    }

    if (o.type === "assistant") {
      addUsage(usage, o.message?.usage);
      const content = o.message?.content;
      if (!Array.isArray(content)) continue;
      const last = turns[turns.length - 1];
      const turn = last && last.role === "assistant" ? last : newTurn("assistant", o.timestamp);
      if (turn !== last) turns.push(turn);
      for (const b of content) {
        if (!b || typeof b !== "object") continue;
        if (b.type === "text") pushText(turn, b.text);
        else if (b.type === "tool_use") {
          if (AGENT_TOOL_NAMES.has(b.name)) {
            const inp = b.input ?? {};
            const d: AgentDispatch = {
              id: b.id ?? null,
              description: String(inp.description ?? ""),
              subagentType: String(inp.subagent_type ?? inp.subagentType ?? "general-purpose"),
              model: String(inp.model ?? "inherit"),
              prompt: cap(String(inp.prompt ?? ""), AGENT_PROMPT_CAP),
              reply: null,
            };
            turn.agents.push(d);
            if (d.id) dispatches.set(d.id, d);
          } else tallyTool(turn, b.name);
        }
        // thinking and other block types are not archived
      }
    }
  }

  return { source: "claude-code", id, title: title ?? aiTitle, cwd, branch, startedAt, endedAt, model: null, turns, usage };
}

/** Injected context blocks (not typed by a person): codex's <environment_context>, AGENTS.md instructions, … Skipped for titles, kept in the body. */
const INJECTED_USER_RE = /^\s*(<(environment_context|user_instructions|permissions[^>]*|system-reminder|INSTRUCTIONS)>|# AGENTS\.md instructions for )/i;

/** Codex rollout: response_item messages first; event_msg only when there is none. */
function parseCodex(raw: string): Parsed {
  type Item = { role: Turn["role"]; at: string | null; text?: string; tool?: string };
  const items: Item[] = [];
  const events: Item[] = [];
  let id: string | null = null;
  let cwd: string | null = null;
  let agentPath: string | null = null;
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  const contentText = (content: unknown): string =>
    Array.isArray(content) ? content.map((c) => c?.text ?? "").filter(Boolean).join("\n\n") : textOf(content);
  // Compaction records (compacted.replacement_history) restate the history before the compaction. Newer codex
  // rewrites old rollouts, and a forked sub-agent carries the parent's user messages only here: messages missing
  // from the body are added at the start (they predate the rest of this file).
  const msgKey = (role: string, text: string): string => `${role}\u0000${md5(text)}`;
  const seen = new Set<string>();
  const carried: Item[] = [];
  const pushMsg = (role: Turn["role"], at: string | null, text: string): void => {
    seen.add(msgKey(role, text));
    items.push({ role, at, text });
  };

  for (const l of lines(raw)) {
    const o = parseJson(l);
    if (!o) continue;
    if (o.timestamp) {
      startedAt ??= o.timestamp;
      endedAt = o.timestamp;
    }
    const p = o.payload ?? o;
    if (o.type === "session_meta" || p.type === "session_meta") {
      const meta = p.payload ?? p;
      id ??= meta.id ?? null;
      cwd ??= meta.cwd ?? null;
      agentPath ??= meta.agent_path ?? null;
      continue;
    }
    if (o.type === "compacted" && Array.isArray(p.replacement_history)) {
      for (const m of p.replacement_history) {
        if (m?.type !== "message" || (m.role !== "user" && m.role !== "assistant")) continue;
        const text = contentText(m.content);
        // Injected environment blocks carry the date of each restatement, so they never compare equal; they are
        // not typed by a person either: only real messages are carried over.
        if (text && !INJECTED_USER_RE.test(text)) carried.push({ role: m.role, at: null, text });
      }
      continue;
    }
    if (o.type === "response_item" || p.type === "message" || p.type === "function_call") {
      const m = o.type === "response_item" ? p : o;
      if (m.type === "message" && (m.role === "user" || m.role === "assistant")) {
        const text = contentText(m.content);
        if (text) pushMsg(m.role, o.timestamp ?? null, text);
      } else if (m.type === "function_call") {
        items.push({ role: "assistant", at: o.timestamp ?? null, tool: m.name ?? "tool" });
      } else if (m.type === "agent_message") {
        // Multi-agent mode: a new task the parent sends to this session is this session's prompt, kept verbatim;
        // other messages between agents are not archived.
        const text = contentText(m.content);
        if (text && agentPath && m.recipient === agentPath && /^Message Type: NEW_TASK\b/.test(text)) {
          pushMsg("user", o.timestamp ?? null, `[task from ${m.author ?? "parent agent"}]\n${text}`);
        }
      }
      continue;
    }
    if (o.type === "event_msg") {
      if (p.type === "user_message" && p.message) events.push({ role: "user", at: o.timestamp ?? null, text: String(p.message) });
      if (p.type === "agent_message" && p.message) events.push({ role: "assistant", at: o.timestamp ?? null, text: String(p.message) });
    }
  }

  const head: Item[] = [];
  for (const c of carried) {
    const k = msgKey(c.role, c.text ?? "");
    if (seen.has(k)) continue;
    seen.add(k);
    head.push({ ...c, at: startedAt });
  }
  const seq = items.length > 0 || head.length > 0 ? [...head, ...items] : events;
  const turns: Turn[] = [];
  for (const it of seq) {
    const last = turns[turns.length - 1];
    if (it.role === "assistant" && last && last.role === "assistant") {
      if (it.tool) tallyTool(last, it.tool);
      else pushText(last, it.text);
      continue;
    }
    const t = newTurn(it.role, it.at);
    if (it.tool) tallyTool(t, it.tool);
    else t.text = it.text ?? "";
    turns.push(t);
  }
  return { source: "codex", id, title: null, cwd, branch: null, startedAt, endedAt, model: null, turns };
}

function parseGeminiHistory(raw: string): Parsed {
  const obj = parseJson(raw.trim());
  const hist: Rec[] = Array.isArray(obj?.history) ? obj.history : [];
  const turns: Turn[] = [];
  for (const h of hist) {
    const role = h?.role === "user" ? "user" : h?.role === "model" ? "assistant" : null;
    if (!role) continue;
    const text = Array.isArray(h.parts) ? h.parts.map((p: Rec) => p?.text ?? "").filter(Boolean).join("\n\n") : textOf(h.parts);
    if (text === "") continue;
    const t = newTurn(role, null);
    t.text = text;
    turns.push(t);
  }
  return { source: "gemini", id: obj?.sessionId ?? null, title: null, cwd: null, branch: null, startedAt: null, endedAt: null, model: null, turns };
}

// ── grok / antigravity / cursor ─────────────────────────────────────────────

/** The content of <tag>…</tag>; the text unchanged when there is no such tag. */
const insideTag = (text: string, tag: string): string => {
  const m = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`).exec(text);
  return m ? m[1] : text;
};
/** Drops whole <tag>…</tag> blocks (settings changes injected by the harness, not typed by a person). */
const dropBlocks = (text: string, tag: string): string => text.replace(new RegExp(`\\s*<${tag}>[\\s\\S]*?</${tag}>\\s*`, "g"), "\n").trim();

/** Continues the trailing assistant turn, or opens one (every CLI splits tool calls over several records). */
const assistantTurn = (turns: Turn[], at: string | null): Turn => {
  const last = turns[turns.length - 1];
  if (last && last.role === "assistant") return last;
  const t = newTurn("assistant", at);
  turns.push(t);
  return t;
};

/**
 * Grok Build: ~/.grok/sessions/<percent-encoded cwd>/<id>/chat_history.jsonl.
 * Records: system (prompt) / user (content blocks; synthetic_reason = injected by the harness; prompt_index = typed) /
 * reasoning (encrypted, not archived) / assistant (content string + tool_calls) / tool_result (not archived) /
 * backend_tool_call (web_search and the like).
 * No timestamps: start, end, title and model are in summary.json next to it, passed in as meta by the importer.
 */
function parseGrok(raw: string): Parsed {
  const turns: Turn[] = [];
  for (const l of lines(raw)) {
    const o = parseJson(l);
    if (!o || typeof o.type !== "string") continue;
    if (o.type === "user") {
      if (o.synthetic_reason) continue;
      const text = textOf(o.content).trim();
      if (!text || /^<(user_info|system-reminder|rules)>/.test(text)) continue;
      const t = newTurn("user", null);
      t.text = insideTag(text, "user_query").trim();
      turns.push(t);
      continue;
    }
    if (o.type === "assistant") {
      const t = assistantTurn(turns, null);
      pushText(t, (typeof o.content === "string" ? o.content : textOf(o.content)).trim());
      for (const c of Array.isArray(o.tool_calls) ? o.tool_calls : []) tallyTool(t, c?.name ?? "tool");
      continue;
    }
    if (o.type === "backend_tool_call") tallyTool(assistantTurn(turns, null), o.kind?.tool_type ?? "backend_tool");
    // system / reasoning / tool_result: not archived
  }
  return { source: "grok", id: null, title: null, cwd: null, branch: null, startedAt: null, endedAt: null, model: null, turns };
}

/**
 * Antigravity (agy): ~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript_full.jsonl.
 * Records {step_index, source, type, status, created_at, content}: USER_EXPLICIT/USER_INPUT (wrapped in
 * <USER_REQUEST>), MODEL/PLANNER_RESPONSE (text), MODEL/GENERIC (tool step output, only counted), SYSTEM/* (not
 * archived). The session id is the folder name; the cwd comes from the importer as meta.
 */
function parseAntigravity(raw: string): Parsed {
  const turns: Turn[] = [];
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  for (const l of lines(raw)) {
    const o = parseJson(l);
    if (!o || typeof o.type !== "string") continue;
    const at = typeof o.created_at === "string" ? o.created_at : null;
    if (at) {
      startedAt ??= at;
      endedAt = at;
    }
    if (o.source === "USER_EXPLICIT" || o.type === "USER_INPUT") {
      let text = typeof o.content === "string" ? o.content : textOf(o.content);
      text = dropBlocks(text, "USER_SETTINGS_CHANGE");
      text = insideTag(text, "USER_REQUEST").trim();
      if (!text) continue;
      const t = newTurn("user", at);
      t.text = text;
      turns.push(t);
      continue;
    }
    if (o.source === "MODEL") {
      const t = assistantTurn(turns, at);
      if (o.type === "PLANNER_RESPONSE") pushText(t, String(o.content ?? "").trim());
      else tallyTool(t, o.type === "GENERIC" ? "tool step" : String(o.type).toLowerCase());
    }
    // SYSTEM: not archived
  }
  return { source: "agy", id: null, title: null, cwd: null, branch: null, startedAt, endedAt, model: null, turns };
}

/** The <timestamp>Monday, Sep 7, 2026, 10:00 AM (UTC-5)</timestamp> at the start of a cursor user message. */
const CURSOR_TS_RE =
  /<timestamp>\s*(?:[A-Za-z]+,\s*)?([A-Za-z]{3,9}\s+\d{1,2},\s*\d{4}),?\s*(\d{1,2}:\d{2}\s*[AP]M)?(?:\s*\(UTC([+-]\d{1,2})(?::?(\d{2}))?\))?\s*<\/timestamp>/i;
function cursorStamp(text: string): string | null {
  const m = CURSOR_TS_RE.exec(text);
  if (!m) return null;
  const tz = m[3] ? `GMT${m[3].startsWith("-") ? "-" : "+"}${String(Math.abs(Number(m[3]))).padStart(2, "0")}${m[4] ?? "00"}` : "";
  const d = new Date(`${m[1]} ${m[2] ?? "12:00 AM"} ${tz}`.trim());
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Cursor Agent: ~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl.
 * Records {role, message:{content:[text|tool_use|tool_result]}} and {type:"turn_ended"}; user text is wrapped in
 * <timestamp> and <user_query>. The cwd and start / end milliseconds are in ~/.cursor/chats/<hash>/<id>/meta.json,
 * passed in as meta by the importer (a timestamp that parses from the text wins).
 */
function parseCursor(raw: string): Parsed {
  const turns: Turn[] = [];
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  for (const l of lines(raw)) {
    const o = parseJson(l);
    if (!o || !o.role || !o.message) continue;
    const parts: Rec[] = Array.isArray(o.message.content) ? o.message.content : [];
    if (o.role === "user") {
      const rawText = textOf(o.message.content);
      const at = cursorStamp(rawText);
      if (at) {
        startedAt ??= at;
        endedAt = at;
      }
      const text = insideTag(rawText.replace(CURSOR_TS_RE, ""), "user_query").trim();
      if (!text) continue; // a user record holding only tool_result is not a turn
      const t = newTurn("user", at);
      t.text = text;
      turns.push(t);
      continue;
    }
    if (o.role === "assistant") {
      const t = assistantTurn(turns, null);
      pushText(t, textOf(parts).trim());
      for (const p of parts) if (p?.type === "tool_use") tallyTool(t, p.name ?? "tool");
    }
  }
  return { source: "cursor", id: null, title: null, cwd: null, branch: null, startedAt, endedAt, model: null, turns };
}

const GENERIC_USER = new Set(["user", "human"]);
const GENERIC_ASSISTANT = new Set(["assistant", "ai", "model", "agent"]);

function genericTurn(o: Rec): Turn | null {
  const roleRaw = String(o.role ?? o.type ?? "").toLowerCase();
  const role = GENERIC_USER.has(roleRaw) ? "user" : GENERIC_ASSISTANT.has(roleRaw) ? "assistant" : null;
  if (!role) return null;
  const text =
    textOf(o.content) || (typeof o.text === "string" ? o.text : "") || (typeof o.message === "string" ? o.message : textOf(o.message?.content));
  if (!text) return null;
  const t = newTurn(role, o.timestamp ?? o.ts ?? null);
  t.text = text;
  return t;
}

function parseGeneric(raw: string, format: string): Parsed {
  let records: Rec[];
  if (format === "generic-json") {
    const obj = parseJson(raw.trim()) ?? {};
    records = obj.messages ?? obj.chat ?? obj.turns ?? obj.history ?? [];
  } else {
    records = lines(raw).map(parseJson).filter(Boolean);
  }
  const turns: Turn[] = [];
  for (const o of records) {
    const t = genericTurn(o);
    if (t) turns.push(t);
  }
  return { source: "generic", id: null, title: null, cwd: null, branch: null, startedAt: null, endedAt: null, model: null, turns };
}

/**
 * `meta`: fields the transcript itself lacks (the CLIs keep times, titles and projects in a summary.json or
 * meta.json next to it); they only fill gaps and never override.
 */
export function parseSession(raw: string, format: string, opts: { sidechains?: boolean; meta?: SessionMeta } = {}): Session {
  const s =
    format === "claude-code"
      ? parseClaudeCode(raw, opts)
      : format === "codex"
        ? parseCodex(raw)
        : format === "gemini-history"
          ? parseGeminiHistory(raw)
          : format === "grok"
            ? parseGrok(raw)
            : format === "antigravity"
              ? parseAntigravity(raw)
              : format === "cursor"
                ? parseCursor(raw)
                : parseGeneric(raw, format);
  const m = opts.meta ?? {};
  for (const k of META_KEYS) {
    const v = m[k];
    if ((s[k] === null || s[k] === undefined) && v) s[k] = v;
  }
  // Titles are always redacted (also under --no-redact): they reach file names, the index and listings.
  const title = s.title ? redactText(s.title).text : titleFromTurns(s.turns, s.cwd);
  // Fork detection material: the set of user-message hashes (a strict subset ⇒ possible fork; flagged, never deleted)
  const userHashes = new Set(s.turns.filter((t) => t.role === "user").map((t) => md5(t.text)));
  return { ...s, title, userHashes };
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const DELEGATION_HEADING_RE = new RegExp(`(?:^|\\n)(?:${escapeRe(DELEGATION_FOLLOW_UP_HEADING)}|${escapeRe(DELEGATION_TASK_HEADING)})\\s*\\n+\\s*([^\\n]+)`);
/** The working folder of a record: `…/runs/<project-key>/<YYYYMMDD-HHMMSS->task>/work`. */
const DELEGATION_WORK_RE = /[\\/]runs[\\/][^\\/]+[\\/](?:\d{8}-\d{6}-)?([^\\/]+)[\\/]work[\\/]?$/;

const isDelegationPrompt = (text: string): boolean => text.trimStart().startsWith(DELEGATION_PROMPT_FIRST_LINE);

/**
 * A title from the user messages when the transcript has none: injected blocks are skipped; for a delegation prompt
 * the task name of the record's working folder, else the line under the task heading. The whole line is redacted
 * before it is cut, so a cut can never leave the start of a secret that the patterns no longer recognise.
 */
function titleFromTurns(turns: Turn[], cwd: string | null): string {
  const cut = (line: string): string => redactText(line).text.slice(0, 40);
  const users = turns.filter((t) => t.role === "user");
  const real = users.find((t) => !INJECTED_USER_RE.test(t.text)) ?? users[0];
  if (!real) return "Untitled session";
  const text = real.text.trim();
  if (isDelegationPrompt(text)) {
    const job = typeof cwd === "string" ? DELEGATION_WORK_RE.exec(cwd) : null;
    if (job) return cut(job[1]);
    const m = DELEGATION_HEADING_RE.exec(text);
    if (m) return cut(m[1].trim());
  }
  return cut(text.split("\n")[0]);
}

/** A ⊊ B ⇒ A is possibly a fork or subset of B (strict inclusion of the user-message hash sets). */
export function isSubsetSession(a: Pick<Session, "userHashes">, b: Pick<Session, "userHashes">): boolean {
  if (a.userHashes.size === 0 || a.userHashes.size >= b.userHashes.size) return false;
  for (const h of a.userHashes) if (!b.userHashes.has(h)) return false;
  return true;
}

const fmtStamp = (iso: string | null): string => {
  if (!iso) return "?";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "?";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const fmtShort = (iso: string | null): string => (fmtStamp(iso) === "?" ? "" : ` · ${fmtStamp(iso).slice(5)}`);

/** ``` inside a fenced block would end it early: written as ˋˋˋ (U+02CB). */
const unfence = (s: string): string => s.replaceAll("```", "ˋˋˋ");

export function renderMarkdown(s: Session, opts: { importedAt?: string; originPath?: string; extraHeader?: string[] } = {}): string {
  const users = s.turns.filter((t) => t.role === "user").length;
  const assistants = s.turns.length - users;
  let toolTotal = 0;
  let dispatchTotal = 0;
  for (const t of s.turns) {
    for (const c of t.tools.values()) toolTotal += c;
    dispatchTotal += t.agents.length;
  }

  const head = [
    `# Session: ${s.title}`,
    "",
    `- source: ${s.source}${s.id ? ` · id \`${s.id}\`` : ""}`,
    ...(s.cwd ? [`- project: ${s.cwd}${s.branch ? ` (branch ${s.branch})` : ""}`] : []),
    ...(s.model ? [`- model: ${s.model}`] : []),
    `- time: ${fmtStamp(s.startedAt)} → ${fmtStamp(s.endedAt)} · turns: ${users} user / ${assistants} assistant · tools ${toolTotal} · dispatches ${dispatchTotal}`,
    ...(s.usage && s.usage.fresh > 0
      ? [
          `- main-agent usage: ${s.usage.fresh} tokens (fresh = input + output + cache creation; ${s.usage.cached} cache-read tokens are counted again every turn and left out)`,
        ]
      : []),
    ...(opts.importedAt ? [`- imported: ${opts.importedAt}${opts.originPath ? ` · original transcript: \`${opts.originPath}\`` : ""}`] : []),
    ...(opts.extraHeader ?? []).map((l) => `- ${l}`),
    "",
    "> Imported by openagent import-sessions. User messages are verbatim; assistant text is kept and tool calls are folded; sub-agent dispatches keep their prompt and reply (truncated); thinking and tool output are not archived.",
    "",
    "---",
  ];

  const body: string[] = [];
  for (const t of s.turns) {
    body.push("", `## ${t.role === "user" ? "User" : "Assistant"}${fmtShort(t.at)}`, "");
    if (t.text !== "") body.push(t.text);
    for (const d of t.agents) {
      body.push(
        "",
        `> [dispatch] ${d.subagentType}/${d.model}${d.description ? ` · ${d.description}` : ""}`,
        "",
        "<details><summary>Dispatch prompt and reply</summary>",
        "",
        "```text",
        unfence(d.prompt),
        "```",
        ...(d.reply ? ["", "Reply:", "", "```text", unfence(d.reply), "```"] : []),
        "",
        "</details>",
      );
    }
    if (t.tools.size > 0) {
      const parts = [...t.tools.entries()].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n));
      body.push("", `> [tools] ${parts.join(" · ")}`);
    }
  }
  return `${[...head, ...body].join("\n")}\n`;
}

/**
 * Archive file name: sortable time stamp + the first 8 id characters (makes re-imports idempotent) + a title slug.
 * The slug is built from the redacted title, and any token that still looks like a key becomes `redacted`: no part
 * of a secret may reach a file name.
 */
export function suggestFileName(s: Pick<Session, "startedAt" | "id" | "title">): string {
  const d = s.startedAt ? new Date(s.startedAt) : null;
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp =
    d && !Number.isNaN(d.getTime()) ? `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}` : "00000000-0000";
  const id8 = (s.id ?? "").replace(/[^0-9a-zA-Z]/g, "").slice(0, 8) || "noid";
  const slug = redactText(s.title ?? "")
    .text.replace(REDACTED_MARK_RE, "redacted")
    .replace(LONG_TOKEN_RE, (tok) => (looksLikeKey(tok) ? "redacted" : tok))
    .replace(/[\\/:*?"<>|#\s.]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return `${stamp}-${id8}${slug ? `-${slug}` : ""}.md`;
}

// ── Project folders: sessions/imported/<project>/ ───────────────────────────

/** Special folders (folder names are data; the underscore keeps them apart from real projects). */
export const BUCKET_UNKNOWN = "_unknown";
export const BUCKET_DELEGATION = "_delegated";
export const BUCKET_TEMP = "_temp";
export const BUCKET_MISC = "_misc";

/** Container folders under the user's home: the project is the next level down. */
const HOME_CONTAINERS = new Set([
  ...ZH_HOME_CONTAINERS,
  "desktop",
  "documents",
  "downloads",
  "onedrive",
  "source",
  "repos",
  "projects",
  "code",
  "dev",
  "workspace",
  "work",
  "github",
]);
const WIN_RESERVED_RE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/** Folder-name cleanup: Windows-invalid characters, leading / trailing dots and spaces, reserved names, length; "" when nothing is left. */
export function sanitizeBucket(name: unknown): string {
  let s = String(name ?? "")
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[.\s-]+|[.\s-]+$/g, "")
    .slice(0, 60)
    .replace(/[.\s-]+$/g, "");
  if (WIN_RESERVED_RE.test(s)) s = `_${s}`;
  return s;
}

/** Whether a session is a task delegated through OpenAgent (the runner's prompt in one of the first user messages; codex injects an environment block first). */
export function isDelegationSession(s: Pick<Session, "turns"> | null | undefined): boolean {
  const users = (s?.turns ?? []).filter((t) => t.role === "user").slice(0, 3);
  return users.some((t) => isDelegationPrompt(t.text));
}

export interface BucketContext {
  /** The user's home directory. */
  home?: string;
  tmpDir?: string;
  /** The `runs/` folder of the OpenAgent home folder: working folders of records. */
  runsDir?: string;
  /** Git root above a folder, or null (injected: this module does no IO). */
  gitRoot?: (p: string) => string | null;
}

/**
 * Session cwd → archive folder name. Pure: git root detection is injected (ctx.gitRoot).
 *  - Working folder of a record (under ctx.runsDir, or `…/.openagent/runs/…`) → _delegated;
 *  - an agent worktree (<repo>/.claude|.codex|.cursor/worktrees/<name>) → back to the main repository;
 *  - temp folders (%TEMP%, /tmp, /var/folders, below ctx.tmpDir) → _temp;
 *  - app data folders, drive roots, the home directory and Desktop / Documents themselves, the Codex desktop app's
 *    dated chat folders → _misc;
 *  - a game folder under steamapps/common → the game's folder name;
 *  - otherwise the git root's folder name; without one the "project level": the first level below a drive, or below
 *    the home directory (one more level below containers such as Desktop / Documents).
 */
export function projectBucket(cwd: string | null | undefined, ctx: BucketContext = {}): string {
  if (typeof cwd !== "string" || !cwd.trim()) return BUCKET_UNKNOWN;
  const raw = cwd.trim();
  if (/^[A-Za-z]:\.?$/.test(raw)) return BUCKET_MISC; // bare drive letter (path.win32.normalize turns "E:" into "E:.")
  const win = /^[A-Za-z]:([\\/]|$)/.test(raw) || raw.startsWith("\\\\");
  const P = win ? path.win32 : path.posix;
  let p = P.normalize(raw);
  if (p.length > P.parse(p).root.length) p = p.replace(/[\\/]+$/, "");
  const key = (x: string): string => (win ? P.normalize(x).replace(/[\\/]+$/, "").toLowerCase() : P.normalize(x).replace(/\/+$/, ""));
  const inside = (child: string, parent: string | undefined | null): boolean => {
    if (!parent) return false;
    const c = key(child);
    const q = key(parent);
    return c === q || c.startsWith(q + P.sep);
  };

  if (inside(p, ctx.runsDir) || /[\\/]\.openagent[\\/]runs([\\/]|$)/.test(p)) return BUCKET_DELEGATION;
  const wt = /^(.+?)[\\/]\.(?:claude|codex|cursor)[\\/]worktrees([\\/]|$)/i.exec(p);
  if (wt) p = wt[1];
  if (
    /[\\/]AppData[\\/]Local[\\/]Temp([\\/]|$)/i.test(p) ||
    /^\/(tmp|private\/tmp|var\/folders|private\/var\/folders)(\/|$)/.test(p) ||
    (ctx.tmpDir && inside(p, ctx.tmpDir))
  )
    return BUCKET_TEMP;
  if (/[\\/]AppData[\\/]/i.test(p) || /\/Library\/(Application Support|Containers|Group Containers)\//.test(p)) return BUCKET_MISC;
  if (/[\\/]Documents[\\/]Codex[\\/]\d{4}-\d{2}-\d{2}([\\/]|$)/i.test(p)) return BUCKET_MISC;
  const game = /[\\/]steamapps[\\/]common[\\/]([^\\/]+)/i.exec(p); // one folder per game
  if (game) return sanitizeBucket(game[1]) || BUCKET_UNKNOWN;

  const rootLen = P.parse(p).root.length;
  if (p.length <= rootLen) return BUCKET_MISC; // drive root / filesystem root
  const home = ctx.home ? P.normalize(ctx.home) : null;
  let rest: string[] | null = null; // segments below the project level
  if (home && inside(p, home)) {
    rest = key(p) === key(home) ? [] : P.relative(home, p).split(/[\\/]/).filter(Boolean);
    if (rest.length === 0) return BUCKET_MISC;
    if (HOME_CONTAINERS.has(rest[0].toLowerCase())) {
      rest = rest.slice(1);
      if (rest.length > 0 && HOME_CONTAINERS.has(rest[0].toLowerCase())) rest = rest.slice(1); // OneDrive/Desktop/<project>
      if (rest.length === 0) return BUCKET_MISC;
    }
    if (rest[0].startsWith(".")) return BUCKET_MISC; // tool folders such as ~/.codex, ~/.config
  }

  const git = ctx.gitRoot ? ctx.gitRoot(p) : null;
  if (git && !(home && key(git) === key(home)) && P.parse(git).root.length < git.length) {
    return sanitizeBucket(P.basename(git)) || BUCKET_UNKNOWN;
  }
  if (rest) return sanitizeBucket(rest[0]) || BUCKET_UNKNOWN;
  // First level below the drive; macOS external volumes /Volumes/<disk>/<project>; /Users|home/<user>/<project>
  const segs = p.slice(rootLen).split(/[\\/]/).filter(Boolean);
  if (!win && segs[0] === "Volumes" && segs.length >= 3) return sanitizeBucket(segs[2]) || BUCKET_UNKNOWN;
  if (!win && (segs[0] === "Users" || segs[0] === "home") && segs.length >= 3) return sanitizeBucket(segs[2]) || BUCKET_UNKNOWN;
  return sanitizeBucket(segs[0]) || BUCKET_UNKNOWN;
}

/** Archive integrity: first 16 hex digits of the sha256 without the checksum line (was the archive edited after import?). */
const CHECKSUM_LINE_RE = /^- checksum: sha256:[0-9a-f]{16}\n/m;
export function archiveChecksum(md: string): string {
  const text = md.replace(/\r\n/g, "\n").replace(CHECKSUM_LINE_RE, "");
  return crypto.createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}
/**
 * Inserts the checksum line into a rendered archive: after the `imported` line, else at the end of the header block,
 * in the header's own line ending (an archive a person edited may be CRLF).
 */
export function withChecksum(md: string): string {
  const first = md.indexOf("\n");
  const eol = first > 0 && md[first - 1] === "\r" ? "\r\n" : "\n";
  const line = `- checksum: sha256:${archiveChecksum(md)}${eol}`;
  const m = /^- imported: [^\r\n]*\r?\n/m.exec(md);
  if (m) return md.slice(0, m.index + m[0].length) + line + md.slice(m.index + m[0].length);
  const blank = md.indexOf(eol + eol, md.indexOf(`${eol}- `));
  return blank === -1 ? md + line : md.slice(0, blank + eol.length) + line + md.slice(blank + eol.length);
}
/** Whether an archive is unchanged since import: true / false / null (no checksum line). */
export function archiveUntouched(md: string): boolean | null {
  const m = /^- checksum: sha256:([0-9a-f]{16})\r?$/m.exec(md);
  if (!m) return null;
  return archiveChecksum(md) === m[1];
}

// ── Distilled books: _prompts/ ──────────────────────────────────────────────

/**
 * `file`: the session's archive relative to the archive folder (`<project>/<name>.md`), so the link from
 * `_prompts/` is `../<project>/<name>.md`; null when the session has no archive (not imported this time).
 */
export function buildPromptBooks(entries: { session: Session; file: string | null }[]) {
  const user: string[] = [];
  const agent: string[] = [];
  const rules: { para: string; title: string; link: string }[] = [];
  const seenRule = new Set<string>();

  for (const { session: s, file } of entries) {
    const link = `\`${(s.id ?? "").slice(0, 8) || "noid"}\` → ${file ? `[${file}](../${file})` : "(not archived)"}`;
    for (const t of s.turns) {
      if (t.role === "user" && t.text !== "") {
        user.push(`### ${fmtStamp(t.at)} · ${s.title}\n\n${link}\n\n${t.text}\n\n---`);
        for (const para of t.text.split(/\n+/)) {
          const p = para.trim();
          if (p.length > 6 && RULE_MARK_RE.test(p)) {
            const key = `${s.id}\0${p}`;
            if (!seenRule.has(key)) {
              seenRule.add(key);
              rules.push({ para: p, title: s.title, link });
            }
          }
        }
      }
      for (const d of t.agents) {
        agent.push(
          `### ${fmtStamp(t.at)} · ${d.subagentType}/${d.model}${d.description ? ` · ${d.description}` : ""}\n\n${link}\n\n\`\`\`text\n${unfence(d.prompt)}\n\`\`\`\n\n---`,
        );
      }
    }
  }

  const ruleGroups = new Map<string, string[]>();
  for (const r of rules) {
    const k = `${r.title}\0${r.link}`;
    if (!ruleGroups.has(k)) ruleGroups.set(k, []);
    ruleGroups.get(k)!.push(`- ${r.para}`);
  }
  const rulesBody = [...ruleGroups.entries()].map(([k, items]) => `## ${k.split("\0")[0]}\n\n${k.split("\0")[1]}\n\n${items.join("\n")}`).join("\n\n");

  return {
    userPromptsMd: `# User prompts, verbatim\n\n> Compiled by machine: nothing filtered, nothing summarised. ${user.length} messages.\n\n${user.join("\n\n")}\n`,
    agentPromptsMd: `# Sub-agent dispatch prompts\n\n> Prompts verbatim; the replies are in each session's archive. ${agent.length} dispatches.\n\n${agent.join("\n\n")}\n`,
    rulesMd: `# Rule paragraphs\n\n> Extraction rule: paragraphs of user messages that contain a marker such as never / always / must / don't / remember / from now on / rule / by default.\n> **This is a regex hit, not a summary**; whether a rule holds, and still holds, is for a person to judge. ${rules.length} paragraphs.\n\n${rulesBody}\n`,
    counts: { user: user.length, agent: agent.length, rules: rules.length },
  };
}

// ── Redaction ───────────────────────────────────────────────────────────────

const SECRET_PATTERNS: [string, RegExp][] = [
  ["openai/anthropic", /\bsk-[A-Za-z0-9_-]{20,}\b/g],
  ["semantic-scholar", /\bs2k-[A-Za-z0-9_-]{12,}\b/g],
  ["github", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g],
  ["github-pat", /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g],
  ["slack", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g],
  ["aws", /\bAKIA[0-9A-Z]{16}\b/g],
  ["google", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["huggingface", /\bhf_[A-Za-z0-9]{30,}\b/g],
  ["pem", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
];

/** Lines that name a secret. */
const KEYWORD_RE = new RegExp(["key", "token", "secret", "password", "passwd", "bearer", "credential", ...ZH_SECRET_KEYWORDS].join("|"), "i");
const LONG_TOKEN_RE = /\b[A-Za-z0-9_-]{24,}\b/g;
const mixedClasses = (tok: string): boolean => /[a-z]/.test(tok) && /[A-Z0-9]/.test(tok) && !/^[0-9a-f]+$/i.test(tok);
/** Slug, file-name and tool-name shapes (several underscores, several hyphens, a leading date) are not key-like. */
const sluggy = (tok: string): boolean => (tok.match(/_/g) ?? []).length >= 2 || (tok.match(/-/g) ?? []).length >= 3 || /^\d{4}-\d{2}-\d{2}/.test(tok);
const looksLikeKey = (tok: string): boolean => mixedClasses(tok) && !sluggy(tok);
/** A replacement left by redactText. */
const REDACTED_MARK_RE = /\[redacted:[^\]]*\]/g;

/** Allowlist replacement + high-entropy replacement on keyword lines; long mixed tokens without a keyword only become suspects. */
export function redactText(text: string): { text: string; redactions: { type: string; len: number }[]; suspects: string[] } {
  const redactions: { type: string; len: number }[] = [];
  let out = text;
  for (const [type, re] of SECRET_PATTERNS) {
    out = out.replace(re, (m) => {
      redactions.push({ type, len: m.length });
      return `[redacted:${type} length ${m.length}]`;
    });
  }
  const suspects: string[] = [];
  const outLines = out.split("\n").map((line) => {
    const toks = line.match(LONG_TOKEN_RE) ?? [];
    if (toks.length === 0) return line;
    if (KEYWORD_RE.test(line)) {
      let l = line;
      for (const tok of toks) {
        if (!mixedClasses(tok)) continue;
        redactions.push({ type: "keyword-line", len: tok.length });
        l = l.replace(tok, `[redacted:keyword-line length ${tok.length}]`);
      }
      return l;
    }
    for (const tok of toks) {
      if (tok.length >= 40 && looksLikeKey(tok) && suspects.length < 20) suspects.push(`${tok.slice(0, 12)}… (length ${tok.length})`);
    }
    return line;
  });
  return { text: outLines.join("\n"), redactions, suspects };
}
