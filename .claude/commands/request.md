---
description: Single entry point for any CEO request — runs Triage and automatically routes to /ticket (direct) or /demand (needs scope).
---

CEO request: $ARGUMENTS

1. Invoke the `triage` subagent with the request above.
2. If triage concludes the request is **already clear enough for a direct ticket**:
   invoke the `ticket` skill (`Skill(skill: "ticket")`) passing the summarized ticket
   that triage produced, already indicating the suggested agent/area.
3. If triage concludes **scope is missing** (goal, user, acceptance criteria): invoke
   the `demand` skill (`Skill(skill: "demand")`) passing the original request and what
   triage identified as missing, so the Demand Analyst does not repeat work already
   done.
4. If triage identifies **more than one area** in the same request, warn the CEO and
   suggest splitting into separate tickets before proceeding — do not run both chains at
   the same time without confirmation.

Use `/request` as the default when you are not sure whether the request is already a
ticket or still needs scope. If you (the CEO) already know exactly what you want and
which area, you can go straight to `/ticket` or `/demand` and skip triage.
