// The importer reads the CLIs' transcript folders under the user's home directory, so every run here is a child
// process with HOME / USERPROFILE pointing at a fixture folder and OPENAGENT_HOME at a temporary home folder: no test
// reads real transcripts or touches the real ~/.openagent.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DELEGATION_PROMPT_FIRST_LINE, DELEGATION_TASK_HEADING } from "@openagent/protocol/delegation-prompt";
import { FAKE_SECRET, FAKE_SHORT_KEY } from "@openagent/testkit/fake-secrets";
import { tempDir } from "@openagent/testkit/paths";

const MODULE = pathToFileURL(path.resolve(import.meta.dirname, "../src/import.ts")).href;
const RUNNER = "const m = await import(process.argv[1]); process.exitCode = await m.importSessions(process.argv.slice(2));";
// A cwd that does not exist: not under the temp folder, no git root, so it is filed by its project-level folder
const proj = (name: string) => (process.platform === "win32" ? `Z:\\${name}\\sub` : `/Volumes/X/${name}/sub`);

let tmp: string;
let home: string;
let ofHome: string;
let sessions: string;
const out = () => path.join(ofHome, "sessions", "imported");
const codexFile = (name: string) => path.join(sessions, `${name}.jsonl`);
const writeCodex = (name: string, id: string, cwd: string | undefined, msgs: [string, string][]) => {
  const recs: unknown[] = [{ type: "session_meta", timestamp: "2026-10-01T08:00:00Z", payload: { id, cwd } }];
  msgs.forEach(([role, text], i) =>
    recs.push({
      type: "response_item",
      timestamp: `2026-10-01T08:0${Math.min(i + 1, 9)}:00Z`,
      payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] },
    }),
  );
  fs.writeFileSync(codexFile(name), recs.map((r) => JSON.stringify(r)).join("\n"));
};
const runRaw = (...args: string[]) =>
  execFileSync(process.execPath, ["--input-type=module", "-e", RUNNER, MODULE, ...args], {
    env: { ...process.env, HOME: home, USERPROFILE: home, OPENAGENT_HOME: ofHome },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
const run = (...args: string[]) => runRaw("--source", "codex", "--all-projects", ...args);
const archives = () =>
  (fs.readdirSync(out(), { recursive: true }) as string[])
    .map((p) => p.replaceAll("\\", "/"))
    .filter((p) => p.endsWith(".md") && !p.endsWith("index.md"))
    .sort();
const read = (rel: string) => fs.readFileSync(path.join(out(), rel), "utf8");
/** Data rows of the "All" table of the top index. */
const indexRows = (md: string) =>
  md
    .split("## All")[1]
    .split("\n")
    .filter((l) => l.startsWith("| ") && !l.startsWith("| Time "));

beforeEach(() => {
  tmp = tempDir("openagent-sessions-");
  home = path.join(tmp, "home");
  ofHome = path.join(tmp, "openagent-home");
  sessions = path.join(home, ".codex", "sessions");
  fs.mkdirSync(sessions, { recursive: true });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

describe("session archive: project folders, refresh of continued sessions, no lost text", () => {
  it("files new sessions by project and delegated tasks under _delegated; writes two levels of index", () => {
    writeCodex("a", "id-a", proj("alpha"), [["user", "ALPHA first question"], ["assistant", "answer one"]]);
    writeCodex("b", "id-b", proj("beta"), [["user", "BETA first question"], ["assistant", "answer"]]);
    const job = path.join(ofHome, "runs", "proj-1a2b3c4d", "20261009-000000-wordcount", "work");
    writeCodex("c", "id-c", job, [["user", `${DELEGATION_PROMPT_FIRST_LINE}\n\n${DELEGATION_TASK_HEADING}\nCount the words`], ["assistant", "ok"]]);
    run();
    const files = archives();
    expect(files.filter((f) => f.startsWith("alpha/"))).toHaveLength(1);
    expect(files.filter((f) => f.startsWith("beta/"))).toHaveLength(1);
    expect(files.filter((f) => f.startsWith("_delegated/"))).toHaveLength(1);
    expect(files.find((f) => f.startsWith("_delegated/"))).toContain("wordcount");
    const index = fs.readFileSync(path.join(out(), "index.md"), "utf8");
    expect(index).toContain("| [alpha](alpha/index.md) | 1 |");
    const rows = indexRows(index);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => /\]\((alpha|beta|_delegated)\//.test(r))).toBe(true);
    expect(fs.existsSync(path.join(out(), "alpha", "index.md"))).toBe(true);
    const alpha = read(files.find((f) => f.startsWith("alpha/"))!);
    expect(alpha).toMatch(/^- checksum: sha256:[0-9a-f]{16}$/m);
    expect(alpha).toMatch(/^# Session: ALPHA first question$/m);
    expect(alpha).toContain("- source: codex · id `id-a`");
  });

  it("refreshes a session that continued; leaves an edited archive alone and lists it; a rerun does nothing", () => {
    writeCodex("a", "id-a", proj("alpha"), [["user", "first question"], ["assistant", "answer one"]]);
    writeCodex("b", "id-b", proj("beta"), [["user", "B first question"], ["assistant", "B answer"]]);
    run();
    const aRel = archives().find((f) => f.startsWith("alpha/"))!;
    const bRel = archives().find((f) => f.startsWith("beta/"))!;
    fs.appendFileSync(path.join(out(), bRel), "\n{>>my note<<}\n");
    writeCodex("a", "id-a", proj("alpha"), [["user", "first question"], ["assistant", "answer one"], ["user", "second question"], ["assistant", "answer two"]]);
    writeCodex("b", "id-b", proj("beta"), [["user", "B first question"], ["assistant", "B answer"], ["user", "B second question"]]);
    const output = run();
    expect(output).toContain(`Refreshed: sessions/imported/${aRel} (2 → 4 turns)`);
    expect(output).toMatch(/1 archives were edited after import/);
    expect(archives()).toEqual([aRel, bRel].sort());
    expect(read(aRel)).toContain("second question");
    expect(read(bRel)).toContain("my note");
    expect(read(bRel)).not.toContain("B second question");
    expect(run()).toMatch(/Done: imported 0, refreshed 0/);
  });

  it("codex: forked threads with the same session id are archived separately; a rollout moved to archived_sessions is not imported twice", () => {
    writeCodex("main", "same-id", proj("alpha"), [["user", "main thread question"], ["assistant", "main answer"]]);
    writeCodex("fork", "same-id", proj("alpha"), [["user", "forked question"], ["assistant", "forked answer"]]);
    run();
    expect(archives()).toHaveLength(2);
    const archived = path.join(home, ".codex", "archived_sessions");
    fs.mkdirSync(archived, { recursive: true });
    fs.renameSync(codexFile("main"), path.join(archived, "main.jsonl"));
    run();
    expect(archives()).toHaveLength(2);
  });

  it("when the start no longer matches but the transcript has more, the transcript wins and the old archive moves to _previous/", () => {
    writeCodex("a", "id-a", proj("alpha"), [["user", "first question"], ["assistant", "answer one"]]);
    run();
    const rel = archives()[0];
    // As if the CLI rewrote it: the opening line changed, and two turns were added
    writeCodex("a", "id-a", proj("alpha"), [["user", "rewritten first question"], ["assistant", "answer one"], ["user", "second question"], ["assistant", "answer two"]]);
    const output = run();
    expect(output).toMatch(/1 sessions were rewritten by the CLI that keeps them/);
    const files = archives();
    expect(files).toContain(rel);
    const old = files.find((f) => f.includes("/_previous/"));
    expect(old).toBeTruthy();
    expect(read(old!)).toContain("first question");
    expect(read(old!)).not.toContain("rewritten");
    expect(read(rel)).toContain("rewritten first question");
  });

  it("--reorganize files a flat archive by its header's project; one whose transcript is gone moves without changes", () => {
    const flatArchive = [
      "# Session: old archive",
      "",
      "- source: codex · id `gone-1`",
      `- project: ${proj("gamma")}`,
      "- time: 2026-09-01 10:00 → 2026-09-01 10:05 · turns: 1 user / 1 assistant · tools 0 · dispatches 0",
      `- imported: 2026-09-01 10:06 · original transcript: \`${path.join(home, "gone.jsonl")}\``,
      "",
      "---",
      "",
      "## User",
      "",
      "a session deleted long ago",
      "",
    ].join("\n");
    fs.mkdirSync(out(), { recursive: true });
    fs.writeFileSync(path.join(out(), "20260901-1000-gone1-old-archive.md"), flatArchive);
    writeCodex("a", "id-a", proj("alpha"), [["user", "first question"], ["assistant", "answer one"]]);
    run();
    const output = run("--reorganize");
    expect(output).toMatch(/Reorganized 2 archives/);
    expect(archives()).toContain("gamma/20260901-1000-gone1-old-archive.md");
    expect(read("gamma/20260901-1000-gone1-old-archive.md")).toBe(flatArchive);
    expect(fs.readdirSync(out()).filter((n) => n.endsWith(".md"))).toEqual(["index.md"]);
  });

  it("--index rebuilds the indexes only; without a home folder it creates nothing", () => {
    expect(runRaw("--index")).toMatch(/No sessions\/imported\/ folder/);
    expect(fs.existsSync(ofHome)).toBe(false);
    writeCodex("a", "id-a", proj("alpha"), [["user", "first question"], ["assistant", "answer one"]]);
    run();
    fs.unlinkSync(path.join(out(), "index.md"));
    expect(runRaw("--index")).toMatch(/Rebuilt sessions\/imported\/index\.md \(1 archives, 1 project folders\)/);
    expect(fs.existsSync(path.join(out(), "index.md"))).toBe(true);
  });

  it("--file imports one transcript regardless of project; --prompts writes the three books; unknown options exit 2", () => {
    writeCodex("a", "id-a", undefined, [["user", "From now on, always write tests first."], ["assistant", "noted"]]);
    const output = runRaw("--file", codexFile("a"), "--source", "codex", "--prompts");
    expect(output).toContain("Imported: sessions/imported/_unknown/");
    expect(fs.readFileSync(path.join(out(), "_prompts", "USER_RULES.md"), "utf8")).toContain("From now on, always write tests first.");
    expect(fs.existsSync(path.join(out(), "_prompts", "USER_PROMPTS.md"))).toBe(true);
    expect(fs.existsSync(path.join(out(), "_prompts", "AGENT_PROMPTS.md"))).toBe(true);
    // An unknown option, an unknown source and a missing value are all bad usage
    for (const args of [["--root", tmp], ["--source", "bogus", "--list"], ["--project"], ["--source", "--list"]]) {
      let status = 0;
      try {
        runRaw(...args);
      } catch (e) {
        status = (e as { status: number }).status;
      }
      expect(status, args.join(" ")).toBe(2);
    }
  });

  it("redacts by default and lists counts; --no-redact keeps the text", () => {
    writeCodex("a", "id-a", proj("alpha"), [["user", `my key is ${FAKE_SHORT_KEY}`], ["assistant", "ok"]]);
    const output = run();
    expect(output).toMatch(/Redacted \d+ items \(openai\/anthropic×\d+\)/);
    const rel = archives()[0];
    expect(read(rel)).toContain("[redacted:openai/anthropic length 27]");
    expect(read(rel)).not.toContain("sk-abcDEF");
    fs.rmSync(out(), { recursive: true, force: true });
    run("--no-redact");
    expect(read(archives()[0])).toContain(FAKE_SHORT_KEY);
  });

  it("keeps a secret at the start of the first message out of every archive file name and index row, with or without --no-redact", () => {
    const secret = FAKE_SECRET;
    writeCodex("a", "id-a", proj("alpha"), [["user", `sk-test${secret} is the key, keep it safe`], ["assistant", "ok"]]);
    for (const flags of [[], ["--no-redact"]]) {
      fs.rmSync(out(), { recursive: true, force: true });
      run(...flags);
      const names = archives();
      expect(names).toHaveLength(1);
      for (const name of names) {
        expect(name).not.toContain("sk-test");
        for (let i = 0; i + 6 <= secret.length; i++) expect(name).not.toContain(secret.slice(i, i + 6));
      }
      for (const index of ["index.md", "alpha/index.md"]) {
        const rows = read(index)
          .split("\n")
          .filter((l) => l.startsWith("| "));
        expect(rows.some((r) => r.includes("is the key"))).toBe(true);
        for (const row of rows) {
          expect(row).not.toContain("sk-test");
          for (let i = 0; i + 6 <= secret.length; i++) expect(row).not.toContain(secret.slice(i, i + 6));
        }
      }
    }
  });

  it("links every prompt-book entry to the archive's real path, project folder included", () => {
    writeCodex("a", "id-a", proj("alpha"), [["user", "From now on, always run the linter."], ["assistant", "ok"]]);
    writeCodex("b", "id-b", proj("beta"), [["user", "Never push on Fridays."], ["assistant", "ok"]]);
    run();
    run("--prompts"); // the second run imports nothing new: links come from the existing archives
    let links = 0;
    for (const book of ["USER_PROMPTS.md", "AGENT_PROMPTS.md", "USER_RULES.md"]) {
      const dir = path.join(out(), "_prompts");
      for (const m of fs.readFileSync(path.join(dir, book), "utf8").matchAll(/\]\(([^)]+)\)/g)) {
        expect(fs.existsSync(path.resolve(dir, m[1])), `${book}: ${m[1]}`).toBe(true);
        expect(m[1]).toMatch(/^\.\.\/(alpha|beta)\//);
        links++;
      }
    }
    expect(links).toBe(4); // two user prompts, two rule paragraphs
  });
});

describe("native history imports keep project boundaries", () => {
  it("defaults to the matching cwd, skips unknown projects, and supports an explicit all-projects choice", () => {
    const project = path.join(tmp, "project");
    fs.mkdirSync(project);
    for (const [id, cwd, text] of [
      ["mine", project, "PROJECT_MATCH"],
      ["other", tmp, "OTHER_PROJECT_SECRET"],
      ["unknown", undefined, "UNKNOWN_PROJECT"],
    ] as const) {
      const records = [
        { type: "session_meta", payload: { id, cwd, timestamp: "2026-09-12T08:00:00Z" } },
        { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } },
      ];
      fs.writeFileSync(path.join(sessions, `${id}.jsonl`), records.map((x) => JSON.stringify(x)).join("\n"));
    }
    const scoped = (...args: string[]) => runRaw("--project", project, "--source", "codex", ...args);
    const listing = scoped("--list");
    expect(listing).toContain("PROJECT_MATCH");
    expect(listing).not.toContain("OTHER_PROJECT_SECRET");
    expect(listing).not.toContain("UNKNOWN_PROJECT");
    expect(fs.existsSync(ofHome)).toBe(false);
    const all = scoped("--list", "--all-projects");
    expect(all).toContain("OTHER_PROJECT_SECRET");
    expect(all).toContain("UNKNOWN_PROJECT");
    scoped();
    expect(archives()).toHaveLength(1);
    expect(read(archives()[0])).toContain("PROJECT_MATCH");
  });
});
