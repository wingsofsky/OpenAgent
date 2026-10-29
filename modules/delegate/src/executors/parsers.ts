/**
 * Parsing what an agent CLI printed: the answer, the session handle and the token usage. The registry names a parser
 * per executor (`answer`, `session`, `usage.parser` in executor-registry.json); this file holds the implementations.
 * Parsers are tolerant: CLIs change their output, so each one falls back to something sensible and never throws.
 */
import fs from "node:fs";
import type { AnswerParser, SessionParser, UsageParser } from "@longkeep/protocol/executor-registry";
import type { Invocation } from "./registry.ts";

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Reads the -o file; without one, the tail of `codex exec` stdout ("tokens used\n<n>\n<final message>") */
function codexAnswer(stdout: string, outFile: string | null): string {
  if (outFile && isFile(outFile)) {
    const s = fs.readFileSync(outFile, "utf8").trim();
    if (s) return s;
  }
  const marker = "\ntokens used\n";
  const at = stdout.lastIndexOf(marker);
  if (at !== -1) {
    const rest = stdout.slice(at + marker.length);
    const nl = rest.indexOf("\n");
    const tail = nl === -1 ? "" : rest.slice(nl + 1).trim();
    if (tail) return tail;
  }
  return stdout.trim();
}

/** "session id: <uuid>" in the header of `codex exec` */
export function codexSession(stdout: string): string | null {
  const m = /session id:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(stdout);
  return m ? m[1] : null;
}

/** "tokens used\n1,234" at the end of `codex exec` */
export function codexUsage(stdout: string): number | null {
  const m = /\ntokens used\s*\n\s*([\d,]+)/.exec(stdout);
  return m ? Number(m[1].replace(/,/g, "")) : null;
}

const ANSWER_KEYS = ["result", "response", "answer", "text", "content", "message", "output", "final"];

function pickAnswer(v: unknown, depth = 0): string | null {
  if (typeof v === "string") return v.trim() ? v : null;
  if (!v || typeof v !== "object" || depth > 3) return null;
  if (Array.isArray(v)) {
    const parts = v.map((i) => pickAnswer(i, depth + 1)).filter((x): x is string => !!x);
    return parts.length ? parts.join("\n") : null;
  }
  const o = v as Record<string, unknown>;
  for (const k of ANSWER_KEYS) {
    const r = pickAnswer(o[k], depth + 1);
    if (r) return r;
  }
  return null;
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** The last JSON value in stdout (the whole text first, then line by line from the end) */
function lastJson(stdout: string): unknown {
  const whole = tryParse(stdout.trim());
  if (whole !== undefined) return whole;
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim().startsWith("{"));
  for (let i = lines.length - 1; i >= 0; i--) {
    const parsed = tryParse(lines[i].trim());
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

/** `--output-format json` answers: whole JSON → last JSON line → raw text; parsed JSON without an answer field = empty */
export function extractJsonAnswer(stdout: string): string {
  const j = lastJson(stdout);
  if (j !== undefined) return (pickAnswer(j) ?? "").trim();
  return stdout.trim();
}

/** Session id in a JSON answer (session_id / sessionId / session / conversation_id / thread_id / chat_id …) */
export function extractJsonSession(stdout: string): string | null {
  const j = lastJson(stdout);
  if (!j || typeof j !== "object") return null;
  const o = j as Record<string, unknown>;
  for (const k of ["session_id", "sessionId", "session", "conversation_id", "conversationId", "thread_id", "threadId", "chat_id", "chatId"]) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Usage in a JSON answer: a total when there is one (usage.total_tokens / totalTokens / total, or top-level
 * total_tokens / totalTokens); otherwise input + output, snake_case or camelCase (cursor uses inputTokens /
 * outputTokens). Cache reads and writes are not counted, the same basis as claude without a total; a CLI that reports a
 * total (grok) decides itself whether it includes the cache.
 */
export function extractJsonUsage(stdout: string): number | null {
  const j = lastJson(stdout);
  if (!j || typeof j !== "object") return null;
  const o = j as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const usage = (o.usage ?? o.token_usage ?? o.tokens) as Record<string, unknown> | number | undefined;
  if (typeof usage === "number") return usage;
  if (usage && typeof usage === "object") {
    const total = num(usage.total_tokens) ?? num(usage.totalTokens) ?? num(usage.total);
    if (total !== null) return total;
    const inp = num(usage.input_tokens) ?? num(usage.inputTokens) ?? num(usage.prompt_tokens) ?? num(usage.promptTokens) ?? num(usage.input) ?? 0;
    const out = num(usage.output_tokens) ?? num(usage.outputTokens) ?? num(usage.completion_tokens) ?? num(usage.completionTokens) ?? num(usage.output) ?? 0;
    return inp + out > 0 ? inp + out : null;
  }
  return num(o.total_tokens) ?? num(o.totalTokens);
}

/** The events of a stream-json output, one JSON object per line; other lines are skipped */
function streamEvents(stdout: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    const j = tryParse(line.trim());
    if (j && typeof j === "object" && !Array.isArray(j)) out.push(j as Record<string, unknown>);
  }
  return out;
}

/** The text parts of an assistant event's message */
function assistantText(e: Record<string, unknown>): string {
  const content = (e.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p): p is { type: string; text: string } => !!p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

/**
 * `--output-format stream-json` answers (claude): the `result` event, which a few closing events may follow; without
 * one, the text of the last assistant message of the main session (sub-agent messages carry a parent_tool_use_id).
 * A run with background tasks ends one turn per task notification, each with its own `result` event, and the last
 * turn may only acknowledge a finished timer: every turn's result is kept, in order, so the real report is not lost.
 */
export function extractStreamAnswer(stdout: string): string {
  const events = streamEvents(stdout);
  const results = events.filter((e) => e.type === "result");
  if (results.length > 0)
    return results
      .map((e) => (typeof e.result === "string" ? e.result.trim() : ""))
      .filter(Boolean)
      .join("\n\n");
  const last = events.findLast((e) => e.type === "assistant" && !e.parent_tool_use_id && assistantText(e));
  return last ? assistantText(last) : "";
}

/** Usage in the `result` event of a stream-json output */
export function extractStreamUsage(stdout: string): number | null {
  const result = streamEvents(stdout).findLast((e) => e.type === "result");
  return result ? extractJsonUsage(JSON.stringify(result)) : null;
}

/**
 * Answer: outFile = the -o file, else the codex output tail; json = a `--output-format json` answer; stream-json = the
 * result event of a `--output-format stream-json` output; stdout = as is
 */
export const ANSWER_PARSER: Record<AnswerParser, (stdout: string, outFile: string | null) => string> = {
  outFile: codexAnswer,
  json: (stdout) => extractJsonAnswer(stdout),
  "stream-json": (stdout) => extractStreamAnswer(stdout),
  stdout: (stdout) => stdout.trim(),
};

/**
 * Session handle (the fallback when this round printed none differs): codex-header = the session id in the output
 * header, else the resume handle; json = the session id in the answer, else the resume handle; json-or-new = like
 * json, then the id we generated; caller-named = we name the session (grok -s) and ignore the output; none = no resume
 */
export const SESSION_PARSER: Record<SessionParser, (stdout: string, inv: Invocation) => string | null> = {
  "codex-header": (stdout, inv) => codexSession(stdout) ?? inv.resumeSession ?? null,
  json: (stdout, inv) => extractJsonSession(stdout) ?? inv.resumeSession ?? null,
  "json-or-new": (stdout, inv) => extractJsonSession(stdout) ?? inv.resumeSession ?? inv.newSession,
  "caller-named": (_stdout, inv) => inv.resumeSession ?? inv.newSession,
  none: () => null,
};

/** Usage: codex-tokens-used = "tokens used" at the end of `codex exec`; json = usage in the answer; stream-json = usage in the result event */
export const USAGE_PARSER: Record<UsageParser, (stdout: string) => number | null> = {
  "codex-tokens-used": codexUsage,
  json: extractJsonUsage,
  "stream-json": extractStreamUsage,
};
