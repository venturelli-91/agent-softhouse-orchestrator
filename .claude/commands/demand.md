---
description: Turns a CEO request into a briefing, PRD and technical tickets, stopping to ask when there is relevant ambiguity.
---

CEO demand: $ARGUMENTS

Run this chain, in order, using the Agent tool to invoke each subagent:

1. **`demand-analyst`** — produce the Briefing (template in the agent's file). If the
   goal, affected user or acceptance criteria cannot be filled in with confidence, stop
   here and ask the CEO before continuing (do not proceed on assumptions).
2. **`product-manager`** — from the approved briefing, produce PRD + stories +
   acceptance criteria + prioritized backlog. If any "pending decision" in the briefing
   blocks the scope, stop and escalate to the CEO.
3. **`tech-lead`** — from the PRD, produce architecture + small technical tickets (max.
   5 active at a time, see `CLAUDE.md`), each already routed to the right agent by the
   `CLAUDE.md` table.

At the end, present to the CEO:
- the briefing,
- the summarized PRD,
- the list of ready technical tickets, each with the responsible agent indicated,
- any pending decision that still needs approval before running `/ticket`.

Do not implement anything at this stage — the goal is to leave with tickets ready for
`/ticket <id-or-description>`.
