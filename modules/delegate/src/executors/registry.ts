/**
 * The executor table: what Longkeep can delegate to and how to launch it.
 *
 * - Built-in executors come from the registry (`@longkeep/protocol/executor-registry`, entries with an argument
 *   template, in registry order): arguments, parsers, usage scope and defaults all come from that table.
 * - On top: `<home>/executors.json` (layout.ts), the only configuration file. An entry for a built-in without
 *   `command` / `extends` only overrides defaults; any other entry is a custom executor (format and validation:
 *   `@longkeep/protocol/executors`). A missing file is an empty table; a broken file throws, never silently ignored.
 * - A project cannot add or change executors: Longkeep reads no configuration from a project folder, so a
 *   cloned repository cannot decide which command a delegation runs.
 * - `updateExecutorDefaults` changes one entry with an atomic write through the scoped path module.
 * - Binary resolution (discovery.ts): environment override > `bin` in executors.json > PATH (+ searchPath) > discovery
 *   rules. A `.js` / `.mjs` entry point is launched with the current Node.
 * - A declared working folder: `workRoot` written by hand in executors.json, or a `-C` / `--cd` / `--cwd` /
 *   `--workspace` hard-coded in the first-round template (one rendered from `{cwd}` does not count).
 */
import fs from "node:fs";
import {
  SETTABLE_KEYS,
  mergeExecutorOverride,
  parseExecutorOverrides,
  serializeExecutorOverrides,
  type Effort,
  type ExecutorOverride,
  type ExecutorOverrides,
  type FallbackStep,
  type Sandbox,
} from "@longkeep/protocol/executors";
import { LOCAL_EXECUTOR_IDS, REGISTRY, registryEntry, renderArgs, type ArgTemplate, type DiscoverRule, type RegistryEntry } from "@longkeep/protocol/executor-registry";
import { HOME_LAYOUT } from "@longkeep/protocol/layout";
import { ensureHome, existingHome } from "@longkeep/common/home";
import { atomicWriteFile, resolveScoped, resolveWritePathCreating } from "@longkeep/common/scoped";
import { discoverCandidates, explainBin, whichOnPath, type BinSource } from "./discovery.ts";
import { ANSWER_PARSER, SESSION_PARSER, USAGE_PARSER } from "./parsers.ts";

export type { Effort, Sandbox } from "@longkeep/protocol/executors";

/** Built-in executor names: the registry's delegatable entries, in registry order */
export const BUILTIN_NAMES: readonly string[] = LOCAL_EXECUTOR_IDS;

export interface Invocation {
  prompt: string;
  cwd: string;
  outFile: string | null;
  model?: string;
  effort?: Effort;
  sandbox: Sandbox;
  timeoutMs: number;
  autoApprove: boolean;
  /** Follow-up round: the session handle left by the previous round (without the executor prefix) */
  resumeSession?: string;
  /** First round: a session id we generated (for CLIs whose caller names the session, such as grok) */
  newSession: string;
}

export interface ExecutorDefaults {
  model?: string;
  effort?: Effort;
  sandbox?: Sandbox;
  timeoutMs?: number;
  stallMs?: number;
  retries?: number;
  autoApprove?: boolean;
}

export interface ExecutorSpec {
  name: string;
  label: string;
  strengths: string;
  /** Environment variable that overrides the executable path */
  binEnv?: string;
  /** Names looked up on PATH */
  binNames: string[];
  /** Known install locations, tried when PATH has none */
  candidates: (env?: NodeJS.ProcessEnv) => string[];
  installHint: string;
  autoApproveDefault: boolean;
  needsOutFile: boolean;
  /** Whether a session can be resumed across processes (false = follow-up rounds replay the previous answer) */
  canResume: boolean;
  buildArgs: (inv: Invocation) => string[];
  extractAnswer: (stdout: string, outFile: string | null) => string;
  /** The session handle in the output; null when this round has none */
  extractSession: (stdout: string, inv: Invocation) => string | null;
  extractUsage: (stdout: string) => number | null;
  /**
   * round = every call reports its own usage; cumulative = resumed sessions report the session total (the runner takes
   * the difference to the previous round). Default round.
   */
  usageScope?: "round" | "cumulative";
  defaults: ExecutorDefaults;
  /** Executable set in executors.json */
  bin?: string;
  /** Working folder written by hand in executors.json (absolute path) */
  workRoot?: string;
  /** Launch-failure fallback chain (folder tasks only) */
  fallback?: FallbackStep[];
  /** Folder tasks yield the projects IntelliJ IDEA has open (folder/ide.ts; macOS only) */
  yieldToIde?: boolean;
}

/**
 * Template context: placeholder values and condition flags of an invocation (template syntax: executor-registry.ts).
 * {timeoutMin} = the timeout in whole minutes (at least 1; agy's --print-timeout); {session} = the resume handle, in
 * the first round the id we generated.
 */
function argContext(inv: Invocation) {
  return {
    values: {
      prompt: inv.prompt,
      cwd: inv.cwd,
      outFile: inv.outFile ?? "",
      model: inv.model ?? "",
      effort: inv.effort ?? "",
      session: inv.resumeSession ?? inv.newSession,
      newSession: inv.newSession,
      resumeSession: inv.resumeSession ?? "",
      sandbox: inv.sandbox,
      timeoutMin: String(Math.max(1, Math.ceil(inv.timeoutMs / 60_000))),
    },
    flags: {
      model: !!inv.model,
      effort: !!inv.effort,
      autoApprove: inv.autoApprove,
      resume: !!inv.resumeSession,
      fresh: !inv.resumeSession,
      outFile: !!inv.outFile,
    },
  };
}

/** A follow-up round uses the resume template when there is one, otherwise the fresh one (with conditional groups) */
const templateFor = (fresh: ArgTemplate, resume: ArgTemplate | undefined) => (inv: Invocation) =>
  renderArgs(inv.resumeSession && resume ? resume : fresh, argContext(inv));

const discoveryOf = (rules: DiscoverRule[] | undefined) => (env?: NodeJS.ProcessEnv) => discoverCandidates(rules, env ? { env } : {});

function specFromEntry(e: RegistryEntry): ExecutorSpec {
  const bin = e.bin!;
  const args = e.args!;
  return {
    name: e.id,
    label: e.label,
    strengths: e.strengths ?? "(not described)",
    binEnv: bin.env,
    binNames: [...bin.names],
    candidates: discoveryOf(bin.discover),
    installHint: e.installHint ?? `${e.id} not found`,
    autoApproveDefault: !!e.autoApproveDefault,
    needsOutFile: !!e.needsOutFile,
    canResume: !!e.canResume,
    buildArgs: templateFor(args.fresh, args.resume),
    extractAnswer: ANSWER_PARSER[e.answer!],
    extractSession: SESSION_PARSER[e.session!],
    extractUsage: USAGE_PARSER[e.usage!.parser],
    usageScope: e.usage!.scope,
    defaults: { ...(e.defaults ?? {}) },
  };
}

/** Built-in executors, in registry order */
export const BUILTIN_EXECUTORS: Record<string, ExecutorSpec> = Object.fromEntries(
  REGISTRY.executors.filter((e) => e.args).map((e) => [e.id, specFromEntry(e)]),
);

const hasResumeBranch = (tpl: ArgTemplate) => tpl.some((a) => typeof a !== "string" && a.if === "resume");

const overrideDefaults = (o: ExecutorOverride): ExecutorDefaults => ({
  ...(o.model !== undefined ? { model: o.model } : {}),
  ...(o.effort !== undefined ? { effort: o.effort } : {}),
  ...(o.sandbox !== undefined ? { sandbox: o.sandbox } : {}),
  ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}),
  ...(o.stallMs !== undefined ? { stallMs: o.stallMs } : {}),
  ...(o.retries !== undefined ? { retries: o.retries } : {}),
});

/**
 * A custom executor from one executors.json entry.
 * With extends: inherits that built-in entry's discovery, parsers, templates, resume support and usage scope, then
 * overrides field by field (command changes the executable name and skips discovery; args replaces the pair, so
 * follow-up rounds need resumeArgs or an {"if": "resume"} group in args).
 */
export function customExecutor(name: string, o: ExecutorOverride): ExecutorSpec {
  if (o.extends) {
    const base = BUILTIN_EXECUTORS[o.extends];
    const entry = registryEntry(o.extends);
    if (!base || !entry?.args) throw new Error(`${name}.extends in executors.json names an unknown built-in executor ${o.extends}`);
    const fresh = o.args ?? entry.args.fresh;
    const resume = o.args ? o.resumeArgs : (o.resumeArgs ?? entry.args.resume);
    const command = o.command;
    return {
      ...base,
      name,
      label: o.label ?? name,
      strengths: o.strengths ?? base.strengths,
      ...(command ? { binEnv: undefined, binNames: [command], candidates: () => [command] } : {}),
      installHint: o.installHint ?? base.installHint,
      autoApproveDefault: o.autoApprove ?? base.autoApproveDefault,
      needsOutFile: o.answer ? o.answer === "outFile" : base.needsOutFile,
      canResume: o.args ? !!o.resumeArgs || hasResumeBranch(o.args) : base.canResume,
      buildArgs: templateFor(fresh, resume),
      ...(o.answer ? { extractAnswer: ANSWER_PARSER[o.answer] } : {}),
      ...(o.usage ? { extractUsage: USAGE_PARSER[o.usage] } : {}),
      defaults: { ...base.defaults, ...overrideDefaults(o) },
      bin: o.bin,
      workRoot: o.workRoot,
      fallback: o.fallback,
      yieldToIde: o.yieldToIde,
    };
  }
  if (!o.command || !Array.isArray(o.args) || o.args.length === 0) throw new Error(`custom executor ${name} in executors.json is missing command / args`);
  const answer = o.answer ?? "json";
  const command = o.command;
  const resumeArgs = o.resumeArgs;
  return {
    name,
    label: o.label ?? name,
    strengths: o.strengths ?? "(not described)",
    binNames: [command],
    candidates: () => [command],
    installHint: o.installHint ?? `${name}: the command ${command} declared in executors.json was not found`,
    autoApproveDefault: o.autoApprove ?? false,
    needsOutFile: answer === "outFile",
    canResume: !!resumeArgs,
    buildArgs: templateFor(o.args, resumeArgs),
    extractAnswer: ANSWER_PARSER[answer],
    extractSession: SESSION_PARSER[resumeArgs ? "json-or-new" : "none"],
    extractUsage: USAGE_PARSER[o.usage ?? (answer === "json" ? "json" : "codex-tokens-used")],
    defaults: { model: o.model, effort: o.effort, sandbox: o.sandbox, timeoutMs: o.timeoutMs, stallMs: o.stallMs, retries: o.retries },
    bin: o.bin,
    workRoot: o.workRoot,
    fallback: o.fallback,
    yieldToIde: o.yieldToIde,
  };
}

/* ------------------------------------------------------------------ */
/* executors.json                                                      */
/* ------------------------------------------------------------------ */

/** The text of `<home>/executors.json`, or null when there is none; creates nothing */
function readConfigText(env: NodeJS.ProcessEnv): string | null {
  const home = existingHome(env);
  if (!home) return null;
  let abs: string;
  try {
    abs = resolveScoped(home, HOME_LAYOUT.executors);
  } catch {
    return null;
  }
  return fs.readFileSync(abs, "utf8");
}

function readOverrides(env: NodeJS.ProcessEnv): ExecutorOverrides {
  const text = readConfigText(env);
  if (text === null) return {};
  try {
    return parseExecutorOverrides(text);
  } catch (e) {
    throw new Error(`home ${(e as Error).message}`);
  }
}

/**
 * The `bin` of every entry, tolerating a broken file (the health check still reports when the table cannot be
 * loaded; the delegation runner throws on the same file).
 */
export function readBinOverrides(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  let raw: unknown;
  try {
    raw = JSON.parse(readConfigText(env) ?? "{}");
  } catch {
    return out;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, o] of Object.entries(raw as Record<string, unknown>)) {
    const b = o && typeof o === "object" && typeof (o as { bin?: unknown }).bin === "string" ? (o as { bin: string }).bin.trim() : "";
    if (b) out[k] = b;
  }
  return out;
}

/** The merged table: built-ins, then the home folder's executors.json */
export function loadExecutors(env: NodeJS.ProcessEnv = process.env): Record<string, ExecutorSpec> {
  const table: Record<string, ExecutorSpec> = {};
  for (const [k, v] of Object.entries(BUILTIN_EXECUTORS)) table[k] = { ...v, defaults: { ...v.defaults } };
  const overrides = readOverrides(env);
  for (const [name, o] of Object.entries(overrides)) {
    const base = table[name];
    if (base && BUILTIN_NAMES.includes(name) && !o.command && !o.extends) {
      table[name] = {
        ...base,
        label: o.label ?? base.label,
        strengths: o.strengths ?? base.strengths,
        bin: o.bin ?? base.bin,
        workRoot: o.workRoot ?? base.workRoot,
        fallback: o.fallback ?? base.fallback,
        yieldToIde: o.yieldToIde ?? base.yieldToIde,
        autoApproveDefault: o.autoApprove ?? base.autoApproveDefault,
        defaults: { ...base.defaults, ...overrideDefaults(o) },
      };
    } else {
      table[name] = customExecutor(name, o);
    }
  }
  return table;
}

/**
 * Changes one entry of `<home>/executors.json` and writes it atomically (patch null removes the entry; a key set to
 * null / "" is removed). Returns the file's table after the write.
 */
export function updateExecutorDefaults(
  name: string,
  patch: Partial<Record<keyof ExecutorOverride, unknown>> | null,
  opts: { env?: NodeJS.ProcessEnv } = {},
): ExecutorOverrides {
  const root = ensureHome(opts.env ?? process.env);
  const rel = HOME_LAYOUT.executors;
  const target = resolveWritePathCreating(root, rel);
  let current: ExecutorOverrides = {};
  try {
    current = parseExecutorOverrides(fs.readFileSync(resolveScoped(root, rel), "utf8"));
  } catch (e) {
    if ((e as { status?: number }).status !== 404) throw e;
  }
  const next = mergeExecutorOverride(current, name, patch);
  atomicWriteFile(target, serializeExecutorOverrides(next));
  return next;
}

/* ------------------------------------------------------------------ */
/* Binaries, declared working folders, the list                        */
/* ------------------------------------------------------------------ */

/** PATH lookup (Windows: only .exe; discovery.ts) */
export function whichExecutable(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  return whichOnPath(name, env, process.platform);
}

function explainExecutorBin(spec: ExecutorSpec, env: NodeJS.ProcessEnv = process.env): { bin: string | null; source: BinSource | null } {
  return explainBin({ override: spec.binEnv ? env[spec.binEnv] : null, bin: spec.bin, names: spec.binNames, candidates: () => spec.candidates(env) }, { env });
}

/** The executable of an executor in resolution order; null when not found */
export function resolveExecutorBin(spec: ExecutorSpec, env: NodeJS.ProcessEnv = process.env): string | null {
  return explainExecutorBin(spec, env).bin;
}

const ROOT_FLAGS = new Set(["-C", "--cd", "--cwd", "--workspace"]);
const CWD_PROBE = "<longkeep-cwd>";

/** The folder in -C <dir> / --cd / --cwd / --workspace, or --flag=<dir> */
function rootFromArgs(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = a.indexOf("=");
    if (eq > 0 && ROOT_FLAGS.has(a.slice(0, eq))) return a.slice(eq + 1);
    if (ROOT_FLAGS.has(a) && i + 1 < args.length) return args[i + 1];
  }
  return null;
}

/** The working folder an executor declares (see the header comment); null when it declares none */
export function declaredWorkRoot(spec: ExecutorSpec): string | null {
  if (spec.workRoot) return spec.workRoot;
  const probe = spec.buildArgs({ prompt: "", cwd: CWD_PROBE, outFile: null, sandbox: "workspace-write", timeoutMs: 60_000, autoApprove: false, newSession: "probe" });
  const hit = rootFromArgs(probe);
  return hit && hit !== CWD_PROBE ? hit : null;
}

export interface ExecutorStatus {
  name: string;
  label: string;
  strengths: string;
  bin: string | null;
  canResume: boolean;
  builtin: boolean;
  /** Defaults that apply when delegating (keys not set = the CLI's own default) */
  defaults: ExecutorDefaults;
  /** Whether `<home>/executors.json` has an entry for it */
  configured: boolean;
  /** Declared working folder; null = works where the request says (scratch folder by default) */
  workRoot: string | null;
  installHint?: string;
}

export function listExecutors(env: NodeJS.ProcessEnv = process.env): ExecutorStatus[] {
  const table = loadExecutors(env);
  let configured = new Set<string>();
  try {
    configured = new Set(Object.keys(readOverrides(env)));
  } catch {
    /* loadExecutors above already threw on a broken file */
  }
  return Object.values(table).map((spec) => {
    const bin = resolveExecutorBin(spec, env);
    const defaults: ExecutorDefaults = {};
    for (const k of SETTABLE_KEYS) {
      const v = spec.defaults[k];
      if (v !== undefined) (defaults as Record<string, unknown>)[k] = v;
    }
    defaults.autoApprove = spec.autoApproveDefault;
    return {
      name: spec.name,
      label: spec.label,
      strengths: spec.strengths,
      bin,
      canResume: spec.canResume,
      builtin: BUILTIN_NAMES.includes(spec.name),
      defaults,
      configured: configured.has(spec.name),
      workRoot: declaredWorkRoot(spec),
      ...(bin ? {} : { installHint: spec.installHint }),
    };
  });
}
