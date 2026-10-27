# OpenAgent

[![CI](https://github.com/wingsofsky/OpenAgent/actions/workflows/ci.yml/badge.svg)](https://github.com/wingsofsky/OpenAgent/actions/workflows/ci.yml)

OpenAgent keeps the context of a long project in a complete set of documents, not in any one account, agent or environment. The documents are the contract: every agent session reads them before it starts and follows the same rules, so you can switch accounts, agents or machines and carry on where the last session stopped. The repository contains four modules: context, sessions, delegate and folder. Each module installs on its own, so you choose the ones you need and download only those.

[中文说明](README.zh-CN.md)

## What each module solves

A new agent session knows only the files it reads. On a long project that causes four problems, and each module answers one of them:

| Problem | Module |
|---|---|
| A new session, or a new account, forgets the rules and decisions of the last one; plans and reports end up scattered or lost | context |
| What was decided three weeks ago sits in a chat you can no longer find | sessions |
| You pay for several agent services, and each is good at something different, but they never work on the same task | delegate |
| A folder of repositories needs the same kind of work, unattended | folder |

A project that already has an `AGENTS.md` and a decision log still gets the checkup: the context module looks at where its documents are, its contract, its decision log and its commit conventions, and moves or rewrites only what you approve.

## What it looks like

**context**: your habits, the project's rules, its decisions and its documents, each in the file every session reads first.

![A project before and after the context module](modules/context/diagram.svg)

**sessions**: past conversations from six agent CLIs, searchable as Markdown.

![Transcripts from six agent CLIs imported as searchable Markdown](modules/sessions/diagram.svg)

**delegate**: your main agent hands a task to another agent CLI, keeps the record and checks the result. A real delegation, as it looked in Claude Code, is in the [delegate README](modules/delegate/README.md).

![The main agent hands a brief to an executor, keeps the record and records a verdict](modules/delegate/diagram.svg)

**folder**: one agent CLI works through a folder of repositories with a brief you saved once.

![One agent CLI works through a folder of repositories, unattended](modules/folder/diagram.svg)

## Modules

| Module | What you get | Needs |
|---|---|---|
| [context](modules/context/README.md) | fixed places under `docs/` for plans, reports, research and guides, and a way to find them; templates for a project's `CLAUDE.md` / `AGENTS.md` and for your own habits in every project; a decision log in the ADR (architecture decision record) style that also records who made each call; lessons learned from working with AI agents. English or Chinese | git |
| [sessions](modules/sessions/README.md) | your past Claude Code, Codex, Gemini CLI, Grok Build, Antigravity and Cursor Agent conversations as searchable Markdown in `~/.openagent`, whichever account they came from | Node 22.19+, pnpm, git |
| [delegate](modules/delegate/README.md) | each agent does what it is best at: from the chat, your main agent hands grok the web search, codex the math, cursor the multi-file code change, agy the explanation or the front end. Every task is kept as a folder with the brief, the transcript, what changed and your verdict; a snapshot is taken before an executor touches the project; one shared handbook records what each CLI is good at | Node 22.19+, pnpm, git, and at least one other agent CLI you are signed in to |
| [folder](modules/folder/README.md) | one agent CLI works through a folder of repositories unattended, with a brief you saved once; builds on delegate | as delegate |

Every module works on Linux, macOS and Windows, and CI tests all three. On Windows, `~/.openagent` is `%USERPROFILE%\.openagent`. OpenAgent is not on npm: the modules with code run from the downloaded repository with Node.

## Install

Send this to your main agent:

```text
Install the context module of OpenAgent from https://github.com/wingsofsky/OpenAgent: follow INSTALL.md in that repository
```

To install more, name them: `(modules: context, sessions)`. The agent explains the modules, downloads only the ones you chose with a sparse clone, checks what is already installed, and asks before each step that changes your machine. It never asks for a password or an API key: each CLI's sign-in opens in your browser, and you sign in there yourself. Each step is described in [INSTALL.md](INSTALL.md). Each module's README also shows how to install it by hand.

## How the modules fit together

```text
modules/context    a skill and templates (no code)
modules/sessions   ┐
modules/delegate   ├─ code, run by one command: node <repo>/packages/cli/src/cli.ts <command>
modules/folder     ┘  (folder needs delegate)
packages/          shared code: file formats, the path gate, the command entry
```

The command lists only the commands of the modules present in your checkout. Records and settings live in `~/.openagent` (set `OPENAGENT_HOME` to move it). OpenAgent writes into your project only when you ask, and reads no configuration from it, so a repository you clone cannot change what a delegation runs.

## Security

- The context module is documents only: it runs nothing on your machine.
- Delegated agents run with your user's permissions. agy, grok, cursor and claude start with their permission prompts skipped, because a headless CLI cannot answer them, so a delegated task can run commands and write files anywhere your account can. The folder it works in is where it starts, not a boundary; codex alone keeps its own sandbox. Before an executor works in your project, a snapshot is taken that you can restore. You can turn prompt skipping off per task or per executor: see [default permissions](modules/delegate/README.md#default-permissions).
- Paths from requests (a project file, a task id, a snapshot path) go through one checked module.
- Every project's main agent can read the handbook and imported conversations. Keep `~/.openagent` out of public sync.

Details: [SECURITY.md](SECURITY.md).

## Documentation

- [INSTALL.md](INSTALL.md): what the agent does during install, module by module
- Each module's README: [context](modules/context/README.md), [sessions](modules/sessions/README.md), [delegate](modules/delegate/README.md) (every delegation command and MCP tool), [folder](modules/folder/README.md)
- [How this repository is built](docs/design/how-this-repository-is-built.md): the checks that keep agent-written code honest

## License

[Apache-2.0](LICENSE)
