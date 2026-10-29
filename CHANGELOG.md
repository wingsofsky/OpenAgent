# Changelog

All notable changes to this project are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## [0.4.0] - 2026-10-29

The project is renamed Longkeep, in full: the command, the packages, the home folder, the variables, the MCP server and the skills, not only the docs ([DECISIONS.md](DECISIONS.md), D048). Not published to npm.

### Changed

- **Breaking**: every `openagent` name is now `longkeep`. To move an existing install:
  - Command: `pnpm openagent <command>` is now `pnpm longkeep <command>`.
  - Home folder: move `~/.openagent` to `~/.longkeep` (on Windows `%USERPROFILE%\.openagent` to `%USERPROFILE%\.longkeep`); the old folder is no longer read. Absolute paths written inside earlier records stay as they were.
  - Environment variables: `OPENAGENT_*` is now `LONGKEEP_*`: `LONGKEEP_HOME`, `LONGKEEP_SEARCH_PATH`, `LONGKEEP_<NAME>_BIN`, `LONGKEEP_GIT` and `LONGKEEP_DELEGATE_DEBUG`.
  - MCP server: remove the server registered as `openagent` and register it again as `longkeep` with the same command ([INSTALL.md](INSTALL.md)). In Claude Code its tools are now `mcp__longkeep__*`.
  - Skills: `openagent-context`, `openagent-delegate`, `openagent-sessions` and `openagent-folder` are now `longkeep-*`, and their folders in the repository are renamed. Replace the links or copies in your agent's skills folder.
  - Folder-task briefs: the draft marker is now `<!-- longkeep:draft … -->`. A saved brief that still starts with the old `openagent:draft` line was never reviewed and would now run: review it and delete the line, or delete the brief so the new default is written.
  - The workspace packages are `@longkeep/*`, and the repository is `https://github.com/wingsofsky/longkeep`.

## [0.3.0] - 2026-10-27

The first public version. Not published to npm: install from the repository ([INSTALL.md](INSTALL.md)).

OpenAgent was ported module by module, with its tests, from an earlier codebase that also had a desktop app, web access and a task inbox. This version keeps only what is used from a main agent's own window; why, and what was dropped, is in [DECISIONS.md](DECISIONS.md) (D042 to D046).

### Added

- Four modules that install on their own from a sparse checkout ([INSTALL.md](INSTALL.md)):
  - `context`: a skill that files documents under `docs/` and finds earlier ones, a contract template, an ADR-style decision log template and lessons from working with AI agents, in English and Chinese, plus a checkup of an existing project's documents.
  - `sessions`: imports past conversations from six agent CLIs as Markdown archives with indexes, refreshes continued ones and collects the user's own prompts and rules.
  - `delegate`: hands subtasks to other local agent CLIs through an MCP server or the command line; every round is a record in `~/.openagent/runs/` with transcript, outcome and verdict; snapshots before a project is changed; one shared agent handbook.
  - `folder`: one agent CLI works through a folder of repositories unattended, with a saved brief.
- `INSTALL.md`, written for the user's own agent to follow: it detects the agent CLIs, opens sign-ins, registers the MCP server, confirms each executor's permissions before the first delegation and offers a checkup of the project's documents.
- `openagent doctor`: where each CLI was found, its version, its sign-in state and an optional one-word probe.
- CI on Linux, macOS and Windows with Node 22 and 24, which also installs each module alone from a sparse clone.

### Changed

- Records and all configuration live in `~/.openagent` (`OPENAGENT_HOME` moves it); nothing in a project configures OpenAgent, so a cloned repository cannot change what a delegation runs.
- English throughout: code, errors, command output, file formats and docs, with Chinese editions of the READMEs and the context skill.
- Executor permissions are set in each CLI's own settings file; the delegate README lists where. A round with no timeout of its own runs up to 30 minutes.

### Removed

- The desktop app, web access (HTTP transport, OAuth), the task inbox, shared memory, project-level overrides of the handbook and executors, traces, the migration command for the earlier data layout, and power saver mode.
