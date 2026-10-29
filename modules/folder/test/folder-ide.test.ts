// IntelliJ IDEA detection (folder/ide.ts) and the bounds that keep one large repository from stalling the queue.
// The IDE's processes and open files are injected, so nothing real is observed.
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { blocksProject, ideaPathHash, readIntellijProjects } from "../src/ide.ts";
import { linkDir } from "@longkeep/testkit/links";
import { tempDir } from "@longkeep/testkit/paths";

const roots: string[] = [];
const temp = () => {
  const r = tempDir("longkeep-idea-");
  roots.push(r);
  return r;
};
afterEach(() => roots.splice(0).forEach((r) => fs.rmSync(r, { recursive: true, force: true })));
const stamp = (root: string) => `/cache/JetBrains/IntelliJIdea2026.2/projects/project.${ideaPathHash(root)}/indexingStamp/indexingStamp.dat`;

it("matches the projects the IDE holds now, including parent and nested folders", async () => {
  const root = temp();
  fs.mkdirSync(path.join(root, "nested"));
  const options = { platform: "darwin" as const, processes: async () => [123], candidates: [root] };
  for (const opened of [root, path.dirname(root), path.join(root, "nested")])
    expect((await readIntellijProjects({ ...options, openFiles: async () => [stamp(opened)] })).projects).toEqual([root]);
  expect((await readIntellijProjects({ ...options, openFiles: async () => [stamp(root + "-unrelated")] })).projects).toEqual([]);
  expect((await readIntellijProjects({ ...options, openFiles: async () => ["/cache/JetBrains/IntelliJIdea2026.2/log"] })).projects).toEqual([]);
  // Java String.hashCode of the path, as IntelliJ names its project folders
  expect(ideaPathHash("/Users/alice/code/demo-project")).toBe("2e52834c");
});

it("no running IDE means nothing is open; an unverified version or a failed look means unknown, which blocks", async () => {
  const root = temp();
  const options = { platform: "darwin" as const, processes: async () => [123], candidates: [root] };
  expect((await readIntellijProjects({ ...options, processes: async () => [] })).state).toBe("ready");
  expect((await readIntellijProjects({ ...options, openFiles: async () => [stamp(root).replace("2026.2", "2027.1")] })).state).toBe("unknown");
  expect((await readIntellijProjects({ ...options, processes: async () => { throw new Error("denied"); } })).state).toBe("unknown");
  expect(blocksProject({ state: "unknown", projects: [] }, root)).toBe(true);
  expect((await readIntellijProjects({ ...options, platform: "win32", openFiles: async () => [stamp(root)] })).projects).toEqual([]);
});

it("does not follow links: a project opened through a link inside the folder is not seen, and nothing is written", async () => {
  const root = temp();
  const outside = temp();
  fs.mkdirSync(path.join(outside, "inner"));
  linkDir(outside, path.join(root, "escape"));
  const options = { platform: "darwin" as const, processes: async () => [123], candidates: [root] };
  // Following the link would hash root/escape/inner and match; not following it never looks there.
  expect(await readIntellijProjects({ ...options, openFiles: async () => [stamp(path.join(root, "escape", "inner"))] })).toEqual({ state: "ready", projects: [] });
  expect(await readIntellijProjects({ ...options, openFiles: async () => [stamp(outside)] })).toEqual({ state: "ready", projects: [] });
  expect(fs.readdirSync(root)).toEqual(["escape"]);
  expect(fs.readdirSync(outside)).toEqual(["inner"]);
});

it("skips dependency and build folders and stays bounded: those never block, and nothing becomes unknown", async () => {
  const root = temp();
  for (const rel of ["node_modules/pkg", "target/classes", "app/src/module/deep/deeper"]) fs.mkdirSync(path.join(root, ...rel.split("/")), { recursive: true });
  const options = { platform: "darwin" as const, processes: async () => [123], candidates: [root] };
  const look = (rel: string) => readIntellijProjects({ ...options, openFiles: async () => [stamp(path.join(root, ...rel.split("/")))] });
  expect(await look("node_modules/pkg")).toEqual({ state: "ready", projects: [] });
  expect(await look("target/classes")).toEqual({ state: "ready", projects: [] });
  expect(await look("app/src")).toEqual({ state: "ready", projects: [root] });
  // Four levels deep at most: a project opened five levels down is not looked for
  expect(await look("app/src/module/deep/deeper")).toEqual({ state: "ready", projects: [] });
});

it("looks level by level, so a large folder cannot use up the search before a project near the top; a search cut short is reported", async () => {
  const root = temp();
  for (const rel of ["a/a1/a11", "a/a2", "b"]) fs.mkdirSync(path.join(root, ...rel.split("/")), { recursive: true });
  const options = { platform: "darwin" as const, processes: async () => [123], candidates: [root], limits: { folders: 3 } };
  // Depth first in name order would spend all three looks inside a/ and never reach b
  expect(await readIntellijProjects({ ...options, openFiles: async () => [stamp(path.join(root, "b"))] })).toEqual({ state: "ready", projects: [root] });
  // a, b, a/a1, then the limit: whatever lies further down was not looked at, and the result says so
  expect(await readIntellijProjects({ ...options, openFiles: async () => [stamp(path.join(root, "a", "a2"))] })).toEqual({ state: "ready", projects: [], partial: [root] });
  expect(await readIntellijProjects({ ...options, limits: { folders: 4 }, openFiles: async () => [stamp(path.join(root, "a", "a2"))] })).toEqual({ state: "ready", projects: [root] });
});

it("an unreadable folder means nothing is open there; the rest of the folder is still checked", async () => {
  const root = temp();
  fs.mkdirSync(path.join(root, "locked"));
  fs.mkdirSync(path.join(root, "zz-app"));
  fs.chmodSync(path.join(root, "locked"), 0o000);
  try {
    const options = { platform: "darwin" as const, processes: async () => [123], candidates: [root] };
    expect(await readIntellijProjects({ ...options, openFiles: async () => [stamp(path.join(root, "zz-app"))] })).toEqual({ state: "ready", projects: [root] });
    expect(await readIntellijProjects({ ...options, openFiles: async () => [stamp(path.join(root, "locked", "x"))] })).toEqual({ state: "ready", projects: [] });
  } finally {
    fs.chmodSync(path.join(root, "locked"), 0o755);
  }
});
