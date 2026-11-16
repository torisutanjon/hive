---
description: End a session — draft today's session note in the shared context and save it on approval.
---
1. `hive_whoami` for your developer's name.
2. Draft `sessions/YYYY-MM-DD-name.md` (today's date; the name in lowercase with dashes) with the sections **Done** (tickets and what shipped), **Decisions**, **Current state** and **Next**. If that file already exists, `hive_read` it and extend it instead.
3. Show the draft and wait for an explicit yes.
4. On yes, `hive_write` it (passing `base` if it already existed) with the message `session: YYYY-MM-DD name`. Stop.
