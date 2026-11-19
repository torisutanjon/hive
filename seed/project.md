---
base_branch: main
verify: []
commit_format: "{KEY}-###: {desc}"
github_repo: "" # owner/name of the code repo on GitHub; used by the review-pr, ci and new-issue workflows
---

# Project settings

Read by the `work` and `start-ticket` workflows. Fill in `verify` with the commands that must pass before a branch is done, in order — for example `yarn type-check`, `yarn lint`, `yarn test`.
