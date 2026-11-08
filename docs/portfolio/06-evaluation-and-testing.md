> Part of the [Agent Softhouse Orchestrator case study](README.md) — evaluation, testing and timeline

## 11. Evaluation: choosing a model per stage

Instead of guessing which model each role needs, I built three eval scripts (`eval-review.ts`, `eval-stages.ts`, `eval-dev.ts`) that score models on cases with **known answers**. The dev eval uses **hidden acceptance tests** the dev never sees. Three runs per case in the recorded run (the eval scripts default to 1 rep). The scores below come from the write-up in `orchestrator/docs/08-real-repo-validation.md`; the raw eval output is not kept in the repo, so they are reported as recorded, not re-measured.

| Stage | Haiku 5.5 | Sonnet 5.5 | Opus 5.5 |
|---|---|---|---|
| Reviewer (5 diffs) | 15/15 | 15/15 | 15/15 |
| QA (5 diffs) | 12/15 | 15/15 | 15/15 |
| Triage (9 requests) | 14/27 | 24/27 | 26/27 |
| Devops | 9/9 | 9/9 | 9/9 |
| Planner | 27/27 | 27/27 | 27/27 |
| Dev, 4 small tickets | 12/12 | 12/12 | 12/12 |
| Dev, 2 harder tickets | 6/6 | 6/6 | 6/6 |

**Decisions from the data**

- Reviewer and devops → Haiku (same accuracy on this test; cheaper per call).
- QA → Haiku is enough in practice; its misses approve scope creep that the reviewer catches 15/15.
- **Triage → keep the default model.** Haiku calls explicit requests "unclear" in most runs, which would push work through the planner route, which adds a model call. This is a case where the cheaper model looks fine on paper and costs more in the pipeline.
- Dev → default model; the eval saturates at 100%, so it can't say whether Haiku equals Sonnet on a real multi-file feature. This is reported as a limit of the test, not as a win.

### Bugs the evals found (all fixed)

1. **A QA prompt that demanded something QA cannot do.** The prompt required running tests, QA has no shell, and stricter models rejected good diffs with *"I found no defect… rejecting because I couldn't run the checks."* Fix: the graph now passes the code-verified evidence to QA (`evidenceNote`).
2. **Compound shell commands silently killed the dev.** A `;` or pipe was denied by the allowlist and the dev gave up without committing (about half the runs, across all three models, which first looked like 36/36 failures). Fix: `DEV_RULES` tells the dev to use one simple command per call; Haiku went from about half the runs to 12/12 (per `orchestrator/docs/08-real-repo-validation.md`).
3. **Two flaws in my own harness** (a "good" case that couldn't distinguish floor from round, and a crash on node failure), fixed and disclosed.

---

## 12. Testing strategy

- **242 tests defined with `node:test`** (81 unit, 161 integration; 2 integration tests skip where symlinks are unavailable; counts as of 2026-11-08), run on Node 24 with native TypeScript. No vitest, no tsx. `npm run test:unit` runs the fast pure tests, `npm run test:int` the ones that build real git repos and drive the graph, and `npm test` runs both.
- **Zero network, model or credentials.** A fake executor (`registerExecutor("fake", ...)`) and a fake publisher exercise the real graph. The fake dev makes **real commits** in a fixture repo.
- Coverage includes: revision cap, self-approval, declared-but-false evidence, forbidden paths, `package.json` changes, uncommitted changes, deploy only after approval, escalation on every failure class, planner clarification loop, push/PR ordering, git config tampering, local merge safety, incident dedupe, chaos sandbox restriction, probe symptoms, deploy command masking, postmortem sanitization, per-ticket locks.
- **CI:** GitHub Actions on Node 24 (typecheck, then `npm test`) with `permissions: contents: read` and no secrets.
- **Live validation** on a real private GitHub repo with the real model: draft PRs, an ambiguous request resolved through planner questions, persistent approval across two processes, and a real squash-merge after green CI.
- **Security review rounds** after each phase; each finding was fixed together with a regression test.

---

## 13. Timeline: how it was built

| Date | Milestone |
|---|---|
| Oct 31 | Baseline import; project scaffold; `claude -p` executor with per-role permissions; tracer-bullet graph (triage → dev → reviewer → QA → CEO → simulated deploy); flow guardrails with code-verified evidence; planner node; publish by code; generic example agents, README, MIT license; secrets check; first public push |
| Nov 1 | Full English migration; real-repo tracer; file-backed checkpoints and resume; model evals and per-stage matrix; retry on busy API; per-repo config and merge policy; daily token cap; notifications; the `orch` CLI; multi-repo/fork/disclosure support |
| Nov 2 | Local merge for solo repos; per-ticket state and locks; git-config tamper checks; **pre/post-production graph** (design → plan → implementation): deploy node, incidents, chaos, monitor, postmortems, `watch`/`chaos`/`rollback`; **real command deploy target and HTTP probe** (PRs #1, #2) |
| Nov 4 | Loose ends closed and decisions recorded in `playbooks/`; `install` option (`npm ci --ignore-scripts` from the lockfile); delivery brief; **atomic task splitting** with scaled token budgets; large-diff escalation; `orch continue` (PRs #3–#7) |
| Nov 6 | Playbook for the command deploy target validated on a staging service; per-ticket metrics on `orch clean`; the orchestrator folder made a self-contained drop-in; **graph-written project docs** (`docs` role, `docs_start`/`docs_mid`/`docs_end`) (PRs #8–#13) |
| Nov 7 | `.claude/CLAUDE.md` rules loading; modularity guardrail; `graph.ts`, `guardrails.ts` and `orch.ts` split by responsibility; the team mapped by tier (`TEAM.md`); per-project dev specialties; red-base refusal; `orch team` (PRs #14–#27) |
| Nov 8 | **`design` node** for UI tickets; **`webcheck` node** (GTM, GA4, Ads, Web Vitals in Chromium); `orch setup`; the prompt-engineer role removed; `.claude/agents` turned into pointer stubs to `orchestrator/agents` (PRs #30–#33 and direct commits) |

The work followed a **spec → plan → implementation** discipline: each major feature has a written design (goals, non-goals, decisions) and an implementation plan under `docs/superpowers/`, and the CEO-approved design was committed before the code.


