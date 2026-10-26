# Installing OpenAgent

You (the agent reading this) are the setup wizard. The user handed this to you, often as nothing more than the repository link, because they do not want to read a manual. Ask first, then detect, then act, and explain every step in plain language.

OpenAgent is a set of modules in one repository. The user installs only the ones they want, and only those are downloaded:

| Module | What the user gets | Needs |
|---|---|---|
| `context` | a skill that tells agents where documents go and how to find them, a contract template (`CLAUDE.md` / `AGENTS.md`), a decision log template, notes on working with AI agents; in English or Chinese | git |
| `sessions` | past conversations of Claude Code, Codex, Gemini CLI, Grok Build, Antigravity and Cursor Agent as searchable Markdown | Node 22.19+, pnpm, git |
| `delegate` | the main agent hands subtasks to other agent CLIs, with records, snapshots and a shared agent handbook, through an MCP server | Node 22.19+, pnpm, git, at least one other agent CLI the user is signed in to |
| `folder` | one agent CLI works through a folder of repositories unattended; builds on `delegate` | as `delegate` |

Each module's own description is `modules/<name>/module.json`: `summary`, `requires` (other modules it needs), `paths` (what to download), `commands` and `skills`. By the end, the modules the user chose are installed and working, and nothing else was touched.

## 0. Ground rules

- **Ask before acting.** For anything that changes the user's machine (cloning, `pnpm install`, installing a CLI, registering MCP, copying a skill), say in one sentence what you are about to do and get consent first.
- **Handle installs and sign-ins, never credentials.** You may install missing CLIs after the user agrees and open sign-ins in a visible terminal window; the CLI opens the browser and the user authorizes there. Never read, write or relay API keys or tokens, never accept passwords in chat, never click consent for the user.
- **Don't touch the user's contract files.** `CLAUDE.md` / `AGENTS.md` belong to the user; setup changes nothing in them.
- **Tell it like it is.** If something is not installed or not verified, say so. Don't invent configuration syntax for other vendors' CLIs: each CLI's own `--help` is the authority.
- Close stdin whenever you launch a CLI yourself (`< /dev/null`); codex waits on stdin otherwise.

## 1. Ask first

Ask these at once:

1. **Which modules?** Explain each in one sentence from the table above. `context` is the usual start; `delegate` is worth it with two or more agent subscriptions, or to have a second session review the first one's work. Modules can be added later.
2. **For `context`: English or Chinese?** The skill's language is the language the agent tends to answer in.
3. **Where should the repository go, and which folder is the project?** The project is the folder the user runs the main agent in. Modules with code keep their records and configuration in `~/.openagent`, not in the project. Which OS is this?
4. Only with `delegate`: **which services do they pay for** (Claude, ChatGPT, Google AI Pro or Ultra, SuperGrok, Cursor, or only API keys), and **which window do they usually direct agents from?** That one is the **main agent**. OpenAgent does not start another agent; it plugs into this one.

## 2. Detect what is on this machine

```bash
command -v git node pnpm                  # node and pnpm only for modules with code
node --version                            # needs 22.19 or later
command -v claude codex agy grok cursor-agent   # only with delegate
```

Node or pnpm missing: with Homebrew, ask and then `brew install node pnpm`; on Windows with winget, ask and then `winget install OpenJS.NodeJS.LTS`, then `corepack enable pnpm`; otherwise point the user to https://nodejs.org (it needs an admin password, which you never handle).

Repeat what you were told and what you found in one sentence: "You want context (Chinese) and delegate; you pay for A and B, this machine has a and b installed, the main agent is X, the project is Y." Continue once they confirm.

## 3. Download only the chosen modules

OpenAgent is not on npm; it runs from a clone on macOS, Linux and Windows alike. A sparse clone downloads only what the chosen modules need. First the modules' own folders:

```bash
git clone --filter=blob:none --sparse https://github.com/wingsofsky/OpenAgent.git <repo>
cd <repo>
git sparse-checkout set modules/<name> [modules/<name> …]
```

Then read `paths` in each chosen `modules/<name>/module.json`, add every module named in its `requires` (and that module's `paths`), and set the union:

```bash
git sparse-checkout set <every path from those module.json files>
```

For example, `delegate` alone is `modules/delegate packages/protocol packages/common packages/cli`. If any chosen module has commands, install its dependencies (no development tools):

```bash
pnpm install --prod --frozen-lockfile
node <repo>/packages/cli/src/cli.ts --help        # lists the commands of the modules present
```

`<repo>` is wherever the user wants the clone; use absolute paths from here on. Below, `openagent` means `node <repo>/packages/cli/src/cli.ts`. If the user already has a clone, use it: a full clone has every module; a sparse one gets more with `git sparse-checkout add <paths>` and another `pnpm install --prod --frozen-lockfile`.

## 4. Delegate: executors, MCP, handbook

Skip this section unless the user chose `delegate` (or `folder`, which needs it).

### 4.1 Find the agent CLIs

```bash
node <repo>/packages/cli/src/cli.ts doctor
```

`doctor` lists the five built-in executors (codex, agy, grok, cursor, claude): where each was found, its version, and whether it is signed in. A CLI missing from PATH may still be found: OpenAgent checks each CLI's usual install folders by itself (the copy the Claude desktop app manages, winget's folders on Windows, `~/.local/bin` and similar).

When `doctor` says "not installed" for a CLI the user says they have, look for it yourself:

1. Ask the shell: `command -v <name>` / `which -a <name>`; on Windows `where.exe <name>` and `Get-Command <name>`.
2. Look where installers put it: `~/.local/bin`, `/opt/homebrew/bin`, `%LOCALAPPDATA%\Programs`, `%LOCALAPPDATA%\Microsoft\WinGet\Packages`, the vendor's own folder under `%LOCALAPPDATA%` or `%APPDATA%`.
3. If the CLI or its desktop app is running, the process list shows the full path (`Get-Process <name> | Select-Object Path` on Windows, `ps -ax -o comm | grep <name>` elsewhere).

Show the user the path you found and run `<path> --version` to prove it works. With their yes, record it in `~/.openagent/executors.json` as `{ "<executor>": { "bin": "<absolute path>" } }`, merged into what is already there, then run `doctor` again. On Windows a `.cmd` or `.bat` shim is refused: point `bin` at the `.exe` or `.js` entry point behind it.

### 4.2 Install missing CLIs

Compare the subscriptions with what `doctor` found, list "paid for but not installed", and ask once: "Shall I install codex and grok?" After consent (macOS / Linux, no `sudo`):

| CLI | Install command |
|---|---|
| Claude Code | `curl -fsSL https://claude.ai/install.sh \| bash` (Windows: `winget install Anthropic.ClaudeCode`), or use the copy the Claude desktop app manages |
| Codex | `npm i -g @openai/codex` (the ChatGPT desktop app also bundles one) |
| Grok Build | `curl -fsSL https://x.ai/cli/install.sh \| bash` |
| Antigravity (`agy`) | `curl -fsSL https://antigravity.google/cli/install.sh \| bash` |
| Cursor Agent | `curl https://cursor.com/install -fsS \| bash` |

On Windows, the install hints `openagent delegate --list` prints for missing CLIs give the PowerShell commands. Each vendor's own site is the authority; if a command fails, show the raw output and don't switch to unofficial sources. A CLI installed into `~/.local/bin` or similar may not be on the current shell's PATH yet: OpenAgent looks there anyway, and a new terminal will find it.

### 4.3 Sign-in (terminal, then browser)

Signing in needs a TTY, which your shell does not have, so open a visible terminal window for the sign-in command. On macOS:

```bash
osascript -e 'tell application "Terminal" to activate' \
          -e 'tell application "Terminal" to do script "codex login"'
```

| CLI | Login command | Check |
|---|---|---|
| Claude Code | `claude auth login` | `claude auth status` |
| Codex | `codex login` | `codex login status` |
| Grok Build | `grok login` | `openagent doctor` checks that its credentials file exists (don't read it) |
| Antigravity | `agy` (the first interactive run signs in; the user closes the window afterwards) | a one-word probe |
| Cursor Agent | `cursor-agent login` | `cursor-agent status` |

One vendor at a time: say what will happen, open the window after consent, wait for the user to say it is done, then check. Users with only API keys set them as environment variables themselves, in their own terminal. On other systems, give the user the sign-in commands to run. Afterwards run `openagent doctor --probe`: each signed-in CLI answers one word, which proves the model is actually available (it costs a little quota; ask first).

### 4.4 Register the MCP server

The MCP server carries the seven delegation tools. The command is the same for every vendor; `<S>` below stands for:

```
node <repo>/packages/cli/src/cli.ts mcp --project <project>
```

| Main agent | How to register |
|---|---|
| Claude Code | from the project folder: `claude mcp add openagent -- <S>` (local scope, this project only). With `--scope project` it goes into the project's `.mcp.json` instead, which Claude Code loads, after asking for approval, for anyone who opens the project; the paths in it are this machine's |
| Codex | `codex mcp add openagent -- <S>`; this is global, so use a different name per project, such as `openagent-notes` |
| Cursor Agent | write `{"mcpServers":{"openagent":{"command":"node","args":["<repo>/packages/cli/src/cli.ts","mcp","--project","<project>"]}}}` into the project's `.cursor/mcp.json`, then `cursor-agent mcp enable openagent` |
| Grok Build, Antigravity, others | `mcp add` per that CLI's own `--help`: the command is `node`, the arguments are `<repo>/packages/cli/src/cli.ts mcp --project <project>` |

If `claude` is not on PATH (on Windows, the copy the Claude desktop app manages often is not), run `mcp add` with the full path `doctor` printed for claude. If the user set `OPENAGENT_HOME`, pass it when registering too, after the name: `claude mcp add openagent -e OPENAGENT_HOME=<path> -- <S>`, `codex mcp add openagent --env OPENAGENT_HOME=<path> -- <S>`. Otherwise a main agent started without that variable uses `~/.openagent`. Run `claude mcp list` first: if a server of the same name exists in another scope, only one of them is used, so pick another name, such as `openagent-notes`.

Without `--project`, the server uses the folder it is started in. It refuses the filesystem root, the user's home directory, the OpenAgent home folder and any folder that contains it. Snapshots and folder tasks are commands the main agent runs in its shell; no registration needed.

### 4.5 The agent handbook

Create the agent handbook (with consent). It holds what is known about each CLI: what it is good at, its quirks, which models and effort levels work. The main agent reads it before every delegation:

```bash
node <repo>/packages/cli/src/cli.ts handbook init
```

It writes `~/.openagent/handbook.md` from the preset in this repository and never overwrites a handbook that already exists. Tell the user it is plain Markdown they can edit, and that suggestions arrive in it tagged with the executor's name, for them to keep or delete.

### 4.6 Depending on subscriptions

- **Only one subscription.** Delegation still gives records, snapshots and folder tasks, and the main agent can delegate to the same vendor's CLI with a cheaper model (`delegate_task({ executor: "codex", model: "<cheaper model>", effort: "low" })`). What is missing is other vendors' models.
- **Two or more.** Pick the one whose judgment they trust most as the main agent; the others are executors. `list_executors` shows who is available; the routing table and quirks are in the handbook.
- **Only API keys.** OpenAgent does not manage keys. Prefer a CLI that uses the key, since only a CLI has a tool loop and file access; a custom executor in `~/.openagent/executors.json` can wrap any command that prints an answer.

Desktop and web apps (Claude desktop, ChatGPT, IDEs) cannot be delegated to: they have no headless entry point. Only command-line agents can.

### 4.7 Permissions, before the first delegation

Go through the executors the user has installed, one at a time:

1. Say in one sentence what it may do by default: with prompts skipped it can read and write anywhere the user's account can and run any command; codex instead runs in its own sandbox (`workspace-write`).
2. Ask whether to keep that default or limit it.
3. To limit it, use the table under "Setting permissions yourself" in `modules/delegate/README.md`: draft the change to that CLI's own settings file, allowing what its usual work needs (searching, reading, writing in its working folder), and show it to the user. Write it only after they agree, then turn skipping off: `openagent delegate --to <name> --set autoApprove=false`.

Each limited executor is probed in step 7.

## 5. Copy the skills

Each module's `module.json` names its skill folders under `skills`; `context` has one per language. Copy each chosen one (with consent), for this project:

```bash
mkdir -p <project>/.claude/skills
cp -r <repo>/modules/<name>/<skill folder> <project>/.claude/skills/
```

For every project, copy into `~/.claude/skills/` instead (macOS / Linux: `rsync -a --delete <source>/ ~/.claude/skills/<skill>/`; Windows: `robocopy <source> "$HOME\.claude\skills\<skill>" /MIR`). Codex reads the same folders from `<project>/.agents/skills/` or `.codex/skills/`. Other agents can follow the files directly; nothing in them depends on one vendor beyond the folder name. Copying does not follow updates (see step 8).

With `context`, the skill's `references/` holds the contract and decision log templates. Offer them, but writing `CLAUDE.md` / `AGENTS.md` or `DECISIONS.md` is the user's call (see the ground rules).

## 6. What goes into `~/.openagent`

Only modules with code write here. All plain text, readable with `cat`. `OPENAGENT_HOME` moves the folder.

| Path | What it is | Module |
|---|---|---|
| `handbook.md` | the agent handbook: routing, quirks, models and effort levels; executors append suggestions tagged with their name, which people keep or delete | delegate |
| `runs/<project-key>/<task-id>/` | one record (a delegated task, or one repository of a folder task): `task.md`, `transcript.md`, `run.json`, `output.log`, `work/` | delegate, folder |
| `snapshots/<project-key>/` | shadow git repositories with project snapshots; the project's `.git` is never written | delegate, folder |
| `executors.json` | executor defaults and custom executors | delegate, folder |
| `folder/brief/` | the brief of folder tasks | folder |
| `sessions/imported/<project>/` | conversation archives, with `index.md` files | sessions |

Nothing in a project configures OpenAgent: a `.openagent/` folder in a project is ignored. Don't put `~/.openagent` into a synced or shared folder without telling the user what it contains.

## 7. Self-test, then hand over

Run the checks for the modules installed, in front of the user:

- **context**: `<project>/.claude/skills/openagent-context/SKILL.md` exists (or the global copy).
- **sessions**: `openagent import-sessions --list --project <project>` shows which past conversations it can import and writes nothing. The brackets at the end of each line name the folder the archive goes to: the project's name, `_temp` for a session started in a temp folder, `_misc` for one outside any project.
- **delegate**, before the session restart: `openagent delegate --list` shows the executors the MCP server will see, and `openagent handbook` shows where the handbook is. After restarting the session: `list_executors` (does it match `doctor`? is the handbook there? if not, `init_handbook`), `executor_doctor`, and optionally a one-word probe with `delegate_task` (`retries: 0`, `timeout_seconds: 120`) and `delegation_status` to show where the record is. For each executor limited in step 4.7, run one probe that has to work: `delegate_task` with `retries: 0`, `timeout_seconds: 120` and the prompt "Create a file named probe.txt containing ok in the current folder, run `git --version`, then reply with one word: ok." It passes when the answer is ok and `probe.txt` is in the record's `work/` folder. An empty answer, a refused tool or a timeout means the rules block normal work: tell the user and go back to step 4.7.
- **folder**: `openagent folder --brief` prints where the brief is and creates the draft; tell the user to read and edit it before the first run.

If everything passes, tell them how to phrase things from now on; they don't need tool names:

- "Write up a plan for …", "where is the report on …": the context skill.
- "Import this project's past conversations": sessions.
- "Let grok search …", "have codex compute …": delegation. "What is waiting for me?": `openagent handbook` (pending suggestions) and `openagent delegate --status` (tasks with `acceptance: pending` still need a verdict).
- "Run the folder task on <folder>": a folder task.

If something fails, show the raw error; don't guess.

## 8. Updating and adding modules

- Update: `git -C <repo> pull`, then `pnpm install --prod --frozen-lockfile` if a module has code, then copy the skills again (a copy does not follow the repository).
- Add a module later: `git -C <repo> sparse-checkout add <its paths>`, `pnpm install --prod --frozen-lockfile`, then steps 4 to 7 for that module.

## Don'ts

- Don't install anything or open sign-in windows before the user agrees; don't click authorize for them, don't touch keys or tokens, don't use `sudo`.
- Don't touch `CLAUDE.md` / `AGENTS.md` during setup.
- Don't import conversations with `--all-projects` without asking.
- Don't download modules the user did not choose.
