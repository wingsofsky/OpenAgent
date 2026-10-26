// Module boundaries, which are what make a sparse checkout of one module work on its own.
// - packages/protocol imports only files from its own src directory: no packages, no node:, no IO.
// - packages/* never import modules/*.
// - A module imports node:, its own files, and the packages its package.json declares; a module it imports must be in
//   its module.json `requires`.
// - module.json `paths` is exactly what a sparse checkout of the module needs: its own folder, the folders of its
//   workspace dependencies (transitively), the required modules' paths, and packages/cli when it has commands.
// - Every command entry exists and exports its function; every skill folder has a SKILL.md.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/** Static imports and re-exports (also the closing line of a multi-line one), side-effect imports, dynamic imports. */
const SPEC = /^\s*(?:import|export|\})[^"'\n;]*?\bfrom\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/gm;

const walk = (dir: string): string[] =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        if (e.name === "node_modules") return [];
        const p = path.join(dir, e.name);
        return e.isDirectory() ? walk(p) : [p];
      })
    : [];
const sources = (dir: string) => walk(dir).filter((f) => /\.(ts|mjs)$/.test(f));
const specifiers = (file: string) => [...fs.readFileSync(file, "utf8").matchAll(SPEC)].map((m) => m[1] ?? m[2] ?? m[3]);
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const posix = (p: string) => p.split(path.sep).join("/");
/** Test tooling (vitest) is declared once, at the root. */
const ROOT_DEV = Object.keys(readJson("package.json").devDependencies ?? {});

/** Workspace packages by name: their folder and declared dependencies. */
const WORKSPACE = new Map<string, { dir: string; deps: string[]; devDeps: string[] }>();
for (const parent of ["packages", "modules"]) {
  for (const name of fs.readdirSync(parent)) {
    const file = path.join(parent, name, "package.json");
    if (!fs.existsSync(file)) continue;
    const pkg = readJson(file);
    WORKSPACE.set(pkg.name, { dir: `${parent}/${name}`, deps: Object.keys(pkg.dependencies ?? {}), devDeps: Object.keys(pkg.devDependencies ?? {}) });
  }
}
const nameOfDir = (dir: string) => [...WORKSPACE].find(([, w]) => w.dir === dir)?.[0];
const packageName = (spec: string) => (spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);

interface Manifest {
  name: string;
  requires: string[];
  paths: string[];
  commands: Record<string, { entry: string; export: string; about: string }>;
  skills: Record<string, string | Record<string, string>>;
}
const MODULES = fs.readdirSync("modules").filter((n) => fs.existsSync(path.join("modules", n, "module.json")));
const manifest = (name: string): Manifest => readJson(path.join("modules", name, "module.json"));

describe("packages", () => {
  const SRC = path.resolve("packages/protocol/src");

  it("protocol sources only import siblings, with explicit extensions", () => {
    const files = fs.readdirSync(SRC).filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"));
    expect(files.length).toBeGreaterThan(0);
    const bad: string[] = [];
    for (const name of files) {
      for (const spec of specifiers(path.join(SRC, name))) {
        const sibling = /^\.\/[a-z0-9-]+\.(ts|json)$/.test(spec) && fs.existsSync(path.join(SRC, spec));
        if (!sibling) bad.push(`${name} -> ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("protocol declares no dependencies", () => {
    const pkg = readJson("packages/protocol/package.json");
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(pkg.peerDependencies ?? {}).toEqual({});
  });

  it("never import a module", () => {
    const bad: string[] = [];
    for (const file of sources("packages")) {
      for (const spec of specifiers(file)) {
        const pkg = WORKSPACE.get(packageName(spec));
        const target = spec.startsWith(".") ? posix(path.relative(".", path.resolve(path.dirname(file), spec))) : (pkg?.dir ?? "");
        if (target.startsWith("modules/")) bad.push(`${posix(file)} -> ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("modules", () => {
  it("are found", () => {
    expect(MODULES).toEqual(expect.arrayContaining(["context", "delegate", "folder", "sessions"]));
  });

  for (const name of MODULES) {
    const dir = `modules/${name}`;
    const m = manifest(name);
    const pkgName = nameOfDir(dir);
    const pkg = pkgName ? WORKSPACE.get(pkgName) : undefined;

    describe(name, () => {
      it("imports only its own files, node: and declared packages; a module only if required", () => {
        expect(m.name).toBe(name);
        const bad: string[] = [];
        for (const file of sources(dir)) {
          for (const spec of specifiers(file)) {
            if (spec.startsWith("node:")) continue;
            if (spec.startsWith(".")) {
              const target = posix(path.relative(dir, path.resolve(path.dirname(file), spec)));
              if (target.startsWith("..")) bad.push(`${posix(file)} -> ${spec} (outside the module)`);
              continue;
            }
            const dep = packageName(spec);
            if (!pkg || ![...pkg.deps, ...pkg.devDeps, ...ROOT_DEV].includes(dep)) bad.push(`${posix(file)} -> ${spec} (not declared)`);
            const ws = WORKSPACE.get(dep);
            if (ws?.dir.startsWith("modules/") && !m.requires.includes(ws.dir.slice("modules/".length))) {
              bad.push(`${posix(file)} -> ${spec} (module not in requires)`);
            }
          }
        }
        expect(bad).toEqual([]);
      });

      it("lists exactly the paths a sparse checkout needs", () => {
        const expected = new Set<string>([dir]);
        const add = (wsName: string) => {
          const ws = WORKSPACE.get(wsName);
          if (!ws || expected.has(ws.dir)) return;
          expected.add(ws.dir);
          ws.deps.forEach(add);
        };
        pkg?.deps.forEach(add);
        for (const r of m.requires) manifest(r).paths.forEach((p) => expected.add(p));
        if (Object.keys(m.commands).length) expected.add("packages/cli");
        expect(new Set(m.paths)).toEqual(expected);
        const required = (pkg?.deps ?? []).map((d) => WORKSPACE.get(d)?.dir).filter((d) => d?.startsWith("modules/"));
        expect(m.requires.map((r) => `modules/${r}`).sort()).toEqual(required.sort());
      });

      it("has its command entries and skill folders", () => {
        for (const [command, spec] of Object.entries(m.commands)) {
          const entry = path.join(dir, spec.entry);
          expect(fs.existsSync(entry), `${command}: ${entry}`).toBe(true);
          expect(fs.readFileSync(entry, "utf8"), `${command}: export ${spec.export}`).toMatch(new RegExp(`export async function ${spec.export}\\(`));
        }
        const skillDirs = Object.values(m.skills).flatMap((s) => (typeof s === "string" ? [s] : Object.values(s)));
        expect(skillDirs.length).toBeGreaterThan(0);
        for (const s of skillDirs) expect(fs.existsSync(path.join(dir, s, "SKILL.md")), `${dir}/${s}/SKILL.md`).toBe(true);
      });
    });
  }
});
