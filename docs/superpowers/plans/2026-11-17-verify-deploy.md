# Verify Deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Right after `deploy`, a new graph node `verify_deploy` polls the 3.1 probe for a few minutes; a degradation opens an incident and proposes the rollback to the CEO at once, instead of waiting for the next `orch watch`.

**Architecture:** `verifyDeploy(home, id, deps)` lives in `src/monitor.ts` next to `watch` (it reuses the incident helpers and the `proposal` guard). It loops `deps.probe` every 30s until `minutes` have passed or a symptom appears. The graph node in `src/ship-nodes.ts` calls it with `defaultProbe` and `notify`, and only writes `summary` + `history`: the ticket status stays `deployed` / `simulated_deploy`, so every `DONE` list and `orch status` keep working unchanged.

**Tech Stack:** TypeScript (node strip-types), `node --test`, LangGraph `StateGraph`, `node:http` fixture servers, `node:timers/promises`.

**Spec:** `docs/superpowers/specs/2026-11-15-orchestrator-lean-triage-production-design.md`, section "3.2 Post-deploy verification tied to the deploy" only.

## Global Constraints

- No config schema change (CEO: ticket 4 does not change the schema). `verify_minutes` is the env var `VERIFY_MINUTES` (default 5, a non-negative number; anything else falls back to 5), following `MERGE_WAIT_MS` / `RETRY_DELAYS_MS`. Not a key of the `deploy` block.
- Poll interval: constant 30s. At least one poll always happens, even with `VERIFY_MINUTES=0`.
- Healthy for the whole window → END, summary `deploy verified: healthy for <minutes> min`.
- Degraded → `openIncident` (existing limit applies) + `rollback: "proposed"` + `notify("Incident <inc> on <id>: <symptom> -> orch rollback <inc>")`; summary `deploy degraded: <symptom>; incident <inc> opened, rollback proposed -> orch rollback <inc>`. No hotfix here: the next `orch watch` creates it through the existing flow (it skips INFRA_ONLY symptoms as today).
- Not configured (deploy record without `cmd.health_url`, e.g. `simulated`) → no probe, summary `deploy not verified: no health check configured`.
- Status after `verify_deploy` is unchanged. Escalated deploys still go straight to END.
- Incident limit reached → `NodeFailure("deploy degraded (<symptom>) but the open incident limit is reached")` (escalation via `guarded`).
- Commits: Conventional Commits in Portuguese with scope (repo convention, see `git log`), ending with the `Co-Authored-By` line.

## Review Focus

- Probe throws (bug or unexpected error) mid-window → must not crash the graph silently; `guarded` only catches `NodeFailure`, so `verifyDeploy` lets it propagate as today's `watch` does. Accepted, no test.
- An incident for the same ticket+symptom already open (re-run) → `openIncident` returns it with `created: false`; still set `rollback: "proposed"` only if `none` (the `proposal` guard) and do not notify twice. Test in Task 1.
- `VERIFY_MINUTES` garbage (`"abc"`, `"-1"`) → falls back to 5, never NaN loops. Test in Task 1 via the exported `verifyMinutes(env)`.
- Existing graph tests with `CMD_CFG` (health on `127.0.0.1:1`) now pass through `verify_deploy`: the harness sets `VERIFY_MINUTES=0` so they never wait 5 min. Task 2.
- A deploy that escalated must not be verified. Test in Task 2.

---

### Task 1: `verifyDeploy` in monitor.ts

**Files:**
- Modify: `orchestrator/src/monitor.ts`
- Test: `orchestrator/tests/monitor.int.test.ts`

**Interfaces:**
- Produces:
  - `export const verifyMinutes = (env: NodeJS.ProcessEnv = process.env): number`
  - `export type VerifyResult = { outcome: "healthy" | "skipped" } | { outcome: "degraded"; symptom: string; incident: string }`
  - `export async function verifyDeploy(home: string, id: string, deps: { probe: Probe; notify: (text: string) => Promise<void>; minutes: number; sleep?: (ms: number) => Promise<unknown> }): Promise<VerifyResult>` — `sleep` defaults to `setTimeout` from `node:timers/promises`; skipped when `readDeploy(home, id).cmd?.health_url` is unset (reuse that exact condition from `unmonitored` in probe.ts).

- [ ] **Step 1: Write the failing tests** (in `monitor.int.test.ts`, reusing its `home`/`notes`; for the configured cases record `T-2` with `cmd: { ...a CommandSettings with health_url "http://x/h" }`)

```ts
test("verifyDeploy without a health check is skipped and never probes", async () => {
  let probed = 0;
  const r = await verifyDeploy(home, "T-1", { probe: () => (probed++, null), notify: async () => {}, minutes: 5 });
  assert.deepEqual(r, { outcome: "skipped" });
  assert.equal(probed, 0);
});
test("a healthy service is polled every 30s for the window and stays without incidents", async () => {
  const waits: number[] = [];
  const r = await verifyDeploy(home, "T-2", { probe: () => null, notify: async () => {}, minutes: 2, sleep: async (ms) => void waits.push(ms) });
  assert.deepEqual(r, { outcome: "healthy" });
  assert.deepEqual(waits, [30_000, 30_000, 30_000, 30_000]); // 5 polls in 2 min
  assert.equal(listIncidents(home).length, 0);
});
test("minutes 0 still polls once", ...) // probe count 1, no sleep
test("a degradation opens one incident with the rollback proposed and notifies once", async () => {
  const seq = [null, "http 500"];
  const r = await verifyDeploy(home, "T-2", { probe: () => seq.shift() ?? null, notify: async (t) => void notes.push(t), minutes: 5, sleep: async () => {} });
  const [inc] = listIncidents(home);
  assert.deepEqual(r, { outcome: "degraded", symptom: "http 500", incident: inc.id });
  assert.equal(inc.rollback, "proposed");
  assert.deepEqual(notes, [`Incident ${inc.id} on T-2: http 500 -> orch rollback ${inc.id}`]);
  // second run with the same symptom: same incident, no second notification
});
test("verifyMinutes falls back to 5 for unset or invalid values", () => {
  assert.equal(verifyMinutes({}), 5);
  assert.equal(verifyMinutes({ VERIFY_MINUTES: "abc" }), 5);
  assert.equal(verifyMinutes({ VERIFY_MINUTES: "-1" }), 5);
  assert.equal(verifyMinutes({ VERIFY_MINUTES: "0" }), 0);
  assert.equal(verifyMinutes({ VERIFY_MINUTES: "0.5" }), 0.5);
});
test("a degradation at the open incident limit throws a limit error", ...) // pre-open MAX_OPEN_INCIDENTS incidents on other tickets; rejects /limit/
```

- [ ] **Step 2: Run** `cd orchestrator && node --test tests/monitor.int.test.ts` — Expected: FAIL (`verifyDeploy` not exported).

- [ ] **Step 3: Implement** `verifyMinutes` and `verifyDeploy` in `src/monitor.ts`. Loop: poll; on symptom → open/update incident and return degraded; stop when `elapsed polls * 30s >= minutes * 60s`, else sleep 30s. Count polls (`polls = floor(minutes*60/30) + 1`), not wall clock, so the test with a fake `sleep` is deterministic. Let `openIncident`'s limit error propagate (the node maps it).

- [ ] **Step 4: Run** `node --test tests/monitor.int.test.ts` and `npm run typecheck` — Expected: PASS.

- [ ] **Step 5: Commit** `feat(monitor): verificação pós-deploy com proposta de rollback imediata`

### Task 2: `verify_deploy` graph node

**Files:**
- Modify: `orchestrator/src/ship-nodes.ts` (new node), `orchestrator/src/graph.ts:59,75` (node + edges), `orchestrator/tests/helpers/graph-harness.ts` (`process.env.VERIFY_MINUTES = "0"` in `beforeEach`), `orchestrator/docs/12-operations.md` (one paragraph after "Real deploy")
- Test: `orchestrator/tests/graph.part4.int.test.ts`

**Interfaces:**
- Consumes: `verifyDeploy`, `verifyMinutes` from Task 1; `defaultProbe` (probe.ts); `notify` (notify.ts); `guarded`, `log` (graph-kit.ts); `orchHome()` (daily-cap.ts).
- Produces: `export const verifyDeployNode = guarded("verify_deploy", ...)` returning `{ summary, history: log(t, "verify_deploy", summary) }`. Wiring: `.addNode("verify_deploy", verifyDeployNode)`, `.addConditionalEdges("deploy", (t) => (["deployed", "simulated_deploy"].includes(t.status) ? "verify_deploy" : END), ["verify_deploy", END])`, `.addEdge("verify_deploy", END)`. A limit error from `verifyDeploy` becomes the `NodeFailure` text in Global Constraints.

- [ ] **Step 1: Write the failing graph tests** (part4, using `start`/`answer`/`CMD_CFG`; a healthy server via `createServer` on `127.0.0.1:0` answering 200, health_url `http://127.0.0.1:<port>/health`)

```ts
test("a simulated deploy is not verified and says so", async () => {
  const end = await answer(await start(), "approve");
  assert.equal(end.status, "simulated_deploy");
  assert.equal(end.summary, "deploy not verified: no health check configured");
  assert.equal(end.history.at(-1).node, "verify_deploy");
});
test("a healthy command deploy is verified and opens no incident", async () => {
  // deploy_cfg: { ...CMD_CFG, health_url: live server }; writeExternal so the settings match
  assert.equal(end.status, "deployed");
  assert.equal(end.summary, "deploy verified: healthy for 0 min");
  assert.deepEqual(listIncidents(process.env.ORCH_HOME!), []);
});
test("a degraded command deploy opens an incident with the rollback proposed", async () => {
  // CMD_CFG as is: health on 127.0.0.1:1 is unreachable
  const [inc] = listIncidents(process.env.ORCH_HOME!);
  assert.equal(end.status, "deployed");
  assert.equal(inc.rollback, "proposed");
  assert.match(end.summary, new RegExp(`^deploy degraded: unreachable: .*; incident ${inc.id} opened, rollback proposed -> orch rollback ${inc.id}$`));
});
// extend the existing "a failing deploy command escalates and writes no record" test:
assert.ok(!end.history.some((h) => h.node === "verify_deploy"));
```

Check how the existing CMD_CFG tests set up the external config (`writeExternal` / `commandTicket`) and do the same.

- [ ] **Step 2: Run** `cd orchestrator && node --test tests/graph.part4.int.test.ts` — Expected: new tests FAIL.

- [ ] **Step 3: Implement** the node and wiring (Interfaces block), harness env, and the docs paragraph in `12-operations.md`: what `verify_deploy` does, `VERIFY_MINUTES` (default 5, 30s polls), that it holds `orch run` for that long, and that the hotfix still comes from `orch watch`.

- [ ] **Step 4: Run** `npm run typecheck && npm test` — Expected: all PASS (also the other graph parts that reach `deploy`).

- [ ] **Step 5: Commit** `feat(graph): nó verify_deploy depois do deploy`
