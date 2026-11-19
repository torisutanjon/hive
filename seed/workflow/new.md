---
description: File a new ticket in the shared context. Drafts it with you first; never starts work.
arguments:
  - name: title
    description: One-line ticket title
    required: true
---
File a ticket titled "{{title}}". Filing is not building.

1. `hive_read {"path": "project.md"}`. If `tracker` is `jira`, stop: tickets come from Jira. Tell the developer to run `new-jira` with the Jira key and paste the ticket.
2. Draft it with the developer:
   - **Goal** — the observable outcome this ticket is after, not the symptom.
   - **Acceptance criteria** — checkable items, always including: a failing test is written first; the `verify` commands in `project.md` pass; anything observable is verified live.
   - **Links** — paths of specs or decisions in this context that the work depends on, if any.
3. Show the full draft and wait for an explicit yes.
4. On yes, call `hive_new_ticket` with the title. Then `hive_read` the new file and `hive_write` it with `base` set to that version: keep the frontmatter, put the links in `links`, and append `## Goal` and `## Acceptance criteria` (as `- [ ]` items) below the heading. Use the message `KEY-###: describe ticket`.
5. Report the key and stop.
