/**
 * Executor registry: `executor-registry.json` is the **only definition** of executor ids, discovery
 * rules, argument templates, parser names and usage scopes, reasoning effort levels and process names; this module
 * types it, validates it at load time, and renders argument templates.
 *
 * Who reads the JSON: the CLI's executor module (binary resolution, the executor table built from the registry,
 * `openagent doctor`) and the delegation runner. No other list of executors exists.
 *
 * Every entry is a local CLI; an entry with `args` can be delegated to and is a built-in executor.
 *
 * Discovery rules (`bin.discover`; the CLI's discovery code is the only interpreter):
 *   `{ os?, path, pick?, then? }`. In path, `~/` = the user's home directory; `%LOCALAPPDATA%` / `%APPDATA%` come from
 *   the environment (defaulting to AppData/Local and AppData/Roaming under the home directory); `{exe}` is `.exe` on
 *   Windows and empty elsewhere; the separator is always `/`.
 *   Without pick, path is a candidate file; with pick, path is a folder whose subfolders are listed by a named rule and
 *   joined with then:
 *     - `claude-version`: purely numeric dotted version folders, newest first; each version lists `<version>/<then>`
 *       first, then `<version>/<subfolder>/<then>` (some versions add a build-hash folder)
 *     - `claude-data`: every package folder, each read as `<package>/claude-code` with the `claude-version` rule (the
 *       Claude desktop app installed from the Microsoft Store keeps its copies under `Claude-Data/<package>/`)
 *     - `cursor-version`: the same version-folder rule as the official cursor-agent.ps1
 *       (YYYY.MM.DD[-HH-MM-SS]-<lowercase hex>), newest first; `.previous`, zips and dist-package do not count
 *     - `newest`: then under every subfolder, newest modification time first (the codex bundled with the ChatGPT
 *       desktop app)
 *   Resolution order: environment override (bin.env) > `bin` in executors.json > PATH (plus the platform folders in
 *   searchPath; on Windows only .exe counts) > discover. Delegation, `openagent delegate --list` and `openagent doctor`
 *   all use this one order.
 *
 * Argument templates (`args.fresh`, optionally `args.resume`; follow-up rounds without resume use fresh, branching with
 * conditional groups):
 *   An array of strings, where an element may be a conditional group `{ "if": <condition>, "args": [...] }` that expands
 *   only when the condition is true. Conditions: model / effort / autoApprove / resume / fresh / outFile. Placeholders:
 *   {prompt} {cwd} {outFile} {model} {effort} {session} {newSession} {resumeSession} {sandbox} {timeoutMin};
 *   substitution happens once (a `{cwd}` inside the prompt stays as written). A plain string array works too:
 *   when an argument is exactly {model} / {effort} and no value is given, it is dropped together with the flag before
 *   it (such as "-m" "{model}").
 *
 * Parser names (implemented by the CLI's delegation module): answer = outFile | json | stream-json | stdout; session =
 * codex-header | json | json-or-new | caller-named | none; usage.parser = codex-tokens-used | json | stream-json. usage.scope: round = every call
 * reports its own usage, cumulative = resumed sessions report the session total (the runner takes the delta instead of
 * adding rounds up).
 *
 * Pure TS, no dependencies, no IO (the protocol package's rule).
 */
import data from "./executor-registry.json" with { type: "json" };

/** Effort levels OpenAgent accepts, from low to high; each entry's efforts lists the subset it passes on to that CLI */
export const EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;
export type Effort = (typeof EFFORTS)[number];

export const PLATFORMS = ["win32", "darwin", "linux"] as const;
export type Platform = (typeof PLATFORMS)[number];

export const PICKS = ["claude-version", "claude-data", "cursor-version", "newest"] as const;
export type DiscoverPick = (typeof PICKS)[number];

export const ARG_CONDITIONS = ["model", "effort", "autoApprove", "resume", "fresh", "outFile"] as const;
export type ArgCondition = (typeof ARG_CONDITIONS)[number];

export const ARG_PLACEHOLDERS = ["prompt", "cwd", "outFile", "model", "effort", "session", "newSession", "resumeSession", "sandbox", "timeoutMin"] as const;
export type ArgPlaceholder = (typeof ARG_PLACEHOLDERS)[number];

export const ANSWER_PARSERS = ["outFile", "json", "stream-json", "stdout"] as const;
export type AnswerParser = (typeof ANSWER_PARSERS)[number];
export const SESSION_PARSERS = ["codex-header", "json", "json-or-new", "caller-named", "none"] as const;
export type SessionParser = (typeof SESSION_PARSERS)[number];
export const USAGE_PARSERS = ["codex-tokens-used", "json", "stream-json"] as const;
export type UsageParser = (typeof USAGE_PARSERS)[number];
export const USAGE_SCOPES = ["round", "cumulative"] as const;
export type UsageScope = (typeof USAGE_SCOPES)[number];

export interface ArgGroup {
  if: ArgCondition;
  args: string[];
}
export type ArgItem = string | ArgGroup;
export type ArgTemplate = ArgItem[];

export interface DiscoverRule {
  os?: Platform[];
  path: string;
  pick?: DiscoverPick;
  then?: string;
}

export interface PathRule {
  os?: Platform[];
  path: string;
}

export interface BinSpec {
  /** Environment variable that overrides the executable path */
  env?: string;
  /** Candidate names on PATH (without extension) */
  names: string[];
  discover?: DiscoverRule[];
}

export type ProcessNames = Record<Platform, string[]>;

/**
 * Health check (`openagent doctor`): the version arguments and how to tell the sign-in state. What cannot be decided is
 * "unknown", never a guess:
 *   - `{ file, env? }`: the credentials file (starting with `~/`) exists = signed in (expiry not checked). Missing:
 *     signed out when none of the API key variables in `env` is set, unknown when one is (or when `env` is not given)
 *   - `{ command, yes?, no? }`: run these arguments (stdin closed, short timeout); output matching the yes regex = signed
 *     in, matching the no regex = signed out, anything else = unknown
 * Tried in order; the first rule that says signed in / signed out wins. Only the minimal real call of `--probe` can tell
 * whether the plan is actually entitled to a model.
 */
export interface DoctorSpec {
  version?: string[];
  login?: Array<{ file: string; env?: string[] } | { command: string[]; yes?: string; no?: string }>;
}

export interface RegistryEntry {
  id: string;
  label: string;
  strengths?: string;
  installHint?: string;
  bin?: BinSpec;
  process?: ProcessNames;
  /** The CLI's local state folder (starting with `~/`) */
  home?: string;
  args?: { fresh: ArgTemplate; resume?: ArgTemplate };
  answer?: AnswerParser;
  session?: SessionParser;
  usage?: { parser: UsageParser; scope: UsageScope };
  needsOutFile?: boolean;
  canResume?: boolean;
  autoApproveDefault?: boolean;
  /**
   * Accepted reasoning effort levels (an ascending subset); empty array = effort is not passed separately (cursor: the
   * effort is part of the model id); omitted = passed through as is
   */
  efforts?: Effort[];
  /** Which flag carries the effort to the CLI (for display); null = not passed separately */
  effortFlag?: string | null;
  /** Whether the delegation settings can choose a sandbox (codex's -s) */
  sandbox?: boolean;
  defaults?: { stallMs?: number };
  doctor?: DoctorSpec;
}

export interface Registry {
  version: number;
  /** Default choices: folderTask = which executor folder tasks go to by default */
  roles: { folderTask: string };
  searchPath: PathRule[];
  executors: RegistryEntry[];
}

/* ------------------------------------------------------------------ */
/* Validation (runs once at load time; a broken table throws, never silently) */
/* ------------------------------------------------------------------ */

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => isStr(v) && (list as readonly string[]).includes(v);
const ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/** Validates one argument template; throws when invalid (where locates the error) */
export function validateArgTemplate(where: string, v: unknown): ArgTemplate {
  if (!Array.isArray(v)) throw new Error(`${where} must be an array`);
  return v.map((item, i) => {
    if (isStr(item)) return item;
    if (isObj(item) && oneOf(ARG_CONDITIONS, item.if) && isStrArr(item.args) && Object.keys(item).length === 2) return { if: item.if, args: [...item.args] };
    throw new Error(`${where}[${i}] must be a string or {"if": ${ARG_CONDITIONS.join("|")}, "args": [strings…]}`);
  });
}

function validatePlatforms(where: string, v: unknown): Platform[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every((x) => oneOf(PLATFORMS, x))) throw new Error(`${where}.os must be an array of ${PLATFORMS.join(" | ")}`);
  return v as Platform[];
}

function validateProcess(where: string, v: unknown): ProcessNames {
  if (!isObj(v) || !PLATFORMS.every((p) => isStrArr(v[p]))) throw new Error(`${where}.process must give arrays of process names for ${PLATFORMS.join(" / ")}`);
  return { win32: v.win32 as string[], darwin: v.darwin as string[], linux: v.linux as string[] };
}

function validateEntry(e: unknown): RegistryEntry {
  if (!isObj(e) || !isStr(e.id) || !ID_RE.test(e.id)) throw new Error(`registry entry has no id or an invalid id: ${JSON.stringify(e)}`);
  const id = e.id;
  const w = `registry ${id}`;
  if (!isStr(e.label)) throw new Error(`${w} is missing label`);
  const out: RegistryEntry = { ...(e as unknown as RegistryEntry) };
  if (e.bin !== undefined) {
    const b = e.bin;
    if (!isObj(b) || !isStrArr(b.names) || (b.env !== undefined && !isStr(b.env))) throw new Error(`${w}.bin needs a names array (env is optional)`);
    for (const [i, r] of ((b.discover as unknown[]) ?? []).entries()) {
      if (!isObj(r) || !isStr(r.path)) throw new Error(`${w}.bin.discover[${i}] is missing path`);
      validatePlatforms(`${w}.bin.discover[${i}]`, r.os);
      if (r.pick !== undefined && !oneOf(PICKS, r.pick)) throw new Error(`${w}.bin.discover[${i}].pick only accepts ${PICKS.join(" | ")}`);
      if (r.pick !== undefined && !isStr(r.then)) throw new Error(`${w}.bin.discover[${i}] has pick, so it needs then`);
    }
  }
  if (e.process !== undefined) validateProcess(w, e.process);
  if (e.args !== undefined) {
    const a = e.args;
    if (!isObj(a)) throw new Error(`${w}.args must be {fresh, resume?}`);
    out.args = { fresh: validateArgTemplate(`${w}.args.fresh`, a.fresh), ...(a.resume !== undefined ? { resume: validateArgTemplate(`${w}.args.resume`, a.resume) } : {}) };
    if (!e.bin) throw new Error(`${w} has an argument template but no bin`);
    if (!oneOf(ANSWER_PARSERS, e.answer)) throw new Error(`${w}.answer only accepts ${ANSWER_PARSERS.join(" | ")}`);
    if (!oneOf(SESSION_PARSERS, e.session)) throw new Error(`${w}.session only accepts ${SESSION_PARSERS.join(" | ")}`);
    const u = e.usage;
    if (!isObj(u) || !oneOf(USAGE_PARSERS, u.parser) || !oneOf(USAGE_SCOPES, u.scope)) throw new Error(`${w}.usage needs parser (${USAGE_PARSERS.join(" | ")}) and scope (${USAGE_SCOPES.join(" | ")})`);
    for (const k of ["needsOutFile", "canResume", "autoApproveDefault"] as const)
      if (typeof e[k] !== "boolean") throw new Error(`${w}.${k} must be a boolean`);
  }
  if (e.efforts !== undefined && (!Array.isArray(e.efforts) || !e.efforts.every((x) => oneOf(EFFORTS, x)))) throw new Error(`${w}.efforts only accepts ${EFFORTS.join(" | ")}`);
  if (e.doctor !== undefined) {
    const d = e.doctor;
    if (!isObj(d) || (d.version !== undefined && !isStrArr(d.version))) throw new Error(`${w}.doctor.version must be an array of strings`);
    for (const [i, r] of ((d.login as unknown[]) ?? []).entries()) {
      const okFile = isObj(r) && isStr(r.file) && (r.env === undefined || isStrArr(r.env));
      const okCmd = isObj(r) && isStrArr(r.command) && [r.yes, r.no].every((x) => x === undefined || isStr(x));
      if (!okFile && !okCmd) throw new Error(`${w}.doctor.login[${i}] must be {file, env?} or {command, yes?, no?}`);
      for (const k of ["yes", "no"] as const) if (okCmd && isStr(r[k])) new RegExp(r[k] as string);
    }
  }
  return out;
}

/** Validates the whole table (exported for tests; runs on the bundled JSON when the module loads) */
export function validateRegistry(raw: unknown): Registry {
  if (!isObj(raw) || !Array.isArray(raw.executors)) throw new Error("registry is missing executors");
  const executors = raw.executors.map(validateEntry);
  const ids = new Set<string>();
  for (const e of executors) {
    if (ids.has(e.id)) throw new Error(`duplicate registry id: ${e.id}`);
    ids.add(e.id);
  }
  const searchPath = ((raw.searchPath as unknown[]) ?? []).map((r, i) => {
    if (!isObj(r) || !isStr(r.path)) throw new Error(`registry searchPath[${i}] is missing path`);
    return { path: r.path, ...(r.os !== undefined ? { os: validatePlatforms(`searchPath[${i}]`, r.os) } : {}) };
  });
  const roles = raw.roles;
  if (!isObj(roles) || !isStr(roles.folderTask) || !executors.some((e) => e.id === roles.folderTask && e.args))
    throw new Error("registry roles.folderTask must be an entry that can be delegated to");
  return { version: Number(raw.version ?? 1), roles: { folderTask: roles.folderTask }, searchPath, executors };
}

export const REGISTRY: Registry = validateRegistry(data);

export const registryEntry = (id: string): RegistryEntry | undefined => REGISTRY.executors.find((e) => e.id === id);

/** Local executors that can be delegated to (they have an argument template), in registry order */
export const LOCAL_EXECUTOR_IDS: readonly string[] = REGISTRY.executors.filter((e) => e.args).map((e) => e.id);

/** Whether a rule applies on this platform */
export const ruleApplies = (r: { os?: Platform[] }, platform: string): boolean => !r.os || (r.os as string[]).includes(platform);

/* ------------------------------------------------------------------ */
/* Effort                                                              */
/* ------------------------------------------------------------------ */

/**
 * Clamps an effort to one the entry accepts: kept when listed; otherwise the nearest higher level, or the highest level
 * when there is none higher (minimal → low); an empty efforts array = no effort (undefined); an entry without efforts,
 * or one not in the registry = passed through as is (custom executors).
 */
export function clampEffort(entry: { efforts?: Effort[] } | undefined, effort: Effort | undefined): Effort | undefined {
  if (!effort) return undefined;
  const accepted = entry?.efforts;
  if (!accepted) return effort;
  if (accepted.length === 0) return undefined;
  if (accepted.includes(effort)) return effort;
  const at = EFFORTS.indexOf(effort);
  return accepted.find((x) => EFFORTS.indexOf(x) > at) ?? accepted[accepted.length - 1];
}

/* ------------------------------------------------------------------ */
/* Rendering argument templates                                        */
/* ------------------------------------------------------------------ */

export interface ArgContext {
  /** Placeholder values; missing ones become an empty string */
  values: Partial<Record<ArgPlaceholder, string>>;
  /** Truth values of the conditional groups */
  flags: Record<ArgCondition, boolean>;
}

const PLACEHOLDER_RE = new RegExp(`\\{(${ARG_PLACEHOLDERS.join("|")})\\}`, "g");

/**
 * Renders an argument template: expands conditional groups and substitutes placeholders once; an argument that is
 * exactly {model} / {effort} without a value is dropped together with the flag before it
 */
export function renderArgs(tpl: ArgTemplate, ctx: ArgContext): string[] {
  const out: string[] = [];
  const flat: string[] = [];
  for (const item of tpl) {
    if (typeof item === "string") flat.push(item);
    else if (ctx.flags[item.if]) flat.push(...item.args);
  }
  for (const a of flat) {
    if ((a === "{model}" && !ctx.values.model) || (a === "{effort}" && !ctx.values.effort)) {
      const prev = out[out.length - 1];
      if (prev && prev.startsWith("-")) out.pop();
      continue;
    }
    out.push(a.replace(PLACEHOLDER_RE, (_, k: ArgPlaceholder) => ctx.values[k] ?? ""));
  }
  return out;
}
