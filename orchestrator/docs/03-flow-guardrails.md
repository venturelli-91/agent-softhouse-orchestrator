# Task 3 — Flow guardrails (Section 1), tests with fake nodes and CI

All in `orchestrator/src/guardrails.ts` (Section 1) and applied in `graph.ts`. The values
mirror `CLAUDE.md`: 5 active tickets, CEO approval for merge/deploy, nobody approves
their own delivery.

## Rules and where they are applied

| Rule | Implementation | Test |
|---|---|---|
| `MAX_REVISIONS=3` | the router sends to `ceo_approval` when `revisions >= 3` | `the cap of 3 revisions escalates to the CEO` |
| Repeated failure | the dev's verification failing twice in a row with the same structural cause (no commit, forbidden path, dirt; numbers ignored) escalates at once, while a red suite keeps using its revisions; each failure's cause stays in the history | `the same verification failure twice escalates at once` |
| `MAX_ACTIVE_TICKETS=5` | `activeTickets(repo)` counts git `ticket/*` worktrees (no other database); `createWorktree` refuses the 6th | `limit of 5 active tickets` |
| Author ≠ reviewer ≠ QA | `selfApproval(author, who)`, checked before spending tokens on reviewer/qa; `author_id` comes from the commit author (identity injected in the env) | `self-approval blocked ...` |
| Evidence verified by code | `verifyEvidence`: new commit, clean worktree, no ignored executable file, allowed paths, `npm test` passes. Runs at the dev, **again** at the reviewer, at the qa and before honoring the CEO's approval | `evidence declared ... rejected`, `a commit without a real passing test ...`, `a worktree with an uncommitted change ...` |
| Forbidden paths | `FORBIDDEN`: `.env*`, `.github/`, `orchestrator/`, keys/credentials; `package.json`/`.npmrc` require the CEO (they execute code on the host). Regex with `/i` and `-z` (NTFS filesystem and exotic names) | `a diff that touches a forbidden path ...`, `a diff that touches package.json ...` |
| Merge/deploy only with the CEO | `simulated_deploy` is only produced by `ceo_approval` after `interrupt()`; the node revalidates the evidence and the payload carries the active flags | `deploy only happens after CEO approval ...`, `an approval flag reaches the CEO ...` |
| Escalation to the CEO | ambiguity, node failure (error, timeout, invalid output, turns), revision cap, budget and invalid evidence become `interrupt({type:"escalation", reason})` | `ambiguous request`, `invalid node output ...`, `budget` |
| Budget | `budgetExceeded` sums `history` tokens against `TOKEN_BUDGET_TICKET` before each node (missing = error) | `an exceeded token budget interrupts the ticket` |
| Turns | the CLI's `--max-turns`; `error_max_turns` is a `NodeFailure` in `parseOutput` | `invalid output, turn limit, error and garbage ...` |
| Model/effort only from the environment | `readEnv`; a test scans `src/` for model names | `model, effort and turns ...`, `no model name in the code` |

## Decisions

- **Approval flags and route:** since every merge/deploy already goes through the CEO, the
  flags (`touches_schema`, `touches_public_api`, `touches_permissions`,
  `touches_external_integration`, `touches_cost`) do not change the path; they appear in
  the active flags so the CEO can decide with context. If there is ever an automatic
  deploy for some case, the flag starts to decide.
- **CEO's answer to an escalation:** `abort` ends it (`status=aborted`); any other text
  becomes an instruction and goes back to the dev with `revisions=0` — only if triage
  already produced criteria. An escalation before that (ambiguous/failed triage) can
  only abort; the planner (task 4) covers scope clarification.
- **CEO rejection** in a normal approval goes back to the dev with `revisions + 1`.
- **Fake executor:** `registerExecutor("fake", ...)` + `EXECUTOR=fake`. It is the same
  hook that will serve other executors in the future; there is no module mock.
- **Test state:** 23 tests, ~23 s, no network, model or credential. The fake dev makes
  real commits in a fixture repo (`scripts/fixture.ts`, also used by the tracer).

## CI

`.github/workflows/ci.yml` (root, with `working-directory: orchestrator`): Node 24,
`npm ci`, `npm run typecheck`, `npm test`, `permissions: contents: read`, no secrets,
triggered only by changes in `orchestrator/`. (It used to live inside `orchestrator/` and
GitHub did not run it; moved at publishing.)

## Security — round 4 (automatic review)

- `npm test` only runs with a clean worktree and without `package.json`/`.npmrc` changed
  or ignored.
- Path matching is case-insensitive and uses `-z`/`core.quotePath=false`.
- `git diff --no-renames`: renaming/moving a forbidden file also exposes the old path.

## Live regression

Real tracer re-run after the task: `status=simulated_deploy`, 79,631 tokens, 36.0 s,
US$ 0.063 (task 2 baseline: 81,832 tokens, 40.1 s, US$ 0.071).
