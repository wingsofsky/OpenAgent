# Longkeep conversations

This module turns the local transcripts of Claude Code, Codex, Gemini CLI, Grok Build, Antigravity and Cursor Agent into Markdown archives with an index, kept in `~/.longkeep` rather than in your project, so a later session can search them for what was decided and why. Its command is `longkeep import-sessions`; it runs no model and needs no network.

![Transcripts from six agent CLIs imported as searchable Markdown](diagram.svg)

## Install

Send this to your main agent:

```text
Install the sessions module of Longkeep from https://github.com/wingsofsky/longkeep: follow INSTALL.md in that repository
```

By hand. Requires Node 22.19 or later, pnpm and git. Download only this module:

```bash
git clone --filter=blob:none --sparse https://github.com/wingsofsky/longkeep.git <repo>
cd <repo>
git sparse-checkout set modules/sessions packages/protocol packages/common packages/cli
pnpm install --prod --frozen-lockfile
node <repo>/packages/cli/src/cli.ts import-sessions --list
```

Copy the [longkeep-sessions](skills/longkeep-sessions/SKILL.md) skill where your agent reads skills (`<project>/.claude/skills/` or `~/.claude/skills/`; Codex: `.agents/skills/`) so it can import and search for you. Below, `longkeep` means `node <repo>/packages/cli/src/cli.ts`.

## longkeep import-sessions

```
longkeep import-sessions [--project <dir>] [--all-projects] [--source <s>] [--file <path>] [--list] [--index] [--reorganize]
                         [--limit <N>] [--force] [--sidechains] [--prompts] [--no-redact]
```

Archives go to `~/.longkeep/sessions/imported/<project>/`, with an `index.md` for all of them and one per project folder. `LONGKEEP_HOME` moves `~/.longkeep`.

| Option | Meaning |
|---|---|
| `--project <dir>` | only sessions that worked in this folder (default: the current folder); sessions with an unknown working folder are skipped. Gemini CLI transcripts do not record their working folder, so import them with `--all-projects` or `--file` |
| `--all-projects` | every project on this machine, including sessions with no known folder |
| `--source <s>` | `auto` (default), `claude-code`, `codex`, `gemini`, `grok`, `agy`, `cursor` or `file` |
| `--file <path>` | import one transcript file |
| `--list` | list what would be imported; write nothing |
| `--index` | only rebuild the indexes |
| `--reorganize` | file existing archives into project folders and re-render those nobody edited |
| `--limit <N>` | at most N archives, newest first |
| `--force` | rewrite archives that were already imported, including edited ones |
| `--sidechains` | include sub-agent transcripts |
| `--prompts` | also write `_prompts/USER_PROMPTS.md`, `AGENT_PROMPTS.md` and `USER_RULES.md`: what you typed, what agents sent to other agents, and paragraphs that look like rules |
| `--no-redact` | turn redaction off |

```bash
longkeep import-sessions --project <project> --list    # preview
longkeep import-sessions --project <project>           # import
```

Re-running is safe: an archive is matched to its transcript, a session that continued is refreshed in place, and an archive a person edited is left alone and listed. A session that an agent CLI ran for a task delegated through Longkeep is filed under `_delegated`, titled by its brief. Run `longkeep import-sessions --help` for where each CLI keeps its transcripts and how archives are filed. Exit codes: 0 fine, 1 the work failed, 2 bad usage.

## Privacy

- Redaction of keys and tokens is on by default and best effort; it does not remove personal information. Review the suspects it lists before sharing an archive, and rotate any key that slipped through.
- Archives live in the home folder, which every project's main agent can read. That is why `--all-projects` should be your decision, and why `~/.longkeep` belongs out of public sync. Details: [SECURITY.md](../../SECURITY.md).

## License

[Apache-2.0](../../LICENSE)
