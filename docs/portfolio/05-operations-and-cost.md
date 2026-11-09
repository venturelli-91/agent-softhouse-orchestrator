> Part of the [Agent Softhouse Orchestrator case study](README.md) — operations loop and cost

## 9. The operations loop (post-production)

Delivery ends at the deploy. Operations is **not a graph**; it is a few file-backed modules driven by `orch watch`:

- **Monitor:** for each deployed ticket with a failing probe, open one **incident** (deduplicated by fingerprint) and notify the human once.
- **Hotfix:** the incident opens one **P0 ticket that re-enters the delivery graph**, except when the symptom is `unreachable` or `timeout` (it says nothing about the code), in which case only the rollback is proposed. It counts toward the 5-ticket limit; at the limit the incident waits.
- **Rollback proposal:** proposed automatically, executed only by `orch rollback <incident-id>` (the CEO's approval). A failed rollback stays proposed for retry.
- **One outage = one incident = one hotfix,** even if the symptom changes.
- **Postmortem:** the `knowledge-manager` agent proposes text; **code** writes it to `playbooks/<date>-<slug>.md`, uncommitted, for the human to read.
- **HTTP probe:** reports `http <status>`, `timeout after <n>ms`, `latency over <m>ms` or `unreachable: <code>`. Redirects are not followed (a 3xx is a symptom) and the URL never appears in a symptom.
- **Chaos engineering (sandbox only):** `orch chaos <ticket> <scenario>` injects one of 12 failures (`broken-build`, `missing-env`, `failed-migration`, `http-500`, `latency-spike`, `memory-growth`, `cert-expired`, `api-down`, `api-timeout`, `rate-limit`, `db-down`, `regression`) to prove the loop reacts. It refuses any non-sandbox target and writes nothing in that case.

---

## 10. Cost engineering

Cost is reported by Claude Code on the subscription login ("US$" is an API-equivalent figure for comparison only). One measured sample is recorded in this repository: `orch clean` appends one line per ticket (route, tasks, revisions, escalations, time, tokens, cost, total and per node) to `ORCH_HOME/metrics.jsonl`, and a single trivial ticket (a button label change on a throwaway repo, 0 revisions, 0 escalations) cost US$0.2308 and took 86 s as of 2026-11-08, with the log and the metrics line in `docs/evidence/cost-1/`. One ticket is not an average; a typical cost per ticket is still to be measured. The earlier baseline table, node-share and ambiguous-route percentages and the Haiku A/B figure were removed because no `metrics.jsonl` or eval output backs them (see `VERIFIED.md`). What the code guarantees: `tokens()` sums input, output, cache read and cache create, so context re-read on every turn counts; read-only nodes can run on a cheaper model through `MODEL_<ROLE>` while dev and planner keep the default.

### Controls

`TOKEN_BUDGET_TICKET` (per ticket, scales with atomic tasks), `TOKEN_CAP_DAILY` (rolling 24h), failed-run spend is counted, and `NOTIFY_URL` pings your phone (for example an ntfy.sh topic) when a ticket is waiting.


