# Hardening after the model evals

What the evals in `08-real-repo-validation.md` turned into, and what was left out on purpose.

## Added

- **Retry on a busy API.** `withRetry` (`run-agent.ts`) retries a `TransientFailure` (API
  error, overloaded, rate limited) after the waits in `RETRY_DELAYS_MS` (default
  `5000,20000`; empty disables). A usage limit, a turn limit and invalid output are never
  retried. Before this, one busy-API reply escalated the ticket to the CEO.
- **Verified evidence for reviewer and QA** (`evidenceNote`): the code, not the agent,
  checked commit, diff and `npm test`; the QA is told so and not to reject only because it
  cannot run tests itself.
- **Shell rules for the dev** (`DEV_RULES`): one simple command per call. Compound commands
  are denied by the `dontAsk` allowlist and the dev used to give up without committing.
- **Rule-based watchdog** (`alerts` in `watchdog.ts`, `npm run watchdog -- --db state.json`):
  flags tickets stalled (24 h, P0 1 h), in a review loop, at 80% of the token budget, or
  escalated. No model, no tokens; `--llm` adds the Watchdog agent.
- **Model choice per stage** is data now: `npm run eval:review|eval:stages|eval:dev`.

## Left out on purpose

| Item | Why |
|---|---|
| QA with a shell or browser | With the evidence note the static QA is 15/15 on Sonnet and Opus; a shell widens the attack surface for no measured gain. Revisit for UI tickets. |
| Container for `npm test` | Needs Docker and a base image per repo; the worktree has no secrets and a minimal env. Revisit before running untrusted repos. |
| Knowledge manager as a node | Costs tokens on every ticket; the learnings that mattered here came from the evals and live in these docs. |
| Real deploy or merge | Stays with the CEO; the devops node only describes status and rollback. |
| Fable on any stage | Billed in dollars and no stage showed a failure a stronger model would fix. |

## Still open

Dev on a real multi-file feature with several revisions (the dev evals saturate at 100%);
quality of planner criteria.

## End-to-end check with everything above

T-301 (`lastItem` helper with tests, clone of the sandbox, `PUBLISHER=none`, Haiku on
reviewer/qa/devops, default model elsewhere): 0 revisions, 93,741 tokens, 47 s, US$ 0.113
reported. Same shape as T-104 (156,679 tokens, 2 revisions) before the changes; one sample,
not a benchmark. Node tokens: triage 5.3k, dev 71.4k, reviewer 5.9k, qa 6.1k, devops 5.1k.
