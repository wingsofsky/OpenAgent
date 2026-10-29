// CRLF in a person's files (Windows checkout, Notepad): task files edited by hand, writeback documents, transcripts.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseTask } from "@longkeep/protocol/task";
import { whichExecutable } from "../src/executors/registry.ts";
import { reviewDelegation, runDelegation } from "../src/delegate/index.ts";
import { lastRoundOf } from "../src/delegate/records.ts";
import { DELEGATION_FOLLOW_UP_HEADING, DELEGATION_TASK_HEADING } from "@longkeep/protocol/delegation-prompt";
import { FAKE_EXECUTOR, tempDir } from "@longkeep/testkit/paths";

const FAKE = FAKE_EXECUTOR;
const crlf = (s: string) => s.replace(/\n/g, "\r\n");
const onlyCrlf = (s: string) => !s.replace(/\r\n/g, "").includes("\n");
const base = tempDir("longkeep-crlf-");
afterAll(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
const project = path.join(base, "project");
fs.mkdirSync(path.join(project, "docs"), { recursive: true });
const env = { ...process.env, LONGKEEP_HOME: path.join(base, "home"), LONGKEEP_SEARCH_PATH: "" };

describe("CRLF task files and writeback documents", () => {
  it("a task file saved as CRLF by a person: the follow-up round and the review keep it CRLF, with one header line each", async () => {
    const r = await runDelegation({ project, executor: "codex", title: "Edited by hand", prompt: "first", bin: FAKE, env });
    fs.writeFileSync(r.taskFile, crlf(fs.readFileSync(r.taskFile, "utf8")));
    const r2 = await runDelegation({ project, executor: "codex", title: "", prompt: "second", bin: FAKE, continueTask: r.taskId, env });
    expect(r2.ok).toBe(true);
    reviewDelegation(project, r.taskId, { verdict: "accepted", reviewer: "claude", env });
    const raw = fs.readFileSync(r.taskFile, "utf8");
    expect(onlyCrlf(raw)).toBe(true);
    expect(raw.match(/^status:/gm)).toHaveLength(1);
    expect(raw.match(/^acceptance:/gm)).toHaveLength(1);
    const t = parseTask(raw)!;
    expect([t.status, t.acceptance?.split(" ")[0]]).toEqual(["done", "accepted"]);
    expect(t.body).toContain("## Round 2 completion summary (@codex)");
  });

  it("writeback into a CRLF document keeps CRLF and leaves the original text untouched", async () => {
    const before = "# Notes\r\n\r\nold entry\r\n";
    fs.writeFileSync(path.join(project, "docs", "crlf.md"), before);
    const r = await runDelegation({ project, executor: "grok", title: "First entry", prompt: "line one", writeback: "docs/crlf.md", bin: FAKE, env });
    expect(r.ok).toBe(true);
    const after = fs.readFileSync(path.join(project, "docs", "crlf.md"), "utf8");
    expect(after.startsWith(before)).toBe(true);
    expect(onlyCrlf(after)).toBe(true);
    expect(after).toContain("{++@grok: \r\n## First entry (");
    expect(after).toContain("\r\nfake answer: line one\r\n++}");
  });

  it("writeback into an LF document stays LF", async () => {
    fs.writeFileSync(path.join(project, "docs", "lf.md"), "# lf\n");
    await runDelegation({ project, executor: "grok", title: "t", prompt: "a", writeback: "docs/lf.md", bin: FAKE, env });
    expect(fs.readFileSync(path.join(project, "docs", "lf.md"), "utf8")).not.toContain("\r");
  });
});

describe("lastRoundOf: CRLF transcripts", () => {
  it("gives the same previous round as the LF transcript", () => {
    const md = [
      "# Delegation: t", "", "---", "",
      "## Round 1 (x)", "", "command: c", "", "### Prompt", "", `preamble\n\n${DELEGATION_TASK_HEADING}\nexplain`, "", "### Answer", "", "explained", "", "### Raw output (stdout)", "", "```text", "raw", "```", "",
      "## Round 2 (y)", "", "command: c", "", "### Prompt", "", `preamble\n\n${DELEGATION_FOLLOW_UP_HEADING}\nexplain more`, "", "### Answer", "", "explained again", "", "### Raw output (stdout)", "", "```text", "raw", "```", "",
    ].join("\n");
    expect(lastRoundOf(md)).toEqual({ prompt: "explain more", answer: "explained again" });
    expect(lastRoundOf(crlf(md))).toEqual(lastRoundOf(md));
    expect(lastRoundOf("# Delegation: t\n\n---\n")).toBeNull();
  });
});

describe.runIf(process.platform === "win32")("whichExecutable: Windows only counts .exe", () => {
  it("npm's extension-less sh shim and the .cmd shim do not count; a name with .exe is looked up as is", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "of-which-"));
    try {
      fs.writeFileSync(path.join(tmp, "gemini"), "#!/bin/sh\n");
      fs.writeFileSync(path.join(tmp, "gemini.cmd"), "@echo off\n");
      fs.writeFileSync(path.join(tmp, "codex.exe"), "");
      const e = { PATH: tmp, LONGKEEP_SEARCH_PATH: "" };
      expect(whichExecutable("gemini", e)).toBeNull();
      expect(whichExecutable("codex", e)).toBe(path.join(tmp, "codex.exe"));
      expect(whichExecutable("codex.exe", e)).toBe(path.join(tmp, "codex.exe"));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
