/**
 * Executor defaults: parsing, merging and serializing `executors.json`.
 *
 * The file lives in the Longkeep home folder (`~/.longkeep/executors.json`), the only place executors are configured
 * (a project cannot override it). Plain JSON, readable with cat and editable by hand. The CLI and the MCP server
 * share this module, so parsing and validation exist exactly once.
 *
 * ```json
 * {
 *   "codex": { "model": "gpt-6-luna", "effort": "high" },
 *   "agy":   { "effort": "low" },
 *   "my-agent": { "label": "My agent", "command": "my-agent-cli", "args": ["run", "{prompt}"], "answer": "stdout" },
 *   "cursor-wt": { "command": "cursor-agent", "args": ["-p", "{prompt}", "--output-format", "json", "--trust"], "workRoot": "D:\\work\\app" }
 * }
 * ```
 * Built-in executors (local entries with an argument template in executor-registry.json) can only override defaults;
 * an entry with command is a custom executor. A custom executor may say `"extends": "codex"`: it inherits that built-in
 * entry's binary discovery, parsers, argument templates and resume support, then overrides field by field (command
 * changes the executable name; args replaces the whole pair, so follow-up rounds need their own resumeArgs or a
 * conditional group in args).
 * usage picks the usage parser by name (codex-tokens-used | json): an entry that extends inherits the built-in entry's
 * by default; one that does not uses json when answer is json, and codex-tokens-used otherwise (outFile / stdout, the
 * text output of codex-like CLIs).
 * args / resumeArgs are argument templates: string arrays that may contain conditional groups
 * {"if": "model", "args": ["-m", "{model}"]} (see the header comment of executor-registry.ts).
 * workRoot (working folder): the folder where the executor changes code; only a person can write it into the file (it
 * is not in SETTABLE_KEYS, so MCP cannot change it). The runner uses it as cwd and {cwd} and states it in the prompt
 * preamble; the record stays in the home folder.
 * fallback (optional, none by default): executors tried in order when this one cannot
 * start (not installed, process fails to launch), such as `[{ "executor": "cursor", "model": "…" }, { "executor":
 * "claude" }]`; only used by folder tasks.
 * yieldToIde (optional, off by default): a folder task run by this executor yields every project IntelliJ IDEA has open
 * (macOS only; see the CLI's folder/ide.ts). Only written by hand, like fallback.
 */

import {
  EFFORTS,
  LOCAL_EXECUTOR_IDS,
  USAGE_PARSERS,
  clampEffort,
  registryEntry,
  validateArgTemplate,
  type ArgTemplate,
  type Effort,
  type UsageParser,
} from "./executor-registry.ts";
import { HOME_LAYOUT } from "./layout.ts";
export { EFFORTS, type Effort } from "./executor-registry.ts";

export const EXECUTORS_FILE = HOME_LAYOUT.executors;

export const EFFORT_LABEL: Record<Effort, string> = { minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "extra high" };

/**
 * Each registry entry's efforts lists what Longkeep passes to that CLI (low…xhigh). No built-in CLI takes minimal, so
 * it is raised to low; a level above the list is lowered to its highest; higher CLI levels such as max go in the CLI's
 * own config. cursor's efforts are empty because the effort is part of the model id, so it returns undefined.
 * Custom executors not in the registry get the value as is (only useful when their template contains {effort}).
 */
export function effortFor(executor: string, effort: Effort | undefined): Effort | undefined {
  return clampEffort(registryEntry(executor), effort);
}

/** A working folder must be an absolute path (Windows drive / UNC, or POSIX /); whether it exists is checked by the runner */
const ABSOLUTE_PATH_RE = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;

export const SANDBOXES = ["read-only", "workspace-write", "danger-full-access"] as const;
export type Sandbox = (typeof SANDBOXES)[number];

export const ANSWER_SOURCES = ["json", "stdout", "outFile"] as const;
export type AnswerSource = (typeof ANSWER_SOURCES)[number];

export interface ExecutorOverride {
  label?: string;
  strengths?: string;
  bin?: string;
  model?: string;
  effort?: Effort;
  sandbox?: Sandbox;
  timeoutMs?: number;
  stallMs?: number;
  retries?: number;
  autoApprove?: boolean;
  /** Custom executor: the built-in executor it inherits from (a local registry entry that can be delegated to) */
  extends?: string;
  /** Custom executor: command and argument templates (placeholders and conditional groups: executor-registry.ts) */
  command?: string;
  args?: ArgTemplate;
  resumeArgs?: ArgTemplate;
  answer?: AnswerSource;
  /** Custom executor: usage parser name (default: see the header comment) */
  usage?: UsageParser;
  installHint?: string;
  /** Working folder: where the executor changes code (absolute path, only written by hand) */
  workRoot?: string;
  /** Launch-failure fallback chain for folder tasks (only written by hand; none by default) */
  fallback?: FallbackStep[];
  /** Folder tasks yield the projects IntelliJ IDEA has open (macOS; only written by hand; off by default) */
  yieldToIde?: boolean;
}

export interface FallbackStep {
  executor: string;
  model?: string;
  effort?: Effort;
}

export type ExecutorOverrides = Record<string, ExecutorOverride>;

/** Keys that set_executor_defaults may change (all others can only be edited in the file by hand) */
export const SETTABLE_KEYS = ["model", "effort", "sandbox", "timeoutMs", "stallMs", "retries", "autoApprove"] as const;

/** Whole-number limits [min, max] of one delegation, shared by the CLI flags and delegate_task */
export const RUN_LIMITS = {
  timeoutSeconds: [1, 7200],
  stallSeconds: [0, 7200],
  retries: [0, 3],
} as const;

const inMs = ([min, max]: readonly [number, number]) => [min * 1000, max * 1000] as const;
/** The same limits for an executor's defaults, wherever they are set (executors.json, set_executor_defaults, --set) */
export const DEFAULT_LIMITS = {
  timeoutMs: inMs(RUN_LIMITS.timeoutSeconds),
  stallMs: inMs(RUN_LIMITS.stallSeconds),
  retries: RUN_LIMITS.retries,
} as const;

export const NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Validates one override; throws when invalid (the message can be shown to people as is) */
export function validateOverride(name: string, o: unknown): ExecutorOverride {
  if (!NAME_RE.test(name)) throw new Error(`invalid executor name ${name} (starts with a lowercase letter, only a-z 0-9 _ -, at most 32 characters)`);
  if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error(`${name} must be an object`);
  const r = o as Record<string, unknown>;
  const out: ExecutorOverride = {};
  for (const k of ["label", "strengths", "bin", "model", "command", "installHint", "workRoot", "extends"] as const) {
    if (r[k] === undefined) continue;
    if (!isStr(r[k])) throw new Error(`${name}.${k} must be a string`);
    if ((r[k] as string).trim()) out[k] = (r[k] as string).trim();
  }
  if (r.effort !== undefined) {
    if (!isStr(r.effort) || !(EFFORTS as readonly string[]).includes(r.effort)) throw new Error(`${name}.effort only accepts ${EFFORTS.join(" | ")}`);
    out.effort = r.effort as Effort;
  }
  if (r.sandbox !== undefined) {
    if (!isStr(r.sandbox) || !(SANDBOXES as readonly string[]).includes(r.sandbox)) throw new Error(`${name}.sandbox only accepts ${SANDBOXES.join(" | ")}`);
    out.sandbox = r.sandbox as Sandbox;
  }
  for (const k of ["timeoutMs", "stallMs", "retries"] as const) {
    if (r[k] === undefined) continue;
    const [min, max] = DEFAULT_LIMITS[k];
    if (!isNum(r[k]) || !Number.isInteger(r[k]) || (r[k] as number) < min || (r[k] as number) > max) throw new Error(`${name}.${k} must be a whole number from ${min} to ${max}`);
    out[k] = r[k] as number;
  }
  for (const k of ["autoApprove", "yieldToIde"] as const) {
    if (r[k] === undefined) continue;
    if (typeof r[k] !== "boolean") throw new Error(`${name}.${k} must be a boolean`);
    out[k] = r[k] as boolean;
  }
  for (const k of ["args", "resumeArgs"] as const) {
    if (r[k] === undefined) continue;
    out[k] = validateArgTemplate(`${name}.${k}`, r[k]);
  }
  if (r.answer !== undefined) {
    if (!isStr(r.answer) || !(ANSWER_SOURCES as readonly string[]).includes(r.answer)) throw new Error(`${name}.answer only accepts ${ANSWER_SOURCES.join(" | ")}`);
    out.answer = r.answer as AnswerSource;
  }
  if (r.usage !== undefined) {
    if (!isStr(r.usage) || !(USAGE_PARSERS as readonly string[]).includes(r.usage)) throw new Error(`${name}.usage only accepts ${USAGE_PARSERS.join(" | ")}`);
    out.usage = r.usage as UsageParser;
  }
  if (out.workRoot && !ABSOLUTE_PATH_RE.test(out.workRoot)) throw new Error(`${name}.workRoot must be an absolute path`);
  if (r.fallback !== undefined) {
    if (!Array.isArray(r.fallback)) throw new Error(`${name}.fallback must be an array`);
    out.fallback = r.fallback.map((f, i) => {
      const at = `${name}.fallback[${i}]`;
      if (!f || typeof f !== "object" || Array.isArray(f)) throw new Error(`${at} must be an object`);
      const s = f as Record<string, unknown>;
      if (!isStr(s.executor) || !NAME_RE.test(s.executor) || s.executor === name) throw new Error(`${at}.executor must name another executor`);
      const step: FallbackStep = { executor: s.executor };
      if (s.model !== undefined) {
        if (!isStr(s.model)) throw new Error(`${at}.model must be a string`);
        step.model = s.model;
      }
      if (s.effort !== undefined) {
        if (!isStr(s.effort) || !(EFFORTS as readonly string[]).includes(s.effort)) throw new Error(`${at}.effort only accepts ${EFFORTS.join(" | ")}`);
        step.effort = s.effort as Effort;
      }
      return step;
    });
  }
  if (out.extends !== undefined) {
    if (!LOCAL_EXECUTOR_IDS.includes(out.extends)) throw new Error(`${name}.extends only accepts the built-in executors ${LOCAL_EXECUTOR_IDS.join(" | ")}`);
    if (LOCAL_EXECUTOR_IDS.includes(name)) throw new Error(`${name} is a built-in executor and cannot use extends`);
    if (out.args && out.args.length === 0) throw new Error(`${name}.args must not be empty`);
  } else {
    if (out.command && (!out.args || out.args.length === 0)) throw new Error(`custom executor ${name} is missing args`);
    if (!out.command && out.args) throw new Error(`${name} has args but no command`);
    // Settings alone only make sense for a built-in executor; for any other name they are usually a typo
    if (!out.command && !LOCAL_EXECUTOR_IDS.includes(name) && Object.keys(out).length > 0) {
      throw new Error(`no executor named ${name}: the built-in ones are ${LOCAL_EXECUTOR_IDS.join(" | ")}; a custom executor needs command and args, or extends`);
    }
  }
  return out;
}

/** Parses the whole file; empty text = empty table; broken JSON / a wrong shape throws (never silently ignored) */
export function parseExecutorOverrides(text: string): ExecutorOverrides {
  if (!text.trim()) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`${EXECUTORS_FILE} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`the top level of ${EXECUTORS_FILE} must be an object`);
  const out: ExecutorOverrides = {};
  for (const [name, o] of Object.entries(raw as Record<string, unknown>)) out[name] = validateOverride(name, o);
  return out;
}

/**
 * Merges one change and returns a new table (the input is not modified):
 *   - patch null → the whole entry is removed
 *   - keys in patch whose value is null / "" / undefined → that key is removed ("back to the CLI's own default")
 *   - other keys overwrite; the result goes through validateOverride first
 *   - an entry that ends up as an empty object is removed from the table
 */
export function mergeExecutorOverride(
  all: ExecutorOverrides,
  name: string,
  patch: Partial<Record<keyof ExecutorOverride, unknown>> | null,
): ExecutorOverrides {
  const next: ExecutorOverrides = { ...all };
  if (patch === null) {
    delete next[name];
    return next;
  }
  const merged: Record<string, unknown> = { ...(all[name] ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || v === "") delete merged[k];
    else merged[k] = v;
  }
  const valid = validateOverride(name, merged);
  if (Object.keys(valid).length === 0) delete next[name];
  else next[name] = valid;
  return next;
}

export function serializeExecutorOverrides(all: ExecutorOverrides): string {
  return JSON.stringify(all, null, 2) + "\n";
}

/** Fullwidth colon, accepted after an author name in a suggestion a person wrote (built at runtime: the source is ASCII) */
const FW_COLON = String.fromCodePoint(0xff1a);
const SIGNED_INSERTION = new RegExp(`\\{\\+\\+@[^\\s:${FW_COLON}{}]{1,32}[:${FW_COLON}]`, "g");

/** Number of suggestions waiting to be merged into the handbook (signed CriticMarkup insertions written back by executors) */
export function countPendingSuggestions(text: string): number {
  return (text.match(SIGNED_INSERTION) ?? []).length;
}

/** A suggestion nobody has decided on yet: an executor's words, not the handbook's */
export interface PendingSuggestion {
  author: string;
  text: string;
}

const SIGNED_BLOCK = new RegExp(`\\{\\+\\+@([^\\s:${FW_COLON}{}]{1,32})[:${FW_COLON}]([\\s\\S]*?)\\+\\+\\}`, "g");

/**
 * Splits a handbook into the text people accepted and the suggestions still waiting. A suggestion ends at the first
 * `++}`; writeback escapes that sequence inside an answer, so an answer cannot end its block early.
 */
export function splitSuggestions(text: string): { accepted: string; suggestions: PendingSuggestion[] } {
  const suggestions: PendingSuggestion[] = [];
  const accepted = text.replace(SIGNED_BLOCK, (_m, author: string, body: string) => {
    suggestions.push({ author, text: body.trim() });
    return "";
  });
  return { accepted, suggestions };
}
