# Task 4 — Planner node

Unclear route: `triage -> discovery -> planner -> dev`. `discovery` asks the CEO; the planner
never asks.

## Behavior

- Runs after `discovery` (or straight after triage for incidents), only when triage returns
  `clear=false`. It receives the discovery briefing and the triage summary. An unclear triage
  does not pass criteria on (`criteria=[]`).
- **One call** with `demand-analyst` + `product-manager` + `tech-lead` concatenated as
  the system prompt (the "sequence" is the order of the files). Three calls would triple
  the context; the brief prioritizes tokens.
- Output = triage output. `clear=true` with criteria: fills title, priority, specialty, flags
  and criteria, and proceeds to the dev. Without closed criteria it escalates to the CEO and
  the ticket can only abort; the questions belong to `discovery`.
- `planner` role: read-only (same table as triage). Turns in `TURNS_PLANNER`;
  model/effort inherit `*_DEFAULT`.
- Rounds of questions are capped in `discovery` (2 pauses), not here.

## Tests (fake nodes)

`an ambiguous request goes through the planner ...`, `a planner without criteria
escalates ...`. The discovery tests cover the questions.

## Real-model validation

Historical (Phase 4, before `discovery`): with "Add a discount to the cart" the planner itself
asked 5 scoping questions (`08-real-repo-validation.md`). That job now belongs to `discovery`.

## Out of scope

devops, watchdog, branch push and PR opening by the code (next tasks of Phase 2).
