# OpenAgent delegation

This module lets a main agent (Claude Code, Codex, …) hand work to other agent CLIs on the same machine. It contains commands and a stdio MCP server. OpenAgent runs the executor headless, keeps each task as plain files in `~/.openagent`, reports what actually changed, and records the verdict.

Words used below:

- **Main agent**: the agent window you drive. OpenAgent does not start one; it plugs into yours over MCP.
- **Executor**: another agent CLI that the main agent hands work to: `codex`, `agy` (Antigravity), `grok`, `cursor` (Cursor Agent), `claude` (Claude Code), or a custom one declared in `executors.json`.
- **Project**: the folder the main agent works in. OpenAgent writes nothing into it unless you ask.
- **Home folder**: `~/.openagent` (or `OPENAGENT_HOME`), where every record and all configuration live. Nothing in a project configures OpenAgent.

```text
You:          Have grok find this year's changes to the MCP spec, with sources
Claude Code:  reads the handbook, then delegate_task({ executor: "grok", ... })
Claude Code:  grok found four changes; sources below. Record: ~/.openagent/runs/<project-key>/<task-id>/
```

Your agent could call `grok -p` in a shell instead. Here is what OpenAgent adds:

| Calling the CLI directly | Through OpenAgent |
|---|---|
| Each CLI needs its own headless flags: cursor stops at a workspace-trust prompt without `--trust`, codex waits for input on stdin | The flags are set per CLI; your agent only names the executor |
| The answer scrolls away in the chat | Each task is a record folder with the brief, the full transcript and the changes |
| The executor reports "done" | OpenAgent compares the working folder before and after. The round stays unaccepted until you or your agent read the diff and the real test output and record a verdict |
| A follow-up starts from nothing | A follow-up round continues the same task and session |
| The executor works in your project | It works in a scratch folder. If you let it into the project, OpenAgent first takes a snapshot, a copy you can restore. Files your `.gitignore` ignores are not in it |

The agent handbook, `~/.openagent/handbook.md`, records what each CLI is good at, its quirks, and which models and effort levels work, each entry with the date it was checked. Your main agent reads it before delegating. An executor's answer can be written back to it (`writeback: "handbook"`) as a suggestion tagged with the executor's name, which you keep or delete; until you decide, your agent treats it as unchecked text.

## Install

Send this to your main agent:

```text
Install the delegate module of OpenAgent from https://github.com/wingsofsky/OpenAgent: follow INSTALL.md in that repository
```

By hand. Requires Node 22.19 or later, pnpm, and git (git is only needed for snapshots and change detection in git work trees). Not on npm yet, so download this module from the repository:

```bash
git clone --filter=blob:none --sparse https://github.com/wingsofsky/OpenAgent.git <repo>
cd <repo>
git sparse-checkout set modules/delegate packages/protocol packages/common packages/cli
pnpm install --prod --frozen-lockfile
node <repo>/packages/cli/src/cli.ts doctor
node <repo>/packages/cli/src/cli.ts handbook init
```

Node runs the TypeScript sources directly. For a shorter command, define an alias (the rest of this guide writes `openagent`):

```bash
alias openagent="node <repo>/packages/cli/src/cli.ts"            # bash / zsh
function openagent { node <repo>\packages\cli\src\cli.ts @args }   # PowerShell
```

Register the MCP server with your main agent. `<project>` is the folder you run the agent in:

```bash
claude mcp add openagent -- node <repo>/packages/cli/src/cli.ts mcp --project <project>
codex mcp add openagent -- node <repo>/packages/cli/src/cli.ts mcp --project <project>
```

Copy the [openagent-delegate](skills/openagent-delegate/SKILL.md) skill where your agent reads skills (`<project>/.claude/skills/` or `~/.claude/skills/`; Codex: `.agents/skills/`), and restart the session so the tools appear. `delegate_task` returns at once with a `watch` command: run in the background, it exits when the round ends and prints the answer, so a main agent that is told when a background command exits (Claude Code is) gets the result without waiting or polling. The skill walks an agent through everyday use; its [delegation practices](skills/openagent-delegate/references/delegation-practices.md) record what went wrong in earlier delegations and what is done now. Updating: `git pull`, then `pnpm install --prod --frozen-lockfile` and copy the skill again.

## Commands

Every command takes `--help`. `openagent --version` prints the version. Exit codes: 0 fine, 1 the work failed, 2 bad usage or a command that could not run at all.

| Command | What it does |
|---|---|
| `openagent delegate` | hand a task to an executor and record it; status, verdicts, executor defaults |
| `openagent doctor` | check each built-in CLI: installed, version, signed in; `--probe` asks each for one word |
| `openagent mcp` | the stdio MCP server for a main agent |
| `openagent handbook` | show where the agent handbook is, or create it |
| `openagent snapshot` | take, list, changes, diff and restore snapshots of a project |

### openagent delegate

```
openagent delegate --to <executor> --title <title> --prompt <text> [--project <dir>] [--prompt-file <file>] [--target <path>]
                  [--writeback handbook|<path>] [--work scratch|project] [--model <m>] [--effort <level>] [--sandbox <s>]
                  [--timeout <s>] [--stall <s>] [--retries <n>] [--issuer <name>] [--no-approve] [--json]
openagent delegate --continue <task-id> --prompt <text>
openagent delegate --status [<task-id>]
openagent delegate --wait <task-id> [--json]      # block until the task's current round ends, then print it
openagent delegate --review <task-id> --verdict accepted|needs_rework|rejected [--note <text>] [--issuer <name>]
openagent delegate --list
openagent delegate --to <executor> --set key=value … | --reset
```

| Option | Meaning |
|---|---|
| `--to` | executor name (see `--list`) |
| `--title` | task title; required for a new task |
| `--prompt` / `--prompt-file` | the complete brief; the executor cannot see the main agent's context |
| `--project` | the project; default the current folder. Not the filesystem root, your home directory, the home folder, a folder inside it, or a folder that contains it |
| `--target` | a project-relative file the task is about; must exist; passed to the executor as information |
| `--writeback` | after a successful round, append the answer as a suggestion tagged with the executor's name (`{++@grok: …++}`) to this document: `handbook` (the agent handbook, `~/.openagent/handbook.md`) or a project-relative file that exists |
| `--work` | `scratch` (default): the executor works in `work/` inside its record; `project`: it works in the project, and a snapshot is taken first |
| `--model`, `--effort` | override the defaults for this task; effort is `minimal`, `low`, `medium`, `high` or `xhigh`, translated to each CLI's flag; no built-in CLI has `minimal`, so it is sent as `low` (cursor takes none: pick a model id that carries the effort) |
| `--sandbox` | codex only: `read-only`, `workspace-write` (default) or `danger-full-access` |
| `--timeout` | seconds before the attempt is killed (default 1800, 30 minutes) |
| `--stall` | seconds without output that count as stalled (0 = off; codex defaults to 300, the others to 0 because they print only when done) |
| `--retries` | retries after a non-zero exit. Default 0, because a round that may write is not repeated; 1 only when the round cannot write: `--sandbox read-only` with prompts not skipped (codex skips none by default) |
| `--issuer` | who issued the task (default `claude`) |
| `--no-approve` | do not skip the executor's permission prompts for this task (see [Default permissions](#default-permissions)) |
| `--json` | print the full result as JSON |

A run prints the answer on stdout and a summary line on stderr: outcome, working folder, task id, record folder, snapshot, session, usage. Exit code 0 when the round finished, 1 when it failed.

```bash
openagent delegate --to grok --title "MCP spec changes" --prompt "What changed in the MCP spec this year? Cite sources and dates."
openagent delegate --continue 20261024-101500-MCP-spec-changes --prompt "Only the changes that affect stdio servers."
openagent delegate --status                       # this project's recent tasks
openagent delegate --review 20261024-101500-MCP-spec-changes --verdict accepted --note "sources checked"
openagent delegate --to cursor --title "Fix the parser" --work project --model <model id> --prompt-file brief.md
```

`--continue` adds a round to the same task, with the same executor; a follow-up round cannot switch to another one. A CLI that can resume its session does so natively (codex `exec resume`, agy `--conversation`, grok, cursor and claude `--resume`); otherwise the previous answer is replayed. Every follow-up prompt carries the first brief and the prompts of the earlier follow-up rounds. Verdicts and review notes stay in the record and are not sent to the executor.

`--set` changes the defaults of one executor in `~/.openagent/executors.json`, which every project shares. Keys: `model`, `effort`, `sandbox`, `timeoutMs`, `stallMs`, `retries`, `autoApprove`. `key=` with no value removes the key; `--reset` removes the whole entry.

```bash
openagent delegate --to grok --set model=<model id> --set effort=high
openagent delegate --to cursor --set autoApprove=false
openagent delegate --to codex --reset
```

### openagent doctor

```
openagent doctor [--probe] [--json]
```

For each built-in executor: where the binary was found, its version, and whether it is signed in (`unknown` when it cannot be decided). `--probe` makes one minimal real call per installed CLI ("reply with one word"), which costs a little quota and catches "signed in but not entitled to the model". Writes nothing under `~/.openagent` or the project; with `--probe`, each CLI may keep the probe session in its own folder. Exit code 1 when a probe failed, 2 when doctor itself could not run.

### openagent mcp

```
openagent mcp [--project <dir>]
```

The stdio MCP server with the seven delegation tools. `--project` defaults to the folder the server starts in. stdout is reserved for JSON-RPC; logs go to stderr. Register one server per project, or register it in a project-scoped configuration. Tools: [MCP tools](#mcp-tools).

### openagent handbook

```
openagent handbook [--json]     where the handbook is, and how many suggestions wait (--json adds the text and the suggestions)
openagent handbook init         create ~/.openagent/handbook.md from the bundled preset
```

There is one handbook, `~/.openagent/handbook.md`, shared by every project. `init` never overwrites it. Writebacks arrive as CriticMarkup insertions tagged with the executor's name (`{++@grok: …++}`): keep one by deleting its marks, delete it by deleting the block, or ask your main agent to do either. Until you decide, a suggestion is kept out of the handbook text that main agents read: `list_executors` and `--json` return it apart, marked as executor output.

### openagent snapshot

```
openagent snapshot list [--limit n] [--json]
openagent snapshot take [label]
openagent snapshot changes <id> [--from <id>]
openagent snapshot diff <id> [path]
openagent snapshot restore <id> [path]     the whole project, or one file; a safety snapshot is taken first
```

Snapshots live in a shadow git repository, `~/.openagent/snapshots/<project-key>/`; the project's own `.git` is never written. Credentials and keys are excluded, and so are folders named `node_modules`, `dist`, `target`, `.venv`, `__pycache__`, `.pnpm-store` and `.Trash` at any depth (see [SECURITY.md](../../SECURITY.md)). Files the project's `.gitignore` ignores (local databases, build output, caches) are not snapshotted either: if an executor working in the project deletes one, a restore cannot bring it back. A restore stops before changing anything when its safety snapshot cannot be taken. `--project <dir>` defaults to the current folder. With no action, `openagent snapshot` lists.

## MCP tools

Seven tools, all about delegation.

| Tool | What it does |
|---|---|
| `list_executors` | executors on this machine (strengths, installed or not, follow-up support, defaults, install hint), the handbook (path, its text without undecided suggestions, the suggestions apart) and this project's recent delegations |
| `delegate_task` | run one executor headless and record the task. Parameters: `executor`, `prompt`, `title`, `work`, `target`, `writeback`, `model`, `effort`, `sandbox`, `timeout_seconds` (max 7200), `stall_seconds`, `retries`, `issuer`, `continue_task` (a task id, for a follow-up round), `wait` (default false: return at once with `task_id` and a `watch` command; true: block until the round ends) |
| `delegation_status` | without `task_id`: recent delegations of this project; with it: the task header, the tail of the live output (`tail_lines`), the record paths |
| `review_task` | record a verdict: `accepted`, `needs_rework` or `rejected`, with a note and the reviewer |
| `set_executor_defaults` | default `model`, `effort`, `sandbox`, `timeoutMs`, `stallMs`, `retries` or `autoApprove` for one executor, in `~/.openagent/executors.json`; `null` restores the CLI's own default, `reset` removes the entry |
| `init_handbook` | create `~/.openagent/handbook.md` from the bundled preset; never overwrites |
| `executor_doctor` | the `openagent doctor` check; `probe: true` asks each CLI for one word |

- By default the round keeps running inside the server process after the tool returns; `watch` (`openagent delegate --wait <task-id>`) blocks until it ends. A client that only closes stdin lets the round finish. One that sends SIGTERM or SIGINT, as the MCP SDK's client does two seconds after closing stdin, makes the server stop the executor's process tree and record the round as stopped before it exits. On Windows no such signal reaches the server: it ends at once, the record stays unfinished, and the executor may keep running.
- `set_executor_defaults` cannot set `command`, `args`, `bin`, `workRoot`, `fallback` or `yieldToIde`; those are written by hand.
- Everything the tools do is also a command (`openagent delegate`, `openagent doctor`, `openagent handbook`); snapshots exist only as a command. A main agent without MCP runs them like any other shell command.

## A delegation's lifecycle

1. The main agent calls `list_executors` and reads the handbook from the path it gives.
2. `delegate_task` creates `~/.openagent/runs/<project-key>/<task-id>/`, decides the working folder (scratch, the project, or a declared `workRoot`), snapshots it when it is not scratch, and runs the CLI with stdin closed, a timeout and a stall watchdog.
3. The working folder is fingerprinted before and after. OpenAgent sets `outcome` from those fingerprints, not from the executor's report: `changed`, `no_changes`, `unchecked` (no fingerprint), or a failure class. `status: done` only means the round ended; `acceptance: pending` waits for someone to check.
4. The main agent reads the diff and the real test output, then calls `review_task`. `needs_rework` continues with `continue_task`. Rounds that may write are not retried automatically, so a failed attempt never repeats on a half-edited tree.

A failed round goes back to `status: pending` with an "Execution failed" section in `task.md`.

## Where things are kept

```
~/.openagent/                         the home folder (OPENAGENT_HOME moves it); the parts delegation uses
  handbook.md                        agent handbook: routing, quirks, models and effort levels
  runs/<project-key>/<task-id>/      one record
    task.md                          header (executor, status, outcome, acceptance, usage, session) and brief
    transcript.md                    every round: prompt, answer, raw output excerpt, changes
    run.json                         plan, rounds, attempts, exit classes
    output.log                       live output of the current attempt
    work/                            scratch folder when the task does not work in the project
  snapshots/<project-key>/           shadow git repositories
  executors.json                     executor defaults and custom executors
```

`<project-key>` is the project folder's name plus a short hash of its canonical path. While a round runs, its record folder also holds `claim.lock`.

**Nothing in a project configures OpenAgent.** Executors and the handbook come only from the home folder, so a cloned repository cannot change which command a delegation runs or what the handbook tells your main agent. A `.openagent/` folder inside a project is ignored.

### executors.json

```json
{
  "grok": { "model": "<model id>", "effort": "high" },
  "cursor": { "workRoot": "<absolute path of a worktree>", "model": "<model id>", "timeoutMs": 1800000 },
  "codex-math": { "extends": "codex", "model": "<model id>", "sandbox": "danger-full-access" },
  "my-cli": { "label": "My CLI", "command": "my-cli", "args": ["run", "{prompt}"], "answer": "stdout" }
}
```

- An entry named after a built-in executor only overrides its defaults: `model`, `effort`, `sandbox`, `timeoutMs`, `stallMs`, `retries`, `autoApprove`, `bin`, `label`, `strengths`.
- An entry with `command` (and `args`) is a custom executor; `extends` inherits a built-in's discovery, parsers and templates. `answer` is `json`, `stdout` or `outFile`; `resumeArgs` declares native resume. Templates and placeholders: the header comment of `packages/protocol/src/executor-registry.ts`.
- `workRoot` (absolute path) makes the executor work in that folder, for example a git worktree; the record stays in the home folder. Only a person writes it: `set_executor_defaults` cannot.
- A broken file is an error, never silently ignored.

## Default permissions

A headless CLI cannot answer a permission prompt: it hangs or refuses every tool. So by default OpenAgent starts most executors with their prompts skipped. From `packages/protocol/src/executor-registry.json`:

| Executor | Default | Flag OpenAgent adds |
|---|---|---|
| `codex` | prompts not skipped; runs in Codex's own sandbox, `workspace-write` unless you pass another `sandbox` | `-s <sandbox>` |
| `agy` | prompts skipped | `--dangerously-skip-permissions` |
| `grok` | prompts skipped | `--always-approve` |
| `cursor` | prompts skipped; Cursor Agent has no write sandbox | `--force` (and always `--trust` for the workspace) |
| `claude` | prompts skipped | `--dangerously-skip-permissions` |

An executor with prompts skipped can run commands and write files anywhere your user account can, not only in its working folder. The working folder organizes output; it is not a sandbox. To turn skipping off:

- for one task: `openagent delegate … --no-approve`
- as a default: `set_executor_defaults({ executor: "cursor", autoApprove: false })` or `openagent delegate --to cursor --set autoApprove=false`
- by hand in `executors.json`: `{ "cursor": { "autoApprove": false } }`

With prompts on, some CLIs (agy in particular) return empty answers headless. More in [SECURITY.md](../../SECURITY.md).

### Setting permissions yourself

OpenAgent has no permission settings of its own beyond `autoApprove` and codex's `sandbox`. To limit what an executor may do, set `autoApprove: false` for it and write the rules in that CLI's own settings file; it reads them in every delegated round, as it does when you run it by hand. Allow what the work needs, or headless rounds fail on the first refused tool.

| Executor | Settings file | What to set there | Sandbox |
|---|---|---|---|
| `codex` | `~/.codex/config.toml` | nothing for OpenAgent: it passes `-s` from the `sandbox` setting (`read-only`, `workspace-write`, `danger-full-access`) | its own, on macOS, Linux and Windows |
| `claude` | `~/.claude/settings.json` | `permissions.allow`, `ask`, `deny` (for example `Bash(git *)`), `permissions.defaultMode` | shell commands only; none on native Windows |
| `grok` | `~/.grok/config.toml` (`GROK_HOME` moves it); sandbox profiles in `~/.grok/sandbox.toml` | permission rules and mode; see `grok --help` | `read-only`, `workspace`, `strict` profiles; none on native Windows |
| `cursor` | `~/.cursor/cli-config.json`; sandbox in `~/.cursor/sandbox.json` | `permissions.allow` and `deny` with `Shell(…)`, `Read(…)`, `Write(…)` | `workspace_readwrite`, `workspace_readonly`; none on native Windows (WSL2 only) |
| `agy` | `~/.gemini/antigravity-cli/settings.json` | `permissions.allow`, `ask`, `deny`; `toolPermission`; `enableTerminalSandbox` | Linux, macOS, and Windows 11 24H2 or later |

- `~` is your home folder (`%USERPROFILE%` on Windows).
- Each CLI also reads a project file (`.claude/settings.json`, `.grok/config.toml`, `.cursor/cli.json`), but a delegated round runs in its scratch folder unless the task works in the project, so put rules you always want in the user file.
- A rule that blocks a command by name (`Bash(rm *)`) is not a boundary: the same command can run through `bash -c` or an absolute path. Only a sandbox keeps writes inside a folder.
- These names come from each CLI's `--help` in October 2026 (codex 0.163, claude 2.1, grok 1.0, cursor-agent 2026.10.22, agy 1.3). They change; check the CLI's own documentation before relying on one.

## Environment variables

| Variable | Effect |
|---|---|
| `OPENAGENT_HOME` | moves the home folder (default `~/.openagent`) |
| `OPENAGENT_SEARCH_PATH` | folders searched for executor binaries in addition to PATH, separated like PATH; replaces the built-in list (`/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, …). Set to an empty string to drop that list; each CLI's own install folder is still checked |
| `OPENAGENT_CODEX_BIN`, `OPENAGENT_AGY_BIN`, `OPENAGENT_GROK_BIN`, `OPENAGENT_CURSOR_BIN`, `OPENAGENT_CLAUDE_BIN` | the executable of that CLI, used as given; wins over everything else |
| `OPENAGENT_GIT` | the git executable OpenAgent uses for snapshots and fingerprints (default `git` from PATH) |
| `OPENAGENT_DELEGATE_DEBUG` | `1` prints every step of the runner to stderr |
| `MCP_TOOL_TIMEOUT` | Claude Code's own setting, in milliseconds: how long it waits for a tool. Raise it (for example `1800000`) in the shell that starts Claude Code if you call `delegate_task` with `wait: true` for long runs |

Binary resolution order: the `OPENAGENT_<NAME>_BIN` variable, then `bin` in `executors.json`, then PATH plus the search folders, then known install locations. On Windows the PATH lookup counts only `.exe` files; a `.js` entry point (such as Cursor Agent's `index.js`) is run with Node; `.cmd` and `.bat` shims are refused.

## Troubleshooting

- **"not found" in `--list`**: the CLI is not on PATH or in a known location. Set `OPENAGENT_<NAME>_BIN`, or `bin` in `executors.json`. The [install guide](../../INSTALL.md) shows how an agent can find the binary for you.
- **Signed in, but the task fails**: quota, plan entitlement or temporary capacity. Run `openagent doctor --probe`, or delegate a one-word probe with `retries: 0` before a batch.
- **Empty answer from agy**: its prompts were not skipped (`--no-approve` or `autoApprove: false`). Headless agy needs them skipped.
- **cursor hangs or fails with `ENAMETOOLONG`**: Cursor Agent derives a folder name from the full working-folder path; a very deep path (about 250 characters) fails. Move the project or `OPENAGENT_HOME` to a shorter path.
- **codex cannot find pnpm or Python**: its `workspace-write` sandbox cannot see per-user installs. Run node entry points directly, or pass `sandbox: "danger-full-access"` when you trust the brief.
- **The tool call times out in Claude Code** with `wait: true` while the round continues: raise `MCP_TOOL_TIMEOUT`, or leave `wait` at its default and use `watch` or `delegation_status`.
- **"cannot be a project"**: the folder is the filesystem root, your home directory, the home folder, a folder inside it, or a folder that contains it. Pick a project folder, or move `OPENAGENT_HOME`.
- **A round hangs or dies without output**: `OPENAGENT_DELEGATE_DEBUG=1` shows each step; `output.log` in the record has the live output.
- **Snapshots unavailable**: git is not installed or not found; set `OPENAGENT_GIT`. Everything else works without git.

Per-CLI quirks and current models and effort levels are kept in the agent handbook, not here: `openagent handbook`.

Apache-2.0.
