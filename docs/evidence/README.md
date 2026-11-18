# Evidence

What backs the claims in `docs/portfolio/` — and how to add more.

## Behavioral benchmark (reproducible, no model)

`npm run bench` (from `orchestrator/`) drives canonical tickets through the **real graph** with a
fake executor and publisher: no model, no network, no credentials. It prints a markdown digest of the
route, final status and revisions per scenario, e.g.:

```
| Scenario | Route | Status | Revisions | Time |
|---|---|---|---|---|
| clear frontend ticket | triage → dev → reviewer → design → qa → webcheck → load → publish → ceo_approval → merge_pr → deploy → verify_deploy | simulated_deploy | 0 | ~8 s |
```

The same flows are covered by `npm test` (418 tests); `bench.ts` is the readable, portfolio-grade
summary of "the graph behaves", not a replacement for the suite. Re-run it whenever the graph changes
and paste the table into the case study.

## Cost evidence (the gap)

The only measured sample today is `cost-1/` (one trivial ticket, US$0.2308). To turn "to be measured"
into a number, run real tickets through the orchestrator and keep the `metrics.jsonl`.

Prerequisites:

1. The **Claude Code CLI** installed and logged in (`claude --version` works).
2. `orchestrator/.env` set from `.env.example` (model, `PUBLISHER`, `AGENTS_DIR`).
3. A target repo, and a committed `.orchestrator.json` in it (via `orch init`).

Process:

```bash
cd orchestrator
npm ci && npm link            # exposes `orch`
cd <target-repo>
orch run "<real request>"     # one ticket
orch approve <id>             # ...through to completion
orch clean <id>               # appends one line to ORCH_HOME/metrics.jsonl
```

`orch clean` writes one JSON line per ticket (route, tasks, revisions, escalations, time, tokens, cost,
total and per-node). Copy those lines into `docs/evidence/cost-<n>/metrics.jsonl` plus the `run.log`, and
update the "Cost per ticket" row in `docs/portfolio/VERIFIED.md` with the real figures. A handful of
tickets on a representative repo is enough to replace the single sample; an average over the set, not one
trivial ticket, is the honest number.

## Model evals

`npm run eval:review`, `eval:stages` and `eval:dev` score models against known answers; they need a model
and are the source of the per-stage table in the case study. The raw output is not committed today (the
scores are "reported as recorded"). To make them reproducible, re-run and keep the printed results in
`docs/evidence/evals-<date>.md` next to the score table.
