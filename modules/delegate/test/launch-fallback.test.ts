// Launch fallback of folder tasks: only a provable non-start advances to the next executor.
import { expect, it } from "vitest";
import { ExecutorStartupError, LAUNCH_CHECK_MS, launchFallback, neverStarted } from "../src/delegate/launch-fallback.ts";

interface Outcome {
  ok: boolean;
  startupFailure?: string;
  stopError?: string;
  error?: string;
  exitCode?: number;
  timedOut?: boolean;
  stalled?: boolean;
  answer?: string;
}
const candidates = [{ executor: "grok" }, { executor: "cursor", model: "grok-4.7-high" }, { executor: "claude" }];
const base = () => ({ candidates, signal: new AbortController().signal, onState: () => {}, delayMs: 25 });

it("waits after a proven non-start, advances once in order, and keeps five minutes in production", async () => {
  expect(LAUNCH_CHECK_MS).toBe(300000);
  const calls: string[] = [];
  const starts: number[] = [];
  const result = await launchFallback<{ executor: string }, Outcome>({
    ...base(),
    execute: async (c) => {
      calls.push(c.executor);
      starts.push(performance.now());
      if (c.executor === "grok") throw new ExecutorStartupError("not installed");
      if (c.executor === "cursor") return { ok: false, startupFailure: "EACCES", error: "not executable" };
      return { ok: true };
    },
  });
  expect(result.ok).toBe(true);
  expect(calls).toEqual(["grok", "cursor", "claude"]);
  expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(23);
  expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(23);
});

it.each<Outcome>([
  { ok: true },
  { ok: true, startupFailure: "ENOENT" },
  { ok: false, error: "spawn ENOENT / failed to start / login required", exitCode: 1 },
  { ok: false, timedOut: true },
  { ok: false, stalled: true },
  { ok: false, answer: "" },
  { ok: false, startupFailure: "ENOENT", stopError: "cannot confirm stop" },
])("does not replace completed, runtime, uncertain or unconfirmed-stop outcomes: %j", async (outcome) => {
  let calls = 0;
  expect(
    await launchFallback({
      ...base(),
      execute: async () => {
        calls++;
        return outcome;
      },
    }),
  ).toEqual(outcome);
  expect(calls).toBe(1);
});

it("never races a silent live process after the check interval", async () => {
  let calls = 0;
  const result = await launchFallback({
    ...base(),
    delayMs: 1,
    execute: async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 35));
      return { ok: true };
    },
  });
  expect(result.ok).toBe(true);
  expect(calls).toBe(1);
});

it("does not classify preflight / config / path errors by their message", async () => {
  let calls = 0;
  await expect(
    launchFallback({
      ...base(),
      execute: async () => {
        calls++;
        throw new Error("ENOENT failed to launch");
      },
    }),
  ).rejects.toThrow("ENOENT");
  expect(calls).toBe(1);
});

it("cancels a pending replacement without launching the next CLI", async () => {
  const stop = new AbortController();
  let calls = 0;
  await expect(
    launchFallback({
      ...base(),
      signal: stop.signal,
      onState: () => stop.abort(),
      execute: async (): Promise<Outcome> => {
        calls++;
        throw new ExecutorStartupError("missing");
      },
    }),
  ).rejects.toThrow();
  expect(calls).toBe(1);
});

it("exhausts the chain without restarting a previous executor", async () => {
  let calls = 0;
  await expect(
    launchFallback({
      ...base(),
      delayMs: 1,
      execute: async (): Promise<Outcome> => {
        calls++;
        throw new ExecutorStartupError("missing");
      },
    }),
  ).rejects.toThrow("none of the fallback executors could start");
  expect(calls).toBe(3);
});

it("one test of a non-start, shared with folder tasks: an OS startup code before any process, nothing else", () => {
  expect(neverStarted({ thrown: new ExecutorStartupError("not installed") })).toBe(true);
  expect(neverStarted({ thrown: new ExecutorStartupError("odd", "EBUSY") })).toBe(false);
  expect(neverStarted({ thrown: new Error("ENOENT failed to launch") })).toBe(false);
  expect(neverStarted({ result: { ok: false, startupFailure: "ENOENT" } })).toBe(true);
  expect(neverStarted({ result: { ok: false, startupFailure: "ENOENT", stopError: "still running" } })).toBe(false);
  expect(neverStarted({ result: { ok: false, startupFailure: "EBUSY" } })).toBe(false);
  expect(neverStarted({ result: { ok: true, startupFailure: "ENOENT" } })).toBe(false);
});
