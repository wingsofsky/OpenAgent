import { describe, expect, it } from "vitest";
import { BRIEF_FILES, HOME_ENV, HOME_LAYOUT, LONGKEEP_DIR, RUN_FILES } from "./layout.ts";

const all = [HOME_LAYOUT, RUN_FILES, BRIEF_FILES].flatMap((t) => Object.values(t) as string[]);

describe("layout", () => {
  it("uses portable relative paths: forward slashes, no dot segments, plain ASCII", () => {
    for (const p of all) {
      expect(p, p).toMatch(/^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/);
    }
  });

  it("names are unique within each table", () => {
    for (const table of [HOME_LAYOUT, RUN_FILES, BRIEF_FILES]) {
      const values = Object.values(table);
      expect(new Set(values).size).toBe(values.length);
    }
  });

  it("names the home folder and its environment variable", () => {
    expect(LONGKEEP_DIR).toBe(".longkeep");
    expect(HOME_ENV).toBe("LONGKEEP_HOME");
  });
});
