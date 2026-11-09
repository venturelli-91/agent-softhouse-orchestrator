# Verification of the case-study claims

Checked against `main` as of 2026-11-08 (date only; all counts here, such as commits, PRs, nodes, prompts, lines and tests, drift as tickets merge). Paths are relative to the repo root. Commands run from `orchestrator/`.

| Claim | Old value | Verified value | How verified |
|---|---|---|---|
| Source size | ~1,400 lines | 2,426 lines (2,235 non-blank) in 38 files; written as "~2,400 lines, 38 files" | `cat src/*.ts \| wc -l`; `ls src/*.ts \| wc -l` |
| Automated tests | 170+ | 245 = 82 unit + 163 integration | Unit: `npm run test:unit` reporter, `tests 82`. Integration: STATIC count only (`grep -cE "^\s*(test\|it)\(" tests/*.int.test.ts`, summed = 163); the int suite was not rerun for this count (the full run of 2026-11-08 before later tests reported 161 integration tests, 159 passed, 2 skipped; a later QA run of the full int suite reported 163 tests, 161 passed, 2 skipped). The same static count on the unit files gives 82, equal to the reporter, so the method is consistent |
| Test scripts | `npm test` only | `test:unit`, `test:int`, `test` runs both | `package.json` scripts |
| Runtime dependencies | 3 | 3 (`@langchain/core`, `@langchain/langgraph`, `zod`) | `package.json` dependencies |
| Commits | 111 | over 200 (213 at commit 0b9be7f, 222 at 27d79d6; it grows with every merge, so the README gives a floor) | `git rev-list --count main` |
| Merged PRs | 7 | over 30 (31 merge commits at 0b9be7f, highest PR number #33) | `git log --oneline main \| grep -ci "merge pull request"` |
| Skipped integration tests | not stated | 2 (the symlink tests in `conventions.int.test.ts`, skipped when the OS cannot create symlinks; observed on Windows 11, run of 2026-11-08: tests 161, pass 159, skipped 2) | `npm test` run on main, int suite reporter |
| Cost per ticket | to be measured | US$0.2308 for ONE trivial ticket (86 s, 0 revisions, 130,878 tokens including cached context; the `tokens` field of metrics.jsonl is 7,853 = input without cache plus output); a sample, not an average | `docs/evidence/cost-1/metrics.jsonl` and `run.log`; `src/metrics.ts:14` |
| Timeline | Oct 31 - Nov 4 | Oct 31 - Nov 8 (commits on 8 distinct days) | `git log --format=%ad --date=short` |
| Role prompts | "20" (original framework), 18 in `examples/agents` | 20 stubs in `.claude/agents/` at the first commit (baseline claim kept); now 21 prompts in `orchestrator/agents/`, 19 stubs in `.claude/agents/` | `git ls-tree -r --name-only <root commit>`; `ls orchestrator/agents`; `ls .claude/agents` |
| `AGENTS_DIR` default | `.claude/agents`; `examples/agents` | `agents` in `.env.example`, resolved to `orchestrator/agents`; `examples/` does not exist; unset in code is an error | `.env.example:3`; `scripts/orch.ts:38`; `src/run-agent.ts:57` |
| Single prompt source | "reuses `.claude/agents` unchanged", "only reads `.claude/agents`" | `orchestrator/agents` canonical, stubs are one-line pointers; `loadPrompt` refuses stubs; conventions test checks the pointer | `src/run-agent.ts:61`; `tests/conventions.int.test.ts:130-139`; `TEAM.md` |
| prompt-engineer role | not mentioned in the portfolio | removed from the project (no file in `orchestrator/agents` or `.claude/agents`); noted in the timeline | `ls`; `git log` "Remove the prompt-engineer role" (Nov 8) |
| Graph nodes | 9 (no design, webcheck, docs) | 14 nodes (+ START/END); diagram regenerated from the compiled graph | `buildGraph().getGraphAsync().drawMermaid()`; `src/graph.ts:30-43` |
| Pipeline agents in tagline | triage, planner, dev, reviewer, QA, devops | there is no `devops` node (deploy is code); added design, webcheck, docs | `src/graph.ts`; `TEAM.md` |
| CLI commands | init, run, status, continue, approve, reject, clean, watch, chaos, rollback | plus `setup`, `team`, `resolve` | `scripts/orch.ts:41` |
| External config location | `~/.orchestrator/config.json` | `<ORCH_HOME>/config.json`, default `orchestrator/.state/config.json`; `deploy` and `webcheck` only from it | `scripts/orch.ts:4`; `src/repo-config.ts:39,76,92` |
| Repo config keys | test, merge, publisher, push remote, base_repo, disclosure | plus `install`, `specialties`, `stack` (and external-only `deploy`, `webcheck`) | `src/repo-config.ts:41-57` |
| Worktree location | implied in repo | outside the repo (`ORCH_WORK`) | `orchestrator/README.md` (drop-in section) |
| Forbidden paths | `.env*`, `.github/`, `orchestrator/`, keys | plus `.orchestrator.json` | `src/evidence.ts:10-13` |
| Modularity guardrail | absent | 300 lines / 160 columns per touched file | `src/modularity.ts:4-5`; `src/dev-node.ts:13` |
| Token budget scaling | "fixed ceiling" | one extra budget per verified task, max 7 | `src/flow-limits.ts:14` |
| Hotfix on infra-only symptom | always a P0 hotfix | `unreachable` / `timeout` only propose the rollback | `src/monitor.ts:12-13,37` |
| Command deploy target validated | not yet proven | validated once on a local staging service, not hosted | `playbooks/2026-11-04-orchestrator-decisions.md` (commit 4e75ca5) |
| Unchanged and confirmed | | MAX_REVISIONS 3, MAX_ACTIVE_TICKETS 5, 12 chaos scenarios, probe symptoms, summary cap 10 lines, tickets/<id>.json + .lock, `activeTickets` via `git worktree list`, `claude -p` flags, minimal env, no model names in `src/`, CI on Node 24 with `contents: read`, `FileSaver`, deploy shadow-binary check, `--tools/--allowedTools/--disallowedTools` | `src/flow-limits.ts`; `src/chaos.ts:5-18`; `src/probe.ts`; `src/ticket.ts:9`; `src/git-safe.ts:36`; `src/run-agent.ts:70-84`; `src/agent-env.ts`; `tests/run-agent.test.ts:39`; `.github/workflows/ci.yml` |

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
- Historical items not checkable from the current tree: the bug table in 07, the Oct 31 - Nov 4 timeline rows, "live validation on a real private GitHub repo", "security review rounds". Left as written.

## Undecided

- `TEAM.md` names `orchestrator/tests/conventions.test.ts`; the file is `conventions.int.test.ts`. Not touched (outside `docs/portfolio/`).
- Integration test count is static (161); a full `npm run test:int` would confirm it.
- The repo URL and name are not hardcoded; the README says "URL pending the repo rename".
