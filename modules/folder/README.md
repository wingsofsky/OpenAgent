# OpenAgent folder tasks

This module runs one agent CLI on a folder, unattended, with a brief you saved once; each such run is a folder task. Typical use: a parent folder of several repositories, and a brief that says "look at each project, pick well-founded unfinished work, do it, and verify it". OpenAgent snapshots the working folder first and keeps the record, transcript and log in its home folder, so the only changes in the folder are the agent's own work.

![One agent CLI works through a folder of repositories, unattended](diagram.svg)

This module builds on the [delegation module](../delegate/README.md): it uses the same executors, defaults, records and snapshots, and installing it installs delegation too.

```bash
openagent folder <dir> --executor grok                  # run once on this folder
openagent folder <dir> --executor grok --new-projects   # each sub-repository not handled before, one task each
openagent folder --brief                                # print where the brief is (creating the draft if needed)
```

The command streams the executor's output, prints where each record is, and exits 0 when every task finished, 1 when one failed. Ctrl+C stops the folder task and the processes it started. From a main agent, run the same command in its shell; the [openagent-folder](skills/openagent-folder/SKILL.md) skill says how. `openagent` means `node <repo>/packages/cli/src/cli.ts`.

## Install

Send this to your main agent:

```text
Install the folder module of OpenAgent from https://github.com/wingsofsky/OpenAgent: follow INSTALL.md in that repository
```

By hand, download this module and the delegation module it needs:

```bash
git clone --filter=blob:none --sparse https://github.com/wingsofsky/OpenAgent.git <repo>
cd <repo>
git sparse-checkout set modules/folder modules/delegate packages/protocol packages/common packages/cli
pnpm install --prod --frozen-lockfile
```

Set up delegation as its README says (at least one agent CLI signed in), then copy both skills, `modules/folder/skills/openagent-folder` and `modules/delegate/skills/openagent-delegate`, where your agent reads skills (`<project>/.claude/skills/` or `~/.claude/skills/`; Codex: `.agents/skills/`).

## The brief

The brief is two files in the home folder, shared by every folder; it is read again before each task, so an edit counts from the next repository on:

- `~/.openagent/folder/brief/task.md`: what to do;
- `~/.openagent/folder/brief/rules.md`: the rules to follow while doing it.

The first run creates both from defaults (`packages/protocol/src/folder-brief.ts`). Each starts with this line:

```
<!-- openagent:draft — edit this brief, then delete this line -->
```

A brief that still contains that line is refused, so nobody runs a brief they never read. Read both files, adapt them to your folders, delete the first line, and run again. A brief that is empty or larger than 32 KiB is refused too. Every run sends the current full text of both files to the executor.

The default rules ask the agent to read each project's contract and README first, keep uncommitted changes, never touch a sub-project's `.git` or run git write commands, write nothing but source, tests and necessary configuration into the projects, and not commit, push, publish or buy anything. These are instructions to the agent. OpenAgent itself enforces only what is listed under [Guards](#guards).

## Guards

- **Folder check**: the folder may not be the filesystem root, your home directory, the OpenAgent home folder or anything inside it, or a folder that contains it.
- **Draft check**: the brief must have been edited (see above).
- **One task per folder**: while a folder task runs, `~/.openagent/runs/<project-key>/folder.lock` holds the folder and a second one is refused. A lock whose process is gone is taken over.
- **Snapshot first**: the working folder (the folder, or one repository with `--new-projects`) is snapshotted into `~/.openagent/snapshots/<project-key>/` before the task. Restore with `openagent snapshot restore <id> --project <dir>`, or one file with `openagent snapshot restore <id> <path> --project <dir>`. With `--new-projects` each repository has snapshots of its own: `openagent snapshot list --project <dir>/<repo>`, and restore with that `--project`. Without git the run goes ahead without a snapshot, and the transcript says so.
- **Records outside the folder**: `~/.openagent/runs/<project-key>/<task-id>/` holds `task.md`, `transcript.md`, `run.json` and `output.log`, one record per task, all under the folder's key. OpenAgent writes nothing into the folder.
- **Time limit**: 30 minutes per task, unless the executor sets `timeoutMs` in `executors.json`.
- **No follow-up rounds**: each repository gets a fresh task.

Executors run with their usual defaults: agy, grok, cursor and claude with permission prompts skipped, codex in its sandbox. See [SECURITY.md](../../SECURITY.md#folder-tasks-run-unattended).

## Only new repositories

With `--new-projects`, the folder task covers the direct sub-folders that are git repositories of their own (a real `.git`, not a link) and have not been completed before. Each one is a task of its own, one after another, working in that repository only; when none is left, no executor starts and the command exits 0. After a successful task the repository is marked completed in `~/.openagent/runs/<project-key>/folder-projects.json`, keyed by the sub-folder's name and file identity, never by reading its git contents. A failed or stopped task marks nothing. A repository that fails (its snapshot cannot be taken, no executor could start) is reported and the queue goes on with the next one; at the end the command lists every repository with its outcome. Only Ctrl+C stops the whole task.

## Yielding to the IDE

Off by default. With `"yieldToIde": true` on the executor in `~/.openagent/executors.json`, a folder task stays out of the repositories you have open in IntelliJ IDEA:

```json
{ "grok": { "yieldToIde": true } }
```

- A repository open in the IDE (or one inside or around an open project) waits; the next free one runs instead.
- Every 10 seconds OpenAgent looks again. When you open the repository that is running, its executor is stopped and the repository goes back into the queue. When it runs again, the prompt says it is a new run after yielding, points at the earlier transcript as reference, and tells the agent to read the code and the git status again before going on. One look that cannot tell what the IDE has open does not stop a running repository; two in a row do.
- A task that finished while the IDE had the repository open is not marked completed. If OpenAgent cannot tell whether the IDE had it open when the task ended, it waits until it can, so a finished repository never runs a second time.
- Detection works on macOS with IntelliJ IDEA 2026.2 (Ultimate or Community) only: OpenAgent reads which project folders the IDE holds open, through `ps` and `lsof`, and writes nothing to the IDE. Any other version, or a failed check, counts as "cannot tell", and the task waits. On other platforms `yieldToIde` is ignored with a notice.
- To find a project opened inside a repository, OpenAgent searches level by level, so the top levels, where projects are usually opened, come first. It skips dependency, build and cache folders (`node_modules`, `target`, `dist`, …), goes four levels deep and stops after 20,000 folders; a repository too large to search completely gets one notice. A folder it cannot read counts as "nothing open there", so one large repository cannot stall the queue. While a repository runs, only that one is searched.

## Launch fallback

Off by default. Give an executor a `fallback` list in `~/.openagent/executors.json`: executors to try, in order, when the executor that owns the list provably never started (not installed, the process could not be created). Every executor in the list must exist in the executor table, or the folder task refuses to start. A step may set `model` and `effort`. A task that resumes after yielding uses the same executor as before; if that one never started, it moves on to the next in the list.

```json
{ "grok": { "fallback": [{ "executor": "cursor", "model": "<model id>" }, { "executor": "claude" }] } }
```

Only an operating-system error before a process existed counts as "never started". A CLI that started and then failed (sign-in, quota, network, a non-zero exit, a timeout) is never replaced. The next candidate starts no earlier than five minutes after the failed one started. Fallback executors must be installed and signed in beforehand.

## Running it on a schedule

OpenAgent has no scheduler or hotkey of its own. Start the command from cron, launchd, Task Scheduler or a launcher, with the same environment you use in a terminal (PATH must find the executor, and `OPENAGENT_HOME` if you moved the home folder).

## License

[Apache-2.0](../../LICENSE)
