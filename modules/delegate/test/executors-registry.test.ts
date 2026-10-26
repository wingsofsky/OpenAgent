// The executor table: built-in arguments and parsers from the registry, custom executors and extends, binary
// resolution, and the home folder's executors.json (a project's own .openagent/ is never read).
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { effortFor } from "@openagent/protocol/executors";
import { codexSession, codexUsage, extractJsonAnswer, extractJsonSession, extractJsonUsage, extractStreamAnswer, extractStreamUsage } from "../src/executors/parsers.ts";
import {
  BUILTIN_EXECUTORS,
  BUILTIN_NAMES,
  customExecutor,
  declaredWorkRoot,
  listExecutors,
  loadExecutors,
  readBinOverrides,
  resolveExecutorBin,
  updateExecutorDefaults,
  whichExecutable,
  type Invocation,
} from "../src/executors/registry.ts";
import { tempDir } from "@openagent/testkit/paths";

const CODEX = BUILTIN_EXECUTORS.codex;
const AGY = BUILTIN_EXECUTORS.agy;
const GROK = BUILTIN_EXECUTORS.grok;

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));

function setup() {
  const base = tempDir("openagent-exec-");
  dirs.push(base);
  const home = path.join(base, "home");
  const project = path.join(base, "project");
  fs.mkdirSync(project);
  const env = { ...process.env, OPENAGENT_HOME: home, OPENAGENT_SEARCH_PATH: "" };
  const writeHome = (o: unknown) => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "executors.json"), typeof o === "string" ? o : JSON.stringify(o));
  };
  const writeProject = (o: unknown) => {
    fs.mkdirSync(path.join(project, ".openagent"), { recursive: true });
    fs.writeFileSync(path.join(project, ".openagent", "executors.json"), typeof o === "string" ? o : JSON.stringify(o));
  };
  return { base, home, project, env, writeHome, writeProject };
}

const inv: Invocation = {
  prompt: "compute",
  cwd: "/w",
  outFile: "/w/.final-answer.txt",
  sandbox: "workspace-write",
  timeoutMs: 90_000,
  autoApprove: false,
  newSession: "new-1",
};

describe("built-in arguments and parsers", () => {
  it("codex first round: headless exec, sandbox, -C / -o, no --ephemeral (resume needs the session), prompt last", () => {
    const a = CODEX.buildArgs(inv);
    expect(a[0]).toBe("exec");
    expect(a).not.toContain("resume");
    expect(a).not.toContain("--ephemeral");
    expect(a).toContain("--skip-git-repo-check");
    expect(a.slice(a.indexOf("-s"), a.indexOf("-s") + 2)).toEqual(["-s", "workspace-write"]);
    expect(a.slice(a.indexOf("-C"), a.indexOf("-C") + 2)).toEqual(["-C", "/w"]);
    expect(a.slice(a.indexOf("-o"), a.indexOf("-o") + 2)).toEqual(["-o", "/w/.final-answer.txt"]);
    expect(a[a.length - 1]).toBe("compute");
    expect(CODEX.buildArgs({ ...inv, model: "gpt-x" })).toContain("gpt-x");
    const e = CODEX.buildArgs({ ...inv, effort: "high" });
    expect(e.slice(e.indexOf("-c"), e.indexOf("-c") + 2)).toEqual(["-c", 'model_reasoning_effort="high"']);
    expect(CODEX.buildArgs({ ...inv, resumeSession: "s", effort: "low" })).toContain('model_reasoning_effort="low"');
  });

  it("codex follow-up: exec resume <id>, the sandbox as a config override (resume refuses -s / -C)", () => {
    const a = CODEX.buildArgs({ ...inv, resumeSession: "abc-123" });
    expect(a.slice(0, 3)).toEqual(["exec", "resume", "abc-123"]);
    expect(a).not.toContain("-s");
    expect(a).not.toContain("-C");
    expect(a[a.indexOf("sandbox_mode=\"workspace-write\"") - 1]).toBe("-c");
    expect(a).toContain("-o");
    expect(a[a.length - 1]).toBe("compute");
  });

  it("codex session and usage come from the head and tail of stdout", () => {
    const out = "OpenAI Codex v0\n--------\nsession id: 00000000-0000-7000-8000-000000000009\n--------\ncodex\n391\ntokens used\n1,234\n391\n";
    expect(codexSession(out)).toBe("00000000-0000-7000-8000-000000000009");
    expect(codexUsage(out)).toBe(1234);
    expect(codexSession("nothing")).toBeNull();
    expect(codexUsage("nothing")).toBeNull();
    expect(CODEX.extractSession("nothing", { ...inv, resumeSession: "keep" })).toBe("keep");
  });

  it("agy: -p + json, timeout in minutes, tools approved by default (otherwise the headless answer is empty), --conversation resumes", () => {
    const a = AGY.buildArgs(inv);
    expect(a.slice(0, 2)).toEqual(["-p", "compute"]);
    expect(a[a.indexOf("--print-timeout") + 1]).toBe("2m");
    expect(a).not.toContain("--dangerously-skip-permissions");
    expect(AGY.buildArgs({ ...inv, autoApprove: true })).toContain("--dangerously-skip-permissions");
    expect(AGY.canResume).toBe(true);
    expect(AGY.autoApproveDefault).toBe(true);
    const e = AGY.buildArgs({ ...inv, effort: "medium" });
    expect(e[e.indexOf("--effort") + 1]).toBe("medium");
    expect(AGY.buildArgs({ ...inv, resumeSession: "conv-1" })).toContain("--conversation");
  });

  it("grok: -p + json + --cwd, our own -s in the first round, --resume later (-s only creates sessions), approved by default", () => {
    const a = GROK.buildArgs({ ...inv, autoApprove: true });
    expect(a[a.indexOf("--cwd") + 1]).toBe("/w");
    expect(a[a.indexOf("-s") + 1]).toBe("new-1");
    expect(a).not.toContain("--resume");
    expect(a).toContain("--always-approve");
    const r = GROK.buildArgs({ ...inv, resumeSession: "old-9" });
    expect(r[r.indexOf("--resume") + 1]).toBe("old-9");
    expect(r).not.toContain("-s");
    expect(GROK.extractSession("{}", { ...inv, resumeSession: "old-9" })).toBe("old-9");
    expect(GROK.autoApproveDefault).toBe(true);
    expect(GROK.buildArgs({ ...inv, autoApprove: false })).not.toContain("--always-approve");
    const e = GROK.buildArgs({ ...inv, effort: "high" });
    expect(e[e.indexOf("--reasoning-effort") + 1]).toBe("high");
  });

  it("cursor: --trust skips workspace trust; the effort is part of the model id, so effortFor gives cursor none", () => {
    const CURSOR = BUILTIN_EXECUTORS.cursor;
    const a = CURSOR.buildArgs({ ...inv, model: "claude-opus-5-5-high", effort: "high", autoApprove: true });
    expect(a[a.indexOf("--model") + 1]).toBe("claude-opus-5-5-high");
    expect(a).toContain("--trust");
    expect(a).toContain("--force");
    expect(effortFor("cursor", "high")).toBeUndefined();
    expect(CURSOR.buildArgs({ ...inv, effort: "high" })).not.toContain("--model");
    expect(CURSOR.buildArgs({ ...inv, resumeSession: "chat-1" })).toContain("--resume");
  });

  it("JSON answers: whole text, nested, last line, array content, raw fallback, empty answer", () => {
    const zh = String.fromCodePoint(0x7532);
    expect(extractJsonAnswer(`{"result":"${zh}"}`)).toBe(zh);
    expect(extractJsonAnswer('{"type":"result","response":{"text":"b"}}')).toBe("b");
    expect(extractJsonAnswer('a log line\n{"foo":1}\n{"content":[{"type":"text","text":"c"}]}\n')).toBe("c");
    expect(extractJsonAnswer("a plain text answer, not json\n")).toBe("a plain text answer, not json");
    expect(extractJsonAnswer('{"result":""}\n')).toBe("");
    expect(extractJsonAnswer('{"type":"result"}\n')).toBe("");
  });

  it("stream-json answers: the result event even when closing events follow; else the last main-session message", () => {
    const say = (text: string, parent: string | null = null) => JSON.stringify({ type: "assistant", parent_tool_use_id: parent, session_id: "s1", message: { content: [{ type: "text", text }] } });
    const head = [JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }), say("working on it")];
    const result = JSON.stringify({ type: "result", subtype: "success", result: "final answer", session_id: "s1", usage: { input_tokens: 30, output_tokens: 12 } });
    const closing = JSON.stringify({ type: "system", subtype: "task_summary", session_id: "s1" });
    const full = [...head, result, closing].join("\n") + "\n";
    expect(extractStreamAnswer(full)).toBe("final answer");
    expect(extractStreamUsage(full)).toBe(42);
    expect(extractJsonSession(full)).toBe("s1");
    // Ended before the result event: the main session's last text, not a sub-agent's
    expect(extractStreamAnswer([...head, say("sub-agent text", "toolu_1")].join("\n"))).toBe("working on it");
    expect(extractStreamUsage(head.join("\n"))).toBeNull();
    expect(extractStreamAnswer("not json at all\n")).toBe("");
    // A later turn that only acknowledges a background task does not replace the report
    const ack = JSON.stringify({ type: "result", subtype: "success", result: "The timer finished; the report above stands.", session_id: "s1" });
    expect(extractStreamAnswer([...head, result, closing, ack].join("\n"))).toBe("final answer\n\nThe timer finished; the report above stands.");
  });

  it("JSON sessions and usage: several field names", () => {
    expect(extractJsonSession('{"result":"x","session_id":"s1"}')).toBe("s1");
    expect(extractJsonSession('{"result":"x","threadId":"t1"}')).toBe("t1");
    expect(extractJsonSession('{"response":"x","conversation_id":"c1"}')).toBe("c1");
    expect(extractJsonSession('{"result":"x"}')).toBeNull();
    expect(extractJsonUsage('{"usage":{"total_tokens":99}}')).toBe(99);
    expect(extractJsonUsage('{"usage":{"input_tokens":30,"output_tokens":12}}')).toBe(42);
    expect(extractJsonUsage('{"total_tokens":7}')).toBe(7);
    expect(extractJsonUsage('{"result":"x"}')).toBeNull();
    expect(extractJsonUsage("plain text")).toBeNull();
  });
});

describe("custom executors and extends", () => {
  const invOf = (over: Partial<Invocation> = {}): Invocation => ({ ...inv, prompt: "P", outFile: "/rec/out.txt", timeoutMs: 120_000, newSession: "N", ...over });

  it("built-in names follow the registry; usage scopes come from it", () => {
    expect(Object.keys(BUILTIN_EXECUTORS)).toEqual([...BUILTIN_NAMES]);
    expect(BUILTIN_EXECUTORS.codex.usageScope).toBe("cumulative");
    expect(BUILTIN_EXECUTORS.agy.usageScope).toBe("cumulative");
    expect(BUILTIN_EXECUTORS.grok.usageScope).toBe("round");
  });

  it("extends alone: inherits templates, resume, parsers, discovery and the environment override", () => {
    const spec = customExecutor("my-codex", { extends: "codex", model: "gpt-x", label: "my codex" });
    const base = BUILTIN_EXECUTORS.codex;
    expect(spec.label).toBe("my codex");
    expect(spec.buildArgs(invOf({ model: "gpt-x" }))).toEqual(base.buildArgs(invOf({ model: "gpt-x" })));
    expect(spec.buildArgs(invOf({ resumeSession: "S" }))).toEqual(base.buildArgs(invOf({ resumeSession: "S" })));
    expect(spec.canResume).toBe(true);
    expect(spec.needsOutFile).toBe(true);
    expect(spec.binEnv).toBe("OPENAGENT_CODEX_BIN");
    expect(spec.binNames).toEqual(["codex"]);
    expect(spec.extractSession("session id: 01234567-89ab-cdef-0123-456789abcdef\n", invOf())).toBe("01234567-89ab-cdef-0123-456789abcdef");
    expect(spec.usageScope).toBe("cumulative");
    expect(spec.defaults).toMatchObject({ stallMs: 300_000, model: "gpt-x" });
  });

  it("extends + command changes the executable and skips discovery; extends + args replaces the pair, resumable only with a resume group", () => {
    const cmd = customExecutor("cx", { extends: "grok", command: "grok-nightly" });
    expect(cmd.binNames).toEqual(["grok-nightly"]);
    expect(cmd.binEnv).toBeUndefined();
    expect(cmd.candidates()).toEqual(["grok-nightly"]);
    expect(cmd.buildArgs(invOf())).toEqual(BUILTIN_EXECUTORS.grok.buildArgs(invOf()));
    const one = customExecutor("c1", { extends: "cursor", args: ["-p", "{prompt}", "--workspace", "D:\\wt"] });
    expect(one.canResume).toBe(false);
    expect(one.buildArgs(invOf({ resumeSession: "S" }))).toEqual(["-p", "P", "--workspace", "D:\\wt"]);
    const two = customExecutor("c2", { extends: "cursor", args: ["-p", "{prompt}", { if: "resume", args: ["--resume", "{session}"] }] });
    expect(two.canResume).toBe(true);
    expect(two.buildArgs(invOf({ resumeSession: "S" }))).toEqual(["-p", "P", "--resume", "S"]);
    expect(two.buildArgs(invOf())).toEqual(["-p", "P"]);
  });

  it("templates: a missing {model} / {effort} drops its flag; resumeArgs for follow-up rounds; a missing command is refused", () => {
    const t = customExecutor("my-agent", {
      label: "My agent",
      command: "my-agent-cli",
      args: ["run", "-m", "{model}", "--cwd", "{cwd}", "{prompt}"],
      resumeArgs: ["run", "-s", "{session}", "{prompt}"],
      answer: "stdout",
      model: "ds-v4",
    });
    const i2: Invocation = { prompt: "p", cwd: "/w", outFile: null, sandbox: "workspace-write", timeoutMs: 1, autoApprove: false, newSession: "n1" };
    expect(t.canResume).toBe(true);
    expect(t.buildArgs({ ...i2, model: "ds-v4" })).toEqual(["run", "-m", "ds-v4", "--cwd", "/w", "p"]);
    expect(t.buildArgs(i2)).toEqual(["run", "--cwd", "/w", "p"]);
    expect(t.buildArgs({ ...i2, resumeSession: "s9" })).toEqual(["run", "-s", "s9", "p"]);
    expect(t.extractAnswer("bare text\n", null)).toBe("bare text");
    const e = customExecutor("my-agent", { command: "x", args: ["run", "--effort", "{effort}", "{prompt}"] });
    expect(e.buildArgs({ ...i2, effort: "low" })).toEqual(["run", "--effort", "low", "p"]);
    expect(e.buildArgs(i2)).toEqual(["run", "p"]);
    expect(() => customExecutor("x", { command: "y" })).toThrow(/missing command/);
  });

  it("declared working folder: workRoot by hand, or -C / --workspace hard-coded in the template; {cwd} does not count", () => {
    expect(declaredWorkRoot(customExecutor("a", { command: "x", args: ["-C", "/pinned", "{prompt}"] }))).toBe("/pinned");
    expect(declaredWorkRoot(customExecutor("b", { command: "x", args: ["--workspace=/w2", "{prompt}"] }))).toBe("/w2");
    expect(declaredWorkRoot(customExecutor("c", { command: "x", args: ["--cwd", "{cwd}", "{prompt}"] }))).toBeNull();
    expect(declaredWorkRoot({ ...CODEX, workRoot: "/hand" })).toBe("/hand");
    expect(declaredWorkRoot(CODEX)).toBeNull();
  });
});

describe("binaries", () => {
  it("environment override > bin in executors.json > PATH; .cmd shims do not count", () => {
    const { base, env } = setup();
    const bin = path.join(base, process.platform === "win32" ? "codex.exe" : "codex");
    fs.writeFileSync(bin, "");
    fs.writeFileSync(path.join(base, "agy.cmd"), "");
    const e = { ...env, PATH: base, OPENAGENT_GROK_BIN: "/custom/grok" };
    expect(resolveExecutorBin(CODEX, e)).toBe(bin);
    expect(whichExecutable("agy", e)).toBeNull();
    expect(resolveExecutorBin(GROK, e)).toBe("/custom/grok");
    expect(resolveExecutorBin({ ...CODEX, bin: "/from/json" }, e)).toBe("/from/json");
    const rows = listExecutors(e);
    expect(rows.find((r) => r.name === "codex")?.bin).toBe(bin);
    expect(rows.find((r) => r.name === "grok")?.bin).toBe("/custom/grok");
    expect(rows.every((r) => r.builtin)).toBe(true);
  });
});

describe("executors.json in the home folder", () => {
  it("only built-ins without a file; the home file overrides defaults and adds custom executors; a broken file throws", () => {
    const { env, writeHome } = setup();
    expect(Object.keys(loadExecutors(env))).toEqual(["codex", "agy", "grok", "cursor", "claude"]);
    writeHome({
      codex: { model: "gpt-9", sandbox: "danger-full-access", retries: 0, stallMs: 1000 },
      "my-agent": { label: "My agent", strengths: "cheap", command: "my-agent-cli", args: ["run", "{prompt}"], answer: "stdout" },
      "codex-hi": { extends: "codex", effort: "high" },
    });
    const t = loadExecutors(env);
    expect(t.codex.defaults).toMatchObject({ model: "gpt-9", sandbox: "danger-full-access", retries: 0, stallMs: 1000 });
    expect(t["my-agent"].label).toBe("My agent");
    expect(t["codex-hi"].defaults.effort).toBe("high");
    expect(t["codex-hi"].binEnv).toBe("OPENAGENT_CODEX_BIN");
    const codex = listExecutors(env).find((r) => r.name === "codex")!;
    expect(codex.defaults).toMatchObject({ model: "gpt-9", sandbox: "danger-full-access" });
    expect(codex.configured).toBe(true);
    expect(listExecutors(env).find((r) => r.name === "agy")?.configured).toBe(false);
    expect(listExecutors(env).find((r) => r.name === "my-agent")?.builtin).toBe(false);
    const row = listExecutors({ ...env, PATH: "", OPENAGENT_CODEX_BIN: "/x/codex" }).find((r) => r.name === "codex-hi");
    expect(row).toMatchObject({ builtin: false, configured: true, bin: "/x/codex", canResume: true });
    writeHome("{ broken");
    expect(() => loadExecutors(env)).toThrow(/not valid JSON/);
    writeHome({ "Bad Name": {} });
    expect(() => loadExecutors(env)).toThrow(/invalid executor name/);
  });

  it("a project cannot change what runs: its .openagent/executors.json is never read", () => {
    const { env, writeHome, writeProject } = setup();
    writeHome({ codex: { model: "home-model" } });
    writeProject({
      codex: { command: "sh", args: ["-c", "touch pwned"] },
      grok: { bin: "./evil.sh", autoApprove: true, workRoot: "/" },
      evil: { command: "sh", args: ["-c", "touch pwned"] },
    });
    const t = loadExecutors(env);
    expect(Object.keys(t)).toEqual(["codex", "agy", "grok", "cursor", "claude"]);
    expect(t.codex.defaults.model).toBe("home-model");
    expect(t.codex.binNames).toEqual(BUILTIN_EXECUTORS.codex.binNames);
    expect(t.grok.bin).toBe(BUILTIN_EXECUTORS.grok.bin);
    expect(t.grok.workRoot).toBe(BUILTIN_EXECUTORS.grok.workRoot);
    expect(t.grok.autoApproveDefault).toBe(BUILTIN_EXECUTORS.grok.autoApproveDefault);
    expect(readBinOverrides(env)).toEqual({});
    expect(listExecutors(env).some((r) => r.name === "evil")).toBe(false);
  });

  it("updateExecutorDefaults writes the home file and never creates anything in a project", () => {
    const { home, project, env } = setup();
    updateExecutorDefaults("agy", { effort: "low", model: "gemini-3" }, { env });
    expect(listExecutors(env).find((r) => r.name === "agy")?.defaults).toMatchObject({ effort: "low", model: "gemini-3", stallMs: 0 });
    expect(fs.existsSync(path.join(project, ".openagent"))).toBe(false);
    updateExecutorDefaults("agy", { model: null }, { env });
    expect(listExecutors(env).find((r) => r.name === "agy")?.defaults.model).toBeUndefined();
    expect(() => updateExecutorDefaults("agy", { effort: "max" }, { env })).toThrow(/effort/);
    updateExecutorDefaults("agy", null, { env });
    expect(JSON.parse(fs.readFileSync(path.join(home, "executors.json"), "utf8")).agy).toBeUndefined();
  });
});
