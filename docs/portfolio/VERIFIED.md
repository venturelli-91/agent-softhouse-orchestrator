# Verification of the case-study claims

Checked against `main` as of 2026-11-17 (date only; all counts here, such as commits, PRs, nodes, prompts, lines and tests, drift as tickets merge). Paths are relative to the repo root. Commands run from `orchestrator/`.

| Claim | Old value | Verified value | How verified |
|---|---|---|---|
| Source size | ~1,400 lines | 3,727 lines (3,430 non-blank) in 48 files; written as "~3,700 lines, 48 files" | `Get-ChildItem src/*.ts` for the file count; sum of line counts with and without blank lines |
| Automated tests | 170+ | 418 = 140 unit + 278 integration (276 pass, 2 skip) | `npm run test:unit` (reporter `tests 140`); `npm run test:int` (reporter `tests 278, pass 276, skipped 2`) |
| Test scripts | `npm test` only | `test:unit`, `test:int`, `test` runs both | `package.json` scripts |
| Runtime dependencies | 3 | 3 (`@langchain/core`, `@langchain/langgraph`, `zod`) | `package.json` dependencies |
| Commits | 111 | 402 | `git rev-list --count main` |
| Merged PRs | 7 | 51 (merge commits; highest PR number #52) | `git log --oneline main \| grep -ci "merge pull request"` |
| Skipped integration tests | not stated | 2 (symlink tests, skipped when the OS cannot create symlinks; observed on Windows 11, run of 2026-11-17: tests 278, pass 276, skipped 2) | `npm test` run on main, int suite reporter |
| Cost per ticket | to be measured | US$0.2308 for ONE trivial ticket (86 s, 0 revisions, 130,878 tokens including cached context; the `tokens` field of metrics.jsonl is 7,853 = input without cache plus output); a sample, not an average | `docs/evidence/cost-1/metrics.jsonl` and `run.log`; `src/metrics.ts:14` |
| Timeline | Oct 31 - Nov 4 | Oct 31 - Nov 17 (commits on 15 distinct days) | `git log --format=%ad --date=short` |
| Role prompts | "20" (original framework), 18 in `examples/agents` | 20 stubs in `.claude/agents/` at the first commit (baseline claim kept); now 22 prompts in `orchestrator/agents/`, 21 stubs in `.claude/agents/` | `git ls-tree -r --name-only <root commit>`; `ls orchestrator/agents`; `ls .claude/agents` |
| `AGENTS_DIR` default | `.claude/agents`; `examples/agents` | `agents` in `.env.example`, resolved to `orchestrator/agents`; `examples/` does not exist; unset in code is an error | `.env.example:3`; `scripts/orch.ts:44`; `src/run-agent.ts:57` |
| Single prompt source | "reuses `.claude/agents` unchanged", "only reads `.claude/agents`" | `orchestrator/agents` canonical, stubs are one-line pointers; `loadPrompt` refuses stubs; conventions test checks the pointer | `src/run-agent.ts:61`; `tests/conventions.int.test.ts`; `TEAM.md` |
| prompt-engineer role | not mentioned in the portfolio | removed from the project (no file in `orchestrator/agents` or `.claude/agents`); noted in the timeline | `ls`; `git log` "Remove the prompt-engineer role" (Nov 8) |
| Graph nodes | 9 (no design, webcheck, docs) | 15 nodes (triage, discovery, planner, dev, reviewer, design, qa, webcheck, load, publish, ceo_approval, merge_pr, deploy, verify_deploy, docs_pre) (+ START/END); diagram regenerated from the compiled graph | `src/graph.ts` `addNode` calls |
| Pipeline agents in tagline | triage, planner, dev, reviewer, QA, devops | no `devops`/`planner`-only model node for deploy (deploy, webcheck, load and verify_deploy are code); the tagline lists triage, discovery, planner, dev, reviewer, design, QA, docs as agents and webcheck, load, publish, deploy, verify_deploy as code | `src/graph.ts`; `README.md` |
| CLI commands | init, run, status, continue, approve, reject, clean, watch, chaos, rollback | init, setup, team, run, adopt, status, continue, approve, reject, request-changes, clean, watch, resolve, rollback, manual, evidence, backlog, demand (18); `chaos` was removed | `scripts/orch.ts:46-49` |
| External config location | `~/.orchestrator/config.json` | `<ORCH_HOME>/config.json`, default `orchestrator/.state/config.json`; `deploy`, `webcheck` and `load` only from it | `scripts/orch.ts`; `src/repo-config.ts` |
| Repo config keys | test, merge, publisher, push remote, base_repo, disclosure | plus `install`, `specialties`, `stack`, `project_docs`, `proposed_agents` (and external-only `deploy`, `webcheck`, `load`, `setup`, `env`) | `src/repo-config.ts` `RepoConfig` |
| Deploy config | environment staging/production | flat `{ command, rollback, health_url, environment?, env?, timeout_s?, max_latency_ms?, verify_minutes?, checks?, metrics_url?, max_error_rate? }`, or a strict `{ staging, production }` pair (staging deployed and verified first, then a CEO "promote?" to production) | `src/repo-config.ts` `DeployConfig`/`PromotedDeploy` |
| Worktree location | implied in repo | outside the repo (`ORCH_WORK`) | `orchestrator/README.md` (drop-in section) |
| Forbidden paths | `.env*`, `.github/`, `orchestrator/`, keys | plus `.orchestrator.json` | `src/evidence.ts` |
| Modularity guardrail | absent | 300 lines / 160 columns per touched file | `src/modularity.ts`; `src/dev-node.ts` |
| Token budget scaling | "fixed ceiling" | one extra budget per verified task, max 7 | `src/flow-limits.ts` |
| Hotfix on infra-only symptom | always a P0 hotfix | `unreachable` / `timeout` only propose the rollback | `src/monitor.ts` |
| Command deploy target validated | not yet proven | validated once on a local staging service, not hosted; `verify_deploy` and the staging→production promotion are covered by graph tests | `playbooks/2026-11-04-orchestrator-decisions.md`; `tests/graph.part4.int.test.ts` |
| Unchanged and confirmed | | MAX_REVISIONS 3, MAX_ACTIVE_TICKETS 5, probe symptoms, summary cap 10 lines, `tickets/<id>.json` + `.lock`, `activeTickets` via `git worktree list`, `claude -p` flags, minimal env, no model names in `src/`, CI on Node 24 with `contents: read`, `FileSaver`, deploy shadow-binary check, `--tools/--allowedTools/--disallowedTools`, `verify_minutes` (0..60, default 5), production checks only GET/HEAD | `src/flow-limits.ts`; `src/probe.ts`; `src/ticket.ts`; `src/git-safe.ts`; `src/run-agent.ts`; `src/agent-env.ts`; `tests/run-agent.test.ts`; `.github/workflows/ci.yml`; `src/repo-config.ts` |

## Removed as unverifiable

This list intentionally keeps the old numbers as an audit log. They must not be reintroduced without a source in a real `metrics.jsonl` or eval output file.

When these figures were removed, no `metrics.jsonl` or eval output file existed in the repo, so every cost/token/dollar figure was removed or replaced with "to be measured" (one measured sample was added later, see the Cost per ticket row above):

- README: "Typical ticket cost ~85k-95k tokens, ~US$0.04-0.11" and "Cost reduction ~78% (US$0.160 to 0.035)".
- 05-operations-and-cost: the baseline table (tokens, turns, time, US$ per node, total 85,246 / 46.4 s / 0.104), "output under 3-5% of tokens", "3.4k-6.7k tokens per turn", "dev ~50-55% of spend", "ambiguous route ~50% more", and the Haiku A/B (US$0.160 to 0.035, ~78%). They exist only as prose in `orchestrator/docs/07-metrics.md` and `08-real-repo-validation.md`, with no raw data on disk.
- 06-evaluation-and-testing: "cost differs by roughly 10x-30x between Haiku and Opus"; "Haiku went from ~50%" kept only with attribution to the orchestrator doc.
- 07-lessons-and-limits: "the A/B cost number comes from one sample per arm" (the number is gone).
- 05: "planner makes two calls" (`src/plan-nodes.ts` has one planner call site); rephrased to "adds a model call".

## Kept with a caveat (not re-measured)

- The model-by-stage score table (15/15, 12/15, 14/27, ...) and the "3 runs per case" statement are reported as recorded in `orchestrator/docs/08-real-repo-validation.md:112-140`. Raw eval output is not in the repo, and the evals were not re-run (they need model calls).
- Historical items not checkable from the current tree: the bug table in 07, the Oct 31 - Nov 8 timeline rows, "live validation on a real private GitHub repo", "security review rounds". Left as written.

## Undecided

- `TEAM.md` names `orchestrator/tests/conventions.test.ts`; the file is `conventions.int.test.ts`. Not touched (outside `docs/portfolio/`).
- The repo URL and name are not hardcoded; the README says "URL pending the repo rename".
