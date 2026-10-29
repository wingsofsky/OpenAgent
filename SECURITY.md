# Security

Longkeep runs on your machine and starts other agent CLIs with your user's permissions. It checks every path it handles itself, but it is not a process sandbox. This page says what is enforced, what is not, and what is shared.

Which module each part concerns: the path gate and the project rules apply to every module with code; executors, snapshots and the handbook to the delegate module; unattended runs to the folder module; imported conversations to the sessions module. The context module has no code and changes nothing on its own.

## What Longkeep enforces

### The path gate

Every path that comes from a request or a record (a project file, a task id, a writeback target, a snapshot path) is resolved under its root (the home folder `~/.longkeep`, a project, a record) by one module, `packages/common/src/scoped.ts`. Files whose names Longkeep fixes itself, such as a shadow repository's configuration, skip this module, because no request can choose their path.

- rejected before touching the disk: NUL, absolute and drive-relative paths, `..` segments, and on Windows every name Windows cannot hold (device names such as `CON` or `nul.txt`, alternate data streams, `:`, a trailing dot or space);
- links are resolved with the native realpath (on Windows this also expands 8.3 short names and returns the on-disk case), and the result must stay inside the root;
- creating parent folders walks one segment at a time and checks each existing segment first, so a link pointing outside is refused with no side effects.

The attack cases are one shared data file, `packages/protocol/src/path-attacks.json`, run by `packages/common/test/path-safety.test.ts` on Linux, macOS and Windows. A new command or MCP tool starts with these tests. Security tests are never switched off by platform; on Windows, directory links fall back to junctions so they run without privileges.

### Which folders can be a project

A project, a folder task's folder, or a declared `workRoot` may not be the filesystem root, your home directory, the Longkeep home folder or anything inside it, or a folder that contains the Longkeep home folder. An agent that skips permission prompts could otherwise change the whole disk or Longkeep's own records.

### Nothing in a project configures Longkeep

Which executors exist, which command each one runs, where it works, whether its prompts are skipped, and what the agent handbook says: all of that comes only from the home folder (`~/.longkeep/executors.json`, `~/.longkeep/handbook.md`). Longkeep reads no configuration, handbook or memory from a project, so a repository you clone cannot make a delegation run its own command or hand your main agent instructions dressed up as your handbook. A `.longkeep/` folder inside a project is ignored. `executors-registry`, `handbook` and `mcp` tests in `modules/delegate/test/` plant such a folder and check that it changes nothing.

What this does not cover: the project's own files are still read by the executors that work in it, and a README or code comment can try to steer an agent. The folder-task brief tells the agent that only the saved task and rules count; nothing enforces that.

### Nothing written into a project unless asked

Records go to the home folder. The project changes only when a delegation works there (`work: "project"`, a snapshot is taken first), when a `writeback` appends a suggestion to a file you named, or when an executor with skipped prompts decides to write there (see below). Longkeep never writes to a project's own `.git` (a `writeback` or `target` inside `.git`, `.hg`, `.svn` or `.jj` is refused): snapshots live in shadow repositories under `~/.longkeep/snapshots/`. Longkeep only reads the project's `.git`, with `git rev-parse` and `git status`, to see what a round changed.

## What Longkeep does not enforce: executors

A headless CLI cannot answer a permission prompt, so by default Longkeep starts most executors with their prompts skipped. The defaults come from `packages/protocol/src/executor-registry.json`:

| Executor | Default | Flag |
|---|---|---|
| `codex` | prompts not skipped; Codex's own sandbox, `workspace-write` unless you choose `read-only` or `danger-full-access` | `-s <sandbox>` |
| `agy` | prompts skipped | `--dangerously-skip-permissions` |
| `grok` | prompts skipped | `--always-approve` |
| `cursor` | prompts skipped; no write sandbox | `--force`, and `--trust` for the workspace |
| `claude` | prompts skipped | `--dangerously-skip-permissions` |

What that means:

- An executor with prompts skipped can run commands, reach the network and write files anywhere your account can. The working folder (scratch, the project or a `workRoot`) decides where it starts and where Longkeep looks for changes; it is not a boundary.
- The outcome Longkeep records (`changed`, `no_changes`) compares the working folder before and after. Writes outside it are not detected, and in a git work tree neither are changes to files git ignores.
- Turn skipping off for one task with `longkeep delegate … --no-approve`, or as a default with `autoApprove: false` (`set_executor_defaults`, `longkeep delegate --to <name> --set autoApprove=false`, or by hand in `executors.json`). Some CLIs, agy in particular, then return empty answers. With skipping off, each CLI follows its own settings file; where those files are and what to set: [Setting permissions yourself](modules/delegate/README.md#setting-permissions-yourself).
- Rounds that may write are not retried automatically, so a failed attempt is not repeated on a half-edited tree.
- claude is started with `--strict-mcp-config`, so the MCP servers configured for your own Claude Code sessions (a database, a mail account) are not available in a delegated round. The other CLIs load whatever MCP servers their own configuration lists; check it before delegating to them with prompts skipped.
- Executors use their own sign-ins and quotas. Longkeep never reads, stores or passes on credentials, and the brief you write is sent to that vendor's service.

## Folder tasks run unattended

`longkeep folder <dir> --executor <id>` starts one executor on a folder with nobody watching, with the prompts-skipped defaults above (codex keeps its sandbox). Guards:

- the brief is created as a draft whose first line is a marker; a brief that still has the marker, is empty, or is larger than 32 KiB is refused, so nobody runs a brief they never read;
- the folder passes the project check above (not the root, not your home directory);
- one folder task per folder at a time (`runs/<project-key>/folder.lock`);
- the working folder is snapshotted before each task, and the record, transcript and log stay in the home folder;
- `fallback` executors are tried only when the first one provably never started;
- with `yieldToIde` (macOS, IntelliJ IDEA), a repository open in the IDE is left alone, and when Longkeep cannot tell what the IDE has open it waits instead of guessing.

The brief's rules ask the agent not to touch sub-projects' `.git`, not to commit or push, and not to read credentials. The agent is asked; nothing enforces it.

## What is shared across projects

The home folder is shared by every project on the machine:

- **the agent handbook** `~/.longkeep/handbook.md`, read by every main agent before delegating. A `writeback: "handbook"` answer may quote a web page, so until you keep it, `list_executors` and `longkeep handbook --json` return it apart from the handbook text, marked as executor output not to be followed. The label is all there is: an agent that reads the raw file sees the suggestion inline;
- **imported conversations** `~/.longkeep/sessions/imported/`: `longkeep import-sessions` imports one project by default, but over time the archive gathers the conversations of every project you import, and `--all-projects` imports all of them at once;
- **records** `~/.longkeep/runs/`, one folder per project, readable by any process running as you.

Keep `~/.longkeep` out of public sync, shared drives and backups you publish: it contains your briefs, answers, transcripts and conversations.

## Snapshots exclude credentials

Snapshots never store, and never restore, paths matching `modules/delegate/src/snapshots/sensitive-paths.json` (`.env` files, `.npmrc`, `.netrc`, `.aws` and kube configs, files named `credential(s)` or `secret(s)` alone or followed by `.`, `-` or `_` and more, token and auth files, SSH keys, `*.pem`, `*.key` and similar), at any depth, even when a project's `.gitignore` re-includes them. This is a file-name list: a secret inside an ordinary file is snapshotted like the rest of that file. Removing a secret from a project does not remove it from older snapshots.

Folders named `node_modules`, `dist`, `target`, `.venv`, `__pycache__`, `.pnpm-store` or `.Trash` are not snapshotted either, at any depth, even when they hold source files. Nor are files the project's `.gitignore` ignores, such as a local database or build output: an executor working in the project can delete them, and no snapshot holds them. Back such files up yourself before letting an executor into the project. A restore stops before changing anything when the safety snapshot taken first cannot be written.

## Imported conversations: redaction is best effort

`longkeep import-sessions` redacts by default: allowlisted secret patterns are replaced, high-entropy tokens on lines with a keyword (key, token, password, …) are replaced, and other long mixed tokens are listed as suspects. It will miss things, and it does not remove personal information. Review the suspects and the archive before sharing anything; rotate any key that slipped through. `--no-redact` turns redaction off (titles are still redacted).

## Transport

The MCP server speaks stdio only: it is started by the main agent as a child process and opens no network port. Longkeep sends nothing over the network itself: records stay on disk, and there is no telemetry. The executors talk to their own vendors' services.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability reporting on this repository (Security tab, "Report a vulnerability"). Include the version (`longkeep --version`) or commit, your OS, and a reproduction with private paths and content removed.
