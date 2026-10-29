import { describe, expect, it } from "vitest";
import { BRIEF_DEFAULTS, DRAFT_MARKER } from "./folder-brief.ts";
import { BRIEF_FILES } from "./layout.ts";

describe("folder task brief defaults", () => {
  it("has exactly the files of BRIEF_FILES", () => {
    expect(Object.keys(BRIEF_DEFAULTS).sort()).toEqual(Object.values(BRIEF_FILES).sort());
    expect(Object.keys(BRIEF_DEFAULTS).sort()).toEqual(["rules.md", "task.md"]);
  });

  it("each default starts with the draft marker on its own first line", () => {
    expect(DRAFT_MARKER).toBe("<!-- longkeep:draft — edit this brief, then delete this line -->");
    for (const [name, text] of Object.entries(BRIEF_DEFAULTS)) {
      expect(text.split("\n")[0], name).toBe(DRAFT_MARKER);
      expect(text.split(DRAFT_MARKER).length - 1, name).toBe(1);
    }
  });

  it("each default is non-empty English Markdown with a heading after the marker", () => {
    for (const [name, text] of Object.entries(BRIEF_DEFAULTS)) {
      const rest = text.slice(DRAFT_MARKER.length + 1);
      expect(rest.trim().length, name).toBeGreaterThan(200);
      expect(rest.startsWith("# "), name).toBe(true);
      expect(text.endsWith("\n"), name).toBe(true);
      // Plain ASCII apart from the marker's dash: no leftover non-English text
      expect(/^[\x09\x0a\x20-\x7e]*$/.test(rest), name).toBe(true);
    }
  });

  it("removing the marker line leaves a brief without it", () => {
    for (const text of Object.values(BRIEF_DEFAULTS)) {
      expect(text.replace(`${DRAFT_MARKER}\n`, "")).not.toContain(DRAFT_MARKER);
    }
  });
});
