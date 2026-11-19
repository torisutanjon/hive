---
description: Draft a GitHub issue with you and create it only after your explicit yes.
arguments:
  - name: title
    description: One-line issue title
    required: true
---
Create a GitHub issue titled "{{title}}", but only after the developer approves it.

Use your own GitHub access: the `gh` CLI or a GitHub MCP server. If you have neither, stop and say so. Pass the title as one quoted argument; never paste it unquoted into a shell command.

1. Look for duplicates: `gh issue list --search "<key words>" --state all --limit 10`. Show any likely duplicates and ask whether to go on.
2. Draft the body: what happens, what should happen, and where it shows (file and line, CI run, or log line). Link any related ticket or spec in this context (`tickets/KEY-###.md`). Never include secrets, tokens or `.env` contents.
3. Show the full draft (title, body and labels, if any). Then wait for an explicit yes. No yes means nothing is created.
4. On yes, write the body to a temp file and run `gh issue create --title <the title> --body-file <file>`.
5. Report the issue URL and stop. An issue is not a ticket; use `new` to file a ticket.
