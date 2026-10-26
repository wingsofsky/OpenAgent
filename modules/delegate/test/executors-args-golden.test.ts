/**
 * Golden arguments and prompts in fixtures/run-args-golden.json. Regenerate with
 * `UPDATE_GOLDEN=1 pnpm vitest run modules/delegate/test/executors-args-golden.test.ts`, and say in the commit message which behaviour
 * changed and why.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { effortFor, type Effort, type ExecutorOverride } from "@openagent/protocol/executors";
import { BUILTIN_EXECUTORS, customExecutor, type Invocation } from "../src/executors/registry.ts";
import { composePrompt } from "../src/delegate/prompt.ts";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "run-args-golden.json");

const CUSTOM: Record<string, ExecutorOverride> = {
  // A wrapper script launched with node, as an API question-answer executor would be (answer on stdout as JSON).
  "api-example": {
    label: "My agent API question answering",
    strengths: "Answers from the prompt only; no file access, tool loop or file changes",
    command: "node",
    args: ["/absolute/path/to/api-executor.mjs", "{prompt}", "{model}"],
    model: "model-x",
    answer: "json",
    retries: 0,
    timeoutMs: 150000,
    stallMs: 0,
  },
  "plain-stdout": { command: "my-agent-cli", args: ["run", "-m", "{model}", "--effort", "{effort}", "{prompt}"], answer: "stdout" },
  "wt-resume": {
    command: "cursor-agent",
    args: ["-p", "{prompt}", "--output-format", "json", "--trust", "--workspace", "D:\\work\\app", "--model", "{model}"],
    resumeArgs: ["-p", "{prompt}", "--output-format", "json", "--resume", "{session}", "--cwd={cwd}"],
  },
  "codex-out": { command: "codex", args: ["exec", "-C", "{cwd}", "-o", "{outFile}", "-c", 'model_reasoning_effort="{effort}"', "{prompt}"], answer: "outFile" },
};

const EFFORTS: Array<Effort | undefined> = [undefined, "minimal", "high", "xhigh"];

function invocations(name: string, needsOutFile: boolean): Array<{ case: string; inv: Invocation }> {
  const out: Array<{ case: string; inv: Invocation }> = [];
  for (const resume of [false, true])
    for (const full of [false, true])
      for (const effort of full ? EFFORTS : [undefined]) {
        const inv: Invocation = {
          prompt: "Task: first line\nsecond line {cwd}",
          cwd: "/work/root dir",
          outFile: needsOutFile ? "/rec/.final-answer.txt" : null,
          sandbox: full ? "read-only" : "workspace-write",
          timeoutMs: full ? 90_000 : 600_000,
          autoApprove: full,
          newSession: "11111111-2222-3333-4444-555555555555",
          ...(resume ? { resumeSession: "sess-abc" } : {}),
          ...(full ? { model: "model-x", effort: effortFor(name, effort) } : {}),
        };
        out.push({ case: `${resume ? "resume" : "fresh"}/${full ? `full/${effort ?? "none"}` : "min"}`, inv });
      }
  return out;
}

function argsTable(): Record<string, Record<string, string[]>> {
  const table: Record<string, Record<string, string[]>> = {};
  const specs = { ...BUILTIN_EXECUTORS, ...Object.fromEntries(Object.entries(CUSTOM).map(([k, v]) => [k, customExecutor(k, v)])) };
  for (const [name, spec] of Object.entries(specs)) {
    table[name] = {};
    for (const { case: c, inv } of invocations(name, spec.needsOutFile)) table[name][c] = spec.buildArgs(inv);
  }
  return table;
}

function promptTable(): Record<string, string> {
  const spec = BUILTIN_EXECUTORS.codex;
  return {
    scratch: composePrompt({ spec, prompt: "do X", cwd: "/rec/work" }),
    "scratch-target": composePrompt({ spec, prompt: "do X", cwd: "/rec/work", targetRel: "a/b.md", targetAbs: "/project/a/b.md" }),
    "declared-root": composePrompt({ spec, prompt: "do X", cwd: "/wt", recordDir: "/rec" }),
    folder: composePrompt({ spec, prompt: "do X", cwd: "/proj", recordDir: "/home/rec", folder: true }),
    "round3-native": composePrompt({
      spec,
      prompt: "continue",
      cwd: "/wt",
      recordDir: "/rec",
      round: 3,
      brief: "first brief",
      rulings: [{ round: 2, text: "ruling two" }],
      transcriptAbs: "/rec/transcript.md",
    }),
    "round2-replay": composePrompt({ spec, prompt: "continue", cwd: "/rec/work", round: 2, brief: "first brief", rulings: [], transcriptAbs: "/rec/transcript.md", previousAnswer: "" }),
  };
}

describe("golden arguments and prompts", () => {
  const current = { args: argsTable(), prompts: promptTable() };
  if (process.env.UPDATE_GOLDEN) fs.writeFileSync(FIXTURE, JSON.stringify(current, null, 1) + "\n");
  const golden = JSON.parse(fs.readFileSync(FIXTURE, "utf8")) as typeof current;

  it("every executor and every kind of call gives the golden arguments", () => {
    expect(Object.keys(current.args).sort()).toEqual(Object.keys(golden.args).sort());
    for (const name of Object.keys(golden.args)) expect(current.args[name], name).toEqual(golden.args[name]);
  });

  it("preambles and follow-up prompts match the golden file", () => {
    expect(current.prompts).toEqual(golden.prompts);
  });
});
