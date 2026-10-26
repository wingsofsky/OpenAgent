# Decision log template

A blank `DECISIONS.md` for a project. Copy everything below the line into the project root and keep adding entries. The [contract template](contract-template.md) points to it, and every rule in the contract that came from a decision carries its ID, such as `[D012]`.

How the log works:

- **One entry per architecture-level choice**: a new contract or file format, a new dependency, a departure from the chosen stack, a security boundary, a change to what the product is. Bug fixes and refactors without a new rule do not get entries.
- **Newest first, append-only.** An entry is never rewritten to say something else. A reversal is a new entry, and the old one's status says "superseded by Dxxx".
- **Three parts**: context (what forced the decision, with evidence), decision (what was chosen, and the options that were not), consequences (costs, limits, what is not verified yet).
- **Who decided is written down**: "the owner decided", "agent recommended, owner approved", or "agent decided within a standing authorization". An agent's inference must never be remembered later as the owner's decision. When the owner's own words matter, quote them.
- **A behaviour change made during a cleanup or a move is a decision too**, and gets its entry before the code.

---

````markdown
# Decisions

Architecture-level choices, newest first. Entries are only added; a reversal is a new entry.

## D002: <the choice, in one line>

Date: YYYY-MM-DD · Decided by: owner | agent recommended, owner approved | agent, standing authorization · Status: proposed | implemented | superseded by D0YY

Context:
- What forced the decision, and where the evidence is (a log, a measurement, a failing test, a document).

Decision:
1. What was chosen.
2. The options that were not chosen, and why.

Consequences:
- What changes, and what it costs.
- What to watch for later; what is not verified yet.

## D001: Keep a decision log

Date: YYYY-MM-DD · Decided by: owner · Status: implemented

Context:
- Choices made in chat were forgotten between sessions, and agents later quoted their own suggestions as the owner's decisions.

Decision:
1. Every architecture-level choice gets an entry here, newest first, append-only, stating who decided.

Consequences:
- Rules in `CLAUDE.md` that come from a decision carry its ID, so an agent can look up why a rule exists before bending it.
````
