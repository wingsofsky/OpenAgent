import { describe, expect, it } from "vitest";
import {
  EFFORTS,
  EFFORT_LABEL,
  EXECUTORS_FILE,
  countPendingSuggestions,
  effortFor,
  mergeExecutorOverride,
  parseExecutorOverrides,
  serializeExecutorOverrides,
  validateOverride,
} from "./executors.ts";

describe("executor defaults kernel", () => {
  it("parse: empty text = empty table; broken JSON / non-object top level / invalid name / invalid enum all throw", () => {
    expect(EXECUTORS_FILE).toBe("executors.json");
    expect(parseExecutorOverrides("")).toEqual({});
    expect(parseExecutorOverrides("  \n")).toEqual({});
    expect(() => parseExecutorOverrides("{ broken")).toThrow(/is not valid JSON/);
    expect(() => parseExecutorOverrides("[]")).toThrow(/top level .* must be an object/);
    expect(() => parseExecutorOverrides('{"Bad Name":{}}')).toThrow(/invalid executor name/);
    expect(() => parseExecutorOverrides('{"codex":{"effort":"max"}}')).toThrow(/effort only accepts/);
    expect(() => parseExecutorOverrides('{"codex":{"sandbox":"yolo"}}')).toThrow(/sandbox only accepts/);
    for (const bad of ['{"timeoutMs":-1}', '{"timeoutMs":0}', '{"timeoutMs":3000000000}', '{"stallMs":1.5}', '{"retries":4}'])
      expect(() => parseExecutorOverrides(`{"codex":${bad}}`), bad).toThrow(/must be a whole number from/);
    expect(() => parseExecutorOverrides('{"x":{"command":"c"}}')).toThrow(/missing args/);
    expect(() => parseExecutorOverrides('{"x":{"args":["a"]}}')).toThrow(/no command/);
    expect(parseExecutorOverrides('{"codex":{"model":" gpt-9 ","effort":"high","extra":1}}')).toEqual({ codex: { model: "gpt-9", effort: "high" } });
  });

  it("merge: overwrite / remove a key / remove an entry / drop empty entries / input unchanged", () => {
    const base = parseExecutorOverrides('{"codex":{"model":"a","effort":"low"},"agy":{"effort":"high"}}');
    const next = mergeExecutorOverride(base, "codex", { effort: "high", sandbox: "danger-full-access" });
    expect(next.codex).toEqual({ model: "a", effort: "high", sandbox: "danger-full-access" });
    expect(base.codex).toEqual({ model: "a", effort: "low" });
    expect(mergeExecutorOverride(next, "codex", { model: null, sandbox: "" }).codex).toEqual({ effort: "high" });
    expect(mergeExecutorOverride(base, "agy", { effort: null })).toEqual({ codex: base.codex });
    expect(mergeExecutorOverride(base, "codex", null)).toEqual({ agy: { effort: "high" } });
    expect(mergeExecutorOverride({}, "grok", { model: "grok-4" })).toEqual({ grok: { model: "grok-4" } });
    expect(() => mergeExecutorOverride(base, "codex", { effort: "ultra" })).toThrow(/effort/);
    expect(() => mergeExecutorOverride(base, "Bad", { model: "x" })).toThrow(/invalid executor name/);
    // A misspelt name with settings only would break every later command: refused before anything is written
    expect(() => mergeExecutorOverride(base, "grk", { model: "x" })).toThrow(/no executor named grk/);
    expect(mergeExecutorOverride(base, "mine", { extends: "grok", model: "x" })).toMatchObject({ mine: { extends: "grok", model: "x" } });
  });

  it("serialize: two-space indent + trailing line break, stable round trip", () => {
    const all = parseExecutorOverrides('{"codex":{"model":"a"}}');
    const text = serializeExecutorOverrides(all);
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('  "codex": {');
    expect(parseExecutorOverrides(text)).toEqual(all);
    expect(validateOverride("grok", { autoApprove: false, retries: 0 })).toEqual({ autoApprove: false, retries: 0 });
  });
});

describe("effortFor / workRoot / pending suggestions", () => {
  it("five levels in the union, clamped to what each CLI takes (checked 2026-10-17: none has minimal; cursor's effort is in the model id)", () => {
    expect(EFFORTS).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
    expect(Object.keys(EFFORT_LABEL)).toEqual([...EFFORTS]);
    expect(effortFor("codex", "xhigh")).toBe("xhigh");
    expect(effortFor("codex", "minimal")).toBe("low");
    expect(effortFor("agy", "xhigh")).toBe("xhigh");
    expect(effortFor("agy", "minimal")).toBe("low");
    expect(effortFor("claude", "xhigh")).toBe("xhigh");
    expect(effortFor("grok", "minimal")).toBe("low");
    expect(effortFor("grok", "xhigh")).toBe("xhigh");
    expect(effortFor("cursor", "high")).toBeUndefined();
    expect(effortFor("my-agent", "minimal")).toBe("minimal"); // custom executors pass through as is
    expect(effortFor("codex", undefined)).toBeUndefined();
  });

  it("workRoot only takes absolute paths", () => {
    expect(() => validateOverride("cursor", { workRoot: "relative/dir" })).toThrow(/absolute path/);
    expect(validateOverride("cursor", { workRoot: "D:\\work\\app" })).toEqual({ workRoot: "D:\\work\\app" });
    expect(validateOverride("cursor", { workRoot: "/srv/app" })).toEqual({ workRoot: "/srv/app" });
  });

  it("unknown keys are ignored; yieldToIde is a boolean", () => {
    expect(validateOverride("grok", { foo: 1, model: "m" })).toEqual({ model: "m" });
    expect(validateOverride("grok", { yieldToIde: true, model: "m" })).toEqual({ yieldToIde: true, model: "m" });
    expect(() => validateOverride("grok", { yieldToIde: "yes" })).toThrow(/yieldToIde must be a boolean/);
  });

  it("countPendingSuggestions counts only insertions tagged with a name (ASCII or fullwidth colon)", () => {
    const fw = String.fromCodePoint(0xff1a);
    expect(countPendingSuggestions(`body {++@grok: a new model++} and {++@codex${fw}another one++}\n{++unsigned++}`)).toBe(2);
    expect(countPendingSuggestions("")).toBe(0);
  });
});
