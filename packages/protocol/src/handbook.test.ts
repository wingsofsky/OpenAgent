import { describe, expect, it } from "vitest";
import { countPendingSuggestions } from "./executors.ts";
import { HANDBOOK_SEED, HANDBOOK_UPDATE_PROMPT } from "./handbook.ts";

describe("handbook preset", () => {
  it("carries the current preset version", () => {
    expect(HANDBOOK_SEED).toMatch(/^# Agent handbook\n\n> Preset version 2026-10-26 /);
  });

  it("points at the home-folder layout and the CLI commands", () => {
    expect(HANDBOOK_SEED).toContain("~/.openagent/handbook.md");
    expect(HANDBOOK_SEED).toContain("~/.openagent/runs/<project-key>/<task-id>/transcript.md");
    expect(HANDBOOK_SEED).toContain("openagent doctor");
    expect(HANDBOOK_SEED).toContain("openagent delegate --list");
  });

  it("starts with no pending suggestions", () => {
    expect(countPendingSuggestions(HANDBOOK_SEED)).toBe(0);
  });

  it("the update prompt asks for dated, sourced additions only", () => {
    expect(HANDBOOK_UPDATE_PROMPT).toMatch(/source link and date/);
  });
});
