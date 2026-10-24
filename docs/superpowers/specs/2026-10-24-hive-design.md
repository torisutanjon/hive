# Hive — design

Date: 2026-10-24. Status: draft, awaiting approval.

## Intent

Every developer on a project runs their own agent setup — their own prompts, rules, and notes. Two developers on the same codebase have agents that cannot see each other's context: the decisions one agent helped make are invisible to the next, and there is no single agreed way of working.

Hive is a shared server every developer's agent connects to. It holds one shared **workflow** (the steps and rules every agent follows) and one shared **context** (specs, decisions, ticket notes), so every agent on the team works the same way and knows the same things. Later it bridges to GitHub, Jira, and Rollbar so agents can see CI results, ticket ownership, and production errors through the same place.

It is a nice-to-have for developer experience, not a fix for an outage. First users: Tristan plus a few teammates on one shared project, all Next.js/TypeScript web developers.

Prior art: Tristan's personal Obsidian vault + `/t-*` commands (ticket notes with frontmatter status, session notes, decisions, a generated backlog). Hive is roughly that, made shared.

## Goals

- One shared workflow and context that every developer's agent reads and writes.
- Any teammate can change the workflow or context; every agent picks the change up on its next use.
- Every change is attributed to the developer who made it and is reversible.
- An agent working on a PR or ticket can find the spec and the decisions behind it.
- Connect from Claude Code, Cursor, and VS Code with only a URL and a token.

## Non-goals (v1)

- No web UI. Humans read the context repo in Obsidian or on GitHub.
- No embeddings / semantic search.
- No multi-team tenancy: one Hive instance serves one context repo.
- No GitHub, Jira, or Rollbar integration in v1 (phased in after; see Roadmap).

## Anti-goals (failure even if it technically works)

- A shared workflow change that nobody can trace or undo.
- An agent creating Jira tickets or GitHub issues without a human approving.
- Two agents creating duplicate tickets for the same error.
- Developers needing to learn a new language or stack to contribute.

## Decided

- **Name:** Hive.
- **Stack:** TypeScript on Node. Chosen because the whole team is Next.js/TypeScript; no learning curve.
- **Protocol:** MCP server using the official `@modelcontextprotocol/sdk`, Streamable HTTP transport.
- **Context storage:** markdown files in a git repo (the "context repo"). The Hive server holds a local clone and commits every write with the developer as author.
- **Human reading:** open the context repo as an Obsidian vault, or browse on GitHub.
- **Workflow delivery:** workflow steps are markdown files exposed as MCP prompts, so every agent gets the same commands.
- **Auth v1:** one bearer token per developer.
- **Search v1:** plain text search.
- **Hosting:** one small container, or local run for the first spike.
- **Scope order:** shared context + workflow first; integrations one at a time after.
- **Today's finish line:** approved design + tickets filed. Building happens on later days.

## Builder's calls (made by Claude, Tristan may override)

- **Context repo layout:**
  - `workflow/<name>.md` — one file per workflow step. Frontmatter `description`; body is the prompt text. Each becomes an MCP prompt named `<name>`.
  - `tickets/<KEY>-###.md` — ticket notes. Frontmatter: `title`, `status` (`todo|in-progress|in-review|done|blocked`), `assignee`, `links` (list of context paths).
  - `specs/`, `decisions/`, `sessions/` — free markdown.
- **What an agent knows when starting a ticket:** the shared workflow, the ticket note, and every spec/decision listed in the ticket's `links`. Delivered by a `start-ticket` workflow prompt that tells the agent to read those.
- **MCP tools v1:** `hive_list(dir)`, `hive_read(path)`, `hive_search(query)`, `hive_write(path, content, message)`. Paths are relative to the context repo root; any path escaping the root, or into `.git/`, is rejected.
- **MCP prompts v1:** one per `workflow/*.md`, re-read from disk on every request (no cache), so edits take effect immediately.
- **Writes:** `hive_write` writes the file and makes one git commit, author = token's developer. Writes are serialized with one in-process lock (fine for a small team). Workflow edits go through the same tool — direct commit, revert via git if needed.
- **Config (env):** `HIVE_CONTEXT_DIR` (path to the context repo clone), `HIVE_TOKENS` (JSON map `token -> {name, email}`), `PORT`.
- **Push/pull of the context repo** to a remote: out of v1 (no remote yet). Added when the GitHub remote exists.
- **Package manager / tests:** yarn, vitest. Node 22.
- **Repo layout:** single package, `src/` — no monorepo.

## Roadmap after v1 (each its own phase)

1. **GitHub:** read issues, CI/CD (Actions) results, and PRs; post PR code review using the linked spec/decisions; create issues.
2. **Jira:** read who is working on what and ticket progress; move tickets.
3. **Rollbar → ticket flow:** agent sees a Rollbar error → checks whether it is a code bug fixable in code → creates a GitHub issue → reports to a human and asks whether to create a ticket → on approval, marks "ticket creation in progress" in shared state (so other agents don't duplicate) → creates the ticket → removes the issue → normal ticket cycle. Needs an atomic lock; git can't do this safely, so this phase adds a small SQLite table for locks.

## Left to the builder

Internal module layout, error messages, logging, Dockerfile details, exact tool schemas beyond the signatures above, test structure.
