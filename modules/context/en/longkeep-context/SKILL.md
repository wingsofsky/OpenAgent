---
name: longkeep-context
description: Keep a project's context in documents that every agent session reads. Use whenever you are about to write an explanatory document (plan, report, research, guide, review, notes) or need an earlier one, since it says where documents go under docs/ and how to find them. Also when checking up a project's documents, and when setting up or tidying a project's contract (CLAUDE.md / AGENTS.md), its decision log (DECISIONS.md) or the agent's memory index (MEMORY.md), and when the user asks how to keep a long project on track with AI agents (review, context isolation, parallel subagents, reasoning effort, where personal habits go). Use when the user says "write up a plan", "where did we put the report on X", "what did we decide about Y", "set up CLAUDE.md for this project", "start a decision log", "check up this project's documents".
---

# Project context in documents

A new agent session knows only the files it reads. This skill decides what those files are: explanatory documents go to fixed places under `docs/`, and three files hold what every session reads first.

| File | Holds |
|---|---|
| `CLAUDE.md` / `AGENTS.md` | the project's contract: rules every session follows, each with its source, under 150 lines |
| `DECISIONS.md` | each design choice with its evidence and who made it; entries are only ever added |
| `MEMORY.md` | the agent's index of lasting facts: the user's preferences, machine quirks, where things are |

Progress goes in `docs/plans/`, never in these three.

## Finding a document

Whenever you need an earlier plan, report, decision or note, and every time before you write a new document:

1. **Start where the project points.** Its contract (`CLAUDE.md`, `AGENTS.md`) often has a "where to find things" section, and some projects keep an index (`INDEX.md`, `docs/README.md`). Follow those first; they win over the steps below.
2. **Otherwise look in the matching `docs/` category.** Names start with the date, so a folder sorted by name runs from oldest to newest: read the newest first, and treat older files as history.
3. **Search before you conclude there is nothing**: topic words in file names first, then in the text (`grep -ril <word> docs/`).
4. **A document describes the day it was written.** Before you rely on it, check the code, `git log` or a newer document, and follow a "superseded by" or "outdated" note to its replacement.
5. **Found one on the same matter? Update it** instead of starting a new file.

## Filing a document

Whenever you create an explanatory document (a report, plan, research or reading notes, a guide, a review, a checklist), and nothing on the same matter exists yet:

1. Put it under the project's `docs/`, in a category folder, created if missing:
   - `docs/reports/`: work reports, wrap-ups, post-mortems
   - `docs/plans/`: plans, designs, roadmaps
   - `docs/research/`: research, comparisons, notes on papers or books
   - `docs/guides/`: usage notes, how-tos
   - not sure: `docs/notes/`
2. Name it `YYYY-MM-DD-<topic>.md`, so that it sorts by date and its topic can be found by name.
3. **Never** in the project root, in a code folder (`src/` and the like), or in a new top-level folder made up on the spot.
4. When the project's own contract sets other rules for documents, those win.

How the document is written is not this rule's business; it only has to stand on its own (the title says what it is, when, and about whom).

## Setting up the contract, the decision log and memory

When the user asks to set up or tidy these files, or a project has none and the user agrees:

- **Contract**: start from [references/contract-template.md](references/contract-template.md). Show the user a draft filled in from what you know of the project and of them; write `CLAUDE.md` only after they approve it. If the project also needs `AGENTS.md` (Codex and others read that name), make it a link to `CLAUDE.md` or a one-line pointer, never a second copy.
- **Decision log**: start from [references/decision-log-template.md](references/decision-log-template.md). One entry per architecture-level choice, newest first, append-only, and every entry says who decided. A recommendation the user accepted is recorded as such, never as the user's own decision.
- **The user's own habits**: start from [references/user-template.md](references/user-template.md). They go into the user-level file (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`), never into a project's contract. Show the draft and write it only after the user approves.
- **Memory**: `MEMORY.md` is an index, one line per fact, details in separate files. A preference that keeps coming back is proposed for the contract.
- **Every rule carries its source**: `[owner]` for the user's own words, `[agreed]` for a suggestion they approved, `[incident]` for a lesson from rework, `[D0xx]` for a decision log entry.

How these habits came about, and the working practices that go with them (review, context isolation, parallel subagents, reasoning effort, where personal habits go): [references/working-with-ai-agents.md](references/working-with-ai-agents.md). Read it first when the user asks about any of these.

## Checking up a project

When the user asks for a checkup of the project's documents, or agrees to the one offered after setup. A report comes first; nothing is moved or written before the user approves it.

1. **Look.** Where explanatory documents are now (`git ls-files '*.md'`); `CLAUDE.md` / `AGENTS.md`: their length, progress or status lines in them, statements the code no longer bears out, an `AGENTS.md` that is a drifted copy; a decision log (`DECISIONS.md`, `adr/`, `docs/adr/`) or none; commit conventions (`git log --oneline -30`, `CONTRIBUTING.md`, commitlint and the like).
2. **Report**, with evidence for each finding (a path, a command's output), and ask which of the two steps below the user wants.
3. **Moving documents.** List each file with its target under `docs/` and its new date-first name; existing conventions in the contract win. After approval, move them with `git mv` and fix the links that pointed at them.
4. **Rewriting the contract.** Gather material:
   - the current contract, each line checked against the repository;
   - what the user keeps repeating: if the Longkeep sessions module is installed, importing with `--prompts` writes `USER_PROMPTS.md` and `USER_RULES.md` under `_prompts/` in the archive. A rule needs two or more places where the user said it, quoted as written;
   - the user's own experience: ask what they keep correcting and what went wrong before;
   - the commit conventions found in step 1.

   Decide each item: keep it in the contract (it changes what an agent does, cannot be read from the code, and is costly to get wrong); delete it (the model does it anyway, the code shows it, or it is outdated); or move it (decisions to `DECISIONS.md`, progress to `docs/plans/`, preferences that are not settled yet to memory). Draft from the [contract template](references/contract-template.md), under 150 lines, every rule with its source. List the rules you inferred yourself separately and ask about each one.
5. **Deliver.** Show the whole draft in the chat, with what was removed and why. Replace the file only after the user approves; if `AGENTS.md` is a link or a one-line pointer to `CLAUDE.md`, keep it that way.

## Don'ts

- Don't write progress, status lines or history into the contract.
- Don't change the user's `CLAUDE.md` or `AGENTS.md` without showing them the draft first.
- Don't rewrite a decision log entry to say something else; a reversal is a new entry.
- Don't create a new document when one on the same matter exists.
