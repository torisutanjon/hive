---
description: Start a session — list the shared tickets by status and recap the last session. Lists only; never starts work.
---
Use the Hive tools only. Do not start any work.

1. `hive_read {"path": "project.md"}` for `tracker`. Then `hive_list {"dir": "tickets"}`, then `hive_read` each `tickets/*.md` except `README.md`, and take `title`, `status`, `assignee` and `jira_reconcile` from its frontmatter.
2. Report the tickets grouped in this order: **in-progress**, **in-review**, **todo**, then the rest (**blocked**, **done**). Show `KEY-### — title` and the assignee if set. Show everything; do not filter.
3. If `tracker` is `jira`: list the tickets with `jira_reconcile: pending` under the heading **MOVE THESE IN JIRA**, each with its key, title, current status and assignee. If there are none, say so.
4. `hive_list {"dir": "sessions"}` and `hive_read` the newest note (names start with the date; skip `README.md`). Summarize its decisions, current state and next steps — or say there are none yet.
5. Stop. Wait for the developer to pick a ticket and run `work`.
