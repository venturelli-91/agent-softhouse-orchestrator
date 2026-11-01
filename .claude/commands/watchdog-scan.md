---
description: Runs an ad-hoc Watchdog sweep at any time, without waiting for the full daily ritual.
---

Invoke the `watchdog` subagent now, outside the daily ritual, to check: errors, alerts,
costs, stalled PRs, CI failures, blocked tickets, AI degradation and the P0 backlog.
Report in the format:

```
- top 3 problems
- impact
- status
- suggested owner
- recommended next action
```

$ARGUMENTS
