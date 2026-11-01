---
description: Generates today's Daily CEO Brief, using the Watchdog to survey the real state of the project.
---

Invoke the `watchdog` subagent to sweep the current project (git, CI, PRs, tickets, AI
costs when they can be measured) and build the brief below. If a source is not available
in this environment (e.g. no `gh` configured), say so instead of inventing data.

```
# Daily CEO Brief
## P0
## Active tickets
## PRs awaiting review
## CI and QA failures
## Alerts and incidents
## Abnormal costs
## Pending CEO decisions
## Top 3 risks
## Recommended next actions
```
