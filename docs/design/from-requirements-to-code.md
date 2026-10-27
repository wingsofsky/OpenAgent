# From requirements to code with AI agents

This is how I take a vague need to working code with several AI agents, and how I handle changes after the first version. The steps are in the order I use them on long projects. Their names come from requirements engineering (elicitation, analysis, specification, validation, change management). The rules behind each step are in [working with AI agents](../../modules/context/en/openagent-context/references/working-with-ai-agents.md) and [delegation practices](../../modules/delegate/skills/openagent-delegate/references/delegation-practices.md). A real example from one feature is at the end, with private details left out.

## Terms

Terms from requirements engineering and testing follow the usual course and ISTQB meaning. The others are specific to how I work with agents.

| Term | Meaning in this guide |
|---|---|
| Main agent | The agent session I talk to, Claude Code in my case. It plans, delegates, checks and reports. |
| Executor | Another agent CLI, such as Codex, Cursor Agent, Grok Build or Antigravity, or a subagent of the main agent, that gets a delegated task. The [delegation tools](../../modules/delegate/README.md) in this repository start executors and keep a record of each task. |
| Brief | The written task an executor gets: the goal, the files it may read and change, the acceptance criteria and the format of its answer. |
| Reviewer | A fresh session or model that reads a plan, a document or a result without the conversation in which it was made. |
| Project contract | The instruction file every agent session reads first (`CLAUDE.md` or `AGENTS.md`). |
| Plan file | A Markdown file under `docs/plans/` with the plan, the open questions, a progress table with one row per phase and the backlog. Diagrams and HTML reports sit next to it. |
| Module | A self-contained part of the product with its own tests, for example one group of tools. |
| Phase | A part of the plan that a single session can finish and check. A module takes one or more phases. |
| Decision log | `DECISIONS.md`, append-only, one entry per decision with who made it. |
| Functional / non-functional requirements, constraints | What the system does / how well it does it (quality requirements) / fixed conditions on the solution (pseudo requirements). See step 5. |
| Acceptance criteria | Conditions that pass or fail and decide whether a requirement is met. Where possible each becomes an automated test. |
| Validation | Checking the requirements, or a finished feature, against what users actually need. Checking the code against the requirements is verification, which is what tests do. |
| Beta test | Validation by real users before a feature is open to everyone. Mine are invite-only. |
| End-to-end check | A run of one whole flow through the real stack: web app, AI service, database and real model calls. |
| Smoke test | A few quick end-to-end runs of the main flow, to see that a change to model calls works at all before the detailed checks. |
| Regression tests | The automated tests and end-to-end checks that run again before each release, to show that existing behaviour still works. Some of the end-to-end checks are manual. |
| Change request | A new or changed requirement that arrives after the plan was approved. |
| Real project | My own writing, published or not, or a test copy of it. Other users' text and third-party works are never used for tests. |

## Requirements elicitation

### 1. Start from the vague need

Most work starts when something in the product feels slow or is missing, either to me or to a user. I write it down in a few plain sentences. The main agent asks about anything unclear and writes no code at this stage.

### 2. Understand the market

The main agent, or an executor with web search, finds out who else has this problem and how they deal with it today. What comes back is a short note on the target users, on where the product should beat existing tools, and on what to leave out.

### 3. Look at existing projects

An executor with web search looks for open-source projects that already cover the need. I use Grok Build here, because its CLI can also search posts on X (formerly Twitter). For each project it lists the parts I could reuse and the parts that do not match my needs. If I build it myself anyway, I write the reason in the decision log.

### 4. Write the requirements as a numbered list

I send all requirements in one message, numbered. The last item tells the main agent what to do with the list, usually to plan it and change nothing yet.

```text
1. Switching the model for one provider means editing code by hand. It should be a setting.
2. The cost of each model call is not visible anywhere.
3. ...
7. Split these up and plan them first. Do not change any files yet.
```

Because the items are numbered, the main agent answers them one by one and I can decide in a single line, such as "1 and 3 as recommended, 2: the second option".

## Requirements analysis and specification

### 5. Classify the requirements

The main agent restates the list in its own words without touching any file, and sorts each item into one of three groups:

- **Functional requirements**: what the system does in its interaction with users and other systems.
- **Non-functional requirements**, also called quality requirements: usability, reliability, performance, security, cost.
- **Constraints**, also called pseudo requirements: fixed conditions on the solution, such as a required language, a hosting region or a law.

All three groups go into the plan. I correct any item it misread in my next message.

### 6. Research the legal constraints

Where the product handles personal data or reaches users in other countries, I research the law before the design starts. I do this in the ChatGPT and Claude web apps, whose research modes in my experience find and cite legal sources more reliably than a coding agent. The questions are numbered, like the requirements:

```text
1. Which laws apply to this product in each target country?
2. What do they require for storing and processing user data?
3. What do they require from the AI providers the data passes through?
4. Can the data leave the country or the EU, and on what terms?
5. What has to be in place before launch, and what before opening to the public?
6. Which of these need a lawyer rather than research?
```

The answers are added to the constraints from step 5. Items that cannot be done yet are recorded as open items, each with the stage at which it becomes due.

### 7. Write acceptance criteria

Each requirement gets at least one acceptance criterion that passes or fails. "Users only see their own projects" becomes: with user A's token, a request for user B's project returns 404. Where possible the criterion is turned into an automated test, and it is copied into the brief, so that it later decides whether the executor's work is accepted. If I cannot write a pass/fail criterion for a requirement, it goes back to step 1.

## Design and validation

### 8. Design the architecture

The main agent writes the plan into a plan file, with an architecture diagram or a one-page HTML report next to it, because I check structure faster in a picture. Open questions are numbered. Each comes with a recommended option first and what it costs. I answer by number and approve with a short "yes" or "start". Each decision log entry says whether I made the decision or accepted the main agent's recommendation.

### 9. Validate the requirements and the plan

A reviewer reads the requirements and the plan before any code exists, ideally a model from another vendor. It gets the plan and the constraints, but not the conversation that produced them. I ask it where the plan will break, and whether each requirement is correct, clear (it can be read only one way), complete, consistent with the others, realistic and verifiable. The main agent checks each finding against the code, the plan file or the decision log, and I change the plan only for findings that hold up.

## Build

### 10. Implement in phases

Each phase starts in a fresh session that first confirms where the last one stopped. The main agent does small tasks itself. It bundles several low-risk tasks into one brief and gives each hard task its own brief. An executor's "done" is not acceptance. The main agent reads the diff, runs the tests derived from the acceptance criteria and records whether it accepts the result.

Before a phase counts as done, I also check three things myself: I compare the API documentation with what the code actually exposes, run the smallest flow by hand the way a user would, and read the real output, such as a generated chapter or a response body, not a summary of it.

### 11. Build the smallest version first

The first build is the smallest version that runs end to end on one real project. It shows whether the approach works and what the output looks like before other code depends on it. A change to model calls also gets a smoke test. Model output is not deterministic, so the smoke test runs a few times and checks the format of the output, not its wording.

### 12. Add modules one at a time

Features are then added as separate modules, each with its own tests and its own phases in the progress table. A module that others depend on is finished and checked first.

## After the first version

### 13. Validate with users

To check whether the requirements themselves were right, I use the feature on my own real project first and then give it to users in a beta test. What they report comes back as a numbered list and starts again at step 4.

Using a feature can also show that it should be removed. I once built a multi-step revision pipeline that passed its tests. On my own chapters on the live site I read its output next to that of a single model call given the full context, preferred the single call, and removed the pipeline (about 5,300 lines).

### 14. Keep a backlog

Ideas that come up in the middle of a phase are written to the backlog in the plan file. The current phase finishes first, and I decide when a backlog item moves up.

### 15. Handle change requests, refactor when needed

When a change request does not fit the current structure, I decide whether to patch around it or restructure. My largest refactor started because agents needed the same features as the web app, while much of the logic still ran in the browser, and every other caller would have had to copy it. A refactor gets its own plan file, phases and reviewer, like new work. It also needs proof that behaviour did not change, for example a comparison of what the system sends to a model before and after. It is released only after the full regression tests pass.

## Rules that hold in every step

- **Private material.** Unpublished manuscripts, personal files and third-party texts in the project folder are never committed, deployed or used as product data. The project contract tells every agent to leave them alone. An agent reads one only when I ask for that task, and its content goes to an executor or a reviewer only with my approval and with names and contact details removed. Nothing enforces this at the file level yet, so I check commits instead: each adds exact file paths, and before I close a piece of work the main agent lists every uncommitted file.
- **Test data.** Test projects, fixtures, screenshots and commit messages use neutral names or a `[TEST]` prefix.
- **Briefs.** A brief names the files the executor may read and change, and nothing from the private folders. Executors work in a scratch folder by default and touch the project only when the brief allows it.
- **Production data.** Tests use local data. A write to production needs my approval for that specific task.
- **Leaked keys.** When a key leaks, every key in that environment is replaced and the services are rebuilt before other work continues.

On my own projects I work alone. In a team, the roles map like this:

| In this guide | In a team |
|---|---|
| my approval | the product owner or the client |
| plan file | design document or ticket |
| decision log | architecture decision records (ADRs) |
| backlog | product backlog |
| reviewer | review by a colleague, on the plan and on the pull request |
| regression tests | CI pipeline plus a release checklist |

In a client project I also ask first which tools and model providers the client allows and what data may leave their network. If the client approves only a single tool, it does every step, and the web research in steps 2 and 3 and any second-vendor review in step 9 are dropped or done by hand.

## Example: connecting outside agents to my writing platform

This happened on my writing platform between 28 July and 2 August 2026. Names of private projects are left out. The sections follow the step numbers above, although the test run under step 13 happened before the modules under step 12, and its results set their scope.

The feature uses MCP (Model Context Protocol), the standard way for an agent such as Claude Code to call tools from an outside service.

**Need (1).** I wanted agents such as Claude Code to run a writing session themselves and use the platform for two things they cannot do alone: the book's memory (setting notes, chapter summaries, style rules) and the polishing step, which removes typical AI phrasing from a draft. Until then both lived only in the web app.

**Market and existing projects (2, 3).** A feasibility note looked at how others expose writing and research tools to agents over MCP. A research search service offered an MCP server with OAuth sign-in (the standard way to let an app act on a user's account) and paid tiers. A community MCP server for another writing app had 57 tools, which I took as a warning about scope, so I kept the tool count small. Two popular writing apps had no API at all. The login provider already shipped an MCP library, so authentication would not have to be written from scratch.

**Requirements, constraints and acceptance criteria (4 to 7).** I cut the scope in the main agent's second round of questions. The first version would serve only me, with no public server, no OAuth and no pricing. It would expose only the polishing rules, retrieval over the whole book, maintenance of the setting notes and saving style decisions. Every saved chapter is also mirrored to a local file. Model calls go through the web app's API, as in the browser, so the same quotas apply. One rule was written down from the start: no other user gets access before per-user authentication exists. The legal research for the platform shaped its privacy policy, and its open items are recorded with their due stage.

**Architecture (8).** For opening the server to other users there were two options. A was a package that people install locally, as a stopgap. B was a remote endpoint on the web app's existing API, with nothing to install. I chose B, because users then only paste one prompt into their own agent, and every request passes the same identity check and quotas as the web app. The tools are defined once and shared by the local and the remote server, so both expose the same tool definitions.

**Validation (9).** I did not have the plan reviewed separately for this feature. A review at the end of the first build found a bug, described below.

**Smallest version (10, 11).** A local MCP server with 13 tools. An end-to-end run on my machine cost 0.53 USD, checked 11 tools and found three bugs. Among them were a save lock (which stops two saves from overwriting each other) that expired as soon as it was issued, and a project summary of 93,000 characters for a long book, which was cut to 9,300. The review at the end found a fourth: the polishing step silently cut text over its size limit. It now skips the step and says so.

**Modules (12).** Planning, writing and review tools came first, with progress messages that keep long calls alive. Per-user tokens came next, built by an executor (a subagent of the main agent). They are stored only as a hash and shown once, and a token cannot create or revoke other tokens. Sixteen end-to-end checks covered them, among them two users who cannot see each other's projects, a revoked token failing on the next request, and a user with a quota of zero refused before any model call. The tool output also stopped carrying the reason behind each polishing edit, so that an outside agent cannot rebuild the rule set from it. The remote endpoint from option B came last.

**Test run and my own use (13).** I delegated a test run to Codex: write 20 chapters of a test book with the tools and report. Storage and retrieval worked, but the planning, writing and review steps had no tools, and long tool calls hit the MCP client's default 60-second timeout. After the fixes, the main agent listed four open questions, numbered. I answered them in a single line, and the decision log quotes my answer. After the release I connected my own Claude Code to production with my own token and used it there.

**Backlog (14).** OAuth for web-based connectors, token scopes, token expiry and an audit log went on the backlog.

**Release.** Before the release a reviewer session repeated the whole verification: type checks, the test suites, a production build and the end-to-end checks, with the token checks repeated independently. Everything reached production on 2 August, where a made-up token was refused.

## Reporting

Every report from the main agent has four parts: what changed, what was verified (with the evidence), what was not verified, and what I have to do. Each claim carries one of three labels: verified (run in this session), implemented (written but not run) or hypothesis (inferred). When unsure, the main agent uses the lower label. Nothing is pushed until I say so.
