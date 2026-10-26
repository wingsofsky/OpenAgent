/**
 * Delegation runner: a main agent (Claude Code through the MCP server, or a person with `openagent delegate`) hands a
 * subtask to another agent CLI on this machine, which runs headless: codex, agy, grok, cursor, claude, or a custom
 * executor declared in executors.json (executors/registry.ts).
 *
 * Contract (plain text, readable with cat; formats from @openagent/protocol):
 *  - One delegation = one record folder `<home>/runs/<projectKey(project)>/<task-id>/` (HOME_LAYOUT / RUN_FILES):
 *    task.md (task.ts: executor, status, outcome, acceptance, usage, session, snapshot, writeback), transcript.md,
 *    run.json, output.log, the claim lock `claim.lock`, and `work/` when the task works in scratch. The
 *    task id is protocol `taskId(title, now)`, made unique within the project's runs folder. Nothing is written into the
 *    project except by the executor working there or a writeback the request asked for. Every path under the home
 *    folder and the project goes through common/scoped.
 *  - A request names a project folder (common/home resolveProject refuses the filesystem root, the user's home directory
 *    and the OpenAgent home folder). `target` and `writeback` are checked before anything is created: target is
 *    project-relative and must exist; writeback is `handbook` (the effective handbook) or a project-relative document
 *    that exists.
 *  - The working folder (spawn cwd = {cwd} in templates = the folder named in the prompt) is decided once, in the first
 *    round, and kept for later rounds: the record's `work/` (`work: "scratch"`, default), the project itself
 *    (`work: "project"`), or a `workRoot` declared in executors.json (or a -C / --workspace hard-coded in its template;
 *    checked like a project, never inside or around the home folder). A folder task works in its folder. When the
 *    working folder is not scratch, a snapshot (snapshots/shadow.ts) is taken before every round and recorded in that
 *    round of run.json and in the task header; without git the round runs without one and the transcript says so.
 *  - Status: in_progress → done (with a completion summary); a failure goes back to pending with an "Execution failed"
 *    section, ready to be delegated again. Follow-up rounds append "## Round N" to the same task and transcript.
 *  - Outcome and acceptance are separate: each round writes `outcome` from facts OpenAgent checks itself (fingerprints of the
 *    working folder before and after differ = changed, equal = no_changes, none = unchecked; failures write their
 *    class). A normal exit only writes `acceptance: pending`; accepted / needs_rework / rejected come from
 *    reviewDelegation. done only means the run ended.
 *  - The run record (protocol/runs.ts): the plan (first brief, working folder, record folder, channel), one Round
 *    per round (executor, model, effort, sandbox, timeouts, normalized-argument hash, resume mode, snapshot, outcome,
 *    acceptance) and one Attempt per launch (exit class, exit code, backoff, raw usage and scope). Time includes backoff;
 *    cumulative usage takes the difference to the previous round.
 *  - Follow-up rounds: every prompt is built from run.json (the first brief and each round's ruling); a CLI that
 *    can resume natively resumes its session, otherwise the previous answer is replayed. Folder tasks have no
 *    follow-up rounds.
 *  - The claim lock is created exclusively and always removed when the round ends, also when the runner itself fails.
 *    It records pid and host: a lock whose process is gone on this machine is stale and reclaimed by the next claim.
 *  - Launching (delegate/process.ts): stdin always closed; timeout and stall kill the whole tree; only non-zero exits
 *    are retried, and rounds that may write (prompts skipped or a writable sandbox) are not retried by default; .cmd / .bat
 *    shims are refused; single files are deleted with unlinkSync. The executor runs with the user's permissions in the
 *    working folder, the same as running the CLI by hand; codex keeps its own sandbox (default workspace-write).
 *  - Writeback: after a successful round the answer is appended to the writeback document as a signed CriticMarkup
 *    insertion (handbook/handbook.ts appendSuggestion) for a person to accept or reject.
 */
export { prepareDelegation, runDelegation } from "./prepare.ts";
export { delegationStatus, listDelegations, reviewDelegation, VERDICTS } from "./review.ts";
export { listExecutors, loadExecutors, updateExecutorDefaults } from "../executors/registry.ts";
export type { DelegationRequest, DelegationResult, PreparedDelegation, RecordPaths, WorkMode } from "./types.ts";
