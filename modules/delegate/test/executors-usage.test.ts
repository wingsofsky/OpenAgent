// Usage parsers: output shaped like each CLI's (fixtures/executor-usage/, formats in index.json) through the parser the
// registry picks; cursor's camelCase fields; custom executors pick a parser by name, and codex-like text output is read
// from the "tokens used" line on stderr.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateOverride } from "@openagent/protocol/executors";
import { extractJsonUsage } from "../src/executors/parsers.ts";
import { BUILTIN_EXECUTORS, customExecutor } from "../src/executors/registry.ts";

const DIR = path.join(import.meta.dirname, "fixtures", "executor-usage");
const index = JSON.parse(fs.readFileSync(path.join(DIR, "index.json"), "utf8")) as {
  executors: Record<string, { stdout: string; stderr?: string; usage: number | null; source: string }>;
};
const read = (f?: string) => (f ? fs.readFileSync(path.join(DIR, f), "utf8") : "");
/** stdout and stderr joined, as the runner does (stdout, stderr head, stderr tail) */
const combined = (x: { stdout: string; stderr?: string }) => `${read(x.stdout)}\n\n${read(x.stderr)}`;

describe("each CLI's output through the registry's usage parser", () => {
  it.each(Object.entries(index.executors))("%s", (key, x) => {
    const spec = BUILTIN_EXECUTORS[key.replace(/-error$/, "")];
    expect(x.source).toBeTruthy();
    expect(spec.extractUsage(combined(x))).toBe(x.usage);
  });

  it("usage scope: codex and agy are cumulative, the rest per round", () => {
    expect(Object.fromEntries(Object.entries(BUILTIN_EXECUTORS).map(([k, s]) => [k, s.usageScope]))).toEqual({
      codex: "cumulative",
      agy: "cumulative",
      grok: "round",
      cursor: "round",
      claude: "round",
    });
  });

  it("camelCase fields: inputTokens + outputTokens, totalTokens, top-level totalTokens; cache not counted", () => {
    expect(extractJsonUsage('{"usage":{"inputTokens":4,"outputTokens":4,"cacheReadTokens":1000}}')).toBe(8);
    expect(extractJsonUsage('{"usage":{"promptTokens":10,"completionTokens":2}}')).toBe(12);
    expect(extractJsonUsage('{"usage":{"totalTokens":99,"inputTokens":1}}')).toBe(99);
    expect(extractJsonUsage('{"totalTokens":7}')).toBe(7);
    expect(extractJsonUsage('{"usage":{"cacheReadTokens":1000}}')).toBeNull();
  });
});

describe("custom executors pick their usage parser by name", () => {
  const codexOut = combined(index.executors.codex);
  const cursorOut = combined(index.executors.cursor);

  it("without extends: answer outFile / stdout defaults to codex-tokens-used (read from the stderr tail), json to json", () => {
    const base = { command: "x", args: ["{prompt}"] };
    expect(customExecutor("cx-out", { ...base, answer: "outFile" }).extractUsage(codexOut)).toBe(1200);
    expect(customExecutor("cx-txt", { ...base, answer: "stdout" }).extractUsage(codexOut)).toBe(1200);
    expect(customExecutor("js", { ...base }).extractUsage(cursorOut)).toBe(8);
    expect(customExecutor("js", { ...base }).extractUsage(codexOut)).toBeNull();
  });

  it("an explicit usage name wins; extends inherits the built-in entry's by default", () => {
    expect(customExecutor("t", { command: "x", args: ["{prompt}"], answer: "stdout", usage: "json" }).extractUsage(cursorOut)).toBe(8);
    expect(customExecutor("my-codex", { extends: "codex" }).extractUsage(codexOut)).toBe(1200);
    expect(customExecutor("my-codex", { extends: "codex", answer: "stdout" }).extractUsage(codexOut)).toBe(1200);
    expect(customExecutor("my-cursor", { extends: "cursor" }).extractUsage(cursorOut)).toBe(8);
    expect(customExecutor("c2", { extends: "cursor", usage: "codex-tokens-used" }).extractUsage(codexOut)).toBe(1200);
  });

  it("validateOverride: usage only accepts the registry's parser names", () => {
    expect(validateOverride("t", { command: "x", args: ["{prompt}"], usage: "json" }).usage).toBe("json");
    expect(() => validateOverride("t", { command: "x", args: ["{prompt}"], usage: "regex" })).toThrow(/usage only accepts codex-tokens-used \| json/);
  });
});
