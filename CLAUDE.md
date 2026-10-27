# CLAUDE.md — OpenAgent

OpenAgent keeps a long project's context in documents any agent session reads, delegates work to other local agent CLIs (codex, grok, cursor, agy, claude) with every run kept as plain files a person can review, archives agent CLI conversations and runs folder tasks. Everything is used from a main agent's own window: no desktop app, no UI. Node and TypeScript only. Apache-2.0.
It is one repository of independently installable modules (`modules/context`, `sessions`, `delegate`, `folder`) over shared packages (`packages/protocol`, `common`, `cli`, `testkit`); a user downloads only the modules they want with a sparse checkout. [owner]
This file holds only the rules every agent session must follow. `AGENTS.md` is a symlink to it; edit only this file. A maintainer may keep personal additions in an untracked `CLAUDE.local.md`.

---

## 1. How to work here
- Done means it ran: tests pass and the command was run for real. CI covers Linux, macOS and Windows; say which platform you did not run locally. [owner]
- A behaviour change during a refactor or a move between modules is a decision, not a cleanup: it gets a decision entry. [D042]
- Architecture choices are recorded in `DECISIONS.md` before the code: newest first, append-only, each saying who decided. [owner]
- English everywhere: code, comments, errors, command output and docs. The Chinese editions are the exceptions: `README.zh-CN.md` files and `modules/context/zh-CN/`, which mirrors `modules/context/en/` file for file (a skill's language is the language the agent answers in). `tests/english-only.test.ts` enforces this. [D042] [owner]
- A capability people should use needs an entry point: a CLI command or an MCP tool, documented in its module's README. [owner]

## 2. Git and private files
- Never commit `docs/plans/`, `docs/reports/`, `docs/research/`, `docs/zh-CN/`, `CLAUDE.local.md` or `.openagent/`. They are gitignored; never force-add them. [incident]
- Commit messages are in English and start with a Conventional Commits prefix, e.g. `fix(delegate): …`. [owner]
- No real user paths or personal information in fixtures, test output, commit messages or docs. [agreed]

## 3. Invariants

### Four rules that cannot be broken
1. **Path safety**: every file access under a root (the home folder, a project, a record) goes through the scoped path module. A new command or tool starts with attack tests: `..`, absolute paths, symlink escape, NUL, zero side effects when creating directories through a link; on Windows also `:`, device names, 8.3 short names, case variants. The attack cases live in one shared fixture file. [D042]
2. **The project is not a configuration source, and nothing is written into it unless the user asks**: records and all configuration (executors, the handbook) live in the OpenAgent home folder (`~/.openagent`, or `OPENAGENT_HOME`); OpenAgent never reads `<project>/.openagent/`. A cloned repository must not be able to change what runs. Never touch a project's `.git`. [D042] [D043]
3. **Plain-text formats**: delegation records, conversation archives and review suggestions (CriticMarkup) are files a person can read with `cat`. Every format is defined once, in `packages/protocol`, whose header comments are the contract; that package has no dependencies and imports only its own siblings. [D006] [D033]
4. **People confirm**: an agent proposes (a verdict, a suggestion written back into the handbook); a person decides, and every decision stays a plain edit to a file they can see. [D042] [D043]

### Modules
- A module installs on its own: it imports only its own files, the packages its `package.json` declares and the modules in its `module.json` `requires`; `paths` there is exactly what a sparse checkout of it needs; `packages/*` never import `modules/*`. `tests/module-boundaries.test.ts` and `scripts/check-module-install.mjs` enforce this. [owner]
- A module's docs describe only what it can do: they name only its own commands and MCP tools (and those of the modules it requires) and link only inside its sparse checkout. `tests/docs.test.ts` enforces this. [agreed]
- No vendor plugin manifests (`.claude-plugin/`, `.agents/plugins/`, `.cursor-plugin/` and the like): installing goes through `INSTALL.md` and sparse checkout, the same for every agent. [owner]

### Trust boundaries
- Executor permission defaults are part of the security model. Changing a default updates `SECURITY.md` and the delegate module's README in the same change. [D012]
- Anything that widens what one project can see of another (the home folder, the handbook, imported sessions) or lets a project influence OpenAgent updates `SECURITY.md` in the same change. [D042] [D043]
- The MCP server speaks stdio only. [D042]

### Platforms
- Linux, macOS and Windows are equal; platform differences stay inside `process.platform` branches; CI on all three is a gate. [D029]
- Tests create links through `packages/testkit/src/links.ts` (directories fall back to junctions on Windows). Never switch off a security test with a platform check. [D029]
- CRLF in users' files is always tolerated and preserved; the repository itself is LF. [D029]
- Tests and every process they start never touch the real `~/.openagent`: `OPENAGENT_HOME` points to a temporary folder (`vitest.config.ts`, e2e scripts). [incident]

## 4. Common commands

```bash
pnpm test && pnpm typecheck                        # always
pnpm lint:deps                                     # knip + dpdm: unused files and exports, import cycles
pnpm openagent --help                               # run the CLI from source
node scripts/check-module-install.mjs [--tests]    # each module installed alone from a sparse clone
```

## 5. Environment pitfalls
- Close stdin when spawning any agent CLI (codex waits on stdin; agy hangs on Windows without a TTY). On Windows only `.exe` counts, never `.cmd` shims. [incident]
- Node 24 on Windows: `fs.rmSync` on a single file can kill the process silently (0xC0000409); delete single files with `unlinkSync`. [incident]
- macOS reports `EPERM` when signalling a process that has already become a zombie; verify with `ps` instead of trusting the signal's return code. [incident]

## 6. Releases
- Tags, npm publishing and GitHub releases only when the maintainer says so explicitly. [agreed]

## 7. Where to find things
- Module details: each module's README and each source file's header comment.
- How the rules came about: `docs/design/how-this-repository-is-built.md`, and the practices in `modules/context/en/openagent-context/references/working-with-ai-agents.md`.
- Executor know-how (routing, quirks, model values): the agent handbook, `~/.openagent/handbook.md`.
- No status lines in this file: it holds rules only. Past 150 lines it needs cutting, not adding. [D030]
