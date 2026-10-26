// Scoped file access against the shared attack table (packages/protocol/src/path-attacks.json), plus the behaviour
// the table cannot express: canonical roots, Windows short names, atomic writes and encoding detection.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import attacks from "@openagent/protocol/path-attacks.json" with { type: "json" };
import {
  atomicWriteFile,
  canonicalRoot,
  plainWinPath,
  readTextScoped,
  resolveContractTarget,
  resolveScoped,
  resolveWritePathCreating,
} from "../src/scoped.ts";
import encodings from "./fixtures/text-encodings.json" with { type: "json" };
import { FILE_SYMLINK_SKIP, linkDir, linkFile } from "@openagent/testkit/links";
import { tempDir } from "@openagent/testkit/paths";

const WIN = process.platform === "win32";
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));

interface Fixture {
  root: string;
  outside: string;
  fileLinks: boolean;
}

function fixture(): Fixture {
  const base = tempDir("openagent-paths-");
  dirs.push(base);
  const root = path.join(base, "root");
  const outside = path.join(base, "outside");
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  const f = attacks.fixture;
  for (const d of f.dirs) fs.mkdirSync(path.join(root, d), { recursive: true });
  for (const [rel, text] of Object.entries(f.files)) fs.writeFileSync(path.join(root, rel), text);
  for (const [rel, text] of Object.entries(f.outsideFiles)) fs.writeFileSync(path.join(outside, rel), text);
  let fileLinks = true;
  for (const link of f.links) {
    const target = link.to.startsWith("outside:") ? path.join(outside, link.to.slice("outside:".length)) : path.join(root, link.to);
    if (link.kind === "dir") linkDir(target, path.join(root, link.path));
    else fileLinks = linkFile(target, path.join(root, link.path)) && fileLinks;
  }
  return { root, outside, fileLinks };
}

/** Every entry under dir, relative, sorted; links are listed but not followed. */
function tree(dir: string): string[] {
  return fs.readdirSync(dir, { recursive: true }).map(String).filter((p) => !p.startsWith(`escape-link${path.sep}`)).sort();
}

function outcome(run: () => unknown): string | number {
  try {
    const r = run() as { rel?: string; followed?: string | null } | null;
    return r && typeof r === "object" && r.followed ? `follows:${r.rel}` : "ok";
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (typeof status !== "number") throw e;
    return status;
  }
}

describe("shared attack table", () => {
  const cases = attacks.cases.filter((c) => c.os === "any" || c.os === process.platform);

  it("has cases for this platform", () => {
    expect(cases.length).toBeGreaterThanOrEqual(WIN ? 28 : 10);
  });

  for (const c of cases) {
    it(`${JSON.stringify(c.rel)}: read ${c.read}, write ${c.write}, contract ${c.contract}`, ({ annotate }) => {
      const f = fixture();
      if (c.needs === "file-link" && !f.fileLinks) return void annotate(FILE_SYMLINK_SKIP, "skip");
      const before = { root: tree(f.root), outside: tree(f.outside) };
      expect(outcome(() => resolveScoped(f.root, c.rel)), "read").toBe(c.read);
      expect(outcome(() => resolveContractTarget(f.root, c.rel)), "contract").toBe(c.contract);
      const write = outcome(() => resolveWritePathCreating(f.root, c.rel));
      expect(write, "write").toBe(c.write);
      // A refused write leaves no trace; an accepted one may only have created the parents it asked for.
      if (write !== "ok") expect(tree(f.root)).toEqual(before.root);
      expect(tree(f.outside)).toEqual(before.outside);
      expect(fs.readFileSync(path.join(f.outside, "secret.md"), "utf8")).toBe("OUTSIDE");
    });
  }
});

describe("roots", () => {
  it("canonicalRoot matches what resolveScoped returns for the root itself", () => {
    const f = fixture();
    expect(canonicalRoot(f.root)).toBe(resolveScoped(f.root, ""));
  });

  it("a missing root is a 409", () => {
    expect(outcome(() => canonicalRoot(path.join(fixture().root, "missing")))).toBe(409);
  });

  it("plainWinPath strips extended-length prefixes on Windows only", () => {
    expect(plainWinPath("/Users/a")).toBe("/Users/a");
    if (WIN) {
      expect(plainWinPath("\\\\?\\D:\\lib")).toBe("D:\\lib");
      expect(plainWinPath("\\\\?\\UNC\\srv\\share\\lib")).toBe("\\\\srv\\share\\lib");
    }
  });

  it.runIf(WIN)("Windows: 8.3 short names and case variants resolve to the real name", () => {
    const f = fixture();
    fs.mkdirSync(path.join(f.root, ".openagent"));
    expect(path.basename(resolveScoped(f.root, ".OPENAGENT"))).toBe(".openagent");
    let short: string | null = null;
    try {
      short = resolveScoped(f.root, "OPENAG~1"); // 404 when 8.3 names are disabled on the volume
    } catch {
      /* not available here */
    }
    if (short !== null) expect(path.basename(short)).toBe(".openagent");
  });
});

describe("atomic writes", () => {
  it("writes the whole content and leaves no temporary files", () => {
    const f = fixture();
    const target = resolveWritePathCreating(f.root, "sub/deep/note.md");
    atomicWriteFile(target, "hello\r\nworld\n");
    expect(fs.readFileSync(target, "utf8")).toBe("hello\r\nworld\n");
    expect(fs.readdirSync(path.dirname(target))).toEqual(["note.md"]);
  });

  it("replaces a link at the target instead of writing through it", ({ annotate }) => {
    const f = fixture();
    if (!f.fileLinks) return void annotate(FILE_SYMLINK_SKIP, "skip");
    atomicWriteFile(resolveWritePathCreating(f.root, "leak.md"), "replaced");
    expect(fs.lstatSync(path.join(f.root, "leak.md")).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(f.outside, "secret.md"), "utf8")).toBe("OUTSIDE");
  });

  it("a contract file that is an inner link is written at its target, keeping the link", ({ annotate }) => {
    const f = fixture();
    if (!f.fileLinks) return void annotate(FILE_SYMLINK_SKIP, "skip");
    const { rel } = resolveContractTarget(f.root, "inner-link.md");
    atomicWriteFile(resolveWritePathCreating(f.root, rel), "through the link");
    expect(fs.lstatSync(path.join(f.root, "inner-link.md")).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(f.root, "a.md"), "utf8")).toBe("through the link");
  });
});

describe("reading text with encoding detection", () => {
  for (const sample of encodings) {
    it(sample.name, async () => {
      const f = fixture();
      fs.writeFileSync(path.join(f.root, "sample.txt"), Buffer.from(sample.hex, "hex"));
      const r = await readTextScoped(f.root, "sample.txt");
      expect(r.encoding).toBe(sample.encoding);
      expect(r.content).toBe(sample.content);
      expect(r.truncated).toBe(false);
    });
  }

  it("UTF-16 with a BOM, binary files, and truncation", async () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.root, "u16.txt"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("hi", "utf16le")]));
    fs.writeFileSync(path.join(f.root, "bin.dat"), Buffer.from([1, 2, 0, 3]));
    fs.writeFileSync(path.join(f.root, "long.md"), "x".repeat(100));
    expect(await readTextScoped(f.root, "u16.txt")).toMatchObject({ content: "hi", encoding: "utf-16le" });
    expect(await readTextScoped(f.root, "bin.dat")).toMatchObject({ content: "", encoding: "binary" });
    expect(await readTextScoped(f.root, "long.md", 10)).toMatchObject({ content: "x".repeat(10), truncated: true, size: 100 });
  });
});
