/**
 * The transcript (`transcript.md`): a header, then one section per round with the command, how it resumed, the working
 * folder and snapshot, attempts, exit, changes (from the fingerprints), outcome, session, usage, the
 * prompt, the answer, raw stdout (capped at 64 KB), the stderr tail and, for git working folders, the uncommitted
 * changes. lastRoundOf reads the previous round back for replay; CRLF transcripts are read the same way.
 */
import { OUTCOME_LABEL, type TaskOutcome } from "@longkeep/protocol/task";
import type { ResumeMode } from "@longkeep/protocol/runs";
import type { ExecutorSpec } from "../executors/registry.ts";
import { DELEGATION_FOLLOW_UP_HEADING, DELEGATION_TASK_HEADING } from "@longkeep/protocol/delegation-prompt";
import { TRANSCRIPT_CAP, fence } from "./process.ts";
import { RESUME_LABEL } from "./prompt.ts";
import type { RootState } from "./work-root.ts";

export interface RoundRecord {
  round: number;
  created: string;
  command: string;
  attempts: number;
  elapsedMs: number;
  exitCode: number | null;
  timedOut: boolean;
  stalled: boolean;
  session: string | null;
  usage: number | null;
  prompt: string;
  answer: string;
  stdout: string;
  stderrTail: string;
  error?: string;
  resumeMode: ResumeMode;
  workRoot: string;
  /** Snapshot id, or a note why there is none (null when the working folder is the scratch folder) */
  snapshot: string | null;
  outcome: TaskOutcome;
  before: RootState | null;
  after: RootState | null;
}

const shortHead = (h: string | null | undefined): string => (h ? h.slice(0, 7) : "none");

/** The "changes:" line: whether the fingerprints differ; a git working folder also shows HEAD and uncommitted entries */
function changeLine(before: RootState | null, after: RootState | null): string {
  if (!before || !after) return "changes: not checked (no fingerprint of the working folder)";
  const verdict = before.hash === after.hash ? "none" : "yes";
  if (after.kind === "git") return `changes: ${verdict} (HEAD ${shortHead(before.head)} -> ${shortHead(after.head)}; ${after.count} uncommitted, ${before.count} before the round)`;
  return `changes: ${verdict} (${after.count} files, ${before.count} before the round)`;
}

export function roundMarkdown(r: RoundRecord): string {
  const out = r.stdout.length > TRANSCRIPT_CAP ? r.stdout.slice(0, TRANSCRIPT_CAP) + "\n... (stdout over 64 KB, cut)" : r.stdout;
  const f1 = fence(out);
  const f2 = fence(r.stderrTail);
  const dirty = r.after?.dirty.join("\n") ?? "";
  const f3 = fence(dirty);
  return [
    `## Round ${r.round} (${r.created})`,
    "",
    `command: ${r.command}`,
    `resume: ${RESUME_LABEL[r.resumeMode]}`,
    `working folder: ${r.workRoot}`,
    ...(r.snapshot ? [`snapshot: ${r.snapshot}`] : []),
    `attempts: ${r.attempts}`,
    `elapsed: ${(r.elapsedMs / 1000).toFixed(1)}s`,
    `exit code: ${r.exitCode ?? "none"}${r.timedOut ? " (killed after the timeout)" : r.stalled ? " (killed after no output)" : ""}`,
    changeLine(r.before, r.after),
    `outcome: ${OUTCOME_LABEL[r.outcome] ?? r.outcome}`,
    ...(r.session ? [`session: ${r.session}`] : []),
    ...(r.usage !== null ? [`usage: ${r.usage} tokens`] : []),
    ...(r.error ? [`error: ${r.error}`] : []),
    "",
    "### Prompt",
    "",
    r.prompt,
    "",
    "### Answer",
    "",
    r.answer || "(none)",
    "",
    "### Raw output (stdout)",
    "",
    `${f1}text`,
    out,
    f1,
    "",
    "### stderr (tail)",
    "",
    `${f2}text`,
    r.stderrTail,
    f2,
    "",
    ...(dirty ? ["### Uncommitted changes in the working folder (git status after the round, at most 50 lines)", "", `${f3}text`, dirty, f3, ""] : []),
  ].join("\n");
}

export function transcriptHeader(x: { title: string; spec: ExecutorSpec; issuer: string; created: string; project: string; target?: string }): string {
  return [
    `# Delegation: ${x.title}`,
    "",
    `executor: ${x.spec.name} (${x.spec.label})`,
    `issuer: ${x.issuer}`,
    `issued: ${x.created}`,
    `project: ${x.project}`,
    ...(x.target ? [`target: ${x.target}`] : []),
    "",
    "---",
    "",
  ].join("\n");
}

export function describeCommand(bin: string, args: string[], prompt: string): string {
  return [bin, ...args.map((a) => (a === prompt ? `<prompt, ${prompt.length} chars>` : /\s/.test(a) ? JSON.stringify(a) : a))].join(" ");
}

/** The prompt and answer of the last round in a transcript (replayed for executors that cannot resume) */
export function lastRoundOf(transcript: string): { prompt: string; answer: string } | null {
  const rounds = transcript.replace(/\r\n/g, "\n").split(/\n## Round \d+ /);
  if (rounds.length < 2) return null;
  const last = rounds[rounds.length - 1];
  const p = /### Prompt\n\n([\s\S]*?)\n\n### Answer\n\n([\s\S]*?)\n\n### Raw output/.exec(last);
  if (!p) return null;
  const rawPrompt = p[1];
  // The task itself follows the task heading or the follow-up heading
  const idx = Math.max(rawPrompt.lastIndexOf(`\n${DELEGATION_TASK_HEADING}\n`), rawPrompt.lastIndexOf(`\n${DELEGATION_FOLLOW_UP_HEADING}\n`));
  const prompt = idx === -1 ? rawPrompt : rawPrompt.slice(rawPrompt.indexOf("\n", idx + 1) + 1);
  return { prompt: prompt.trim(), answer: p[2].trim() };
}
