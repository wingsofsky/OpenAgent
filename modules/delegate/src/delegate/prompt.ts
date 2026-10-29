/**
 * The prompt sent to an executor: a preamble (role, working folder, record folder, rules) and the task.
 *
 * - The first line is always DELEGATION_PROMPT_FIRST_LINE, and the brief sits under DELEGATION_TASK_HEADING (first
 *   round) or DELEGATION_FOLLOW_UP_HEADING (later rounds): the session importer recognises delegated sessions by them
 *   (@longkeep/protocol/delegation-prompt).
 * - The working folder is the executor's actual cwd / -C, decided once by prepare.ts. In the scratch folder the agent
 *   may only change that folder. When the working folder is the project or a declared folder, it changes code, builds
 *   and tests there, and the record folder (in the Longkeep home folder) gets the transcript and any separate report;
 *   nothing of the record goes into the working folder. Folder tasks use stricter wording: every record and build
 *   product goes to the record folder, never into a sub-project.
 * - From round 2 on, every round carries the original brief and the rulings of the earlier rounds (from run.json, never
 *   scraped from the transcript); when the session cannot be resumed natively, the previous answer is replayed too.
 */
import type { ResumeMode } from "@longkeep/protocol/runs";
import type { ExecutorSpec } from "../executors/registry.ts";
import { DELEGATION_FOLLOW_UP_HEADING, DELEGATION_PROMPT_FIRST_LINE, DELEGATION_TASK_HEADING } from "@longkeep/protocol/delegation-prompt";

export const RESUME_LABEL: Record<ResumeMode, string> = { fresh: "first round", native: "native resume", replay: "replay of the previous answer" };

export function composePrompt(x: {
  spec: ExecutorSpec;
  /** This round's task (the brief in the first round) */
  prompt: string;
  /** Working folder */
  cwd: string;
  targetRel?: string;
  targetAbs?: string;
  /** Record folder, given when the working folder is not the record's scratch folder */
  recordDir?: string;
  /** Folder task: stricter wording */
  folder?: boolean;
  /** Follow-up rounds: round number, original brief, rulings of earlier rounds, where the full transcript is */
  round?: number;
  brief?: string;
  rulings?: Array<{ round: number; text: string }>;
  transcriptAbs?: string;
  /** Replay: the previous answer (when the session cannot be resumed natively) */
  previousAnswer?: string;
}): string {
  const lines = [DELEGATION_PROMPT_FIRST_LINE, `Executor: ${x.spec.label}.`];
  if (!x.recordDir) lines.push(`Working folder: ${x.cwd}. Create or change files only inside this folder; do not change anything elsewhere.`);
  else if (x.folder) lines.push(`Working folder: ${x.cwd}. Source changes stay inside this folder; records and build output may only be written to the record folder below.`);
  else lines.push(`Working folder: ${x.cwd}. Change code, build and run tests here; do not change files outside this folder.`);
  if (x.targetRel && x.targetAbs) lines.push(`Target document (read only; ${x.targetRel} in the project): ${x.targetAbs}`);
  if (x.recordDir && x.folder)
    lines.push(
      `Record and build output folder for this run: ${x.recordDir}. Every development record, test report, temporary build product and project cache must go to this folder, never into a sub-project. Do not change project configuration to redirect these paths; use the build tools' command-line options or a temporary configuration kept in this record folder.`,
    );
  else if (x.recordDir)
    lines.push(`Record folder for this run: ${x.recordDir}. Longkeep writes the transcript and output log there; a report you want to keep separately goes there too, not into the working folder.`);
  lines.push("When you are done, give your final answer in the language of the task; if you cite sources, include links or references.");
  const round = x.round ?? 1;
  if (round <= 1) {
    lines.push("", DELEGATION_TASK_HEADING, x.prompt);
    return lines.join("\n");
  }
  lines.push(
    `This is round ${round} of the same task: the original brief and the rulings of earlier rounds still apply; where they conflict with this round's task, this round wins.${x.transcriptAbs ? ` The full record of earlier rounds is in ${x.transcriptAbs}.` : ""}`,
  );
  if (x.brief) lines.push("", "Original brief:", x.brief);
  for (const r of x.rulings ?? []) lines.push("", `Ruling of round ${r.round}:`, r.text);
  if (x.previousAnswer !== undefined) lines.push("", "Your previous answer:", x.previousAnswer || "(none)");
  lines.push("", DELEGATION_FOLLOW_UP_HEADING, x.prompt);
  return lines.join("\n");
}

/** Rounds that actually ran according to the transcript (failed rounds count too) */
export function countRounds(transcript: string): number {
  return (transcript.replace(/\r\n/g, "\n").match(/^## Round \d+ \(/gm) ?? []).length;
}
