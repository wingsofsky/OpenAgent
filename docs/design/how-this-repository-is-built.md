# How this repository is built

Longkeep is built by one maintainer directing AI coding agents: a main agent writes, tests and reports, and other CLIs take delegated pieces. The general practices behind that, and the templates that put them into files, are the [context module](../../modules/context/README.md): see its [working with AI agents](../../modules/context/en/longkeep-context/references/working-with-ai-agents.md). This page lists how this repository applies them: which checks fail when a rule is broken, and how the modules are laid out.

## Invariants backed by tests

| Invariant | Enforced by |
|---|---|
| Every path that comes from a request or a record passes one path gate under its root (the home folder, a project, a record), `packages/common/src/scoped.ts`; only files whose names Longkeep fixes itself skip it | `packages/common/test/path-safety.test.ts` runs the shared attack table `packages/protocol/src/path-attacks.json`: `..`, absolute paths, NUL, symlink escape, no side effects when creating folders through a link, and on Windows `:`, device names, alternate data streams, 8.3 short names. Directory links fall back to junctions on Windows (`packages/testkit/src/links.ts`), so the tests run there without privileges. |
| Nothing is written into a user's project unless they ask | Records go to `~/.longkeep` (`packages/protocol/src/layout.ts`); `modules/delegate/test/delegate.test.ts` checks that a scratch delegation writes its output into the record's scratch folder, `modules/folder/test/folder.test.ts` that a folder task leaves only the agent's changes, and every test runs with `LONGKEEP_HOME` pointing at a temporary folder (`vitest.config.ts`). |
| Formats are plain text, defined once | Each format lives in one file in `packages/protocol`, whose header comment is the contract. `tests/module-boundaries.test.ts` fails if that package imports anything outside its own folder. |
| People confirm | `modules/delegate/test/handbook.test.ts`: writebacks land in the handbook as suggestions tagged with the executor's name, which a person keeps or deletes. `modules/delegate/test/mcp.test.ts` pins the seven MCP tools, none of which accepts a suggestion. |
| A project configures nothing | The `executors-registry`, `handbook` and `mcp` tests in `modules/delegate/test/` plant a `.longkeep/` folder in a project (an executor that runs `sh -c`, a handbook with instructions) and check that nothing changes. |
| One module installs on its own | `tests/module-boundaries.test.ts`: a module imports only its own files, the packages it declares and the modules in its `requires`; `paths` in its `module.json` is exactly what a sparse checkout of it needs. `scripts/check-module-install.mjs` installs each module alone from a sparse clone and runs its commands. |

Structural rules are enforced the same way:

- **Dead code and import cycles fail CI**: `pnpm lint:deps` runs knip (unused files and exports) and dpdm (cycles).
- **English only**, except the Chinese editions: `tests/english-only.test.ts` fails on Chinese text outside `README.zh-CN.md` files and `modules/context/zh-CN/`.
- **Docs match the code**: `tests/docs.test.ts` fails when a document names an `longkeep` command or an MCP tool that does not exist, when a module's documents name a command of a module it does not require, or when a link points to a file that is not there or, from a module, into a module that a sparse checkout of it would not have.
- **Three platforms are gates.** CI runs on Linux, macOS and Windows with Node 22 and 24. A change is not finished because it works on the machine where it was written.

## Layout: modules over shared packages

```
   main agent (Claude Code, Codex, ...)            person
              | stdio MCP                             | shell
   +----------v-----------------------------------------v---------+
   | packages/cli: the `longkeep` entry; runs the commands that  |
   | the modules present list in modules/<name>/module.json        |
   +-------+-------------------+--------------------+--------------+
           |                   |                    |
   modules/delegate     modules/sessions     modules/folder (needs delegate)
   delegation, MCP,     conversation         folder tasks
   handbook, snapshots  archives
           |                   |                    |
   packages/common: the path gate, the home folder, argument parsing
   packages/protocol: plain-text formats, no dependencies, no IO
              |
   ~/.longkeep (records, handbook, executors.json, archive)

   modules/context: a skill and templates, no code
```

- **Files are the protocol.** Tasks, transcripts, suggestions and conversation archives are Markdown and JSON a person can read with `cat`. An agent without MCP can read the same files. The one format two modules share at run time, the lines that mark a delegated prompt so that the session importer recognises it, lives in `packages/protocol` like every other.
- **Records live in one place.** The home folder holds every record, so a project's tree only changes when someone asked for a change there.
- **Docs should claim only what the code enforces.** Before publishing, models with no context read the docs in several review rounds, and every claim they questioned was checked against the code.
