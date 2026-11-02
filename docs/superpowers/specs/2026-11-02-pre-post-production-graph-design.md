# Pre/Post-Production Orchestration: Design

Status: approved by the CEO on 2026-11-02. Nothing here is built yet.

## Intent

The CEO wants the framework to carry a piece of work from a request to a running product and keep it healthy afterwards: requirements, user stories, development, commit, a commit/PR review explained in plain language, deploy, monitoring, and a way to handle the failures products commonly have. The CEO also wants those failures provoked on purpose, to see the system keep working.

Today `orch` covers triage to a simulated deploy. It has nothing before the dev (formal requirements, stories) and nothing after the deploy (monitoring, incidents, learning). This work prepares the graph for the whole cycle. A throwaway test product comes afterwards, as a separate project.

## Decisions made by the CEO

- Two loops: **delivery** (pre-production) and **operations** (post-production). The boundary is the deploy.
- An incident found by operations becomes a **P0 ticket that enters the delivery graph again**. Delivery never waits for what happens after a deploy.
- The graph is prepared first. The test product is decided afterwards.
- Chaos scope: every common product failure (see the catalog below).
- The CEO stays the only one who approves merge and deploy (unchanged rule).
- Hotfixes respect the limit of 5 active tickets (see below).

## Goals

1. Delivery graph starts with `requirements` and `stories` and ends with a `deploy` node that sits behind CEO approval.
2. `reviewer` and `qa` produce a short plain-language explanation of what changed and why; it reaches the CEO at approval.
3. Operations loop: `monitor` detects a failure, opens an incident, which creates a P0 hotfix ticket; a rollback proposal waits for CEO approval; `postmortem` records the failure in `playbooks/`.
4. Chaos: a way to inject each failure in the catalog and prove the loop reacts, without any real product or real production.
5. Everything testable with fake nodes: no model, no network, no real deploy.

## Non-goals

- A real deploy target (Vercel or other), a real product, real monitoring integrations (Sentry, Datadog). The deploy target and the health probe are plug-in points with a simulated default.
- Automatic approval of anything, automatic rollback, automatic fix in production.
- A UI or dashboard. Output is the terminal, the existing notification and files.

## Anti-goals (a failure even if it technically works)

- Anything reaches production, or changes it, without `orch approve`.
- The monitor floods the CEO: the same failure must not open a new ticket on every check.
- Chaos injection touching anything that is not explicitly marked as a sandbox.
- Hotfix tickets starving or crashing normal tickets (per-ticket state and locks stay as they are).

## Constraints (carried over from the hardening plan)

- Everything under `orchestrator/` (plus these docs); deleting it must still restore the old flow.
- No new dependency, daemon or database: files, `git`, `gh`.
- Host-side git goes through `safeGit` / `safeRemoteGit`; the ticket's pinned `repo` and `.git/config` hash checks apply to anything that publishes or merges.
- Each new behavior gets a test with fake nodes. Existing tests keep passing (87 today).
- Conventional Commits in English with scope `orchestrator`, one logical change per commit, no attribution lines.
- Do not run anything against the real model or a real GitHub repo.

## Architecture

```
DELIVERY (per ticket, one graph)
request -> triage -> requirements -> stories -> dev -> reviewer -> qa -> publish
        -> ceo_approval -> merge_pr -> deploy -> (end, ticket "deployed")

OPERATIONS (not per ticket, thin)
monitor --failure--> incident --> hotfix ticket (P0) -> enters DELIVERY at dev
                              \-> rollback proposal -> ceo_approval -> rollback
postmortem (after an incident closes) -> playbooks/<date>-<slug>.md
```

- **requirements / stories:** build on the existing `planner` node rather than duplicating it. Output: a briefing (goal, user, acceptance criteria) and small stories that become the ticket's `criteria`. Triage still decides when to skip them for a clear ticket (existing rule in `CLAUDE.md`).
- **deploy:** replaces the simulated `devops` node. Runs only after `merge_pr` and the CEO's approval. The target is an interface with one implementation today: `simulated`.
- **monitor:** reads a health probe (interface, simulated default) for deployed tickets. Not a node inside a ticket's graph.
- **incident:** a small file in `ORCH_HOME` keyed by failure fingerprint (deduplication and a cap on open incidents). Opening one creates the P0 hotfix ticket and notifies the CEO.
- **rollback:** always a proposal that waits for approval; it is a change to production.
- **postmortem:** the agent proposes the text; code writes the file under `playbooks/` (the agent has no write access there).

## Chaos catalog

Deploy: broken build, missing environment variable, failed migration.
Runtime: 500s, latency spike, memory growth, expired certificate or token.
Dependencies: external API down, timeout, rate limit; database unavailable.
Code: a regression that passes the tests.

Each item is a named scenario that makes the simulated probe report a symptom. Injection refuses to run unless the target is marked `sandbox`.

## My calls (the CEO should check these)

- Names: `requirements`, `stories`, `deploy`, `monitor`, `incident`, `postmortem`.
- Operations runs as a command (`orch watch`, run on demand or by a scheduler) and not as a long-lived daemon.
- Rollback needs CEO approval, even though it restores a previous state.
- Incident deduplication by a fingerprint of symptom plus ticket, with a cap of open incidents.
- The plain-language explanation is a field in the reviewer and QA outputs, shown with the approval request.
- The deployed state is a new final status next to `simulated_deploy`; existing statuses keep their meaning.

## Left to the builder

Schemas and prompts of the new nodes, file layout inside `orchestrator/`, the probe and target interfaces, fingerprint format, test structure, and how `orch status` shows incidents.

## Decided by the CEO: hotfix and the ticket limit

A P0 hotfix counts toward the limit of 5 active tickets like any other (it also keeps token spend bounded). When the limit is reached the incident waits and notifies the CEO.

## Acceptance

With fake nodes only:
1. A ticket runs from request to `deploy` (simulated) and only deploys after approval.
2. An injected failure makes `monitor` open exactly one incident and one P0 ticket, even if checked repeatedly.
3. A rollback proposal does nothing until approved.
4. `postmortem` writes one file under `playbooks/`.
5. Chaos injection refuses a target not marked `sandbox`.
6. The reviewer/QA explanation shows up in the approval request.
7. All existing tests still pass.
