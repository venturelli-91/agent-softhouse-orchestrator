# Pre/Post-Production Graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `orch` so a ticket runs from request to a (simulated) deploy with an explained review, and an operations loop detects injected failures, opens one P0 hotfix ticket per failure, proposes a rollback for the CEO and records a postmortem.

**Architecture:** The delivery graph in `src/graph.ts` keeps its shape; `devops` becomes a code-only `deploy` node that calls a pluggable `DeployTarget` (default `simulated`) and records the deploy in `ORCH_HOME/deployed/`. Operations is not a graph: `src/incidents.ts`, `src/chaos.ts`, `src/monitor.ts` and `src/postmortem.ts` are small file-backed modules driven by `orch watch`. An incident creates a normal ticket (priority P0) that enters the delivery graph.

**Tech Stack:** Node 24 (type stripping, `node --test`), TypeScript, LangGraph.js, zod, `git`.

**Spec:** `docs/superpowers/specs/2026-11-02-pre-post-production-graph-design.md`

## Global Constraints

- Everything stays under `orchestrator/` (plus these docs); deleting `orchestrator/` must still restore the old flow.
- No new dependency, daemon or database: files, `git`, `gh` only.
- Nothing reaches or changes production without `orch approve` / `orch rollback`; no automatic rollback or fix.
- At most 5 active tickets (`MAX_ACTIVE_TICKETS`); a P0 hotfix counts like any ticket and an incident waits when the limit is hit.
- Host-side git through `safeGit` / `safeRemoteGit`; ticket state stays per-ticket (`ticket-store.ts`).
- Existing tests keep passing (87 today); each new behavior gets a test with fake nodes (no model, no network, no real deploy).
- Commits: Conventional Commits in English with scope `orchestrator`, one per task, no co-author or attribution lines.
- Run `cd orchestrator && npm run typecheck`; `tests/graph.test.ts` takes about 200 s, so run single files while working and the full `npm test` only at the end of Tasks 3 and 8.

## Deviation from the spec (flag to the CEO)

The spec names `requirements` and `stories` nodes. This plan implements them as the output of the existing single `planner` node (briefing and stories), because the code already runs demand-analyst, product-manager and tech-lead in one agent turn to spend tokens once. Splitting later is a graph edit; the ticket fields stay the same.

## Review Focus

- `orch watch` run twice on the same failure: one incident, one ticket, one notification (Task 6).
- Active-ticket limit reached when an incident opens: the incident waits with status `waiting`, nothing crashes, and the next `watch` creates the ticket once there is room (Task 6).
- Rollback proposed but never approved: the target's `rollback` is not called; approving twice rolls back once (Task 6).
- Chaos on a target not marked sandbox: refused with an error and nothing written (Task 5).
- Postmortem with a title like `../../x`: the file stays inside `playbooks/` (Task 7).

---

### Task 1: Plain-language explanation reaches the CEO

**Files:**
- Modify: `orchestrator/src/graph.ts` (`ReviewOutput`, `Ticket`, `reviewStep`, `ceoApproval`)
- Test: `orchestrator/tests/graph.test.ts`

**Interfaces:**
- Produces: `ReviewOutput.explanation: string` (zod `.default("")`, so existing fake nodes still validate); `Ticket.explanation: string` (default `""`); the approval/escalation `interrupt` payload gains `explanation: string`.

- [ ] **Step 1: Write failing test** `the reviewer and qa explanations reach the approval request`: fake `reviewer` returns `explanation: "R-EXPL"` and `qa` returns `explanation: "Q-EXPL"`; after `start`, read the pending interrupt with `graph.getState(config(id))` and assert its `explanation` contains both strings.
- [ ] **Step 2: Run** `node --test tests/graph.test.ts`; expect the new test to fail.
- [ ] **Step 3: Implement.** In `reviewStep`, append each approved step's `explanation` (trimmed, capped with `cap`) to `Ticket.explanation`; ask for it in the step context ("explanation: what changed and why, in plain language a non-programmer follows, up to 6 lines"); pass `t.explanation` in the `interrupt` payload.
- [ ] **Step 4: Run** `node --test tests/graph.test.ts`; expect green.
- [ ] **Step 5: Commit** `feat(orchestrator): carry a plain-language review explanation to the CEO approval`

### Task 2: Planner outputs a briefing and stories; incident tickets stay P0

**Files:**
- Modify: `orchestrator/src/graph.ts` (`PlanOutput`, `Ticket`, `planner`, `triage`, `ticketData`)
- Test: `orchestrator/tests/graph.test.ts`

**Interfaces:**
- Produces: `Ticket.briefing: string` and `Ticket.stories: string[]` (defaults `""` / `[]`); `Ticket.incident: string` (default `""`, the incident id that created the ticket).

- [ ] **Step 1: Write failing tests:** `the planner's briefing and stories land on the ticket and in the dev context` (ambiguous triage, planner returns `briefing: "B-CANARY"`, `stories: ["As a buyer I want X so that Y"]`; the dev request context contains both); `a ticket with an incident keeps priority P0 even if triage says P2` (pass `incident: "inc-1"` via `start(..., extra)`).
- [ ] **Step 2: Run;** expect failures.
- [ ] **Step 3: Implement.** Extend `PlanOutput` with `briefing` and `stories` (both `.default`-ed so older fake outputs validate); include them in `ticketData`; in `triage` and `planner` return `priority: t.incident ? "P0" : <model value>`.
- [ ] **Step 4: Run** `node --test tests/graph.test.ts`; expect green.
- [ ] **Step 5: Commit** `feat(orchestrator): planner writes a briefing and stories, incident tickets stay P0`

### Task 3: `deploy` node and pluggable deploy targets

**Files:**
- Create: `orchestrator/src/deploy.ts`
- Modify: `orchestrator/src/graph.ts` (replace `devops` with `deploy`, `RETRYABLE`, `POST_DEV`, edges), `orchestrator/scripts/orch.ts` (`DONE`), existing tests that name `devops` or `simulated_deploy`
- Test: `orchestrator/tests/deploy.test.ts`, `orchestrator/tests/graph.test.ts`

**Interfaces:**
- Produces in `deploy.ts`: `type DeployTarget = { sandbox: boolean; deploy(d: { id: string; sha: string }): string; rollback(d: { id: string; sha: string; previous: string }): string }`; `registerDeployTarget(name: string, t: DeployTarget): void`; `getDeployTarget(name: string): DeployTarget` (throws on unknown name); `recordDeploy(home: string, r: { id: string; repo: string; sha: string; previous: string; target: string; sandbox: boolean }): void` writing `home/deployed/<id>.json`; `deployedIds(home: string): string[]`; `readDeploy(home: string, id: string): DeployRecord`. Built-in target `simulated` has `sandbox: true` and returns strings starting `simulated:`. Ids go through the same validation as `ticketFile`.
- Produces: `Ticket.deploy_target: string` (default `"simulated"`); final status `simulated_deploy` for the simulated target, `deployed` for any other.

- [ ] **Step 1: Write failing tests** in `deploy.test.ts`: `simulated target is a sandbox and reports simulated`; `unknown target throws`; `recordDeploy then readDeploy round-trips and deployedIds lists it`; `ids with path separators are rejected`. In `graph.test.ts`: `after approval the deploy node runs the ticket's target and ends in simulated_deploy` (assert the record exists in the fixture home and that no agent call named `devops` happens).
- [ ] **Step 2: Run** the two files; expect failures.
- [ ] **Step 3: Implement `deploy.ts`, then the `deploy` node:** no agent call; it takes `previous` as the ticket's `base` sha and `sha` as `approved_sha`, calls the target, calls `recordDeploy`, adds `deploy:<result>` to `evidence`. Rename `devops` to `deploy` in the edges, `RETRYABLE` and `POST_DEV`; add `deployed` next to `simulated_deploy` in `DONE` in `orch.ts`. Update existing tests that referenced `devops`.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`; expect green.
- [ ] **Step 5: Commit** `feat(orchestrator): deploy node with pluggable targets replaces the simulated devops agent`

### Task 4: Incident store

**Files:**
- Create: `orchestrator/src/incidents.ts`
- Test: `orchestrator/tests/incidents.test.ts`

**Interfaces:**
- Produces: `type Incident = { id: string; ticket: string; symptom: string; status: "open" | "waiting" | "closed"; hotfix: string; rollback: "none" | "proposed" | "done"; opened: string }`; `MAX_OPEN_INCIDENTS = 5`; `fingerprint(ticket: string, symptom: string): string` (first 12 hex chars of sha1); `openIncident(home: string, ticket: string, symptom: string): { incident: Incident; created: boolean }` (returns the existing one with `created: false` when the fingerprint is already open or waiting; throws `Error("open incident limit reached")` at the cap); `updateIncident(home: string, id: string, patch: Partial<Incident>): Incident`; `listIncidents(home: string): Incident[]` (sorted by `opened`); files under `home/incidents/<id>.json`.

- [ ] **Step 1: Write failing tests:** `same ticket and symptom open once`; `a different symptom opens another`; `a closed incident can be opened again`; `the cap of open incidents throws`; `updateIncident merges and listIncidents sorts by opened`.
- [ ] **Step 2: Run;** expect failures.
- [ ] **Step 3: Implement the four functions** with plain `fs` reads and writes.
- [ ] **Step 4: Run** `node --test tests/incidents.test.ts`; expect green.
- [ ] **Step 5: Commit** `feat(orchestrator): file-backed incident store with fingerprint dedupe and a cap`

### Task 5: Chaos scenarios and the simulated probe

**Files:**
- Create: `orchestrator/src/chaos.ts`
- Test: `orchestrator/tests/chaos.test.ts`

**Interfaces:**
- Consumes: `readDeploy` (Task 3).
- Produces: `SCENARIOS: Record<string, string>` mapping the spec's catalog names to the symptom text the probe reports: `broken-build`, `missing-env`, `failed-migration`, `http-500`, `latency-spike`, `memory-growth`, `cert-expired`, `api-down`, `api-timeout`, `rate-limit`, `db-down`, `regression`; `injectFailure(home: string, id: string, scenario: string): void` (throws if the scenario is unknown or the deploy record has `sandbox: false`, and writes nothing in either case); `clearFailure(home: string, id: string): void`; `type Probe = (home: string, id: string) => string | null`; `simulatedProbe: Probe` (returns the active scenario's symptom or `null`).

- [ ] **Step 1: Write failing tests:** `every catalog scenario injects and the probe reports its symptom` (loop over `SCENARIOS`); `clearFailure makes the probe healthy`; `injecting on a non-sandbox deploy throws and writes nothing`; `an unknown scenario throws`.
- [ ] **Step 2: Run;** expect failures.
- [ ] **Step 3: Implement** with one small JSON file `home/chaos/<id>.json`.
- [ ] **Step 4: Run** `node --test tests/chaos.test.ts`; expect green.
- [ ] **Step 5: Commit** `feat(orchestrator): chaos scenarios that only inject into sandbox deploys`

### Task 6: Monitor opens one hotfix ticket and proposes a rollback

**Files:**
- Create: `orchestrator/src/monitor.ts`
- Test: `orchestrator/tests/monitor.test.ts`

**Interfaces:**
- Consumes: `deployedIds`, `readDeploy` (Task 3); `openIncident`, `updateIncident`, `listIncidents` (Task 4); `Probe`, `simulatedProbe` (Task 5); `getDeployTarget` (Task 3).
- Produces: `watch(home: string, deps: { probe: Probe; makeHotfix: (r: { incident: Incident; repo: string }) => Promise<string>; notify: (text: string) => Promise<void> }): Promise<Incident[]>`. For each deployed id with a symptom: open or reuse the incident; on `created`, notify the CEO; if it has no hotfix yet, call `makeHotfix` (returns the new ticket id) and store it in `hotfix`, setting `rollback: "proposed"` once; if `makeHotfix` throws with a message matching `/limit/`, set `status: "waiting"` and keep going; a healthy probe for a deployed id closes its open incidents. `approveRollback(home: string, incidentId: string): string`: refuses unless `rollback === "proposed"`, calls the target's `rollback` with the deploy record's `sha` and `previous`, sets `rollback: "done"`; a second call throws `"already rolled back"`.
- `makeHotfix` is injected so tests need no git; `orch watch` (Task 8) supplies the real one built on `createWorktree` with `incident` set.

- [ ] **Step 1: Write failing tests** with a fake probe, a counting `makeHotfix`, a recording `notify` and a recording target registered under a test name: `two watches on one failure make one incident, one ticket and one notification`; `a limit error leaves the incident waiting and the next watch creates the ticket`; `the rollback target is not called until approveRollback`; `approveRollback twice rolls back once`; `a healthy probe closes the incident`.
- [ ] **Step 2: Run;** expect failures.
- [ ] **Step 3: Implement `watch` and `approveRollback`.**
- [ ] **Step 4: Run** `node --test tests/monitor.test.ts`; expect green.
- [ ] **Step 5: Commit** `feat(orchestrator): monitor opens one P0 hotfix per failure and proposes a rollback for the CEO`

### Task 7: Postmortem written by code

**Files:**
- Create: `orchestrator/src/postmortem.ts`
- Modify: `orchestrator/src/guardrails.ts` (add role `knowledge`, read-only like `watchdog`), `orchestrator/src/run-agent.ts` only if roles are listed there
- Test: `orchestrator/tests/postmortem.test.ts`

**Interfaces:**
- Produces: `writePostmortem(repo: string, incident: Incident, text: string, date = new Date()): string` returning the path of `<repo>/playbooks/<YYYY-MM-DD>-<slug>.md`; `slug` keeps only `[a-z0-9-]` from the symptom; a second call for the same incident id returns the existing path and does not rewrite it; the file is left uncommitted for the CEO.
- Produces: `proposePostmortem(incident: Incident, ctx: string): Promise<string>` asking the `knowledge-manager` agent (role `knowledge`, schema `{ text: string }`) for the text.

- [ ] **Step 1: Write failing tests:** `the postmortem lands in playbooks with the date and slug`; `writing it twice keeps one file`; `a symptom containing ../ stays inside playbooks`; `proposePostmortem uses the fake knowledge executor` (register it with `registerExecutor`).
- [ ] **Step 2: Run;** expect failures.
- [ ] **Step 3: Implement,** following how `watchdog` is wired in `run-agent.ts` and `guardrails.ts`.
- [ ] **Step 4: Run** `node --test tests/postmortem.test.ts` and `npm run typecheck`; expect green.
- [ ] **Step 5: Commit** `feat(orchestrator): postmortems written by code from an agent proposal`

### Task 8: CLI, docs and the end-to-end acceptance test

**Files:**
- Modify: `orchestrator/scripts/orch.ts`, `orchestrator/README.md`
- Test: `orchestrator/tests/operations.test.ts`

**Interfaces:**
- Consumes: everything above. Produces commands: `orch watch` (one monitor pass using `simulatedProbe`; the real `makeHotfix` calls `createWorktree`, then drives the graph with `incident` set; a failure from `activeTickets` limit must surface as an error matching `/limit/`), `orch chaos <ticket-id> <scenario>|--clear`, `orch rollback <incident-id>` (the CEO's approval of a proposed rollback), `orch status` listing incidents next to tickets.

- [ ] **Step 1: Write failing acceptance test** `operations.test.ts` with the fixture repo and fake nodes: a ticket reaches `simulated_deploy`; `injectFailure` then `watch` opens one incident and one P0 hotfix ticket (the ticket's `priority` is `P0` and `incident` is set); a second `watch` creates nothing; the rollback target is untouched until `approveRollback`; `writePostmortem` produces one file; `injectFailure` on a non-sandbox record is refused.
- [ ] **Step 2: Run;** expect failure.
- [ ] **Step 3: Wire the four commands in `orch.ts`** (locks on the ticket ids they touch, `notify` for new incidents) and update the usage comment.
- [ ] **Step 4: Update `README.md`:** the two loops, the deploy target interface, `watch`, `chaos`, `rollback`, the scenario catalog and that chaos only works on sandbox targets.
- [ ] **Step 5: Verify** `npm test`, `npm run typecheck`, then a smoke with a throwaway home: `ORCH_HOME=<tmp> node scripts/orch.ts watch` prints that nothing is deployed and exits 0; `orch chaos` without arguments exits 1 with usage.
- [ ] **Step 6: Commit** `feat(orchestrator): orch watch, chaos and rollback commands for the operations loop`
