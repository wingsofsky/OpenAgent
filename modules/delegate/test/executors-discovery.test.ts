// Finding executables: the registry's discovery rules interpreted against folder trees built from the shared fixture
// fixtures/executor-discovery.json, plus path expansion and the PATH rules.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REGISTRY } from "@longkeep/protocol/executor-registry";
import { discoverCandidates, expandPath, explainEntryBin, whichOnPath } from "../src/executors/discovery.ts";
import fixture from "./fixtures/executor-discovery.json" with { type: "json" };

const isFile = (p: string) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

interface Case {
  name: string;
  platform: string;
  env: Record<string, string>;
  path: string[];
  files: string[];
  mtimes?: Record<string, number>;
  overrides?: Record<string, string>;
  expect: Record<string, { candidates: string[]; bin: string | null }>;
}

describe("executable discovery: the shared folder-tree fixture", () => {
  for (const c of fixture.cases as Case[]) {
    it(c.name, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "of-discover-"));
      try {
        const abs = (rel: string) => path.join(root, ...rel.split("/"));
        for (const rel of c.files) {
          fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
          fs.writeFileSync(abs(rel), "");
        }
        for (const [rel, t] of Object.entries(c.mtimes ?? {})) fs.utimesSync(abs(rel), t, t);
        const env = {
          ...Object.fromEntries(Object.entries(c.env).map(([k, v]) => [k, abs(v)])),
          PATH: c.path.map(abs).join(path.delimiter),
          // Absolute registry folders (/opt/homebrew/bin …) would find CLIs installed on this machine: keep only the
          // ones under the home directory, so the fixture is the whole truth
          LONGKEEP_SEARCH_PATH: REGISTRY.searchPath
            .filter((r) => r.path.startsWith("~") && (!r.os || (r.os as string[]).includes(c.platform)))
            .map((r) => r.path)
            .join(path.delimiter),
        };
        const ctx = { env, platform: c.platform, home: root };
        const rel = (p: string | null) => (p === null ? null : path.relative(root, p).split(path.sep).join("/"));
        const got: Record<string, { candidates: Array<string | null>; bin: string | null }> = {};
        for (const e of REGISTRY.executors.filter((x) => x.bin)) {
          const over = c.overrides?.[e.id];
          got[e.id] = {
            candidates: discoverCandidates(e.bin!.discover, ctx).filter(isFile).map(rel),
            bin: rel(explainEntryBin(e, over ? abs(over) : null, ctx).bin),
          };
        }
        expect(got).toEqual(c.expect);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

describe("executable discovery: path expansion and PATH rules", () => {
  it("~/, %LOCALAPPDATA% / %APPDATA% (default AppData under the home directory), {exe} per platform", () => {
    const home = path.join(os.tmpdir(), "h");
    expect(expandPath("~/.grok/bin/grok{exe}", { home, platform: "win32", env: {} })).toBe(path.join(home, ".grok", "bin", "grok.exe"));
    expect(expandPath("~/.grok/bin/grok{exe}", { home, platform: "darwin", env: {} })).toBe(path.join(home, ".grok", "bin", "grok"));
    expect(expandPath("%LOCALAPPDATA%/agy/bin/agy.exe", { home, platform: "win32", env: {} })).toBe(path.join(home, "AppData", "Local", "agy", "bin", "agy.exe"));
    expect(expandPath("%APPDATA%/Claude", { home, platform: "win32", env: { APPDATA: path.join(home, "R") } })).toBe(path.join(home, "R", "Claude"));
  });

  it("Windows only counts .exe: extension-less sh shims and .cmd do not; a name with .exe is looked up as is; elsewhere the name as is", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "of-which-"));
    try {
      for (const n of ["gemini", "gemini.cmd", "codex.exe"]) fs.writeFileSync(path.join(dir, n), "");
      expect(whichOnPath("gemini", { PATH: dir, LONGKEEP_SEARCH_PATH: "" }, "win32")).toBeNull();
      expect(whichOnPath("codex", { Path: dir, LONGKEEP_SEARCH_PATH: "" }, "win32")).toBe(path.join(dir, "codex.exe"));
      expect(whichOnPath("codex.exe", { PATH: dir, LONGKEEP_SEARCH_PATH: "" }, "win32")).toBe(path.join(dir, "codex.exe"));
      expect(whichOnPath("gemini", { PATH: dir, LONGKEEP_SEARCH_PATH: "" }, "darwin", { home: dir })).toBe(path.join(dir, "gemini"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
