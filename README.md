# Hive

Hive is a shared MCP server that gives every developer's agent one workflow and one context (specs, decisions, tickets, sessions), stored as markdown in a git repo. Every change is a commit by the developer who made it.

## Requirements

- Node >= 22.18 (runs TypeScript directly)
- git
- yarn 1

## Quick start

1. Install dependencies:

   ```sh
   yarn install
   ```

2. Create the context repo. This refuses a non-empty directory:

   ```sh
   yarn seed ~/hive-context
   ```

3. Make a token (at least 32 characters is required):

   ```sh
   node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
   ```

4. Start Hive:

   ```sh
   export HIVE_CONTEXT_DIR=~/hive-context
   export HIVE_TOKENS='{"<token>":{"name":"Your Name","email":"you@example.com"}}'
   export HIVE_TICKET_KEY=HIVE
   export PORT=4000
   yarn start
   ```

   It prints `hive listening on http://127.0.0.1:4000`. A bad config prints every problem and exits 1.

## Configuration

| Variable | Meaning |
| --- | --- |
| `HIVE_CONTEXT_DIR` | Path to the context repo. Must be a git repo. |
| `HIVE_TOKENS` | JSON map `token → {name, email}`, one entry per developer. Each token is at least 32 characters. |
| `HIVE_TICKET_KEY` | Ticket prefix, uppercase (e.g. `HIVE`). |
| `PORT` | 1–65535. |

Hive listens on 127.0.0.1 only.

## Connect your agent

The endpoint is `http://127.0.0.1:<PORT>/mcp`, with the header `Authorization: Bearer <token>`.

**Claude Code:**

```sh
claude mcp add --transport http hive http://127.0.0.1:4000/mcp --header "Authorization: Bearer <token>"
```

Then run `/mcp` to check it is connected. Prompts appear as `/mcp__hive__<name>`.

**Cursor:** `.cursor/mcp.json` (project) or `~/.cursor/mcp.json`:

```json
{ "mcpServers": { "hive": { "url": "http://127.0.0.1:4000/mcp", "headers": { "Authorization": "Bearer <token>" } } } }
```

**VS Code:** `.vscode/mcp.json`. It asks for the token once and keeps it out of the file:

```json
{
  "inputs": [{ "type": "promptString", "id": "hive-token", "description": "Hive token", "password": true }],
  "servers": { "hive": { "type": "http", "url": "http://127.0.0.1:4000/mcp", "headers": { "Authorization": "Bearer ${input:hive-token}" } } }
}
```

Never commit a real token to a repo.

## Tools

| Tool | Purpose |
| --- | --- |
| `hive_whoami` | Show who you are authenticated as. |
| `hive_list(dir?)` | List files in the context repo. |
| `hive_read(path)` | Read a file. Returns `{content, version}`. |
| `hive_search(query)` | Search file contents. |
| `hive_write(path, content, message, base?)` | Write a file and commit it. Omit `base` to create; pass `version` to overwrite. |
| `hive_delete(path, message)` | Delete a file and commit it. |
| `hive_history(path?, limit?)` | Show commit history, for one file or the whole repo. |
| `hive_revert(commit)` | Revert a commit. |
| `hive_new_ticket(title)` | Create the next numbered ticket. |
| `hive_workflow(name, args?)` | Fetch a workflow prompt. |

## Workflow

The seeded prompts:

- `start`: begin a session.
- `new {title}`: file a new ticket.
- `work {key}`: work a ticket.
- `end`: end the session and write the note.
- `start-ticket {key}`: begin a session on a specific ticket.

They are plain markdown in `workflow/` of the context repo. Edits apply on the next request; new files appear after the client reconnects. `project.md` holds `base_branch`, `verify` and `commit_format` for the `work` workflow.

## Context repo

```
workflow/    prompts
tickets/     one file per ticket
specs/       specs
decisions/   decisions
sessions/    session notes
project.md   base_branch, verify, commit_format
```

Direct edits (for example in Obsidian) are fine: Hive commits them as "manual edits" before its next write.

## Development

```sh
yarn type-check
yarn lint
yarn test
```
