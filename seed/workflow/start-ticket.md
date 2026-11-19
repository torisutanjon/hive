---
description: Load everything needed before working a ticket — the ticket, its linked specs and decisions, and the project settings.
arguments:
  - name: key
    description: Ticket key, e.g. HIVE-012
    required: true
    pattern: "^[A-Z][A-Z0-9]*-[0-9]+$"
---
Load the context for {{key}}. Read only; change nothing.

1. `hive_read {"path": "tickets/{{key}}.md"}`. If it is not found, stop and say so.
2. `hive_read` every path listed in its frontmatter `links`.
3. `hive_read {"path": "project.md"}` for `base_branch`, `verify` and `commit_format`.
4. Summarize the goal, the acceptance criteria, what each linked spec or decision requires, and the project settings. Flag anything missing or contradictory.
