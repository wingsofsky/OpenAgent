/**
 * Executor health check: `longkeep doctor [--probe] [--json]`.
 *
 * For each built-in executor (the registry's delegatable entries) it reports:
 *   - the executable and where it was found, in the same resolution order as delegation (discovery.ts; `bin` overrides
 *     come from the home folder's executors.json, tolerating a broken file)
 *   - the version: the registry's doctor.version arguments (default --version), stdin closed, short timeout, first line
 *   - the sign-in state from the registry's doctor.login rules (a credentials file or a status command; DoctorSpec in
 *     executor-registry.ts); what cannot be decided is "unknown", never a guess
 *   - with --probe, one minimal real call (reply with one word, short timeout) to catch "signed in but not entitled to
 *     the model". Arguments and answer parsing use the same spec as delegation; the cwd is a temporary folder, and the
 *     CLI keeps a session record in its own folder.
 *
 * Writes nothing under the home folder or any project. Every child process has stdin closed and a hidden window; a
 * `.js` entry point (cursor's versions/<v>/index.js) is launched with the current Node, as in delegation.
 * Exit codes: 0 fine, 1 a probe failed, 2 the command itself failed.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REGISTRY, type RegistryEntry } from "@longkeep/protocol/executor-registry";
import { killTree, spawnOnce } from "../delegate/process.ts";
import { expandPath, explainEntryBin, type BinSource } from "./discovery.ts";
import { BUILTIN_EXECUTORS, readBinOverrides } from "./registry.ts";

type LoginState = "yes" | "no" | "unknown";

interface DoctorRow {
  id: string;
  label: string;
  bin: string | null;
  binSource: BinSource | null;
  /** Install hint when not installed */
  installHint?: string;
  version: string | null;
  /** Why the version could not be read (timeout, exit code, failed to start) */
  versionError?: string;
  login: { state: LoginState; detail: string };
  probe?: { ok: boolean; answer: string; exitCode: number | null; timedOut: boolean; elapsedMs: number; error?: string };
}

interface DoctorReport {
  at: number;
  platform: string;
  probed: boolean;
  executors: DoctorRow[];
}

interface DoctorOptions {
  probe?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Timeout of the version and status commands */
  quickTimeoutMs?: number;
  probeTimeoutMs?: number;
}

const PROBE_PROMPT = "Reply with exactly one word: ok";
const QUICK_TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MS = 120_000;
const OUTPUT_CAP = 64 * 1024;

const viaNode = (bin: string) => /\.(m?js|cjs)$/i.test(bin);

/** Runs a short command: stdin closed, hidden window, the tree killed on timeout; each stream capped at 64 KB */
function runQuick(bin: string, args: string[], timeoutMs: number, env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean; error?: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let done = false;
    const child = spawn(viaNode(bin) ? process.execPath : bin, viaNode(bin) ? [bin, ...args] : args, {
      cwd: os.tmpdir(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    const finish = (code: number | null, error?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut, ...(error ? { error } : {}) });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (b: string) => {
      if (stdout.length < OUTPUT_CAP) stdout += b;
    });
    child.stderr.on("data", (b: string) => {
      if (stderr.length < OUTPUT_CAP) stderr += b;
    });
    // A failed spawn also errors the pipes (ENOTCONN); the child's error event carries the cause
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});
    child.once("error", (e) => finish(null, e.message));
    child.once("close", (code) => finish(code));
  });
}

/** Terminal colour codes (cursor-agent status colours its check mark): not wanted in the details */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");
const stripAnsi = (s: string) => s.replace(ANSI, "");
const firstLine = (s: string) =>
  stripAnsi(s)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean)
    ?.slice(0, 200) ?? "";
const tail = (s: string, n = 300) => {
  const t = stripAnsi(s).trim();
  return t.length > n ? `...${t.slice(-n)}` : t;
};

async function checkVersion(entry: RegistryEntry, bin: string, opt: { quickTimeoutMs: number; env: NodeJS.ProcessEnv }) {
  const r = await runQuick(bin, entry.doctor?.version ?? ["--version"], opt.quickTimeoutMs, opt.env);
  const line = firstLine(r.stdout) || firstLine(r.stderr);
  if (r.error) return { version: null, versionError: `failed to start: ${r.error}` };
  if (r.timedOut) return { version: null, versionError: `timed out (${Math.round(opt.quickTimeoutMs / 1000)} s)` };
  if (r.code !== 0) return { version: line || null, versionError: `exit code ${r.code}` };
  return { version: line || null };
}

async function checkLogin(entry: RegistryEntry, bin: string, opt: { quickTimeoutMs: number; env: NodeJS.ProcessEnv }): Promise<DoctorRow["login"]> {
  const rules = entry.doctor?.login ?? [];
  if (!rules.length) return { state: "unknown", detail: "this CLI has no sign-in state to check; use --probe for a real call" };
  const notes: string[] = [];
  for (const rule of rules) {
    if ("file" in rule) {
      if (fs.existsSync(expandPath(rule.file))) return { state: "yes", detail: `credentials file ${rule.file} exists (expiry not checked)` };
      if (!rule.env) {
        notes.push(`no credentials file ${rule.file} (an API key environment variable may be in use)`);
        continue;
      }
      const set = rule.env.filter((name) => opt.env[name]);
      if (!set.length) return { state: "no", detail: `no credentials file ${rule.file}, and ${rule.env.join(" / ")} is not set` };
      notes.push(`no credentials file ${rule.file}; ${set.join(", ")} is set (only --probe tells whether the key works)`);
      continue;
    }
    const cmd = [entry.bin?.names[0] ?? path.basename(bin), ...rule.command].join(" ");
    const r = await runQuick(bin, rule.command, opt.quickTimeoutMs, opt.env);
    if (r.error || r.timedOut) {
      notes.push(`${cmd} ${r.timedOut ? "timed out" : `failed to start: ${r.error}`}`);
      continue;
    }
    // The rules match line by line; the detail is the matching line (with JSON output the first line is just "{")
    const lines = stripAnsi(`${r.stdout}\n${r.stderr}`)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const hit = (re: string | undefined) => (re ? lines.find((l) => new RegExp(re).test(l)) : undefined);
    const yes = hit(rule.yes);
    if (yes) return { state: "yes", detail: `${cmd}: ${yes.slice(0, 200)}` };
    const no = hit(rule.no);
    if (no) return { state: "no", detail: `${cmd}: ${no.slice(0, 200)}` };
    notes.push(`output of ${cmd} not recognised (exit code ${r.code}): ${(lines[0] ?? "").slice(0, 200)}`);
  }
  return { state: "unknown", detail: notes.join("; ") };
}

async function probe(id: string, bin: string, opt: { probeTimeoutMs: number; env: NodeJS.ProcessEnv }): Promise<NonNullable<DoctorRow["probe"]>> {
  const spec = BUILTIN_EXECUTORS[id];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "longkeep-doctor-"));
  try {
    const outFile = spec.needsOutFile ? path.join(dir, "answer.txt") : null;
    const args = spec.buildArgs({
      prompt: PROBE_PROMPT,
      cwd: dir,
      outFile,
      sandbox: "read-only",
      timeoutMs: opt.probeTimeoutMs,
      autoApprove: spec.autoApproveDefault,
      newSession: randomUUID(),
    });
    const r = await spawnOnce({ bin, args, cwd: dir, env: opt.env, timeoutMs: opt.probeTimeoutMs, stallMs: 0, logAbs: path.join(dir, "probe.log") });
    let answer = "";
    try {
      answer = spec.extractAnswer(r.stdout, outFile).trim();
    } catch {
      answer = "";
    }
    const ok = r.exitCode === 0 && !r.timedOut && answer.length > 0;
    // Why it failed: did not start > timed out > an error the CLI printed as its answer (claude's result) > the last
    // line of stderr / stdout (codex's "ERROR: …")
    const lastLine = (s: string) =>
      s
        .trim()
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .pop() ?? "";
    const error = ok
      ? undefined
      : (r.startupFailure ??
        (r.timedOut ? `timed out (${Math.round(opt.probeTimeoutMs / 1000)} s)` : tail(answer || lastLine(r.stderr) || lastLine(r.stdout)) || `exit code ${r.exitCode}`));
    return { ok, answer: answer.slice(0, 200), exitCode: r.exitCode, timedOut: r.timedOut, elapsedMs: r.elapsedMs, ...(error ? { error } : {}) };
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* some CLIs leave a background process holding the cwd (Windows cannot delete it): the system cleans it up later */
    }
  }
}

/** Runs the check once; executors in parallel (each one in turn: version → sign-in → probe) */
export async function runDoctor(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const env = opts.env ?? process.env;
  const quickTimeoutMs = opts.quickTimeoutMs ?? QUICK_TIMEOUT_MS;
  const probeTimeoutMs = opts.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  const overrides = readBinOverrides(env);
  const entries = REGISTRY.executors.filter((e) => e.args);
  const rows = await Promise.all(
    entries.map(async (e): Promise<DoctorRow> => {
      const { bin, source } = explainEntryBin(e, overrides[e.id] ?? null, { env });
      const row: DoctorRow = { id: e.id, label: e.label, bin, binSource: source, version: null, login: { state: "unknown", detail: "not installed" } };
      if (!bin) return { ...row, installHint: e.installHint };
      Object.assign(row, await checkVersion(e, bin, { quickTimeoutMs, env }));
      row.login = await checkLogin(e, bin, { quickTimeoutMs, env });
      if (opts.probe) row.probe = await probe(e.id, bin, { probeTimeoutMs, env });
      return row;
    }),
  );
  return { at: Date.now(), platform: process.platform, probed: !!opts.probe, executors: rows };
}

const SOURCE_LABEL: Record<BinSource, string> = { env: "environment variable", config: "executors.json", path: "PATH", discover: "known install location" };
const LOGIN_LABEL: Record<LoginState, string> = { yes: "signed in", no: "signed out", unknown: "unknown" };

/** The report for people */
export function formatDoctor(r: DoctorReport): string {
  const out: string[] = [];
  for (const x of r.executors) {
    if (!x.bin) {
      out.push(`${x.id.padEnd(8)} not installed`, `         ${x.installHint ?? ""}`);
      continue;
    }
    out.push(`${x.id.padEnd(8)} ${x.bin} (${SOURCE_LABEL[x.binSource!]})`);
    out.push(`         version  ${x.version ?? "unavailable"}${x.versionError ? ` (${x.versionError})` : ""}`);
    out.push(`         sign-in  ${LOGIN_LABEL[x.login.state]}: ${x.login.detail}`);
    if (x.probe) out.push(`         probe    ${x.probe.ok ? "passed" : "failed"} (${(x.probe.elapsedMs / 1000).toFixed(1)} s): ${x.probe.ok ? x.probe.answer : (x.probe.error ?? "")}`);
  }
  if (!r.probed) out.push("", "The sign-in state only looks at local credentials and status commands; add --probe to have each CLI answer one word and confirm it really works.");
  return out.join("\n");
}

const USAGE = "Usage: longkeep doctor [--probe] [--json]";

/** `longkeep doctor` */
export async function doctorCommand(argv: string[]): Promise<number> {
  try {
    let probeAll = false;
    let json = false;
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === "--") continue;
      if (a === "--probe") probeAll = true;
      else if (a === "--json") json = true;
      else if (a === "--help" || a === "-h") {
        console.log(USAGE);
        return 0;
      } else throw new Error(`unknown option ${a}\n${USAGE}`);
    }
    if (probeAll && !json) console.error("Probing: each CLI answers one word, up to about 2 minutes...");
    const report = await runDoctor({ probe: probeAll });
    console.log(json ? JSON.stringify(report, null, 2) : formatDoctor(report));
    return report.executors.some((x) => x.probe && !x.probe.ok) ? 1 : 0;
  } catch (e) {
    console.error(`longkeep doctor: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
}
