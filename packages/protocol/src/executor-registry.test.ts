import { describe, expect, it } from "vitest";
import {
  EFFORTS,
  LOCAL_EXECUTOR_IDS,
  REGISTRY,
  clampEffort,
  registryEntry,
  renderArgs,
  validateArgTemplate,
  validateRegistry,
  type ArgCondition,
} from "./executor-registry.ts";
import { effortFor, validateOverride } from "./executors.ts";

const flags = (on: ArgCondition[] = []): Record<ArgCondition, boolean> =>
  Object.fromEntries((["model", "effort", "autoApprove", "resume", "fresh", "outFile"] as const).map((k) => [k, on.includes(k)])) as Record<ArgCondition, boolean>;

describe("executor registry", () => {
  it("the bundled JSON validates; ids are unique; exactly the five delegatable CLIs", () => {
    expect(LOCAL_EXECUTOR_IDS).toEqual(["codex", "agy", "grok", "cursor", "claude"]);
    expect(REGISTRY.executors.map((e) => e.id)).toEqual([...LOCAL_EXECUTOR_IDS]);
    for (const id of LOCAL_EXECUTOR_IDS) {
      const e = registryEntry(id)!;
      expect(e.bin?.names.length, id).toBeGreaterThan(0);
      expect(e.process?.win32.length, id).toBeGreaterThan(0);
      expect(e.installHint, id).toBeTruthy();
      expect(e.strengths, id).toBeTruthy();
    }
    // The two CLIs that report the session total when resuming
    expect(REGISTRY.executors.filter((e) => e.usage?.scope === "cumulative").map((e) => e.id)).toEqual(["codex", "agy"]);
  });

  it("a broken table throws: duplicate id, unknown pick, wrong condition name, template without parsers", () => {
    const ok = { id: "x", label: "X" };
    expect(() => validateRegistry({})).toThrow(/missing executors/);
    expect(() => validateRegistry({ executors: [{ id: "x" }] })).toThrow(/missing label/);
    expect(() => validateRegistry({ executors: [ok, ok] })).toThrow(/duplicate/);
    expect(() => validateRegistry({ executors: [{ ...ok, bin: { names: ["x"], discover: [{ path: "~/x", pick: "glob", then: "x" }] } }] })).toThrow(/pick/);
    expect(() => validateArgTemplate("t", ["-p", { if: "verbose", args: ["-v"] }])).toThrow(/t\[1\]/);
    expect(() => validateRegistry({ executors: [{ ...ok, bin: { names: ["x"] }, args: { fresh: ["{prompt}"] } }] })).toThrow(/answer/);
    expect(() => validateRegistry({ executors: [{ ...ok, args: { fresh: [] } }] })).toThrow(/no bin/);
    expect(() => validateRegistry({ executors: [ok], roles: { folderTask: "x" } })).toThrow(/roles.folderTask/);
    expect(REGISTRY.roles.folderTask).toBe("grok");
  });

  it("rendering: conditional groups expand by truth value; placeholders are replaced once; a plain -m {model} without a value drops the flag too", () => {
    const tpl = ["-p", "{prompt}", { if: "resume" as const, args: ["--resume", "{resumeSession}"] }, { if: "fresh" as const, args: ["-s", "{newSession}"] }, "--t", "{timeoutMin}m"];
    expect(renderArgs(tpl, { values: { prompt: "look at {cwd}", newSession: "n1", timeoutMin: "3" }, flags: flags(["fresh"]) })).toEqual(["-p", "look at {cwd}", "-s", "n1", "--t", "3m"]);
    expect(renderArgs(tpl, { values: { prompt: "p", resumeSession: "r1", timeoutMin: "1" }, flags: flags(["resume"]) })).toEqual(["-p", "p", "--resume", "r1", "--t", "1m"]);
    expect(renderArgs(["run", "-m", "{model}", "--effort", "{effort}", "{prompt}"], { values: { prompt: "p" }, flags: flags() })).toEqual(["run", "p"]);
    expect(renderArgs(["-c", "x=\"{effort}\""], { values: {}, flags: flags() })).toEqual(["-c", "x=\"\""]);
  });

  it("effort: clamped by the entry's efforts (minimal → low); empty list = not passed; unknown executors pass through", () => {
    expect(EFFORTS).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
    expect(clampEffort({ efforts: ["low", "high"] }, "medium")).toBe("high");
    expect(clampEffort({ efforts: ["low", "medium"] }, "xhigh")).toBe("medium");
    expect(clampEffort({ efforts: [] }, "high")).toBeUndefined();
    expect(clampEffort(undefined, "minimal")).toBe("minimal");
    expect(effortFor("gemini", "minimal")).toBe("minimal");
  });

  it("extends in executors.json: only delegatable built-in entries; built-in names cannot extend; command / args optional; templates may use conditional groups", () => {
    expect(validateOverride("my-codex", { extends: "codex", model: "gpt-x" })).toEqual({ extends: "codex", model: "gpt-x" });
    expect(validateOverride("wt", { extends: "cursor", args: ["-p", "{prompt}", { if: "resume", args: ["--resume", "{session}"] }] }).args).toHaveLength(3);
    expect(() => validateOverride("x", { extends: "gemini" })).toThrow(/extends only accepts/);
    expect(() => validateOverride("x", { extends: "chatgpt" })).toThrow(/extends only accepts/);
    expect(() => validateOverride("codex", { extends: "agy" })).toThrow(/cannot use extends/);
    expect(() => validateOverride("x", { command: "c", args: ["-p", { if: "nope", args: [] }] })).toThrow(/x\.args\[1\]/);
  });

  it("the registry carries no fallback chain: launch fallbacks can only be written into executors.json by a person", () => {
    expect(REGISTRY.executors.every((e) => !("fallback" in e))).toBe(true);
  });

  it("fallback in executors.json: only other executors, with limited levels", () => {
    expect(validateOverride("grok", { fallback: [{ executor: "cursor", model: "m" }, { executor: "claude" }] }))
      .toEqual({ fallback: [{ executor: "cursor", model: "m" }, { executor: "claude" }] });
    expect(() => validateOverride("grok", { fallback: [{ executor: "grok" }] })).toThrow(/fallback\[0\]/);
    expect(() => validateOverride("grok", { fallback: [{ executor: "Bad Name" }] })).toThrow(/fallback\[0\]/);
    expect(() => validateOverride("grok", { fallback: [{ executor: "cursor", effort: "huge" }] })).toThrow(/effort/);
    expect(() => validateOverride("grok", { fallback: "cursor" })).toThrow(/fallback must be an array/);
  });
});
