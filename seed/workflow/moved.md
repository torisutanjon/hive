---
description: Confirm you moved a ticket in Jira, and clear it from the MOVE THESE IN JIRA list.
arguments:
  - name: key
    description: The Jira key, e.g. AX-123
    required: true
    pattern: "^[A-Z][A-Z0-9]*-[0-9]+$"
---
The developer says {{key}} has been moved in Jira.

1. `hive_read {"path": "tickets/{{key}}.md"}`. If it is not found, stop and say so.
2. If `jira_reconcile` is not `pending`, say there was nothing to move, and stop.
3. Set `jira_reconcile: ""` with `hive_write`, passing `base` (the version from step 1), with the message `{{key}}: moved in Jira`.
4. Report and stop.
