# Delegation practices

What went wrong when work was handed to other agent CLIs, and what is done now. How to call the tools, probe, accept and follow up is in [SKILL.md](../SKILL.md); routing, quirks, models and effort levels per CLI are in the agent handbook.

Each entry has two parts: **What went wrong** is what happened, **Now** is what is done since.

## 1. Whether to delegate

- **Three sizes of work.** Small tasks (a few lines, one lookup, one command) the main agent does itself. Several low-risk mechanical jobs (pure moves, pure function extraction, bulk renames) go out together as one task. Hard tasks (multi-file implementation, concurrency, migrations) go out, and come back to be checked item by item.
- **Delegating saved no time.** What went wrong: writing the brief and checking the result took longer than the executor saved. Now: note the executor's time, the time spent on the brief and the check, and the rework the check found. When the brief and the check cost more than they save, when what is left is small, or when the executor's quota is unreliable, the main agent takes the work back.
- **Mechanical work comes with a file list.** Translating comments, renaming and moving files go to an executor with the list of files it may change; the main agent reads the diff.

## 2. The brief

- **The brief described a state that no longer existed.** What went wrong: the brief's account of the code did not match HEAD, the executor followed it literally, stopped with zero changes, and a round was wasted. Now: before sending, check every statement about the current state against HEAD, and say for each existing test the task will break how it should be handled.
- **The executor did not know the red lines.** What went wrong: an executor cannot read the project's contract, so it did not know which files are off limits or that it must not write to git. Now: the brief states the relevant red lines (no git writes, which files may change); the main agent commits by exact path and names the executor and model at the end of the commit message.
- **Reasoning effort follows the task.** Design and review tasks get a high level, implementation tasks get high: the hard calls belong in the design task.

## 3. Taking the work back

- **The check cannot be skipped.** What went wrong: over one long refactor, about one task in six turned out to have a real problem on checking, and the executor's own report gave no sign of it. Now: first confirm the diff touches only allowed files, then run the tests yourself; check every issue the executor raises in the code, and ask the human only about product questions.

## 4. Review and questions of taste

- **Review goes to another vendor.** Before a plan or a change is final, send it to another vendor's CLI for review. By default it runs in a scratch folder inside its record and cannot touch the project; run it in the background and keep working. Pick a model different from the main agent's: the same model has the same blind spots. The review brief says what to review, what to check it against and the format of each finding; each finding is checked when it comes back.
- **Questions of taste go to several vendors.** A design, a piece of prose, a first impression: send the same brief to several, each with a clean context, no internal contract and no extra constraints; the main agent collects the answers and the human decides.
- **The executor read the machine's private configuration.** What went wrong: most agent CLIs read the user's global instructions and installed skills, so private interface rules and working habits leaked into the executor's context. Now: for a clean context, point the executor's home folder (`HOME`, `USERPROFILE` on Windows) at an empty folder; some CLIs have a home variable of their own, which must point there too.
