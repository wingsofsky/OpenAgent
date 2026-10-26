import { describe, expect, it } from "vitest";
import { parseTask, serializeTask } from "../packages/protocol/src/task.ts";

const crlf = (s: string) => s.replace(/\n/g, "\r\n");
const onlyCrlf = (s: string) => !s.replace(/\r\n/g, "").includes("\n");

const LF_TASK = [
  "# Task: delegated from elsewhere",
  "",
  "status: done",
  "created: 2026-10-09 10:00",
  "issuer: claude",
  "target: docs/a.md",
  "executor: codex",
  "completed: 2026-10-09 10:05",
  "priority: high",
  "",
  "---",
  "",
  "First paragraph",
  "",
  "Second paragraph",
  "",
].join("\n");

describe("task file: CRLF (Windows checkout / Notepad)", () => {
  it("CRLF and LF parse to the same task: no key falls into extras, status / completion time are kept", () => {
    const lf = parseTask(LF_TASK, "a")!;
    const win = parseTask(crlf(LF_TASK), "a")!;
    expect(win.status).toBe("done");
    expect(win.executor).toBe("codex");
    expect(win.completed).toBe("2026-10-09 10:05");
    expect(win.extras).toEqual(["priority: high"]);
    expect(win.body).toBe("First paragraph\n\nSecond paragraph");
    const { eol, ...rest } = win;
    expect(eol).toBe("\r\n");
    expect(rest).toEqual(lf);
    expect(lf.eol).toBeUndefined();
  });

  it("writes back pure CRLF after an edit, with no duplicated keys", () => {
    const t = parseTask(crlf(LF_TASK), "a")!;
    t.status = "in_progress";
    t.body = `${t.body}\n\n## Summary (@codex)\n\nDone`;
    const out = serializeTask(t);
    expect(onlyCrlf(out)).toBe(true);
    expect(out.match(/^status:/gm)).toHaveLength(1);
    expect(out.match(/^executor:/gm)).toHaveLength(1);
    expect(out.match(/^priority:/gm)).toHaveLength(1);
    const again = parseTask(out)!;
    expect(again.status).toBe("in_progress");
    expect(out).toContain("status: in_progress\r\n");
    expect(again.extras).toEqual(["priority: high"]);
    expect(again.body).toBe("First paragraph\n\nSecond paragraph\n\n## Summary (@codex)\n\nDone");
    expect(serializeTask(again)).toBe(out); // stable round trip
  });

  it("an LF file stays LF; CRLF mixed into the body follows the file's style", () => {
    const t = parseTask(LF_TASK)!;
    t.body = "one\r\ntwo";
    const out = serializeTask(t);
    expect(out).not.toContain("\r");
    expect(parseTask(out)!.body).toBe("one\ntwo");
  });

  it("a UTF-8 BOM (older Notepad) does not stop recognition", () => {
    const t = parseTask(String.fromCharCode(0xfeff) + crlf(LF_TASK))!;
    expect(t.title).toBe("delegated from elsewhere");
    expect(t.executor).toBe("codex");
  });

  it("trailing whitespace of a value (tabs included) stays out of the field", () => {
    const t = parseTask("# t\n\nstatus: in_progress   \nexecutor: grok\t\n")!;
    expect(t.status).toBe("in_progress");
    expect(t.executor).toBe("grok");
  });
});
