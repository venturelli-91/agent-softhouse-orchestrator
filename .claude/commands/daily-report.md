---
description: Generates the end-of-day Daily Delivery Report and triggers the Knowledge Manager to record new learnings.
---

Invoke the `watchdog` subagent to survey what changed today (commits, merged PRs, CI,
costs) and build the report below. Then, if there is a new learning (a recurring
failure, a relevant decision, a pattern worth keeping), invoke `knowledge-manager` to
record it in `playbooks/` before closing the report.

```
# Daily Delivery Report
## Delivered
## In progress
## Blocked
## New bugs
## Quality and tests
## Production changes
## Costs and AI usage
## Learnings added to the playbooks
```
