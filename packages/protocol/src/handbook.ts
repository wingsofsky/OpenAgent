/**
 * The agent handbook preset and the "let grok update it" prompt.
 * The handbook itself is `~/.longkeep/handbook.md` in the Longkeep home folder (HOME_LAYOUT.handbook), one page for
 * every project (a project cannot bring its own). When the file is missing, the CLI creates it from this preset;
 * from then on the file takes over. It is the shared memory across agents: people and every CLI read the same
 * page, and newer dated evidence wins over it.
 * Sources: hands-on use of each CLI, its --help and model list, and each vendor's official docs (listed after the
 * tables); every section carries the date it was checked.
 * Only general guidance (routing, each CLI's quirks, how to report back), never anyone's accounts or machine setup.
 * The preset is versioned here: when it changes, update the "Preset version" line at the top. Companion skills only describe the workflow and read the handbook before delegating; they keep no
 * experience of their own.
 */

export const HANDBOOK_SEED = `# Agent handbook

> Preset version 2026-10-29 (the preset bundled with Longkeep)

Read this page before delegating. It says which CLI to use for what, each CLI's quirks, and which models and effort levels work. New models, flags and quirks go here too.
Suggestions an executor added are CriticMarkup insertions tagged with its name, and nobody has reviewed them yet. A person keeps one by deleting its marks, or drops it by deleting the block (or asks the main agent to do either); kept text becomes part of the page.
Where things live: this page is \`~/.longkeep/handbook.md\`, one page for every project. Delegation transcripts are \`~/.longkeep/runs/<project-key>/<task-id>/transcript.md\`.
Every entry carries the date it was checked. When it conflicts with newer dated evidence (that day's --help, the local model cache, an error in a delegation transcript), the newer evidence wins; then come back and fix this page. Entries marked "unverified" are for reference only.
This is the general preset: adjust it to the CLIs you have installed and the plans you pay for.

## Routing (2026-10-16)

| Task | Send to | Model · effort | Why |
|---|---|---|---|
| Multi-file implementation, running tests, engineering changes | cursor (working in a code worktree: give it a workRoot, or declare a custom executor pinned to the worktree) | a strong model with an effort suffix, such as claude-opus-5-5-high; out of quota → grok-4.7-xhigh-fast | Steady on multi-file changes. No write sandbox: check git status when collecting |
| Web search, X / GitHub intelligence, what's new | grok | grok-4.7 · high | Built-in web and X search that cites sources |
| Explaining, teaching, plain language, front end, copy | agy | gemini-3.8-flash-high (deeper: gemini-3.1-pro-high), no separate effort | Clear explanations, natural prose, good front-end code |
| Translation | grok or agy | — | Both translate well; see "Before a batch" |
| Math, numerics, scientific code | codex | whatever the model cache currently lists · high | Needs model entitlement on your plan (see "Before a batch") |
| Breaking work down, writing docs, reviewing, acceptance | the main agent | — | It holds the whole context |

## Quirks (2026-10-16)

- **codex**: "signed in" does not mean you are entitled to a model: a retired model, or one your plan does not include, returns 400 while the CLI still shows signed in (see "Before a batch"). Codex models execute acceptance criteria literally and can stop with zero changes on any conflict, so the brief must state the goal, which files may change and what counts as done. The workspace-write sandbox cannot see a per-user pnpm (run node entry points directly); for scientific code that cannot see a per-user Python, pass sandbox=danger-full-access. exec resume continues sessions natively but has no -s, so the runner passes the sandbox as -c sandbox_mode=…; a resumed round keeps the sandbox it is given (checked 2026-10-26). The sandbox makes .git read-only and has no network (unverified). The hash directory under bin changes with every upgrade, so custom executors with a hard-coded command must follow.
- **agy**: good at explanations, front end and natural prose. Headless mode must run with prompts skipped (the runner passes --dangerously-skip-permissions by default), otherwise even file reads are denied and the answer is empty. Models with a suffix (gemini-3.8-flash-high) carry their own effort; passing a different --effort is a conflict error. --conversation continues sessions natively. Fanning out a batch quickly hits the per-account quota (429), which takes hours to reset: keep batches small.
- **grok**: search is built in (search_web / search_x). Give it three instructions, "cite sources, give dates, report only what changed relative to now", or the answer is fluff. Keep tasks bounded: one deep search can burn over a million tokens. In json mode it prints only when finished, so do not treat silence as a hang. -s only creates new sessions (resuming with -s fails with "Session ID … is already in use"); the runner resumes with --resume.
- **cursor**: headless needs -p --force --trust; without --trust it hangs on workspace trust. No write sandbox: check git status when collecting. Always pass a model explicitly: otherwise it uses the default in its config, which may be the most expensive tier; use model ids that carry an effort suffix. Two parallel runs on one account can hit resource_exhausted; on Windows, Git Bash must be on PATH. It builds its project directory name from the full working-folder path, so a deeply nested working folder (over about 250 characters in total) fails with ENAMETOOLONG. Follow-up rounds resume the session with --resume (checked 2026-10-26).
- **claude**: on Windows the claude.exe managed by the desktop app sits one hash directory deeper; if the registry cannot find it, set LONGKEEP_CLAUDE_BIN. Follow-up rounds resume the session with --resume (checked 2026-10-26). Claude Code's auto-mode safety check has refused the combination "danger-full-access + a prompt asking it to npx-download and run something" (unverified).

## Effort levels (checked 2026-10-16 against each CLI's --help and local model cache)

| CLI | Levels | How it is passed |
|---|---|---|
| codex | low · medium · high · xhigh · max (gpt-5.6-terra also has ultra; no minimal) | -c model_reasoning_effort="…" |
| agy | low · medium · high · xhigh · max | --effort (not for suffixed models) |
| grok | grok-4.7 / 4.6: low…xhigh (default high); grok-4.5: low…high | --reasoning-effort (alias --effort) |
| claude | low · medium · high · xhigh · max | --effort |
| cursor | not passed separately: pick a model id with an effort suffix, such as claude-opus-5-5-high, grok-4.7-xhigh-fast | --model |

The Longkeep runner accepts five levels, minimal…xhigh: for codex / agy / grok / claude, minimal becomes low and xhigh is passed through; cursor gets no effort. For max / ultra, put it in the CLI's own config (for codex, ~/.codex/config.toml) or in a custom executor's arguments.

## Available models (each CLI's own list is authoritative)

- **codex**: ~/.codex/models_cache.json lists what your plan can use (2026-10: gpt-6-luna, gpt-5.6-terra, gpt-5.6-luna; gpt-5.6-sol and gpt-6-astra are retired). Once the default model in config.toml is retired, calls without a model also return 400.
- **grok**: grok models or ~/.grok/models_cache.json (2026-10: grok-4.7, the flagship; grok-4.7-build-fast, twice the price; grok-4.6; grok-4.5).
- **agy**: agy models (needs network); gemini-3.8-flash-high and gemini-3.1-pro-high are known to work (2026-10).
- **cursor**: cursor-agent models (needs network); claude-opus-5-5-high and grok-4.7-xhigh-fast are known to work (2026-10).
- **claude**: --model takes aliases such as fable / opus / sonnet or full model names.

## Presets (2026-10-16)

- Multi-file implementation: cursor · claude-opus-5-5-high; out of quota → grok-4.7-xhigh-fast
- Search / what's new: grok · grok-4.7 · high
- Explaining / teaching / front end / copy / translation: agy · gemini-3.8-flash-high; deeper → gemini-3.1-pro-high
- Math / scientific code: codex · whatever the model cache lists · high (probe first)

Two ways to set them, both editing the same file, \`~/.longkeep/executors.json\` (shared by every project): tell the main agent "switch grok's default to grok-4.7 high" (set_executor_defaults), or edit the file by hand. \`longkeep delegate --list\` shows each executor with its current defaults; \`longkeep doctor\` checks that each CLI is installed and signed in.

## Reporting back to the human (2026-10-22)

How the main agent reports what it and the executors found:

- **Conclusion first, in plain words.** One or two sentences a non-specialist can act on, then the details. Name what was verified and what was not.
- **Draw when the point is shape, not prose.** Architecture, how parts connect, a flow or sequence, a before/after, a comparison across options, progress over many items: draw it. Use the client's visualization tool if it has one (an inline diagram or widget tool, an artifact or page); otherwise a Mermaid block in Markdown; otherwise a table. One idea per diagram, the explanation stays in the text.
- **Tables for comparisons.** When several executors or options are compared (a cold read by three models, quota per CLI, test results), put them in one table with the same columns, not three paragraphs.
- **Only verified numbers in a chart.** A diagram looks authoritative; draw what was measured or read from files, mark estimates as estimates, and never chart numbers an executor made up.
- **Ask executors for structure.** When delegating something that will be reported, ask for a table or a short list in the answer, so the main agent does not have to restructure prose.

## Before a batch (2026-10)

- Most failed delegations are quota, entitlement or temporary capacity, not the task itself: probe with one sentence before a batch and send real work only after it passes.

## Sources

- Each CLI's --help and model list, checked 2026-10-16: codex 0.162, grok 1.0, agy 1.3, cursor-agent 2026.10, claude 2.1
- Official docs: learn.chatgpt.com (Codex config), antigravity.google (agy headless flags), docs.x.ai (Grok Build), cursor.com (Cursor Agent model strings)
`;

/** A ready brief for "let grok search for new models and field notes"; nothing sends it automatically */
export const HANDBOOK_UPDATE_PROMPT = `Search the web for what changed in the last 30 days in these five command-line agents: Codex CLI, Antigravity CLI (agy), Grok Build CLI, Cursor Agent CLI, Claude Code.

Look for: new models, retired models and recommended usage; changes in effort levels; changes in headless flags (-p / --output-format / resume / skipping permission prompts / workspace trust); practical experience and pitfalls the community agrees on.

Requirements:
1. Output only additions and corrections relative to "Current handbook" below; do not repeat what is already there and unchanged.
2. Give a source link and date for every item; leave out anything without a reliable source.
3. English, under 400 words, in subsections "Routing / Quirks / Effort levels / Available models / Presets".
4. The answer will be written back into the handbook as suggestions tagged with your name that a person keeps or deletes one by one, so write sentences that can be merged as-is, each with a date.`;
