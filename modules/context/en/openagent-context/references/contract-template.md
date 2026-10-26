# Contract template

A blank `CLAUDE.md` (or `AGENTS.md`) built from the practices in [Working with AI agents](working-with-ai-agents.md); its decision log starts from the [decision log template](decision-log-template.md). Copy everything below the line into your project and fill in the `<…>` parts. Delete what does not fit; add only rules you would be annoyed to repeat.

Two habits keep it useful:

- **Tag every rule with its source** when you keep it: `[owner]` for your own words, `[agreed]` for an agent's suggestion you approved, `[incident]` for a lesson from rework, `[D0xx]` for a decision log entry. The rules below are untagged until you adopt them.
- **Keep it under 150 lines.** Progress, status and history go in the files named in the last section, never here.

---

````markdown
# CLAUDE.md: <project name>

<One or two sentences: what this project is, who it is for.>
This file holds only the rules every session must follow. Progress and history live elsewhere (see "Where things are").

## Working with me

### Asking or doing
- When I ask a question or want an analysis or a comparison: answer, and change no files.
- When I say "read only", "don't execute yet" or "wait": stop where you are.
- Before a large change: restate my goal and the gap to the current state in your own words, then write a plan file. Start when I approve it.
- When unsure what I mean, go by the purpose, not the letter. If still unsure, ask.

### When I have to decide
- List "what you need to decide now" as numbered items. Each has the recommended option first, its cost (what changes for users, what it costs, what it touches) and the alternative.
- A recommendation is not a decision. When recording, say whether I decided or I approved your recommendation.
- Things decided only by me: <product scope, naming, pricing, licences, public wording, switching models or executors, commits, pushes, releases, production data>.

### Scope
- Do only what was asked: no drive-by refactors, no switches, guards or fallbacks nobody asked for.
- No new or upgraded dependencies without asking.
- Implementation details within the technical scope are yours to decide; mention them in the report, and record lasting ones in the decision log.

## Evidence and reporting
- Every claim has a level: verified (ran in this session), implemented (written, not run), hypothesis. Downgrade when unsure, never upgrade.
- Fidelity, highest first: a real run > integration tests > unit tests > typecheck > reading the code. Green tests alone are not done. A user-facing change is opened and looked at.
- When output is bad, look upstream first: was the information enough, then the prompt, then the model. A root cause needs authoritative evidence (logs, the database, version history, a real request), not only a reading of the code.
- The same approach failing twice means a new diagnosis, not a third try.
- Every report has four parts: what changed, what was verified (with evidence), what was not, what I have to do. Failures or changes you did not cause are marked "not introduced by this change".
- Conclusion first. Use a diagram or table when the point is structure or comparison.
- Money and tokens come from the vendor's dashboard or a ledger, never estimates. Give the unit price before adding a model or service.

## Delegation
- Small tasks: do them yourself. Several low-risk mechanical tasks: one combined brief. Hard tasks: delegate, then check every item.
- A brief is written for a literal executor: goal, working folder, files allowed to change, what not to do, what counts as done, the answer format. It cannot ask follow-up questions.
- Check each claim in a brief against the current HEAD before sending it; name the existing tests the change will break and how to handle them.
- An executor's "done" is not acceptance: read the diff (only allowed files touched?), run the tests yourself, then record the verdict.
- Executors make no git writes; the main agent commits by exact path.
- One task per worktree at a time.

## Git
- Add files by exact path; never `git add -A` or `git add .`.
- Before wrapping up, run `git status` and list uncommitted changes, marking those not made in this session. Leave other sessions' changes alone.
- No commit, push, tag or release unless I say so.
- <Commit message format, e.g. Conventional Commits.>

## Project invariants
<Only the rules that must never break, each with the test or check that enforces it.>
- <invariant>: enforced by <test or check>.

## Commands
```bash
<install>
<typecheck>
<test>
<run locally>
```

## Where things are
| What | Where |
|---|---|
| Decisions and their reasons | `DECISIONS.md`, append-only; a reversal is a new entry |
| Lasting facts across sessions (preferences, environment pitfalls, outside resources) | the agent's memory: `MEMORY.md`, one line each, details in separate files. A preference that keeps coming back is proposed for this file |
| Plans and progress | `docs/plans/` |
| Reports, wrap-ups, post-mortems | `docs/reports/` |
| Research and comparisons | `docs/research/` |
| How-tos | `docs/guides/` |
| Architecture | `<architecture doc>`; the code wins when they disagree |

A session starts by reading the newest plan and the last decision entries, and runs `git status` and `git log --oneline -10`. Don't assume the last session finished.
````
