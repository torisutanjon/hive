---
description: Show GitHub Actions results for a branch and explain any failures. Read only.
arguments:
  - name: branch
    description: Branch name, e.g. HIVE-012/github-workflows
    required: true
---
Check CI for branch `{{branch}}`. Read only; change nothing.

Use your own GitHub access: the `gh` CLI or a GitHub MCP server. If you have neither, stop and say so. Pass the branch name as one quoted argument.

1. `gh run list --branch "{{branch}}" --limit 10`. Take the latest run of each workflow.
2. For each failed run: `gh run view <id> --log-failed`. Read only the failing steps.
3. For each failure give the job and step, the shortest decisive error line, and the likely cause in the code (file and line). Say whether it is new on this branch or already failing on the base branch: read `base_branch` with `hive_read {"path": "project.md"}`, then `gh run list --branch "<base_branch>" --limit 5`.
4. If the branch name starts with a ticket key, `hive_read {"path": "tickets/<KEY>.md"}` and say which acceptance criteria the failures block.
5. Report and stop. Fixing belongs to `work`.
