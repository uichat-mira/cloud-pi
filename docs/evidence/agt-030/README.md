# AGT-030 · Scheduler restart/recovery evidence

`restart-recovery.txt` is the captured stdout of:

```bash
npm run scheduler:poc
```

It was produced in the `feat/agt-030-scheduler-poc` worktree on Node
`v22.23.2`. The command runs real child processes against the real AGT-028
`startResearch()` executor and run store. The AGT-027 runtime port and research
tool layer are deterministic fixtures, so this is **local fixture evidence**,
not a live model or real-network run. No credential or private data is present.

What to look for:

- Scenario A: the first process creates `poc-daily`, fires the
  `Asia/Shanghai 09:00` occurrence, and exits; the second process reloads the
  definition, fires the next day exactly once, and advances `nextRunAt`.
- Scenario B: the first process exits hard while the run store still says
  `running`; the second process recovers the persisted `activeTrigger` as
  `interrupted`, clears the lease, and then runs the next due occurrence
  successfully. A duplicate tick in that process starts nothing.

The design and full test/evidence map are in
[`docs/engineering/agt-030-scheduler-poc.md`](../../engineering/agt-030-scheduler-poc.md).
