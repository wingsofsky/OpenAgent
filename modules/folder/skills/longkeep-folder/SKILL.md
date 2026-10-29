---
name: longkeep-folder
description: Run one agent CLI on a folder of repositories, unattended, with a brief the user saved once (folder tasks, built on Longkeep delegation). Use when the user says "run the folder task on <folder>", "work through these repositories overnight", "edit the folder-task brief", or asks to install the folder module.
---

# Longkeep folder tasks

A folder task runs one CLI on a folder, unattended, with a brief the user saved once: `~/.longkeep/folder/brief/task.md` (what to do) and `rules.md` (how). Typical use: a parent folder of repositories, and a brief that says "look at each project, pick well-founded unfinished work, do it, verify it". It builds on the delegation module: the executors, their defaults and the records are the same.

`longkeep` below means `node <repo>/packages/cli/src/cli.ts` until the package is published. Not installed yet, or the user asks to install: follow INSTALL.md in the Longkeep repository (https://github.com/wingsofsky/longkeep/blob/main/INSTALL.md).

1. **The brief.** `longkeep folder --brief` prints where it is and creates a draft on first use. A brief whose first line is still the draft marker is refused. On first use, read both files to the user, help them adapt them, and let them delete the marker line; never delete it yourself. Do not edit the brief without being asked.
2. **Run it** in the background (it can take hours): `longkeep folder <dir> --executor <id>`, or `--new-projects` for the sub-folders that are git repositories not handled before, one task per repository, in turn. The default executor is grok. Each task snapshots its working folder first; records go to `~/.longkeep/runs/<project-key>/`; the folder only gets the agent's own changes. Each task gets 30 minutes unless the executor sets `timeoutMs`. A repository that fails is reported and the rest still run; only Ctrl+C stops the whole task.
3. **One at a time.** A second folder task on the same folder is refused while one runs ("already running on this folder"); wait or stop the first.
4. **Yielding to the IDE** (macOS, IntelliJ IDEA 2026.2): with `"yieldToIde": true` on the executor in `~/.longkeep/executors.json`, a repository open in the IDE waits, and one that the user opens while it runs is stopped and resumed later, told to read the code and the git status again. When Longkeep cannot tell what the IDE has open, it waits; one failed look does not stop a running repository. Elsewhere the setting is ignored with a notice.
5. **Launch fallback**: a `fallback` list on the executor is tried only when it provably never started; every executor in it must exist, or the task refuses to start.
6. **Report back**: for each repository, the outcome and the record path from the output; then read the transcripts that matter and summarize what was done, verified and left open. Treat the agent's claims as claims until you have read its diff and test output.

Details: `<repo>/modules/folder/README.md`.

## Don'ts

- Don't edit the brief or delete its draft marker without being asked.
- Don't start a folder task on a folder the user did not name.
- Don't report a repository as done from the agent's own summary; read its diff and test output.
