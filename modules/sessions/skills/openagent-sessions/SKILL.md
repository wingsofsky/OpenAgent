---
name: openagent-sessions
description: Import, refresh, organize and search past agent CLI conversations (Claude Code, Codex, Gemini CLI, Grok Build, Antigravity, Cursor Agent) as Markdown archives with indexes, and distill the user's own prompts and rules from them. Use when the user says "import this project's past conversations", "export my conversations", "what did we decide about X in an earlier session", "collect the rules I keep repeating", or asks to install the sessions module.
---

# OpenAgents conversations

`openagent import-sessions` turns the local transcripts of Claude Code, Codex, Gemini CLI, Grok Build, Antigravity and Cursor Agent into Markdown archives in `~/.openagent/sessions/imported/<project>/`, with an `index.md` for all of them and one per project. No model, no network. `OPENAGENT_HOME` moves `~/.openagent`.

`openagent` below means `node <repo>/packages/cli/src/cli.ts` until the package is published. Not installed yet, or the user asks to install: follow INSTALL.md in the OpenAgents repository (https://github.com/wingsofsky/OpenAgents/blob/main/INSTALL.md).

```bash
openagent import-sessions --project <project> --list     # preview, writes nothing
openagent import-sessions --project <project>            # this project's conversations
openagent import-sessions --all-projects                 # every project on this machine: ask the user first
openagent import-sessions --all-projects --reorganize    # file existing archives into project folders, re-render untouched ones
openagent import-sessions --index                        # only rebuild the indexes
openagent import-sessions --project <project> --prompts  # also distill user prompts, dispatch prompts and rule paragraphs into _prompts/
```

- The brackets at the end of each `--list` line name the folder the archive goes to: the project's name, `_temp` for a session started in a temp folder, `_misc` for one outside any project, `_delegated` for a session another agent started to do a delegated task.
- Running it again is safe: a session that continued is refreshed in place, and an archive a person edited is left alone and listed.
- To answer "what did we decide about X", read the relevant `index.md`, then search the archives with your own tools.
- `--prompts` writes only what the user typed, the prompts agents sent to other agents, and paragraphs that look like rules. Rules are a pattern match, not a summary: show them to the user, who decides which belong in the project's contract.
- Redaction is on by default and best effort; it does not remove personal information. Before anything is shared, review the suspects it lists. Every project's main agent can read the home folder, which is why `--all-projects` needs the user's yes.

## Don'ts

- Don't import with `--all-projects` without asking.
- Don't put an archive into a project, or send it anywhere, without the user's yes.
- Don't write rules distilled with `--prompts` into the contract on your own; propose them.
