/**
 * Stop a process and everything it started (macOS and Linux; Windows uses `taskkill /T`, see delegate/process.ts).
 *
 * Agent CLIs start shell tools in their own process groups, so killing the CLI alone leaves children running. Freeze
 * the tree first (SIGSTOP the group and every descendant found through `ps`, repeating until the set stops growing),
 * then SIGKILL it from the leaves up. The final signals' return codes are not trusted: macOS answers EPERM for a
 * process that has already become a zombie. Instead, `ps` must show no live member of the tree afterwards.
 */
import { spawnSync } from "node:child_process";

const NOT_STOPPED = "could not confirm that the agent's child processes stopped; check running processes before retrying";

interface Row {
  pid: number;
  ppid: number;
  zombie: boolean;
}

function listProcesses(): Row[] {
  const result = spawnSync("/bin/ps", ["-axo", "pid=,ppid=,stat="], { encoding: "utf8", timeout: 4000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error("could not list processes; check running processes before retrying");
  return result.stdout.trim().split("\n").map((line) => {
    const [pid, ppid, stat = ""] = line.trim().split(/\s+/);
    return { pid: Number(pid), ppid: Number(ppid), zombie: stat.startsWith("Z") };
  });
}

const pause = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** Returns undefined when the whole tree is gone, otherwise a message for the person. */
export function stopTree(pid: number): string | undefined {
  const known = new Set([pid]);
  let error: string | undefined;
  const send = (target: number, signal: NodeJS.Signals): void => {
    try {
      process.kill(target, signal);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ESRCH" && code !== "EPERM") error = NOT_STOPPED;
    }
  };
  send(-pid, "SIGSTOP");
  send(pid, "SIGSTOP");
  try {
    for (let pass = 0; pass < 4; pass++) {
      const rows = listProcesses();
      const before = known.size;
      let added: boolean;
      do {
        added = false;
        for (const { pid: child, ppid } of rows) {
          if (known.has(ppid) && !known.has(child)) {
            known.add(child);
            send(child, "SIGSTOP");
            added = true;
          }
        }
      } while (added);
      if (known.size === before) break;
      if (pass === 3) throw new Error("the agent's child processes kept changing; check running processes before retrying");
    }
  } catch (e) {
    error = (e as Error).message;
  } finally {
    for (const member of [...known].reverse()) send(member, "SIGKILL");
    send(-pid, "SIGKILL");
  }
  if (error) return error;
  try {
    // SIGKILL takes a moment to land: look up to five times, 50 ms apart.
    for (let attempt = 0; attempt < 5; attempt++) {
      if (!listProcesses().some((p) => known.has(p.pid) && !p.zombie)) return undefined;
      pause(50);
    }
  } catch (e) {
    return (e as Error).message;
  }
  return NOT_STOPPED;
}
