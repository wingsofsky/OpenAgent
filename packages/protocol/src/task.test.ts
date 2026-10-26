import { describe, expect, it } from "vitest";
import {
  ACCEPTANCES,
  ACCEPTANCE_LABEL,
  OUTCOMES,
  OUTCOME_LABEL,
  acceptanceState,
  acceptanceValue,
  normalizeAcceptance,
  normalizeOutcome,
  normalizeStatus,
  parseTask,
  serializeTask,
  taskId,
  type TaskDoc,
} from "./task.ts";

describe("task file: parsing", () => {
  it("round-trips every field; writes the Task: title and English keys", () => {
    const t: TaskDoc = {
      title: "Fix broken links",
      status: "in_progress",
      created: "2026-08-24 10:15",
      issuer: "alice",
      target: "docs/guide.md",
      snapshot: "a1b2c3d4e5",
      executor: "codex",
      session: "codex:00000000-0000-7000-8000-000000000009",
      usage: "1234 tokens",
      writeback: "handbook",
      body: "Check every link.\n\n## Comment summary\n\n- Two links are broken",
    };
    const text = serializeTask(t);
    expect(text.startsWith("# Task: Fix broken links\n\nstatus: in_progress\ncreated: 2026-08-24 10:15\nissuer: alice\n")).toBe(true);
    expect(text).toContain("writeback: handbook\n");
    const round = parseTask(text, "20260824-101512-polish");
    expect(round).not.toBeNull();
    expect({ ...round, id: undefined }).toEqual({ ...t, id: undefined });
    expect(round!.id).toBe("20260824-101512-polish");
  });

  it("outcome and acceptance are separate fields with a stable round trip; acceptanceState takes the verdict", () => {
    const t: TaskDoc = {
      title: "t",
      status: "done",
      executor: "codex",
      completed: "2026-10-17 12:00",
      outcome: "no_changes",
      acceptance: acceptanceValue("needs_rework", "claude", "2026-10-17 12:30"),
      body: "x",
    };
    const text = serializeTask(t);
    expect(text).toContain("completed: 2026-10-17 12:00\noutcome: no_changes\nacceptance: needs_rework (claude, 2026-10-17 12:30)\n");
    const back = parseTask(text)!;
    expect([back.outcome, back.acceptance]).toEqual(["no_changes", "needs_rework (claude, 2026-10-17 12:30)"]);
    expect(back.extras).toBeUndefined();
    expect(acceptanceState(back.acceptance)).toBe("needs_rework");
    expect(acceptanceState("pending")).toBe("pending");
    expect(acceptanceState("accepted(claude, by hand)")).toBe("accepted");
    expect(acceptanceState(undefined)).toBeNull();
    expect(acceptanceState("  ")).toBeNull();
  });

  it("Task: prefix is optional; unknown keys are kept; keys are case-insensitive", () => {
    const src = ["# Fix the table of contents", "", "Status: pending", "priority: high", "", "---", "", "body"].join("\n");
    const t = parseTask(src)!;
    expect(t.title).toBe("Fix the table of contents");
    expect(t.status).toBe("pending");
    expect(t.extras).toEqual(["priority: high"]);
    expect(serializeTask(t)).toContain("priority: high");
    expect(parseTask("# task:   lower-case prefix\n")!.title).toBe("lower-case prefix");
  });

  it("header keys of dropped features are kept as unknown lines", () => {
    const t = parseTask("# Task: old\n\nstatus: done\nchannel: oauth\nclaimed: codex at 2026-10-09 10:01\n\n---\n\nx\n")!;
    expect(t.status).toBe("done");
    expect(t.extras).toEqual(["channel: oauth", "claimed: codex at 2026-10-09 10:01"]);
    expect(serializeTask(t)).toBe("# Task: old\n\nstatus: done\nchannel: oauth\nclaimed: codex at 2026-10-09 10:01\n\n---\n\nx\n");
  });

  it("no rule: the body is empty and the header takes what it can", () => {
    const t = parseTask("# Task: bare header\n\nstatus: done\n")!;
    expect(t.status).toBe("done");
    expect(t.body).toBe("");
  });

  it("returns null for files that are not tasks", () => {
    expect(parseTask("just a line\n")).toBeNull();
    expect(parseTask("")).toBeNull();
  });

  it("key-value lines and --- in the body do not leak into the header", () => {
    const t: TaskDoc = { title: "x", status: "pending", body: "status: done\noutcome: changed\n\n---\n\nsecond half" };
    const round = parseTask(serializeTask(t))!;
    expect(round.status).toBe("pending");
    expect(round.outcome).toBeUndefined();
    expect(round.body).toBe(t.body);
  });

  it("keeps a non-standard status as written", () => {
    expect(parseTask("# Task: edited by hand\n\nstatus: on_hold\n\n---\n\nx")!.status).toBe("on_hold");
    expect(normalizeStatus("on_hold")).toBeNull();
    expect([normalizeStatus(" in_progress "), normalizeStatus("done")]).toEqual(["in_progress", "done"]);
  });
});

describe("enums and display labels", () => {
  it("labels cover every outcome and acceptance; normalizing accepts only enum values", () => {
    expect(Object.keys(OUTCOME_LABEL)).toEqual([...OUTCOMES]);
    expect(Object.keys(ACCEPTANCE_LABEL)).toEqual([...ACCEPTANCES]);
    for (const k of OUTCOMES) expect(normalizeOutcome(k)).toBe(k);
    for (const k of ACCEPTANCES) expect(normalizeAcceptance(k)).toBe(k);
    expect(normalizeOutcome("no changes")).toBeNull();
    expect(normalizeAcceptance("whatever")).toBeNull();
  });
});

describe("task id", () => {
  const d = new Date(2026, 7, 24, 10, 15, 12);
  it("timestamp + slug, without an extension", () => {
    expect(taskId("Fix broken links", d)).toBe("20260824-101512-Fix-broken-links");
    expect(taskId("café crème", d)).toBe("20260824-101512-café-crème");
  });
  it("replaces path-hostile characters and whitespace", () => {
    expect(taskId("a/b\\c: *?\"<>|#d", d)).toBe("20260824-101512-a-b-c-d");
    expect(taskId("v1.2 notes", d)).toBe("20260824-101512-v1-2-notes");
  });
  it("cuts the slug at 24 characters", () => {
    expect(taskId("x".repeat(40), d)).toBe(`20260824-101512-${"x".repeat(24)}`);
  });
  it("falls back to task for an empty title", () => {
    expect(taskId("///", d)).toBe("20260824-101512-task");
  });
});
