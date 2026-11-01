# Phase 4 — validation on a real repo

Goal: take the orchestrator past the disposable fixture. Target: a private throwaway
GitHub repo (`venturelli-91/orchestrator-sandbox`, a small Node app with `npm test`),
real model, `PUBLISHER=github`. The production deploy stays simulated.

## What was added

- `scripts/tracer.ts`: `--repo <path>` (target an existing repo instead of the
  fixture), `--id <ticket>`, one CEO answer per pause read from stdin (the ambiguous
  route pauses twice), `--db <file>` and `--resume` (see below).
- `src/file-saver.ts`: `FileSaver`, a `MemorySaver` that writes its state to a JSON file
  after every checkpoint. A ticket paused for CEO approval can be answered by a later,
  separate process: `npm run tracer -- --db state.json --id T-1` (stdin empty, stops at
  the pause) then `echo approve | npm run tracer -- --db state.json --resume --id T-1`.
  Chosen over `@langchain/langgraph-checkpoint-sqlite` to avoid the native
  `better-sqlite3`; it rewrites the whole file per checkpoint, fine for a few local
  tickets.
- Agent summaries over 10 lines are truncated by the code (`cap` in `graph.ts`) instead
  of failing the node.

## Runs (model `claude-sonnet-5-5`, medium effort, simulated CEO answers)

| Ticket | Route | Revisions | Tokens | Time | US$ | Result |
|---|---|---|---|---|---|---|
| T-101 multi-file discount | clear | 1 | 113,118 | 67 s | 0.198 | draft PR #1 |
| T-102 "Add a discount to the cart" | ambiguous | 1 | 214,694 | 272 s | 0.239 | **escalated**: QA summary over 10 lines, then budget |
| T-103 same, after the fix | ambiguous | 1 | 150,822 | 120 s | 0.302 | draft PR #2 |
| T-104 `isEmpty` helper, 2 processes | clear | 2 | 156,679 | 134 s | 0.160 | approved from a second process |
| T-105 same, Haiku on read-only nodes | clear | 0 | 99,692 | 61 s | 0.035 | simulated deploy |

## Findings

1. **Real publish works.** Push of the verified SHA to `ticket/<id>` and a draft PR via
   `gh pr create --draft`; the `pr:<url>` entry reaches the CEO payload.
2. **Ambiguous route works with a real model.** The planner asked 5 scoping questions;
   the CEO's answer went back to the planner, which closed the criteria and released the dev.
3. **Bug found and fixed (T-102).** The zod `refine` on `summary` rejected a QA summary
   longer than 10 lines, so a verbose-but-approving QA killed the node and wasted a round.
   Now truncated in code; test `a summary over 10 lines is truncated, not a node failure`.
4. **Persistent approval works** (T-104): process 1 paused at approval and exited;
   process 2 resumed and ran devops.
5. **Stale `.env`.** A local `.env` created before the English rename kept the old
   `TURNOS_*`/`PUBLICADOR` names. Recreate it from `.env.example` after pulling.
6. **QA is static.** The QA node has no shell, approves by reading the diff and says so.
   The evidence that tests pass comes from the graph (`tests:npm test ok`), not from the QA.
7. The ambiguous route costs ~50% more tokens than the clear one (planner, 2 calls).

## Token optimization

The dev node is ~55% of the tokens; output is <5% everywhere, so cost is context re-read
per turn. Lever tested: a cheaper model on the read-only nodes only (triage, reviewer,
qa, devops), through `MODEL_<ROLE>`; dev and planner keep the default.

| | T-104 (all default model) | T-105 (Haiku on 4 read-only nodes) |
|---|---|---|
| Tokens | 156,679 | 99,692 |
| US$ | 0.160 | 0.035 |
| Revisions | 2 | 0 |

US$ fell ~78%. Haiku nodes used more turns (triage 6 vs 2, reviewer 5 vs 2), so tokens per
node can rise while cost falls; the token budget counts tokens, not dollars.
**Caveat:** one sample per arm, and the revision count differed (0 vs 2), so part of the
gap is run-to-run variance. Whether a cheaper reviewer/QA catches as much is not proven;
watch rejection rates over more tickets. `.env.example` now ships these overrides.

## Does a cheaper model still catch bad diffs?

`scripts/eval-review.ts --models a,b` runs reviewer and qa on 5 hand-made diffs with known
verdicts (1 good; 4 bad: no tests, rounds up instead of down, no range check, scope creep).
One run per case.

| Model | Reviewer (correct / US$) | QA (correct / US$) |
|---|---|---|
| Haiku 5.5 | 5/5 / 0.006 | 4/5 / 0.007 |
| Sonnet 5.5 | 5/5 / 0.066 | 4/5 / 0.086 |
| Opus 5.5 | 5/5 / 0.230 | 4/5 / 0.265 |

- **Reviewer:** all three models caught all four bad diffs and approved the good one.
  Haiku costs ~1/10 of Sonnet and ~1/40 of Opus here, so it is the default for this node.
- **QA is inconclusive, not a model difference.** Every model "missed" the same case: the
  harness runs QA in an empty workspace, so QA rejected the good diff because it could not
  read `src/cart.js` (its stop rule demands every criterion validated). The four bad diffs
  were rejected correctly. A fair QA eval needs a real worktree per case.
- First attempt had a flaw of mine (the "good" diff lacked the test import), which all
  models rightly rejected; fixed before the table above.
- Limits: 5 cases, 1 run each, only the read-only nodes. Dev, planner, triage and devops
  are not covered, and Fable was not tested.

## Still open

Real deploy/merge; QA with a shell or real browser; container sandbox for `npm test`;
watchdog automation; knowledge manager as a node; more than a handful of real tickets.
