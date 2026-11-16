---
description: Work one ticket end to end — goal, approach, failing test, build, verify, review — then stop before pushing.
arguments:
  - name: key
    description: Ticket key, e.g. HIVE-012
    required: true
---
Work {{key}}. The job is the ticket's goal, not making a symptom go away.

**Confidence gate, every step.** Give every finding and suggested approach a confidence %. At 75% or more, proceed. At 70–74%, proceed and say what would raise it. Below 70%, stop and ask the developer targeted questions.

1. **Load.** Follow the `start-ticket` workflow for {{key}} (or call `hive_workflow` with name `start-ticket` and key {{key}}). Then set `status: in-progress` and `assignee` to your developer (`hive_whoami`) with `hive_write`, passing `base`.
2. **Goal.** State the goal and check the ticket against it. Push back if it is invalid, already done, or underspecified.
3. **Approach, no code yet.** Propose 2–3 approaches, recommendation first, with trade-offs and confidence. Strip anything the goal does not need.
   - *Bounded* (changes an existing flow you can read): state the approach and what done means, then continue.
   - *Architectural* (a new subsystem, or an interface other code depends on): write `decisions/{{key}}-design.md` with `hive_write`, show it, and **wait for approval**. Add its path to the ticket's `links`.
4. **Failing test first.** Write the test that proves the goal is unmet, and see it fail for the right reason.
5. **Build** on a branch off `base_branch` named `{{key}}-<short-slug>`, in small commits following `commit_format` from `project.md`.
6. **Verify.** Run every command in `verify` from `project.md`, in order, stopping at the first failure. Check anything visual live; never reason about it from source.
7. **Review as a reviewer.** Read the whole branch diff: scope, security (input validation, auth, secrets, injection), and anything no test can reach. Fix what you would block a merge for, then verify again.
8. **Stop.** Do not push or open a PR — the developer does that. Report what is blocked on the developer, what changed (branch, commits, a suggested PR title), and what you found.
9. **Close.** Set `status: in-review` with `hive_write`, passing `base`. Record any architectural call in `decisions/`. Add the ticket and branch to today's session note (see the `end` workflow).
