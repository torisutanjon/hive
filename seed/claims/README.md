# Claims

One file per claimed external item, e.g. `rollbar-1234.md`. A claim is created once, with `hive_write` and no `base`. Creating a claim that already exists fails, even when two agents race for it, because Hive pushes every change and a rejected push is redone. That makes a claim the lock that stops duplicate issues and tickets across every teammate's machine.

Frontmatter: `item`, `state` (`claimed`, `issue`, `ticketed`, `closed`, `declined`), `by`, `issue` (URL), `ticket` (key). Claims are kept as a record, so a recurring error points to its existing ticket. A claim holds only identifiers and state, never error text.

Claims need a shared context repo (one with an origin); without one, each machine has its own claims.
