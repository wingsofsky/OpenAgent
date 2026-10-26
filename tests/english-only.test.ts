// The repository is English throughout: code, comments, errors, output and docs.
// The Chinese editions are the exceptions: every README.zh-CN.md, and the Chinese skill of the context module (a skill's
// language is the language the agent answers in). A README.md may name its Chinese edition in that edition's script.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

const CHINESE_EDITIONS = ["modules/context/zh-CN/"];
const allowed = (rel: string) => path.posix.basename(rel) === "README.zh-CN.md" || CHINESE_EDITIONS.some((d) => rel.startsWith(d));
const LANGUAGE_LINK = /^\[[^\]]+\]\(README\.zh-CN\.md\)$/;
const TEXT = /\.(ts|mjs|js|json|md|ya?ml|txt)$/;
// CJK Unified Ideographs, CJK punctuation and fullwidth forms
const range = (from: number, to: number) => `${String.fromCodePoint(from)}-${String.fromCodePoint(to)}`;
const CJK = new RegExp(`[${range(0x3000, 0x303f)}${range(0x3400, 0x4dbf)}${range(0x4e00, 0x9fff)}${range(0xff00, 0xffef)}]`);

/** The tracked text files, which are what gets published */
function trackedText(): string[] {
  const r = spawnSync("git", ["ls-files", "-z"], { encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.split("\0").filter((f) => TEXT.test(f) && fs.existsSync(f));
}

it("no Chinese text outside the Chinese editions", () => {
  const hits: string[] = [];
  for (const rel of trackedText()) {
    if (allowed(rel)) continue;
    const readme = path.posix.basename(rel) === "README.md";
    fs.readFileSync(rel, "utf8").split("\n").forEach((line, i) => {
      if (CJK.test(line) && !(readme && LANGUAGE_LINK.test(line.trim()))) hits.push(`${rel}:${i + 1}`);
    });
  }
  expect(hits).toEqual([]);
});

it("the Chinese context skill mirrors the English one file for file", () => {
  const files = (root: string): string[] =>
    fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.relative(root, path.join(e.parentPath, e.name)));
  expect(files("modules/context/zh-CN").sort()).toEqual(files("modules/context/en").sort());
});
