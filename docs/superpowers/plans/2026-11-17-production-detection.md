# Production Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `orch watch` detects real production degradation (failing synthetic checks, 5xx error rate over a limit), not only whether `health_url` answers. Each degradation opens an incident through the existing monitor flow.

**Architecture:** Three optional keys go on the external-only `deploy` block (`checks`, `metrics_url`, `max_error_rate`). They are snapshotted into `CommandSettings` at deploy and shown in the CEO approval. `defaultProbe` runs health, then checks, then metrics, and returns the first failure as the symptom. Cumulative counters are persisted per ticket under `ORCH_HOME/deployed/metrics/<id>.json`, so the error rate is computed across separate `orch watch` runs. `monitor.ts` does not change: the `unreachable:`/`timeout` prefixes still route to rollback only.

**Tech Stack:** TypeScript (node --experimental-strip-types), `node --test`, zod 4, global `fetch`, `node:http` fixture servers.

**Spec:** `docs/superpowers/specs/2026-11-15-orchestrator-lean-triage-production-design.md`, section "3.1 Real production detection" only, including its "Decisions after the builder check (2026-11-17 …)" block, which is binding.

## Global Constraints

- `checks`, `metrics_url`, `max_error_rate` are optional keys of the external-only `deploy` block. A `deploy` key in `.orchestrator.json` stays an error.
- Old deploy records and configs without the new keys keep working. A config without them must still parse to exactly what it parses to today (the existing `loadRepoConfig` defaults test stays unchanged), so in-flight tickets do not trip "deploy settings changed".
- Base URL for checks = `new URL(health_url).origin`. Each check `path` is relative to it. `health_url` stays required.
- Check shape: `{method, path, expect_status, body?}`. `expect_status` is required and must match exactly. Requests use `redirect: "manual"`, a 10s timeout and `max_latency_ms`, same as health.
- With `environment: "production"`, checks allow only GET/HEAD and no `body` (zod refine). Staging allows any method.
- Metrics payload: `{"requests": number, "errors_5xx": number}`, cumulative, zod-validated. An invalid payload is a symptom.
- `max_error_rate` defaults to `0.02` (2%). Symptom text: `error rate 5.0% over 2%`.
- First poll only records. A counter reset (current < previous) skips that poll. Zero new requests is healthy. A `ponytail:` comment marks the no-windowing ceiling.
- Probe order: health, then checks, then metrics. The first failure is the symptom. Unreachable/timeout symptoms keep their leading `unreachable:` / `timeout` prefix.
- No new dependency. No WHAT-comments. Commits use Portuguese Conventional Commits with a scope.

## Review Focus

- An error rate exactly at the limit is healthy (`>` not `>=`). Pinned in Task 2.
- A non-round limit prints cleanly: `max_error_rate: 0.07` gives `over 7%`, not `over 7.000000000000001%`. Pinned in Task 2.
- A metrics payload with negative or missing counters, or one that is not JSON, gives `metrics: invalid payload`. It must never produce a `NaN` rate or throw out of `watch`. Pinned in Task 2.
- `metrics_url` with credentials or a non-http scheme is rejected like `health_url`, and no metrics/check symptom ever carries a URL. Pinned in Tasks 1 and 2.
- `forgetDeploy` (used by `orch clean`) also removes the persisted counters, so a re-deployed id starts again with a first poll. Pinned in Task 2.

---

### Task 1: Deploy config keys, snapshot and approval display

**Files:**
- Modify: `orchestrator/src/repo-config.ts` (`DeployConfig`, `LoadConfig.writes[].body`)
- Modify: `orchestrator/src/deploy.ts` (`CommandSettings`)
- Modify: `orchestrator/src/ship-nodes.ts:55-63` (the `cmd` snapshot in `deployTicket`)
- Modify: `orchestrator/src/ceo-node.ts:45-49` (approval `deploy` block)
- Modify: `orchestrator/docs/12-operations.md` ("Real deploy (command target)" table)
- Test: `orchestrator/tests/repo-config.int.test.ts`, `orchestrator/tests/graph.part4.int.test.ts`

**Interfaces:**
- Produces (in `repo-config.ts`):
  - `export const DeployCheck = z.object({ method: z.enum(["GET","HEAD","POST","PUT","PATCH","DELETE"]), path: urlPath, expect_status: z.number().int().min(100).max(599), body: jsonBody.optional() })` and `export type DeployCheck = z.infer<typeof DeployCheck>`.
  - `DeployConfig` gains `checks: z.array(DeployCheck).min(1).max(10).optional()`, `metrics_url: httpUrl("metrics_url").optional()`, `max_error_rate: z.number().min(0).max(1).optional()`, plus a `.refine` with `path: ["checks"]` and the message `"production checks must be GET or HEAD without a body"`. No `.default` on the new keys (Global Constraints).
  - `httpUrl(name: string)`: the existing `health_url` refine moved into a helper so both URLs share it. The message stays `` `${name} must be an http or https URL without credentials` ``.
  - `jsonBody`: the JSON-string refine moved out of `LoadConfig.writes[].body` so both share it.
  - `urlPath` must be declared above `DeployConfig`. Move it, do not duplicate it.
- Produces (in `deploy.ts`): `CommandSettings` gains `checks?: DeployCheck[]; metrics_url?: string; max_error_rate?: number`. Import the type from `repo-config.ts`.

- [ ] **Step 1: Write the failing tests**

In `tests/repo-config.int.test.ts` (reuse `withDeploy`/`okDeploy`):

```ts
test("deploy checks, metrics_url and max_error_rate are optional and kept as given", () => {
  const extra = { checks: [{ method: "POST", path: "/items", expect_status: 201, body: '{"a":1}' }], metrics_url: "https://x.example/metrics", max_error_rate: 0.05 };
  const t = withDeploy({ ...okDeploy, ...extra });
  assert.deepEqual(loadRepoConfig(t.d, t.base, t.h).deploy, { ...okDeploy, ...extra, environment: "staging", env: [], timeout_s: 300, max_latency_ms: 2000 });
  t.done();
});

test("production checks accept only GET or HEAD without a body", () => {
  for (const check of [{ method: "POST", path: "/x", expect_status: 200 }, { method: "GET", path: "/x", expect_status: 200, body: "{}" }]) {
    const t = withDeploy({ ...okDeploy, environment: "production", checks: [check] });
    assert.throws(() => loadRepoConfig(t.d, t.base, t.h), /checks: production checks must be GET or HEAD without a body/);
    t.done();
  }
  const t = withDeploy({ ...okDeploy, environment: "production", checks: [{ method: "HEAD", path: "/", expect_status: 200 }] });
  assert.equal(loadRepoConfig(t.d, t.base, t.h).deploy?.checks?.length, 1);
  t.done();
});

test("bad checks and metrics_url are rejected", () => {
  for (const bad of [
    { checks: [{ method: "GET", path: "//evil.com", expect_status: 200 }] },
    { checks: [{ method: "GET", path: "/x" }] },
    { checks: [{ method: "GET", path: "/x", expect_status: 200, body: "not json" }] },
    { metrics_url: "https://u:p@x.example/metrics" },
    { metrics_url: "file:///etc/passwd" },
    { max_error_rate: 2 },
  ]) {
    const t = withDeploy({ ...okDeploy, ...bad });
    assert.throws(() => loadRepoConfig(t.d, t.base, t.h), undefined, JSON.stringify(bad));
    t.done();
  }
});
```

The existing test "a deploy block in the external config is loaded with defaults" stays unchanged. It proves the absent keys add nothing.

In `tests/graph.part4.int.test.ts`:
- Leave the existing record `deepEqual` in "a command deploy runs only after approval…" and the approval `deepEqual` in "the approval request shows the deploy environment" unchanged. They prove the absent keys add no fields (not even `undefined` ones).
- Add:

```ts
test("checks, metrics_url and max_error_rate are snapshotted into the record and shown in the approval", async () => {
  const extra = { checks: [{ method: "GET" as const, path: "/login", expect_status: 200 }], metrics_url: "http://127.0.0.1:1/metrics", max_error_rate: 0.05 };
  const g = await start("T-1", new MemorySaver(), { deploy_target: "command", deploy_cfg: { ...CMD_CFG, ...extra } });
  assert.deepEqual(paused(g.r)?.deploy, { target: "command", environment: "staging", command: "node --version", rollback: "node --version",
    env: [], health_url: CMD_CFG.health_url, ...extra });
  const end = await answer(g, "approve");
  assert.deepEqual(readDeploy(process.env.ORCH_HOME!, "T-1").cmd, { rollback: "node --version", health_url: CMD_CFG.health_url, env: [], timeout_s: 30,
    max_latency_ms: 2000, environment: "staging", git_config_hash: end.git_config_hash, ...extra });
});
```

`start` writes `extra.deploy_cfg` into the external config, so the extra keys reach both the ticket and the "settings changed" check without touching the harness.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd orchestrator && node --test tests/repo-config.int.test.ts tests/graph.part4.int.test.ts`
Expected: the new tests FAIL (unknown keys are stripped, so the deepEquals miss the new fields and the production refine does not exist). The existing tests PASS.

- [ ] **Step 3: Implement the schema, snapshot and display**

- `repo-config.ts`: the interfaces above.
- `ship-nodes.ts`: in the `cmd` object, spread each new key only when it is defined: `...(c.checks && { checks: c.checks })`, and the same for `metrics_url`, plus `max_error_rate` with `!== undefined`.
- `ceo-node.ts`: add the same three conditional spreads inside the existing `t.deploy_cfg ? {...}` branch.
- `docs/12-operations.md`: add three rows to the deploy table:
  - `checks`: optional, at most 10 `{method, path, expect_status, body?}`. `path` is relative to the origin of `health_url` (no query string). `expect_status` must match exactly (redirects are not followed). `body` is a JSON string. With `environment: "production"`, only GET/HEAD and no body.
  - `metrics_url`: optional, http or https without credentials. It returns `{"requests": n, "errors_5xx": n}` (cumulative counters).
  - `max_error_rate`: optional, 0 to 1, default 0.02.

  Also extend the `orch approve` sentence so it lists `checks`, `metrics_url` and `max_error_rate` when set.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd orchestrator && node --test tests/repo-config.int.test.ts tests/graph.part4.int.test.ts && npm run typecheck`
Expected: all PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add orchestrator/src/repo-config.ts orchestrator/src/deploy.ts orchestrator/src/ship-nodes.ts orchestrator/src/ceo-node.ts orchestrator/docs/12-operations.md orchestrator/tests/repo-config.int.test.ts orchestrator/tests/graph.part4.int.test.ts
git commit -m "feat(deploy): checks, metrics_url e max_error_rate opcionais no bloco deploy"
```

---

### Task 2: Probe runs checks and the error rate with persisted counters

**Files:**
- Modify: `orchestrator/src/probe.ts`
- Modify: `orchestrator/src/deploy.ts` (counter store, `forgetDeploy`)
- Modify: `orchestrator/docs/12-operations.md` ("HTTP probe" section)
- Test: `orchestrator/tests/probe.test.ts`

**Interfaces:**
- Consumes: `CommandSettings.checks?`, `.metrics_url?`, `.max_error_rate?` and `DeployCheck` from Task 1.
- Produces (in `deploy.ts`):
  - `export type Counters = { ts: string; requests: number; errors_5xx: number }`
  - `export function readCounters(home: string, id: string): Counters | null`: returns `null` when the file is missing.
  - `export function recordCounters(home: string, id: string, c: Counters): void`
  - File: `join(home, "deployed", "metrics", `${id}.json`)`. It is a subdirectory, so `deployedIds` (which lists only `*.json` files directly in `deployed/`) never mistakes it for a ticket. Use `checkId(id)` like `file()` does.
  - `forgetDeploy` also removes the counters file (`force: true`).
- Produces (in `probe.ts`):
  - `httpProbe(url: string, opts: { timeout_ms: number; max_latency_ms: number; method?: string; body?: string; expect_status?: number }): Promise<string | null>`. With no `expect_status`, keep today's `res.ok` rule. With it, require exact equality and report `http <status>` otherwise. A `body` is sent with `content-type: application/json`. The existing call sites and tests stay valid.
  - `export async function errorRate(home: string, id: string, url: string, max: number): Promise<string | null>`: fetch with a 10s timeout and no latency limit. A non-2xx answer or a fetch failure gives the `httpProbe` symptom with ` on metrics` appended. Then zod-parse `{ requests: z.number().nonnegative(), errors_5xx: z.number().nonnegative() }`. A JSON or schema failure gives `metrics: invalid payload`. Then apply the algorithm below.
  - `defaultProbe` becomes `async`. It returns `null` when there is no `health_url`. Otherwise it returns the health symptom, else the first check symptom, else the `errorRate(..., cmd.max_error_rate ?? 0.02)` symptom when `metrics_url` is set, else `null`.
  - Check symptom = the `httpProbe` symptom for `new URL(check.path, new URL(cmd.health_url).origin)` with `` ` on ${method} ${path}` `` appended. It is a suffix, so `unreachable:` / `timeout` stay leading and `INFRA_ONLY` in `monitor.ts` still matches.

The algorithm in `errorRate` after a valid payload (the spec pins it):

```ts
const prev = readCounters(home, id);
recordCounters(home, id, { ts: new Date().toISOString(), requests, errors_5xx });
// ponytail: rate over the gap between two watch runs, no windowing; keep a series of samples if the gap gets too coarse
if (!prev) return null;
const dr = requests - prev.requests, de = errors_5xx - prev.errors_5xx;
if (dr < 0 || de < 0 || dr === 0) return null;
const rate = de / dr;
return rate > max ? `error rate ${(rate * 100).toFixed(1)}% over ${+(max * 100).toFixed(2)}%` : null;
```

- [ ] **Step 1: Write the failing tests**

In `tests/probe.test.ts`, change the fixture to `handler: (res, req) => void` and `createServer((req, res) => handler(res, req))`, so the existing handlers stay valid. Add a helper that records a command deploy with extra settings:

```ts
const deployWith = (home: string, extra: object) => recordDeploy(home, { id: "T-1", repo: "/r", sha: "a", previous: "b", target: "command", sandbox: false,
  cmd: { rollback: "x", health_url: url, env: [], timeout_s: 30, max_latency_ms: 2000, environment: "staging", git_config_hash: "", ...extra } });
let counters: unknown = { requests: 0, errors_5xx: 0 };
const metricsHandler = (res, req) => req.url === "/metrics" ? res.end(JSON.stringify(counters)) : res.end("ok");
```

Each test makes its own `home` with `mkdtempSync` and removes it at the end, like the existing ones. Add these tests:

- `"a failing synthetic check is the symptom"`: checks `[{ method: "GET", path: "/login", expect_status: 200 }]`. The handler answers 500 on `/login` and `ok` elsewhere. `assert.equal(await defaultProbe(home, "T-1"), "http 500 on GET /login")`.
- `"a check matches its expected status exactly, with its method and body"`: check `{ method: "POST", path: "/items", expect_status: 201, body: '{"a":1}' }`. The handler answers 201 only when `req.method === "POST"` and the read body equals `'{"a":1}'`, else 200. Assert `null`. Then switch the handler to always 200 and assert `"http 200 on POST /items"`.
- `"a check may expect a redirect, which is not followed"`: `expect_status: 302`, and the handler answers 302 with `location: http://127.0.0.1:1/x`. Assert `null`.
- `"a dropped check connection keeps the unreachable prefix"`: the handler calls `req.socket.destroy()` on `/x`. `assert.match(symptom, /^unreachable: \S+ on GET \/x$/)`.
- `"a failing health url stops before the checks and the metrics"`: count requests to `/login` and `/metrics`. Health answers 500. Assert `"http 500"`, both counts `0`, and `readCounters(home, "T-1") === null`.
- `"an error rate over the limit is the symptom"`: `metrics_url: origin + "/metrics"` with the `metricsHandler`. With `{100,0}` assert `null` (first poll only records). With `{200,5}` assert `"error rate 5.0% over 2%"`.
- `"a healthy service with checks and metrics stays null across polls"`: one passing check plus metrics `{100,1}`, then `{200,2}` (1%). Assert `null` both times.
- `"an error rate exactly at the limit is healthy and a non-round limit prints cleanly"`: `max_error_rate: 0.07`. Polls `{100,0}` then `{200,7}` give `null`. A poll of `{300,17}` gives `"error rate 10.0% over 7%"`.
- `"a counter reset skips that poll and becomes the new baseline"`: polls `{200,5}`, `{10,9}` give `null` and `null`. Then `{110,10}` (1/100 = 1%) gives `null`, and `readCounters(home, "T-1")?.requests === 110`.
- `"zero new requests is healthy"`: polls `{100,3}` then `{100,3}` give `null`.
- `"an invalid metrics payload is a symptom"`: for each of `{ requests: "x", errors_5xx: 0 }`, `{ requests: -1, errors_5xx: 0 }`, `{ requests: 1 }` and the raw text `not json` (the handler writes the string as is), assert `"metrics: invalid payload"`.
- `"a failing metrics endpoint is a symptom without the url"`: metrics answers 503, so assert `"http 503 on metrics"`. Then point `metrics_url` at a closed port (`http://127.0.0.1:1/metrics`) and assert `/^unreachable: \S+ on metrics$/` with no `127.0.0.1` in the symptom.
- `"forgetDeploy removes the counters"`: one metrics poll. Then `forgetDeploy(home, "T-1")`, and `readCounters(home, "T-1") === null`.

The existing test "defaultProbe checks the health url of a command deploy" (a record without the new keys) stays as is. It proves old records still work.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd orchestrator && node --test tests/probe.test.ts`
Expected: the new tests FAIL (`readCounters` is not exported, checks are ignored, and `defaultProbe` returns `null`). The existing tests PASS.

- [ ] **Step 3: Implement the counter store, `httpProbe` options, `errorRate` and the `defaultProbe` order**

Follow the Interfaces block and the algorithm above. Do not change `monitor.ts`.

In `docs/12-operations.md` "HTTP probe", add the following after the health sentence:
- After health, each check runs against the origin of `health_url` with the same timeout and latency limit. A wrong status reads `http <status> on <METHOD> <path>`.
- Then `metrics_url` is read. The first `watch` only records the counters. Later runs compare against the last recorded counters (stored in `ORCH_HOME/deployed/metrics/<id>.json`), and a 5xx share of the new requests above `max_error_rate` reads `error rate X% over Y%`. A counter reset skips one run. No new requests counts as healthy. An invalid payload reads `metrics: invalid payload`.
- The first failure is the symptom. Unreachable/timeout symptoms still propose only the rollback, and the others also open the hotfix ticket.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd orchestrator && node --test tests/probe.test.ts tests/monitor.int.test.ts && npm run typecheck && npm test`
Expected: all PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add orchestrator/src/probe.ts orchestrator/src/deploy.ts orchestrator/docs/12-operations.md orchestrator/tests/probe.test.ts
git commit -m "feat(probe): checks sintéticos e taxa de erro 5xx entre execuções do watch"
```
