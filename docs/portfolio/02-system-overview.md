> Part of the [Agent Softhouse Orchestrator case study](README.md) — system overview and ticket flow

## 4. System overview

```mermaid
graph TD;
  triage(triage)
  discovery(discovery)
  planner(planner)
  dev(dev)
  docs_pre(docs_pre)
  reviewer(reviewer)
  design(design)
  qa(qa)
  webcheck(webcheck)
  load(load)
  publish(publish)
  ceo_approval(ceo_approval)
  merge_pr(merge_pr)
  deploy(deploy)
  verify_deploy(verify_deploy)
  triage -.-> dev;
  triage -.-> discovery;
  triage -.-> planner;
  triage -.-> ceo_approval;
  discovery -.-> planner;
  discovery -.-> ceo_approval;
  planner -.-> dev;
  planner -.-> ceo_approval;
  dev -.-> docs_pre;
  dev -.-> dev;
  dev -.-> ceo_approval;
  docs_pre --> reviewer;
  reviewer -.-> design;
  reviewer -.-> qa;
  reviewer -.-> dev;
  reviewer -.-> ceo_approval;
  design -.-> qa;
  design -.-> dev;
  design -.-> ceo_approval;
  qa -.-> webcheck;
  qa -.-> dev;
  qa -.-> ceo_approval;
  webcheck -.-> load;
  webcheck -.-> dev;
  webcheck -.-> ceo_approval;
  load -.-> publish;
  load -.-> dev;
  load -.-> ceo_approval;
  publish -.-> ceo_approval;
  publish -.-> dev;
  ceo_approval -.-> discovery;
  ceo_approval -.-> planner;
  ceo_approval -.-> dev;
  ceo_approval -.-> reviewer;
  ceo_approval -.-> design;
  ceo_approval -.-> qa;
  ceo_approval -.-> webcheck;
  ceo_approval -.-> load;
  ceo_approval -.-> publish;
  ceo_approval -.-> merge_pr;
  ceo_approval -.-> deploy;
  merge_pr -.-> deploy;
  merge_pr -.-> dev;
  merge_pr -.-> ceo_approval;
  deploy -.-> verify_deploy;
  deploy -.-> ceo_approval;
  verify_deploy -.-> ceo_approval;
```

### Components

| Component | File | Responsibility |
|---|---|---|
| Graph | `src/graph.ts` | Nodes, conditional edges, escalation routing (node bodies live in `plan-nodes.ts`, `dev-node.ts`, `review-nodes.ts`, `ship-nodes.ts`, `ceo-node.ts`, `webcheck.ts`, `load.ts`, `project-docs.ts`; the ticket schema is `src/ticket.ts`) |
| Executor | `src/run-agent.ts` | Runs one agent as a `claude -p` subprocess, parses/validates output, retries transient errors |
| Guardrails | `src/guardrails.ts` (re-exports `flow-limits.ts`, `permissions.ts`, `evidence.ts`, `git-safe.ts`, `modularity.ts`) | Limits, per-role permission table, minimal env, evidence verification |
| Publisher | `src/publish.ts` | Pushes the verified SHA and opens a **draft** PR (code, not agent) |
| Deploy | `src/deploy.ts` | Pluggable `DeployTarget` (simulated sandbox, or an external command); staging and production targets with a CEO promotion |
| Monitor / probe | `src/monitor.ts`, `src/probe.ts` | HTTP health checks, incident creation, `verify_deploy` after a deploy |
| Incidents | `src/incidents.ts` | File-backed store with fingerprint dedupe |
| Postmortem | `src/postmortem.ts` | Writes a sanitized postmortem into `playbooks/` |
| Ticket store | `src/ticket-store.ts` | One state file and one lock per ticket |
| Checkpointer | `src/file-saver.ts` | JSON-file `MemorySaver` so approval can happen in a later process |
| Repo config | `src/repo-config.ts` | Per-repo settings (test command, merge policy, publisher, deploy, webcheck, load) |
| Watchdog | `src/watchdog.ts` | Rule-based detection of stalled, looping or over-budget tickets (no model) |
| Team | `src/team.ts`, `src/specialties.ts` | Per-repo choice of dev specialties and stack (`orch team`) |
| Webcheck | `src/webcheck.ts`, `src/webcheck-evaluate.ts` | Code node: starts the app, checks GTM/GA4/Ads ids and Web Vitals budgets in Chromium |
| Load | `src/load.ts`, `src/load-driver.ts`, `src/load-proxy.ts` | Code stage: concurrency and slow-dependency load test against the running service |
| Project docs | `src/project-docs.ts` | Read-only `docs` agent returns updated file contents; code writes the repo's own tracked docs (`project_docs`) on the ticket's branch |
| CLI | `scripts/orch.ts` | `init`, `setup`, `team`, `run`, `adopt`, `status`, `continue`, `approve`, `reject`, `request-changes`, `clean`, `watch`, `rollback`, `resolve`, `manual`, `evidence`, `backlog`, `demand` |

### Non-invasive by design

The orchestrator reads its role prompts from `orchestrator/agents/` (the single prompt source; 22 role prompts as of 2026-11-17) and the repo rules from `CLAUDE.md`. `.claude/agents/*.md` are one-line pointer stubs to those prompts, so `/request`, `/ticket` and `/demand` read the same text and no prompt is duplicated. A check in `loadPrompt` fails if `AGENTS_DIR` points at the stubs, and `tests/conventions.int.test.ts` fails if a stub drifts from the pointer line.

---

## 5. How a ticket flows

1. **Triage** (read-only agent) classifies the request: priority, specialty, risk flags (schema, public API, permissions, external integration, cost), and whether it is clear enough to build.
2. **Clear** → straight to the dev. **Ambiguous** → the **discovery** agent (a pragmatic senior developer) asks one batch of problem/success/users/scope/constraints questions; the CEO's answers feed the **planner**, which writes the briefing and acceptance criteria.
3. **Large request** → the planner splits it into **atomic tasks**; the dev runs them one at a time, each verified before the next.
4. **Dev** works in an isolated git worktree (`ticket/<id>`, kept outside the repo) with a restricted tool set and commits its work.
5. **Code verifies the evidence** (new commit, clean tree, allowed paths, tests pass). Only then the ticket moves on.
6. **Reviewer** and **QA** (read-only, different identities from the author) receive the diff plus the code-verified evidence. UI tickets (`frontend`, `fullstack`) also pass through **design** (read-only) after the reviewer and **webcheck** (code) after QA. A rejection sends the ticket back to the dev with `revisions + 1`; at 2 revisions it escalates.
7. **Publish** (code) pushes exactly the verified SHA and opens a **draft PR**.
8. **CEO approval** is a LangGraph `interrupt()`. The CEO sees a plain-language explanation, the evidence, the PR and the active risk flags, and answers `orch approve` or `orch reject "reason"`.
9. **Merge** (opt-in `merge: auto`) squash-merges the approved commit only if CI is green and stable; otherwise the PR is left to the human.
10. **Deploy** runs through the configured `DeployTarget`, then `verify_deploy` probes it; with a `staging`/`production` pair, a healthy staging pauses for the CEO to promote to production, then the operations loop takes over.

The `docs_pre` node updates the repo's own tracked docs (`project_docs`) before review and never blocks a ticket. Each delivery also carries a **brief** (why, how, where it applies) that is bounded and escaped before it reaches prompts or the PR body.


