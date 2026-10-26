import { describe, expect, it } from "vitest";
import {
  RUN_FILE,
  lastRawTokens,
  normalizeArgs,
  parseRunRecord,
  roundElapsed,
  roundTokens,
  rulingsOf,
  serializeRunRecord,
  totalTokens,
  type Attempt,
  type RunRecord,
} from "./runs.ts";

const att = (tokens: number | null, scope: "round" | "cumulative" = "round", extra: Partial<Attempt> = {}): Attempt => ({
  n: 1, startedAt: "t", elapsedMs: 100, backoffMs: 0, exit: "ok", exitCode: 0,
  usage: tokens === null ? null : { tokens, scope }, error: null, ...extra,
});

describe("run record v2", () => {
  const rec: RunRecord = {
    version: 2, id: "x", plan: { title: "T", executor: "codex", brief: "B" },
    rounds: [{ n: 1, at: "a", tokens: 10 }, { n: 2, at: "b", ruling: "again", tokens: 5 }, { n: 3, at: "c", ruling: "once more", tokens: null }],
  };

  it("serializes and parses back; broken input returns null", () => {
    expect(RUN_FILE).toBe("run.json");
    expect(parseRunRecord(serializeRunRecord(rec))).toEqual(rec);
    expect(parseRunRecord(String.fromCharCode(0xfeff) + serializeRunRecord(rec))).toEqual(rec);
    expect(parseRunRecord("{")).toBeNull();
    expect(parseRunRecord(JSON.stringify({ ...rec, version: 1 }))).toBeNull();
    expect(parseRunRecord(JSON.stringify({ ...rec, plan: { title: "T" } }))).toBeNull();
    expect(parseRunRecord(JSON.stringify({ ...rec, rounds: [{}] }))).toBeNull();
  });

  it("rulings of the earlier rounds, in order", () => {
    expect(rulingsOf(rec)).toEqual([{ round: 2, text: "again" }, { round: 3, text: "once more" }]);
  });

  it("usage: round scope as is; cumulative native resume of the same session takes the delta; a new session / replay / counter reset as is", () => {
    const prev = { tokensRaw: 100, session: "s1" };
    expect(roundTokens([att(40)], { resume: "native", previous: prev, session: "s1" })).toEqual({ tokens: 40, raw: 40 });
    expect(roundTokens([att(130, "cumulative")], { resume: "native", previous: prev, session: "s1" })).toEqual({ tokens: 30, raw: 130 });
    expect(roundTokens([att(130, "cumulative")], { resume: "native", previous: prev, session: "s2" }).tokens).toBe(130);
    expect(roundTokens([att(130, "cumulative")], { resume: "replay", previous: prev, session: "s1" }).tokens).toBe(130);
    expect(roundTokens([att(60, "cumulative")], { resume: "native", previous: prev, session: "s1" }).tokens).toBe(60);
    expect(roundTokens([att(60, "cumulative")], { resume: "native", previous: { tokensRaw: null, session: "s1" }, session: "s1" }).tokens).toBe(60);
    // The last attempt with a number counts; no number at all is null, not 0
    expect(roundTokens([att(7), att(null)], { resume: "fresh", session: null }).tokens).toBe(7);
    expect(roundTokens([att(null)], { resume: "fresh", session: null })).toEqual({ tokens: null, raw: null });
    expect(lastRawTokens({ n: 1, at: "", attempts: [att(5), att(9), att(null)] })).toBe(9);
    expect(lastRawTokens(undefined)).toBeNull();
  });

  it("elapsed time includes backoff; the total only adds rounds with a number", () => {
    expect(roundElapsed([att(1), att(1, "round", { elapsedMs: 50, backoffMs: 2000 })])).toBe(2150);
    expect(totalTokens(rec)).toBe(15);
    expect(totalTokens({ ...rec, rounds: [] })).toBeNull();
  });

  it("normalized arguments: prompt, temporary answer file and pre-generated session id become placeholders, the rest stays", () => {
    expect(normalizeArgs(["exec", "-o", "/r/.a.txt", "-c", "x", "PROMPT", "--session-id", "uuid-1", "--x=uuid-1"], { prompt: "PROMPT", outFile: "/r/.a.txt", newSession: "uuid-1" }))
      .toEqual(["exec", "-o", "<outFile>", "-c", "x", "<prompt>", "--session-id", "<newSession>", "--x=<newSession>"]);
  });
});
