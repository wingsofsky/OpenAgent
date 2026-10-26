// The project queue of folder tasks (folder/queue.ts): yielding to the IDE, resuming, and never recording an
// interrupted project as done.
import { expect, it } from "vitest";
import { runProjectQueue } from "../src/queue.ts";

const project = (name: string) => ({ rel: name, cwd: `/tmp/${name}` });
type Result = { ok: boolean; transcriptRel?: string };

it("waits for an open project, works on the others, and resumes it with the previous attempt", async () => {
  let open = false;
  let first = true;
  const order: string[] = [];
  const done: string[] = [];
  const states: string[] = [];
  const results = await runProjectQueue<{ rel: string; cwd: string }, Result>({
    projects: [project("a"), project("b")],
    signal: new AbortController().signal,
    intervalMs: 1,
    observe: async () => ({ state: "ready", projects: open ? ["/tmp/a"] : [] }),
    onState: (s) => states.push(s.message),
    onComplete: (p) => {
      done.push(p.rel);
    },
    execute: async (p, signal, previous) => {
      order.push(p.rel);
      if (p.rel === "a" && first) {
        first = false;
        open = true;
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        return { ok: false, transcriptRel: "interrupted.md" };
      }
      if (p.rel === "b") {
        expect(previous).toBeUndefined();
        open = false;
      } else expect(previous).toEqual({ ok: false, transcriptRel: "interrupted.md" });
      return { ok: true };
    },
  });
  expect(order).toEqual(["a", "b", "a"]);
  expect(done).toEqual(["b", "a"]);
  expect(results.every((r) => r.result.ok)).toBe(true);
  expect(states.join()).toContain("Yielding a to the IDE");
});

it("is cancelled while waiting without starting anything or recording completion", async () => {
  const stop = new AbortController();
  let calls = 0;
  await expect(
    runProjectQueue<{ rel: string; cwd: string }, Result>({
      projects: [project("a")],
      signal: stop.signal,
      intervalMs: 1,
      observe: async () => ({ state: "unknown", projects: [], message: "unknown" }),
      onState: () => stop.abort(),
      execute: async () => {
        calls++;
        return { ok: true };
      },
      onComplete: () => {
        calls++;
      },
    }),
  ).rejects.toThrow();
  expect(calls).toBe(0);
});

it("looks again before recording success and never records an interrupted project as done", async () => {
  const stop = new AbortController();
  let open = false;
  let completed = false;
  await expect(
    runProjectQueue<{ rel: string; cwd: string }, Result>({
      projects: [project("a")],
      signal: stop.signal,
      intervalMs: 1,
      observe: async () => ({ state: "ready", projects: open ? ["/tmp/a"] : [] }),
      onState: (s) => {
        if (s.phase === "waiting") stop.abort();
      },
      execute: async () => {
        open = true;
        return { ok: true };
      },
      onComplete: () => {
        completed = true;
      },
    }),
  ).rejects.toThrow();
  expect(completed).toBe(false);
});

it("an observation that throws counts as unknown, which blocks", async () => {
  const stop = new AbortController();
  const states: string[] = [];
  await expect(
    runProjectQueue<{ rel: string; cwd: string }, Result>({
      projects: [project("a")],
      signal: stop.signal,
      intervalMs: 1,
      observe: async () => {
        throw new Error("lsof failed");
      },
      onState: (s) => {
        states.push(s.message);
        stop.abort();
      },
      execute: async () => ({ ok: true }),
      onComplete: () => {},
    }),
  ).rejects.toThrow();
  expect(states[0]).toMatch(/Cannot tell which projects the IDE has open/);
});

it("one look that cannot tell does not stop a running project; two in a row do", async () => {
  const run = async (looks: Array<"ready" | "unknown">) => {
    let i = 0;
    let stopped = false;
    const results = await runProjectQueue<{ rel: string; cwd: string }, Result>({
      projects: [project("a")],
      signal: new AbortController().signal,
      intervalMs: 5,
      observe: async () => ({ state: looks[Math.min(i++, looks.length - 1)], projects: [] }),
      onState: () => {},
      onComplete: () => {},
      execute: async (_p, signal, previous) => {
        if (previous) return { ok: true };
        await new Promise((resolve) => setTimeout(resolve, 80));
        stopped = signal.aborted;
        return { ok: !stopped };
      },
    });
    return { stopped, results };
  };
  // before the run, one unsure look during it, then clear again
  expect((await run(["ready", "unknown", "ready"])).stopped).toBe(false);
  // two unsure looks in a row stop it; it runs again once the IDE can be read
  const twice = await run(["ready", "unknown", "unknown", "ready"]);
  expect(twice.stopped).toBe(true);
  expect(twice.results.map((r) => r.result.ok)).toEqual([true]);
});

it("when the looks after a finished run cannot tell, the queue waits until they can instead of running it again", async () => {
  const looks: Array<"ready" | "unknown"> = ["ready", "unknown", "unknown", "unknown", "ready"];
  let i = 0;
  let runs = 0;
  const done: string[] = [];
  const states: string[] = [];
  await runProjectQueue<{ rel: string; cwd: string }, Result>({
    projects: [project("a")],
    signal: new AbortController().signal,
    intervalMs: 1,
    observe: async () => ({ state: looks[Math.min(i++, looks.length - 1)], projects: [], message: "cannot tell" }),
    onState: (s) => states.push(s.message),
    onComplete: (p) => {
      done.push(p.rel);
    },
    execute: async () => {
      runs++;
      return { ok: true };
    },
  });
  expect(runs).toBe(1);
  expect(done).toEqual(["a"]);
  expect(states).toContain("a finished; it is recorded as done once the IDE can be read. cannot tell");
});

it("stopped while it waits after a finished run, the project is not recorded as done", async () => {
  const abort = new AbortController();
  const done: string[] = [];
  let looks = 0;
  await expect(
    runProjectQueue<{ rel: string; cwd: string }, Result>({
      projects: [project("a")],
      signal: abort.signal,
      intervalMs: 1,
      observe: async () => (looks++ === 0 ? { state: "ready", projects: [] } : { state: "unknown", projects: [], message: "cannot tell" }),
      onState: (s) => {
        if (s.message.startsWith("a finished")) abort.abort();
      },
      onComplete: (p) => {
        done.push(p.rel);
      },
      execute: async () => ({ ok: true }),
    }),
  ).rejects.toThrow();
  expect(done).toEqual([]);
});

it("asks about every queued project before choosing one, and only about the running one while it runs", async () => {
  let running: string | null = null;
  const asked: Array<{ running: string | null; cwds: string[] }> = [];
  await runProjectQueue<{ rel: string; cwd: string }, Result>({
    projects: [project("a"), project("b")],
    signal: new AbortController().signal,
    intervalMs: 5,
    observe: async (cwds) => {
      asked.push({ running, cwds });
      return { state: "ready", projects: [] };
    },
    onState: () => {},
    onComplete: () => {},
    execute: async (p) => {
      running = p.cwd;
      await new Promise((resolve) => setTimeout(resolve, 40));
      running = null;
      return { ok: true };
    },
  });
  expect(asked[0]).toEqual({ running: null, cwds: ["/tmp/a", "/tmp/b"] });
  const during = asked.filter((a) => a.running);
  expect(during.length).toBeGreaterThan(0);
  expect(during.every((a) => a.cwds.length === 1 && a.cwds[0] === a.running)).toBe(true);
});
