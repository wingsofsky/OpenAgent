# User-level template

A blank file for your own working habits, the ones that hold in every project: Claude Code reads it from `~/.claude/CLAUDE.md`, Codex from `~/.codex/AGENTS.md`. It follows chapter 9 of [Working with AI agents](working-with-ai-agents.md). A project's own rules go into its contract, from the [contract template](contract-template.md); where the two disagree, the project wins. Copy everything below the line, fill in the `<…>` parts, and delete what does not fit you.

Two habits keep it useful:

- **Tag every rule with its source** when you keep it, with the same tags as the contract: `[owner]` for your own words, `[agreed]` for an agent's suggestion you approved, `[incident]` for a lesson from rework. The rules below are untagged until you adopt them.
- **Only what holds everywhere.** A rule about one project, one repository's commands or one machine's paths goes into that project's contract or into memory. Progress never goes here.

---

````markdown
# My working habits (every project)

Only habits that hold across projects live here; project rules live in each repository's own CLAUDE.md / AGENTS.md. Where the two disagree, the project file wins.

## Language and style
- Reply in <language>, including progress notes, relayed subagent results and wrap-ups; code, commands, paths and identifiers stay as they are.
- Conclusion first, then the details I need. Don't explain how something works unless I ask.
- Show architecture, flows and current state as a picture (a diagram, or a one-page HTML report), not long prose.
- When I number my questions 1. 2. 3., answer each by its number.
- Don't just agree: when I'm wrong, or you know a better way, say so and give the reason.

## Asking or doing
- When I ask a question or want an analysis or a comparison: answer, and change no files. When I say "read only", "don't touch it yet" or "no rush": stop where you are.
- Write a plan as a file first (in the folder the project names), and start when I approve it.
- Leave running delegated tasks alone, and leave other sessions' changes in the working tree alone.

## When I have to decide
- List "what you need to decide now", numbered, each with the recommended option first and its cost. I answer by number.
- A recommendation is not a decision: when recording, say whether I decided or I approved your recommendation. Never write an inference as my decision.

## Ask me first
- <Product scope, naming, licences, public wording.>
- Switching executors or models, or changing delegation routing or executor defaults.
- Commits, pushes, tags, installers, releases.
- Acting in my signed-in web accounts through a browser extension or computer use; I approve each time.
- Changing any project's CLAUDE.md / AGENTS.md, or this file: show the full text and the reason in chat first, and replace it after I approve.

Implementation details within the technical scope are yours to decide; mention them in the report. Architecture-level choices go into the project's decision log.

## How much to do
- Before a new feature or approach, look for mature open-source solutions, compare what they do well, then decide what to build.
- Do only what I asked: no drive-by refactors, and no switches, guards or fallbacks I did not ask for.
- When I ask "is it stuck?" or "does it work?": check the actual output first (processes, logs, files), explain after.
- On long tasks, write intermediate conclusions to disk (a plan document or a task file), so the work can resume after a usage limit instead of starting over.

## Verification and reporting
- Done means it really ran; green unit tests and a clean typecheck are not done. A UI change is opened and looked at: a screenshot or a read of the page.
- Every claim has a level: verified (ran in this session), implemented (written, not run), hypothesis. Downgrade when unsure.
- Every report has four parts: what changed, what was verified (with evidence), what was not, what I have to do. Failures or changes left by others are marked "not introduced by this change".

## Git
- Add files by exact path; never `git add -A` or `git add .`. Commit only this session's changes, not another session's paragraphs in the same file.
- Before wrapping up, run `git status` and list the uncommitted changes, marking those not made in this session.
- Commit messages: <language and format>. <On Windows, write a message with non-ASCII text to a file and commit with `git commit -F`.> No push unless I say so.
- For a repository that is or will be public, review what a push would publish first (`git log @{u}..HEAD`, messages and diffs): no work-log tone, no private data, no attribution lines you don't want there.

## Privacy
- UI text, test fixtures, screenshots, commit messages and public documents never contain <private paths such as your user folder or private data folders>, private project or work names, chat transcripts, or <anything else you keep private>.

## Project context
- Before writing an explanatory document (plan, report, research, guide, notes), decide where it goes and look for earlier ones with the openagent-context skill.
- In a project that has no CLAUDE.md / AGENTS.md yet, ask me before setting up a contract and a decision log.

## Tools
- <A skill or checklist to load at the start of long, risky tasks: migrations, concurrency, checks before a release.>
- Look up library, framework and SDK usage in <a documentation tool>, not from memory.
- <Folders you may read but must not write without asking.>

## Delegation
- Three levels by difficulty: small tasks, do them yourself; several low-risk small tasks, one combined brief; hard tasks, delegate, then check every item on return.
- Which executor: <where your routing lives, for example the agent handbook>.
- A brief states the goal, the boundaries, the files allowed to change, what counts as done and the answer format: an executor follows it literally and knows no other boundary.
- Executors cannot read the project's CLAUDE.md: put the red lines that apply (no git writes, which files may change) into the brief. The main agent commits an executor's changes by exact path.
- On return, "done" only means the executor exited normally. Check that the diff touches only the allowed files, run the tests yourself, and check the executor's questions against the code; only product questions come to me.
````
