---
description: Review a GitHub pull request against its ticket and the ticket's linked specs and decisions. Posts nothing without your approval.
arguments:
  - name: number
    description: Pull request number, e.g. 42
    required: true
---
Review pull request #{{number}}. Read only until the developer approves posting.

Use your own GitHub access: the `gh` CLI or a GitHub MCP server. If you have neither, stop and say so. Pass the PR number as one quoted argument.

1. Read the PR: `gh pr view "{{number}}" --json title,body,headRefName,baseRefName,author,url`, then `gh pr diff "{{number}}"`.
2. Find the ticket. The branch name starts with the ticket key (e.g. `HIVE-012/github-workflows`). Run `hive_read {"path": "tickets/<KEY>.md"}`. If there is no key or no ticket, say so and review against the PR description only.
3. `hive_read` every path in the ticket's frontmatter `links`, then `project.md`.
4. Review the diff against the ticket's goal and acceptance criteria and against every linked spec and decision. Report only what you would block or flag: unmet criteria, contradictions with a spec or decision, correctness bugs, security problems, and missing tests for changed behaviour. For each finding give the file and line, what is wrong, why (cite the criterion, spec or decision), and a fix. No style nits.
5. Show the review and a verdict (`approve`, `request changes` or `comment`). Then wait for an explicit yes. No yes means nothing is posted.
6. On yes, write the review to a temp file and post it: `gh pr review "{{number}}" --approve` (or `--request-changes`, or `--comment`) `--body-file <file>`. Use the verdict the developer agreed to.
7. Report the PR URL and stop.
