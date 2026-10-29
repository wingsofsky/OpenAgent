import { describe, expect, it } from "vitest";
import { countPendingSuggestions } from "./executors.ts";
import { HANDBOOK_SEED, HANDBOOK_UPDATE_PROMPT } from "./handbook.ts";

describe("handbook preset", () => {
  it("carries the current preset version", () => {
    expect(HANDBOOK_SEED).toMatch(/^# Agent handbook\n\n> Preset version 2026-10-29 /);
  });

  it("points at the home-folder layout and the CLI commands", () => {
    expect(HANDBOOK_SEED).toContain("~/.longkeep/handbook.md");
    expect(HANDBOOK_SEED).toContain("~/.longkeep/runs/<project-key>/<task-id>/transcript.md");
    expect(HANDBOOK_SEED).toContain("longkeep doctor");
    expect(HANDBOOK_SEED).toContain("longkeep delegate --list");
  });

  it("starts with no pending suggestions", () => {
    expect(countPendingSuggestions(HANDBOOK_SEED)).toBe(0);
  });

  it("the update prompt asks for dated, sourced additions only", () => {
    expect(HANDBOOK_UPDATE_PROMPT).toMatch(/source link and date/);
  });
});
