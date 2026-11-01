# Consolidated metrics

Everything measured in this session, per phase. Consumption = `claude -p` with the
project's default model and medium effort, subscription login. "US$" is only the API
equivalent; real usage is charged against the plan limit. "Tokens" = input + output +
cache created + cache read, summed across all turns of the node (the context is re-read
every turn).

## 1. Live consumption

### Measured runs

| Milestone | Scope | Tokens | Turns | Time | US$ |
|---|---|---|---|---|---|
| Task 1 (smoke) | only `triage` | ~5,050 (cache created 4,400 + output 650) | 2 | 7.4 s | 0.024 |
| Task 2 (baseline) | triage, dev, reviewer, qa | 81,832 | 19 | 40.1 s | 0.071 |
| Task 3 (regression) | same path, with guardrails | 79,631 | n/a | 36.0 s | 0.063 |
| Phase 2 (final) | + `devops` | 85,246 | 18 | 46.4 s | 0.104 |

Task 3 only recorded the total, without a per-node breakdown. All ran the same trivial
ticket (change a button's text), clear path, 0 revisions, approved by the simulated CEO.

### Per node

| Node | Task 2: tokens / turns / time / US$ | Final: tokens / turns / time / US$ | Token change |
|---|---|---|---|
| triage | 10,842 / 3 / 7.3 s / 0.011 | 15,994 / 4 / 8.9 s / 0.012 | +47% |
| dev | 41,421 / 6 / 12.1 s / 0.021 | 40,583 / 5 / 11.0 s / 0.023 | -2% |
| reviewer | 11,749 / 4 / 8.2 s / 0.016 | 11,513 / 3 / 8.7 s / 0.020 | -2% |
| qa | 17,820 / 6 / 12.4 s / 0.023 | 11,824 / 4 / 11.0 s / 0.023 | -34% |
| devops | n/a | 5,332 / 2 / 6.7 s / 0.025 | new |
| **Total** | **81,832 / 19 / 40.1 s / 0.071** | **85,246 / 18 / 46.4 s / 0.104** | **+4%** |

Context vs output detail (Task 2): triage ctx 10,117 + output 725; dev 40,591 + 830;
reviewer 10,947 + 802; qa 16,466 + 1,354. Final: triage 15,233 + 761; dev 39,914 + 669;
reviewer 10,714 + 799; qa 10,641 + 1,183; devops 4,722 + 610.

### Reading

- The dev concentrates ~48% of the tokens; output is <3% in every node, so the cost is
  the context re-read per turn (3.4k to 6.7k tokens per turn). The lever is fewer turns
  and a smaller system prompt, not a shorter answer.
- Triage grew 47% without a prompt change: variation between runs (4 turns versus 3),
  not a code regression.
- The total rose 4% in tokens but 46% in US$ (0.071 to 0.104): `devops` cost 0.025 on
  just 5.3k tokens, and the per-node sum is not proportional to tokens (the mix of cache
  created and cache read has different prices).
- Not measured live: planner (ambiguous route), `publish` with `github`, `watchdog`. All
  three have a fake-node test, at no token cost.
- Floor of a lean `claude -p` (Haiku, empty prompt): ~1,900 tokens. The rest of each
  node is role prompt + schema + request.

## 2. Tests

| Milestone | Tests | Note |
|---|---|---|
| Task 1 | 6 (`run-agent`) | no model or credential |
| Task 3 | 23, ~23 s | flow guardrails with fake nodes |
| Task 4 | 26, ~29 s | + 3 for the planner |
| Phase 2 (publish/devops/watchdog) | 31 | + 5 |
| Final (pinned SHA, moved HEAD) | 32 | + 1 in `evidence.test.ts` |

Final distribution: `graph.test.ts` 16, `evidence.test.ts` 8, `run-agent.test.ts` 8. No
test uses the network, a model or a credential. CI on GitHub Actions: green on `main`.

## 3. Code size

- `orchestrator/src/`: 532 lines (brief's target: core in ~300; it exceeded through
  guardrails, publisher and watchdog, which the brief did not count).
- `tests/` + `scripts/`: 448 lines. `examples/agents/`: 18 prompts, ≤7 lines each
  (target: 8 prompts ≤15 lines).
- Runtime dependencies: 3 (`@langchain/langgraph`, `@langchain/core`, `zod`); dev: 2
  (`typescript`, `@types/node`).
- README: ~12 lines of text plus the generated diagram (target: ≤20 lines of text).

## 4. Process

- 22 commits on `main`, 13 of them orchestrator `feat`/`fix`; 100% atomic, in English.
- Automatic security reviews per phase: 4 rounds in Phase 1/Task 3 (sandbox, `npm test`
  on the host, forbidden paths, renames), plus 2 findings in `publish.ts` and 1 in
  `graph.ts` in Phase 2, all fixed with a test.
- History rewritten once before publishing (personal paths) and again to remove personal
  terms from `check-secrets.sh`; zero occurrences in the final search on `main`.
- Limits and guardrails measured in code: `MAX_REVISIONS=3`, `MAX_ACTIVE_TICKETS=5`,
  `RECURSION_LIMIT=40`, `NODE_TIMEOUT_MS=600 s`, default budget
  `TOKEN_BUDGET_TICKET=200000` (the measured ticket uses 43% of it).
