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

2. Create the context repo. `--key` is the ticket prefix; it is saved as `ticket_key` in `project.md`:

   ```sh
   yarn seed ~/hive-context --key HIVE
   ```

3. Make a token (at least 32 characters is required):

   ```sh
   node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
   ```

4. Start Hive:

   ```sh
   export HIVE_CONTEXT_DIR=~/hive-context
   export HIVE_TOKENS='{"<token>":{"name":"Your Name","email":"you@example.com"}}'
   export PORT=4000
   yarn start
   ```

   It prints `hive listening on http://127.0.0.1:4000`. A bad config prints every problem and exits 1.

## Configuration

| Variable | Meaning |
| --- | --- |
| `HIVE_CONTEXT_DIR` | Path to the context repo. Must be a git repo. |
| `HIVE_TOKENS` | JSON map `token → {name, email}`, one entry per developer. Each token is at least 32 characters. |
| `PORT` | 1–65535. |

The ticket prefix is `ticket_key` in the context repo's `project.md` frontmatter: uppercase letters/digits starting with a letter (`^[A-Z][A-Z0-9]*$`, e.g. `HIVE`). Set it once with `yarn seed <dir> --key HIVE`; everyone on the repo shares it. Hive will not start without it.

Hive listens on 127.0.0.1 only.

## Upgrading

Existing context repos must add `ticket_key: <KEY>` (the prefix you already use) to the frontmatter of `project.md` before upgrading, or Hive will not start.

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
| `hive_list(dir?)` | List one folder of the context repo (default: root). |
| `hive_read(path)` | Read a file. Returns `{content, version}`. |
| `hive_search(query)` | Case-insensitive text search over the markdown files (up to 50 matches). |
| `hive_write(path, content, message, base?)` | Write a file as one commit by you. Omit `base` to create; to overwrite, pass `base` = the `version` from `hive_read` (rejected if the file changed since). |
| `hive_delete(path, message)` | Delete a file and commit it. |
| `hive_history(path?, limit?)` | Show commit history, for one file or the whole repo. |
| `hive_revert(commit)` | Undo a commit with a revert commit by you; fails without changes on conflict. |
| `hive_new_ticket(title)` | Create the next `KEY-###` ticket; numbers are never reused. |
| `hive_workflow(name, args?)` | Render a workflow prompt as text, for clients without prompt support. |

## Workflow

The seeded prompts:

- `start`: list tickets by status and recap the last session.
- `new {title}`: draft a ticket with you, then file it.
- `new-jira {key}`: with `tracker: jira`, file a ticket from a pasted Jira ticket (Jira stays the source of truth).
- `moved {key}`: confirm you moved a ticket in Jira; clears it from the MOVE THESE IN JIRA list in `start`.
- `work {key}`: work a ticket end to end (goal, approach, failing test, build, verify, review), then stop before pushing.
- `end`: draft today's session note and save it on approval.
- `start-ticket {key}`: load the ticket, its linked specs and decisions, and project settings (read only).
- `review-pr {number}`: review a pull request against its ticket and the ticket's linked specs and decisions; posts only after you say yes.
- `ci {branch}`: show GitHub Actions results for a branch and explain failures (read only).
- `new-issue {title}`: draft a GitHub issue, check for duplicates, create it only after you say yes.
- `rollbar {item}`: turn a Rollbar error into a GitHub issue and a ticket without duplicates. It claims the error in the shared context automatically, then asks before creating the issue and before creating the ticket. Needs a shared context repo.

They are plain markdown in `workflow/` of the context repo. Edits apply on the next request; new files appear after the client reconnects. `project.md` holds `base_branch`, `verify`, `commit_format` and `tracker` (`hive` or `jira`) for the `work` workflow.

The GitHub workflows use your agent's own GitHub access (the `gh` CLI or a GitHub MCP server); Hive stores no GitHub credentials.

## Context repo

```
workflow/    prompts
tickets/     one file per ticket
specs/       specs
decisions/   decisions
sessions/    session notes
claims/      one claim per external item (the cross-machine lock)
project.md   base_branch, verify, commit_format
```

Direct edits (for example in Obsidian) are fine: Hive commits them as "manual edits" before its next write.

## Share with teammates

One person creates the context repo once: run `yarn seed ~/hive-context --key HIVE`, create an empty GitHub repo, then run `git remote add origin git@github.com:<owner>/<repo>.git` and `git push -u origin main`.

Everyone else clones it with `git clone git@github.com:<owner>/<repo>.git ~/hive-context`, then sets `HIVE_CONTEXT_DIR` to the clone.

Each developer runs their own Hive. With an `origin`, Hive pulls before every change and pushes after it. Reads pull at most every 30 s. If origin is unreachable (10 s connect timeout), writes are refused. Hive uses your own git SSH key and stores no GitHub credentials. At startup it exits if origin can't be reached.

Without an `origin`, Hive works locally as before.

## Development

```sh
yarn type-check
yarn lint
yarn test
```
