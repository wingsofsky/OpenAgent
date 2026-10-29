/**
 * Default brief of folder tasks: one CLI works through a folder of projects with a saved brief, kept in
 * `folder/brief/` of the Longkeep home folder (HOME_LAYOUT.folderBrief; file names in BRIEF_FILES).
 *
 * When the brief does not exist yet, the CLI writes these defaults. Both start with DRAFT_MARKER on its own first line:
 * the runtime refuses to run a brief that still contains the marker, so a person has to read and edit the brief (and
 * delete the line) before any agent works unattended on their folders. The marker is an HTML comment, invisible when
 * the Markdown is rendered.
 *
 */
import { BRIEF_FILES } from "./layout.ts";

export const DRAFT_MARKER = "<!-- longkeep:draft — edit this brief, then delete this line -->";

type BriefFile = (typeof BRIEF_FILES)[keyof typeof BRIEF_FILES];

const TASK = `${DRAFT_MARKER}
# Folder task

Explore the sub-projects inside the given working folder on your own: read each project's documentation, task notes, code and tests, and work out where it stands.
Pick unfinished work, defects or to-dos that have clear grounds and can be verified, change the projects concerned directly, and verify the result.
Do not wait for me to name a feature; first summarize what you found and why you chose it, then start implementing.
If the projects are independent of each other, handle them one by one; for a project without a clear to-do, describe its state and do not invent features.

## Done means
- Follow the ${BRIEF_FILES.rules} provided by Longkeep, and each project's own contract and conventions.
- Actually run the tests and builds related to the change; never report a guess as verified.
- Report what you found, why you chose it, the files you changed, the verification results and what is left undone.
`;

const RULES = `${DRAFT_MARKER}
# Rules

- Before starting, read AGENTS.md, CLAUDE.md, the README, task notes and the relevant code of the target project, and follow the conventions that apply.
- Keep the existing stack and code style; check the working tree first and keep any uncommitted changes.
- Only change the projects inside the given working folder that the task concerns; do not change this run's ${BRIEF_FILES.task} or ${BRIEF_FILES.rules}.
- Change code directly; never write CriticMarkup review marks into source code.
- Each sub-project has its own Git: never create, delete or modify .git, and do not run git init/add/commit/reset/checkout/clean or similar commands. For read-only checks use git --no-optional-locks status.
- In a sub-project, change only the source, tests and necessary configuration the task needs; do not add plans, development notes, reports, logs, snapshots or CLI metadata. Output those records directly: Longkeep archives them in this run's record folder in the Longkeep home folder.
- Test reports, temporary build output and project caches must also be directed, through command-line arguments, to this run's record folder provided by the runner; do not change a sub-project's configuration for that.
- Do not delete unrelated files, do not overwrite other people's changes, do not read or print credentials.
- Do not commit, push, deploy or publish on your own; do not buy services.
- When credentials are missing, requirements conflict, or a person has to decide, record why you are blocked and continue with the work that is not blocked.
- At the end, list every verification you actually ran and its result, keeping what is done, what is not verified and what is not done clearly apart.
`;

/** Default contents of the saved brief, keyed by file name */
export const BRIEF_DEFAULTS: Readonly<Record<BriefFile, string>> = {
  [BRIEF_FILES.task]: TASK,
  [BRIEF_FILES.rules]: RULES,
};
