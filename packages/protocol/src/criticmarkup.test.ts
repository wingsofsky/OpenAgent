import { expect, it } from "vitest";
import { makeCritic } from "./criticmarkup.ts";
import { countPendingSuggestions } from "./executors.ts";

it("an insertion tagged with an executor's name is the suggestion the handbook counts as waiting for a decision", () => {
  const mark = makeCritic.ins("a new model", "grok");
  expect(mark).toBe("{++@grok: a new model++}");
  expect(countPendingSuggestions(`# Handbook\n\n${mark}\n`)).toBe(1);
  expect(countPendingSuggestions(makeCritic.ins("unsigned"))).toBe(0);
});
