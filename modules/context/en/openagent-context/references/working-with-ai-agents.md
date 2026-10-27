# Working with AI agents: lessons learned

This page records what went wrong when one maintainer ran long projects with AI agents, and what is done now. The rules themselves are in the [contract template](contract-template.md) and the [decision log template](decision-log-template.md); this page does not repeat them. It says where those rules came from, plus the practices that do not fit in a contract. Lessons about handing work to other agent CLIs are in the delegate module.

Each entry has two parts: **What went wrong** is what happened, **Now** is what is done since.

## 1. Keeping the contract short

- **Status lines swamped the contract.** What went wrong: after every task an agent "just updated the docs", so progress, status lines and history went into the contract, it kept growing, and the real rules were pushed out of the context window. Reminders did not stop it. Now: the contract has no status lines, only where progress is kept; it has a line limit, and past it you cut instead of adding; a hook can report the line count after each edit. Codex reads only the first 32 KiB of `AGENTS.md`.
- **The old version stays out of the contract.** What went wrong: an old contract held phase plans, status tables and a retired tech stack, and at rewrite time nobody knew what to keep. Now: delete it all, and end the contract with one line saying which commit holds the old version, to read with `git show <commit>:CLAUDE.md` when needed.
- **Settled procedures stay out of the contract.** What went wrong: every procedure written into the contract made it longer. Now: once a procedure has gone smoothly, propose at the end of the task to turn it into a skill or a template; the contract keeps one line pointing to it at most.
- **A memory index line holds only a pointer.** What went wrong: an index meant to have one line per entry had one line that kept getting progress appended until it was thousands of characters long, and every session read all of it. Now: an index line says only what the entry is and where to look; progress goes into that entry's own file or a plan document.

## 2. Writing rules that get followed

- **Rules without a source.** What went wrong: agents could not tell a hard requirement from an old suggestion, so they either clung to outdated suggestions or bent hard requirements. Now: every rule carries its source (`[owner]`, `[agreed]`, `[incident]`, `[D0xx]`; meanings in the contract template), and an agent looks up why a rule exists before bending it.
- **The human's own words never reached the contract.** What went wrong: requests repeated in chat were never written down, so every new session had to be told again. Now: when rebuilding a contract, take only the messages the human typed from the conversation history, never an agent's paraphrase of them.
- **A recommendation recorded as the human's decision.** What went wrong: the human mostly picked the agent's recommended option, the record said the human decided, and later nobody could tell whose judgement it was. Now: record it as "agent recommended, human agreed", and quote the human when the exact words matter.
- **Rules that exist only as text.** What went wrong: such a rule was forgotten the first time it got in the way. Now: each rule that must never break has something that fails when it breaks: a test, a lint rule or a CI job. A checker proves itself first: break one thing on purpose and watch it fail, then trust it.

## 3. What counts as done

- **Tests passed, the real run failed.** What went wrong: all unit tests passed, and the problem showed up only on a real model call. Now: done means it ran for real; a change that touches model calls is tried once on a real project.
- **Tests touched real configuration.** What went wrong: tests and the processes they started wrote into the developer's own configuration folder. Now: tests and every process they start point at a temporary folder.
- **One model cannot see its own mistakes.** What went wrong: two agents ran the same model, and one reading the other's diff did not catch its errors. Now: fill the gap with checks that need no judgement: declaration-by-declaration comparison, DOM or frame hashes, planted faults, mutations a test must catch.
- **One operation implemented several times.** What went wrong: the same operation lived in several places, every change missed one of them, and they drifted apart. Now: each operation has one implementation.

## 4. Several sessions and git

- **A broad `git add` committed someone else's work.** What went wrong: with several sessions sharing one working tree, `git add -A` committed another session's unfinished changes. Now: add exact paths only; before wrapping up, run `git status`, mark what this session did not change, and leave it alone.

## 5. Long projects

- **One phase, one session.** A long project is cut into phases. At the end of a phase the work is merged, the session stops and hands over an architecture diagram and a status summary; the next session confirms that state before it starts. The human says where to stop.
- **A usage limit sent the work back to the start.** What went wrong: intermediate conclusions lived only in the context, the session hit its usage limit, and the next one had to start over. Now: the plan file is written as an operating manual (principles, a brief template, a progress table the main agent keeps, decisions made so far, where a cold start begins), and intermediate conclusions go into it as they come.
- **Reasoning effort follows the stage.** Planning, splitting the work, finding a root cause and reviewing run at the highest level (named differently per vendor: max, xhigh and the like): a mistake there carries into every later step. Executing a written plan needs only high: the hard calls were made in the plan, and the highest level mostly costs time and money. When execution hits a large decision the plan does not cover, stop and take it back to planning instead of forcing it at execution effort.

## 6. Habits for directing agents

The contract template already has the rules for asking versus doing, decisions, and evidence and reporting. These are the habits it does not cover:

- **Two columns of requirements**: functional and non-functional, split before any design. A deadline is no reason to drop one of them.
- **"Do we already have what X needs?" asks for a gap list**: what exists, what is missing, how big the change is. Not for starting work.
- **Finish the main line first.** Side tasks that come up midway are noted and queued unless the human moves one forward.

## 7. Review and context isolation

- **Review with eyes that have not seen the work.** Before a plan or a change is final, give it to a reviewer who took no part in it: a new session, a new subagent, ideally another vendor's model. The reviewer's brief says what to review, what to check it against (the plan file, the contract's invariants) and the format of each finding (location, how to trigger it, severity, confidence).
- **Give material, not conclusions.** Ask "where will this break", not "is this right". Hand over your own judgement and the reviewer will mostly agree with it.
- **Findings are leads, not conclusions.** The main agent reproduces each one or checks it in the code, then decides whether to act. Findings it cannot check go to the human as a separate list, never quietly dropped.
- **Check prose for people the way you check code.** What went wrong: a delivered report read as machine-written. Now: before a report, interface text, a README or public material ships, a model with no background reads it, given only the text and who the reader is, never the conversation, the sources or a self-assessment. It points out what it cannot follow, what sounds machine-written and which claims it would question. What it cannot follow, real readers cannot follow either: fix the text, do not give it more background. A blind read does not catch wrong numbers or facts; check each one against its source separately.
- **Context steers judgement.** An agent that has read your reasoning follows it; one that has seen option A cannot judge option B fairly. For an independent judgement, keep these out of its view on purpose.
- **Isolate opinions, not facts.** Constraints, red lines, where files are and what counts as done are written out in full; your guesses, leanings and the last round's conclusions are left out. A subagent knows only what its brief says, and guesses at any fact that is missing.
- **Isolation protects the main session too.** Wide searches and reading piles of files go to a subagent; the main session takes only the conclusions, not the file-reading.

## 8. Parallel subagents

- **Independent work goes out together.** Searching a large codebase, researching several sources, reviewing one change from several angles (correctness, security, whether the docs match the code): when no piece waits for another's result, send them at the same time.
- **Writing is different.** Two writers never touch the same files; to write in parallel, each writer gets its own working tree. A step that needs an earlier step's result runs after it.
- **Each subagent gets a self-contained brief.** One checkable goal; ask for the conclusion, not the process.
- **Check each result on return.** A subagent's conclusion is a lead to check. Merge and deduplicate several reviews first, then check.
- **Parallelism trades money for time.** Several subagents cost roughly several times as much. Work that a few tool calls can finish, do yourself.

## 9. Personal habits travel with the person

- **Personal habits go into the user-level instructions.** Which language to answer in, pictures or prose, the report format, whether the agent should state disagreement plainly: these follow the person, not the project. They go into user-level files such as Claude Code's `~/.claude/CLAUDE.md` and Codex's `~/.codex/AGENTS.md`, which apply in every project. A project contract holds only that project's rules; where the two conflict, the project wins. On a new machine, bring this file over first. To write one, start from the [user-level template](user-template.md).
- **Agents tend to answer in the language their rules are written in.** What went wrong: with skills and a contract written only in English, the answers turned English too. Now: for answers in another language, use skills and a contract in that language, and state the reply language explicitly.
- **Ask for a picture by saying "visualize".** Structure, data flow and current state are easier to follow as a diagram than as long text. In a client with a drawing tool (the Claude desktop app, for example), saying "visualize" is the most reliable way to get one drawn; where there is no drawing tool, ask for a one-page HTML report or a Mermaid diagram.
