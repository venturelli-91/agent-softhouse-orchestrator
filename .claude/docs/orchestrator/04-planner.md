# Task 4 — Planner node

Ambiguous route from the brief: `triage -> planner -> dev`, and `ceo_approval -> planner`
when information is missing.

## Behavior

- Runs only when triage returns `clear=false` (the post-triage router in `graph.ts`). An
  ambiguous triage no longer passes criteria on (`criteria=[]`).
- **One call** with `demand-analyst` + `product-manager` + `tech-lead` concatenated as
  the system prompt (the "sequence" is the order of the files). Three calls would triple
  the context; the brief prioritizes tokens.
- Output (`PlanOutput`) = triage output + `question`. `clear=true` with criteria: fills
  title, priority, specialty, flags and criteria, and proceeds to the dev. Without closed
  criteria: `status=ambiguous`, `summary=question`.
- **Clarification:** `status=ambiguous` goes to `ceo_approval` as an escalation with the
  question. An answer other than `abort` is appended to the `request` (`CEO
  clarification: ...`) and the ticket returns to the planner; `abort` ends it. Node
  failures (error, timeout, invalid output) still only abort while there are no criteria.
- `planner` role: read-only (same table as triage). Turns in `TURNS_PLANNER`;
  model/effort inherit `*_DEFAULT`.
- No cap of its own on clarification rounds: each loop requires a human answer, and the
  token budget and `RECURSION_LIMIT` still apply.

## Tests (fake nodes)

`an ambiguous request goes through the planner ...`, `a planner without criteria
escalates with the question ...`, `the CEO aborts when the planner asks for
clarification`. Total: 26 tests.

## Out of scope

devops, watchdog, branch push and PR opening by the code (next tasks of Phase 2).
