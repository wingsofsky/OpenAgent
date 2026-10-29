/**
 * Where Longkeep keeps things. Every record and all configuration live in the Longkeep home folder;
 * nothing is written into a user's project unless they ask for it, and nothing in a project configures Longkeep. The
 * home folder is `~/.longkeep` and moves with LONGKEEP_HOME (resolved by the CLI: this package does no IO).
 *
 * These names are file-format data, not labels: renaming one is a format change and needs a migration step.
 * All paths use forward slashes and are relative to the folder named in the comment above each table.
 */

export const HOME_ENV = "LONGKEEP_HOME";
/** Name of the home folder under the user's home directory. */
export const LONGKEEP_DIR = ".longkeep";

/** Relative to the home folder. */
export const HOME_LAYOUT = {
  handbook: "handbook.md",
  importedSessions: "sessions/imported",
  runs: "runs",
  folderBrief: "folder/brief",
  snapshots: "snapshots",
  executors: "executors.json",
} as const;

/** Files of one record, relative to `runs/<project-key>/<task>/`. */
export const RUN_FILES = {
  task: "task.md",
  transcript: "transcript.md",
  run: "run.json",
  output: "output.log",
} as const;

/** The saved brief of folder tasks, relative to `folder/brief/`. */
export const BRIEF_FILES = {
  task: "task.md",
  rules: "rules.md",
} as const;
