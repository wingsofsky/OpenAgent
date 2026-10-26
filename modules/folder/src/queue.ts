/**
 * The project queue of a folder task: one project after another, never two agent CLIs at once.
 *
 * - `observe` is asked about the queued projects before each project, and only about the running one every `intervalMs`
 *   while it runs. Without IDE yielding it always says "nothing open", and the projects simply run in order.
 * - A project the IDE has open (or an unknown state) is passed over for now and the next free one runs; when none is
 *   free, the queue waits. A running project that the IDE opens is stopped (its signal aborts) and goes back to the end
 *   of the queue; when it runs again, `execute` gets the stopped attempt as `previous`, so the prompt can say it is a
 *   new run after a pause. While a project runs, "cannot tell" stops it only when it repeats: one failed look (the IDE
 *   quitting between `ps` and `lsof`) does not kill a long run.
 * - A run that finished while the IDE held its project counts as interrupted too: a project is only recorded as done
 *   when the IDE does not hold it at that moment. When that last look cannot tell, the queue waits until it can rather
 *   than run a finished project a second time, and says so: stopped during that wait, the project stays not done.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { blocksProject, type IdeObservation } from "./ide.ts";

export interface QueueProject {
  /** Relative to the folder ("" for the folder itself) */
  rel: string;
  /** Absolute working folder */
  cwd: string;
}

export interface QueueState {
  phase: "waiting" | "running";
  message: string;
}

export async function runProjectQueue<P extends QueueProject, R extends { ok: boolean }>(x: {
  projects: P[];
  signal: AbortSignal;
  observe: (cwds: string[]) => Promise<IdeObservation>;
  execute: (project: P, signal: AbortSignal, previous: R | undefined) => Promise<R>;
  onComplete: (project: P) => void | Promise<void>;
  onState: (state: QueueState) => void;
  intervalMs?: number;
}): Promise<Array<{ project: P; result: R }>> {
  const intervalMs = x.intervalMs ?? 10_000;
  const queue: Array<{ project: P; previous: R | undefined }> = x.projects.map((project) => ({ project, previous: undefined }));
  const results: Array<{ project: P; result: R }> = [];
  let last = "";
  const state = (phase: QueueState["phase"], message: string) => {
    const key = `${phase}:${message}`;
    if (key === last) return;
    last = key;
    x.onState({ phase, message });
  };
  const observation = async (cwds: string[]): Promise<IdeObservation> => {
    try {
      return await x.observe(cwds);
    } catch {
      return { state: "unknown", projects: [], message: "Cannot tell which projects the IDE has open; waiting." };
    }
  };
  while (queue.length) {
    x.signal.throwIfAborted();
    const seen = await observation(queue.map((item) => item.project.cwd));
    x.signal.throwIfAborted();
    const index = queue.findIndex((item) => !blocksProject(seen, item.project.cwd));
    if (index < 0) {
      state("waiting", seen.state === "ready" ? `Waiting for the IDE to close: ${queue.map((item) => item.project.rel || ".").join(", ")}` : (seen.message ?? "Waiting for the IDE."));
      await sleep(intervalMs, undefined, { signal: x.signal });
      continue;
    }
    const item = queue.splice(index, 1)[0];
    const attempt = new AbortController();
    const watch = new AbortController();
    const label = item.project.rel || ".";
    let interrupted = false;
    state("running", `${item.previous ? "Reading the changes and continuing" : "Working on"}: ${label}`);
    const monitor = (async () => {
      let unsure = 0;
      try {
        for (;;) {
          await sleep(intervalMs, undefined, { signal: watch.signal });
          const current = await observation([item.project.cwd]);
          if (watch.signal.aborted) return;
          unsure = current.state === "ready" ? 0 : unsure + 1;
          if ((current.state === "ready" && blocksProject(current, item.project.cwd)) || unsure >= 2) {
            interrupted = true;
            state("running", `Yielding ${label} to the IDE and stopping the agent`);
            attempt.abort(new Error("the IDE opened this project (or its state is unknown); this run yielded"));
            return;
          }
        }
      } catch (e) {
        if (!watch.signal.aborted) throw e;
      }
    })();
    let result: R;
    try {
      result = await x.execute(item.project, AbortSignal.any([x.signal, attempt.signal]), item.previous);
    } finally {
      watch.abort();
      await monitor;
    }
    x.signal.throwIfAborted();
    // A quick CLI can finish between two looks: never record it as done while the IDE holds the project.
    let after = await observation([item.project.cwd]);
    while (!interrupted && after.state !== "ready") {
      state("waiting", `${label} finished; it is recorded as done once the IDE can be read. ${after.message ?? ""}`.trim());
      await sleep(intervalMs, undefined, { signal: x.signal });
      after = await observation([item.project.cwd]);
    }
    if (interrupted || blocksProject(after, item.project.cwd)) {
      item.previous = result;
      queue.push(item);
      continue;
    }
    if (result.ok) await x.onComplete(item.project);
    results.push({ project: item.project, result });
  }
  return results;
}
