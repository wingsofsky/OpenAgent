# Decision log (selected entries)

OpenAgent has kept an architecture decision log from its first day, written as the project went. This file is a curated selection that shows the format and how decisions were made. Entries are shortened; IDs and dates are the original ones.

Entries up to D040 were made in the earlier codebase this repository was ported from, which also had a desktop app, web access and a task inbox; they describe that codebase. D041 onward explain how this repository came about, what it was narrowed to, and how it has changed since.

## How the log works

- **One entry per architecture-level choice**: a new contract, a new dependency, a departure from the locked stack, a security boundary, a product reshape. Bug fixes and refactors without a new rule do not get entries.
- **Newest first, append-only.** An entry is never rewritten to say something else. A reversal is a new entry, and the old one's status says "superseded by Dxxx".
- **Three parts**: context (what forced the decision, with evidence), decision (what was chosen, and who chose it), consequences (costs, limits, what is still unverified).
- **Who decided is written down.** "Maintainer decided", "agent recommended, maintainer approved", or "within technical scope, the agent decided under a standing authorization". This keeps an agent's inference from being remembered later as a human decision.
- **The contract file points here.** Every rule in `CLAUDE.md` carries a tag such as `[D029]`, so an agent can look up why a rule exists before bending it.

## Template

```markdown
## D0XX — <one line: what was decided>

Date: YYYY-MM-DD · Status: proposed / implemented / superseded by D0YY

Context:
- Why it had to be decided: the problem and where the evidence is.

Decision:
1. What was chosen, and who chose it (maintainer / agent recommended, maintainer approved).

Consequences:
- Costs and limits; what to watch for later; what is not verified yet.
```

---

## D046 — Executor permissions stay in each CLI's own settings

Date: 2026-10-26 · Status: implemented

Context:
- Delegated CLIs run with their permission prompts skipped by default, because a headless CLI cannot answer a prompt. A design with three tiers per task (read, edit, full) was drafted, with each tier mapped to every CLI's flags.
- Research against each CLI's `--help` and docs showed the cost: five different permission models, no sandbox on native Windows for three of the five CLIs, and deny rules on command names that are not a boundary (`Bash(rm *)` does not match `bash -c` or an absolute path).

Decision (maintainer decided, finding the tiers too complex):
1. OpenAgent adds no permission settings beyond `autoApprove` and codex's `sandbox`. The delegate README lists each CLI's settings file, the keys that limit it and its sandbox per platform.
2. Setup asks, executor by executor, whether to keep the default or limit it. To limit it, the main agent drafts the change to that CLI's own settings file, writes it only after the user agrees, turns `autoApprove` off and runs a probe that must still succeed.
3. A round with no timeout of its own runs up to 30 minutes instead of 10; deep research timed out at 10 (maintainer decided).

Consequences:
- How safe a limited executor is depends on that CLI. The listed names were checked against each CLI's `--help` in October 2026 and will drift.

---

## D045 — Split the repository into modules that install on their own

Date: 2026-10-26 · Status: implemented

Context:
- One install pulled in everything: a user who wanted only the document conventions still cloned the delegation engine and installed its dependencies. The document conventions need no code at all.

Decision (maintainer asked for installable modules; the layout was recommended by the agent and approved):
1. Four modules, `context`, `sessions`, `delegate` and `folder`, over shared packages (`protocol`, `common`, `cli`, `testkit`). Each module's `module.json` lists what a sparse checkout of it needs and which modules it requires.
2. Installing goes through `INSTALL.md`, which the user's own agent follows, the same for every vendor; no npm package and no vendor plugin manifests for now.
3. Tests keep the split honest: `tests/module-boundaries.test.ts` checks imports, `tests/docs.test.ts` checks that a module's docs name only commands and links it has, and CI installs each module alone from a sparse clone.

Consequences:
- Installing needs git, and pnpm for modules with code. Updates are `git pull` plus copying the skills again.

---

## D044 — Drop the migration command and power saver mode before the first release

Date: 2026-10-26 · Status: implemented

Context:
- OpenAgent has not been released. Nobody outside the maintainer has data in the previous layout, yet the migration command took about 700 lines of code, 270 of tests and 180 of fixtures, plus shims that still recognized the old name in transcripts, delegation folders and contract-file markers.
- Power saver mode was a prompt the main agent wrote into the project's contract file. Nothing measured or enforced it; an outside review had already called it a dispatch prompt without a budget.

Decision (maintainer decided):
1. Removed: `openagent migrate`, its guide, fixtures and tests, and every shim for the old name. Supersedes decision 2 of D042 and decision 4 of D043.
2. Removed: power saver mode, meaning the handbook section, the skill section, the `dispatch_policy` status in `list_executors` and the managed-block kernel it used. Supersedes decision 2 of D041.

Consequences:
- This version reads nothing in the previous layout. Delegations recorded under the old name are filed with their project when conversations are imported, not under `_delegated`.
- The handbook preset moves to version 2026-10-26.

---

## D043 — Narrow the new repository to five things

Date: 2026-10-25 · Status: implemented; decision 4 superseded by D044

Context:
- A third review round of the new repository reported two high-severity issues: a repository could ship its own executor settings and change which command a delegation runs, and it could ship "confirmed" memories and a handbook of its own. Checking the code showed both were inherited from the previous repository, not introduced by the port; they came from an assumption nobody had written down: every project folder is the user's own. The port itself had lost one behaviour: folder tasks no longer had a lock (the module had been rewritten rather than moved, and its tests with it).
- What is used in practice is delegation with its records, the handbook, rules for where agents file documents, exporting and organising conversations, and folder tasks, all from the main agent's window; none of it needs a UI.

Decision (maintainer chose the narrowing; the details were recommended by the agent and approved):
1. The scope is those five things.
2. Removed: shared memory, project-level overrides (OpenAgent reads nothing from a project to configure itself), the review command, traces (the export command, OTLP sending and the trace file in each record), the snapshot MCP tools and the MCP tool groups. Snapshots themselves stay: they run before every change to a project.
3. Folder tasks get back what the previous repository had: one run per new repository, a lock per folder, and yielding to IntelliJ IDEA (macOS).
4. `openagent migrate` converts old conversation archives so the importer recognizes them instead of archiving them twice.
5. One companion skill instead of three.

Consequences:
- Both high-severity issues disappear by construction instead of needing a trust gate; tests plant a hostile `.openagent/` folder and check that nothing changes.
- A project cannot have its own handbook or executor settings any more.
- Yielding to the IDE only works on macOS.

---

## D042 — A new English repository for the AI infrastructure, ported module by module with its tests

Date: 2026-10-23 · Status: decided; the port is in progress in this repository; parts of decisions 1, 3 and 4 superseded by D043, the migration command of decision 2 by D044

Context:
- After the first phase of D041 was pushed, a second review round by five sub-agents agreed with the direction but found five new bugs, among them a writeback that could create a nearly empty project handbook shadowing the shared one, a security page and kernel comments that had gone stale, and two separate handbook code paths (desktop and MCP). It also found that the loop of people confirming memories and suggestions existed only in the desktop reader, and that three different "OpenAgent folders" were easy to confuse.
- Between 15% and 26% of the lines in the code contained Chinese (in the runtime about 1,800 lines, of which roughly 900 were comments and 240 error messages). The Chinese folder names, memory header fields and status values were file formats, not just labels.
- The maintainer asked whether a clean, all-English rewrite would be better than cleaning up the old code. The agent advised against starting from zero, because the attack tests, Windows pitfalls, each CLI's headless quirks and the process-tree handling had been learned through failures, and recommended a new repository that ports the old code module by module, translating and simplifying as it goes.

Decision (the maintainer accepted the agent's six recommendations as a whole):
1. **A new English repository for the AI infrastructure only**, positioned as "the record-and-review layer for AI work". Kept: path safety, the protocol kernels, the delegation engine, `openagent doctor`, snapshots, conversation import, the home folder, folder tasks, the stdio MCP server with 13 tools, the delegate, setup and contract-audit skills, the agent handbook.
2. **All file formats in English.** A one-time `openagent migrate` imports old libraries and the old app data, dry run first, never deleting the source. Only the migration code reads the old format.
3. **Every record goes to `~/.openagent`** (`handbook.md`, `memory/`, `sessions/imported/`, `runs/`, `folder/brief/`, `snapshots/`, `executors.json`); nothing is written into a project by default, and project overrides live only in `<project>/.openagent/`. This supersedes, for the new repository, D041's "the home folder is itself a library" and the app-data location of folder-task records.
4. **Dropped**: the whole web path (HTTP transport, OAuth, the external profile, tasks issued from the web), the task inbox, the MCP tools for reading and writing library files and for review marks, the desktop backend, IDE yielding, the session-end import hook, and the replay evaluation harness (to return with the A/B comparison). People were to confirm through new memory and review commands instead (both removed again in D043).
5. **Repository names**: the new repository takes over the project's public name; at the switch, the old repository is renamed and archived.
6. **Language**: code, comments, errors, docs and command output in English, with no localization layer; `README.zh-CN.md` is the one Chinese file.
7. The five bugs are not fixed in the old repository before the switch: they only trigger after creating a handbook or opening the home folder there.
8. **The reference implementation of path safety is the JavaScript one** (the new repository has no Rust); the attack cases are exported as a shared JSON table that the reader will run later too.

Consequences:
- Until the switch, two data formats exist side by side: the old desktop app does not see records written by the new CLI.
- Daily delegation moves to the new repository only at the end of the port.
- Package names are `@openagent/protocol` and `@openagent/cli` (command `openagent`); the npm scope is not registered yet and is checked before publishing.

## D041 — Splitting the repository, phase one: power saver mode into the handbook, lean MCP defaults, a shared home folder

Date: 2026-10-23 · Status: phase one implemented and pushed with CI green on all jobs; phase two (moving the desktop code out) not started; decision 2 superseded by D044

Context:
- Five sub-agents compared each feature with competing tools and with what the main agents already do natively. Their conclusion: the delegation-and-acceptance chain and the conversation archive were distinctive; the reader, the tool groups and a dedicated power saver tool largely overlapped with mainstream agents. The maintainer proposed splitting into two repositories: AI infrastructure (delegation, handbook, unattended runs, memory, power saver mode) and, later, the reader on its own.
- Measured: the infrastructure side was about 14,000 lines, the reader side about 16,000; the UI imported 13 modules through the protocol package and the runtime directly in one place. Splitting does not change run time; the gain is in development and CI (the infrastructure side needs neither the large frontend dependency tree nor a Rust toolchain).
- Two unrelated problems surfaced at the same time: CI on main was red on all six jobs, and the installer had grown to several hundred megabytes, mostly the bundled git, whose hard links were expanded when packaged.

Decision (the maintainer said to start; the concrete steps were recommended by the agent and chosen by the maintainer from options):
1. **Two phases**: first tidy both sides inside the existing repository; move the reader out with its history when its next round of work starts.
2. **Power saver mode becomes a handbook section**: the `set_dispatch_policy` tool and its tool group were removed; the handbook preset gained a "Power saver mode" section with the exact begin and end markers of the managed block, and the main agent edits the contract file with its own tools. The managed-block kernel stays, because the status report in `list_executors` uses it. This supersedes the rule that the block changes only through that tool.
3. **Lean MCP defaults**: a local stdio server without `--tools` loads only the infrastructure groups (delegation, memory, snapshots).
4. **A home folder `~/.openagent`** (moved with `OPENAGENT_HOME`) for the handbook, shared memory and the conversation archive, shared by all projects.
5. **Home by default, the project may override**: a project's own handbook wins over the shared one; recall reads the project's memories first and labels where each came from; new proposals go to the home folder unless the project scope is asked for. Web clients still saw only the current library.
6. **`openagent folder <dir>` became public**, so unattended folder runs work without the desktop app.

Consequences:
- Changing how delegation is used means changing the CLI guide and the delegate skill together.
- Fixed along the way: tests had picked up CLIs installed on the developer's machine (`OPENAGENT_SEARCH_PATH` now isolates them), slow Windows runners timed out, and a real bug let the "too broad" project check be bypassed when the home directory was reached through a link. The macOS installer's bundled git was trimmed from hundreds of megabytes to about 11 MB; the Windows package was not changed.
- D042 followed the same day and moved the infrastructure to a new repository instead of phase two as planned here.

## D040 — One repository, two products: OpenAgent CLI and OpenAgent Desktop

Date: 2026-10-21 · Status: implemented, unreleased (part of the planned first public release)

Context:
- A cold read of the release candidate by an agent with no context found the README listed thirteen sections, yet the most-used feature, delegation, had no section on how to use it; its tool names did not appear in the README at all.
- The code had already split cleanly (D033): the runtime package depends only on the MCP SDK, zod and an encoding detector, and an end-to-end test installs it outside the repository and runs it.
- The one real coupling: the agent handbook's preset lived in UI code, so CLI-only users could not create a handbook.

Decision (the maintainer asked for the features to be split; the shape below was recommended by the agent and approved):
1. Two products, one repository. The CLI (delegation, executor registry, handbook, session archive, MCP) is `packages/runtime`; the desktop app (reader, snapshots, review, in-app chat) is `src` and `src-tauri`. Splitting the repository would mean versioning the protocol package and running two CI pipelines for no user benefit.
2. Docs are split by product: the README introduces both; each product has its own guide; automation workflows moved to their own page.
3. The handbook preset moved to the zero-dependency protocol package, and a new MCP tool `init_handbook` creates it. The preset carries general guidance only; conventions that hold for one person stay out of the repository.

Consequences:
- CLI-only users review suggestions as plain `{++…++}` marks, without the review UI.
- The new tool was added during the scope freeze for the first release (D039); it is listed in the changelog under the unreleased 0.2.0.

## D036 — The desktop app runs on the Node runtime as a sidecar; snapshots move to the git CLI

Date: 2026-10-18 · Status: implemented

Context:
- The same backend existed three times: in Rust (desktop), in a dev-mode file bridge, and in the runtime (MCP, delegation). Snapshots had two writers, libgit2 in Rust and the git CLI in JS, which recognized each other only through a shared directory-name hash. Any semantic change had to be made three times.

Decision (within technical scope the agent decided, under the maintainer's standing authorization to finish the refactor; library choices informed by a delegated research task that was reviewed before use):
1. One backend: the runtime's API is the only backend for both the desktop app and browser dev mode. The desktop app starts it as a sidecar (a `serve --stdio` subcommand speaking line-delimited JSON-RPC 2.0).
2. Rust keeps only what is native: sidecar supervision, system dialogs, trash, drag and drop, open-with entry points, the global hotkey. Commands went from 54 to 19.
3. **Departure from the locked stack (D001)**: snapshots use the git CLI instead of git2-rs. After the move, git2 had no caller, the JS snapshot code already had end-to-end tests, and the C build dependencies disappeared.
4. Installers bundle the official Node and a git build, with their license texts.

Consequences:
- The desktop app now depends on a Node process; if the sidecar fails to start, every library operation reports the reason.
- Installers grew by roughly 200 MB uncompressed.
- Two rows of the "paired Rust/JS implementations" table in the contract became obsolete and were removed.
- Not verified on a real machine: the macOS sidecar and bundled git. CI builds the installers but does not launch them, so this stays open until a manual install test.

## D033 — Extract the runtime: a zero-dependency protocol package and a runtime package

Date: 2026-10-18 · Status: implemented

Context:
- The MCP server, delegation runner and session importer lived in loose scripts sharing the desktop app's dependencies. Two files had grown past 1,700 lines. The runtime could not be installed or run on its own.

Decision (agent recommended; maintainer said to proceed):
- `@openagent/protocol`: pure TypeScript, no dependencies, no IO. The review, task, managed-block, shared-memory and executor-default kernels live here. A test enforces that it imports only files from its own directory.
- `@openagent/runtime` (command `openagent`): MCP server, delegation runner, session import. Development runs TypeScript sources directly (Node type stripping); releases are bundled once at build time with esbuild.
- Old script entry points stay as forwarders so registered MCP clients keep working.
- Large files are split by moving code only, verified by comparing the multiset of code lines before and after: nothing lost, nothing changed.
- A new end-to-end test packs the runtime, installs it outside the repository and runs it on both CI platforms.

Consequences:
- Total runtime lines went up slightly (import headers); the plan's goal of "no growth" was not met, and the entry says so.

## D030 — Contract check-up: keep CLAUDE.md short with a skill and a hook

Date: 2026-10-16 · Status: implemented

Context:
- Contract files grow: progress tables added by "updating the docs while wrapping up" crowd out the rules, a copied `AGENTS.md` can pass the first 32 KiB that Codex reads, and requirements people repeat in chat often never reach the file at all.

Decision (maintainer chose the form; agent proposed the steps):
- A companion skill, `openagent-contract-audit`, with seven steps: measure, check against reality, mine the human's own words from transcripts, judge each rule, redraft from a skeleton, tag every rule's source and self-review, deliver the full text for approval before replacing anything.
- An anti-bloat hook after every edit: line count (200), estimated tokens, status-line count, `AGENTS.md` size. Over the limit, it feeds a reminder back to the agent; if the hook itself fails, it never blocks work.

Consequences:
- Source tagging is the key step: it stops an agent's inference from being written down as the human's decision.

## D029 — Windows and macOS are equal first-class platforms

Date: 2026-10-09 · Status: first wave implemented · Supersedes the 2026-08-22 plan "macOS first, port to Windows later"

Context:
- A full audit on Windows found security holes, not just bugs: the JS path check only split on `/`, so `..\x.md` escaped the library; alternate data streams, 8.3 short names and case variants bypassed the sensitive-name check; `CON` could be written. Without `.gitattributes`, CRLF checkouts broke the task-header parser. 18 symlink-escape tests ran only on Unix.

Decision (maintainer asked for native Windows support in parallel with macOS; agent proposed the approach):
- One codebase, never a fork: path safety, the review format and the task bus may only have one implementation each, because two implementations mean two attack surfaces. Platform differences live in narrow branches.
- One path discipline across both languages; Windows file-name rules are one table on both sides.
- Security tests must run on Windows: directory links use junctions, which need no privileges and are the more common escape route there anyway.
- CI on macOS and Windows, Node 22 and 24, is a gate. The repository is LF; users' CRLF files are tolerated and preserved.

Consequences:
- A second wave (single instance, killing process trees with job objects, very long command lines) was listed explicitly as not done.

## D017 — Tighten external permissions before release

Date: 2026-09-12 · Status: implemented

Context:
- A combined black-box and white-box review found that the external tool allowlist did not restrict document paths, that unaccepted suggestions could pollute task control headers, and that snapshots could capture local authorization state. Docs promised "every change is reviewed" and "the working directory is the isolation", which the implementation did not deliver.

Decision:
- Path checks stay in one place; external clients get an additional resource gate: hidden paths, credentials and internal state are never exposed; agent contracts are read-only; task control goes only through dedicated tools.
- The automatic runner rejects unknown channels, unaccepted marks, duplicate control headers and symlinked tasks; tasks issued from outside run only when the runner is started with an explicit flag.
- One shared sensitive-path list feeds the external profile, JS snapshots and Rust.

Consequences:
- The docs were rewritten to claim only what the code enforces. The rules do not detect secrets with arbitrary names in prose; a person still reviews a library before sharing it.

## D012 — Local delegation: agents call each other only through files

Date: 2026-09-04 · Status: implemented

Context:
- The first use case: act as the main agent in Claude Code and hand subtasks to other local agents by strength (search, plain-language explanation, math).

Decision:
- **Agents never call each other directly; they go through task files in the library.** A delegation is a task file plus a working directory holding the transcript and outputs. Failure returns the task to pending with the error attached.
- The executor table is data: flags per CLI, binary resolution order, defaults.
- Spawn discipline: stdin always closed, the whole process tree killed on timeout.
- MCP gains a local HTTP transport (127.0.0.1 only, bearer token, Host/Origin allowlist) and two profiles: full for local agents, external for web AIs (read, suggest, drop notes; never write).
- Machine write-backs are always suggestions; nothing a machine writes changes the text until a person accepts it.

Consequences:
- Later additions in the same entry: async runs, follow-up rounds, an OAuth 2.1 server whose consent happens on the local machine (someone with the public URL cannot approve), web AIs as executors that claim tasks from the inbox. Each was verified against the real clients.

## D006 — Review format: CriticMarkup plus author signatures

Date: 2026-08-22 · Status: implemented

Context:
- Review state must be readable and writable as plain text, and agent docs are full of syntax examples that must not be mistaken for marks.

Decision:
- Standard CriticMarkup marks; content starting with `@name:` records the author.
- Text in lenticular brackets (U+3010 … U+3011) is a message to the agent: highlighted, never part of accept/reject.
- Marks inside code fences and inline code are literal text.
- Writes are atomic in the same directory; a truncated document can never be saved through review.

Consequences:
- Any editor or a bare terminal can take part in review. The parser is tested independently of the UI.

## D001 — Lock the stack and product shape

Date: 2026-08-22 · Status: implemented; snapshot engine superseded by D036

Context:
- Three parallel research tracks (competing products, agent harnesses, desktop stacks) found the gap: open source + local + Markdown-native + harness-agnostic + Word-grade review + git versioning, together.

Decision (maintainer decided the product shape; agent proposed the stack):
- Shell: Tauri 2 (Electron documented as plan B). Editor: ProseMirror with a suggest-changes plugin, plus CodeMirror 6 for source mode. Versioning: libgit2 with a shadow repository. Agent bridge: own MCP server plus an ACP client panel.
- One path-check function as the single point of trust; when the dev bridge and Rust disagree, Rust wins.

Consequences:
- Accepted the differences between two WebView engines; IME risk was explored first in a dedicated test page.
