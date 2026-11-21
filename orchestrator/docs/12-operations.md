# Operations: deploy, watch, probe, webcheck

Commands and variables are in [11-reference.md](11-reference.md).

## Two loops (pre and post production)

Delivery is the graph, ending in the `deploy` node, which calls a `DeployTarget`
(`{ sandbox, deploy({id, sha}), rollback({id, sha, previous}) }`, registered with `registerDeployTarget`; the built-in
`simulated` target is a sandbox) and records the deploy in `ORCH_HOME/deployed/<id>.json`. Operations is not a graph:
it is a few file-backed modules driven by `orch watch`. Nothing reaches or changes production without your
`orch approve` / `orch rollback`.

## Operations commands

`orch watch` makes one monitor pass: for each deployed ticket with a failing probe it opens one incident (deduplicated
by ticket and symptom), notifies you once, opens one P0 hotfix ticket that enters the delivery graph (it counts toward
the 5 active tickets; at the limit the incident stays `waiting` and a later `watch` creates the ticket) and proposes a
rollback; a healthy probe closes the incident. `orch rollback <incident-id>` is your approval of that proposal: the
target's `rollback` runs once and never before. `orch status` lists incidents after the tickets. The postmortem
(`writePostmortem`, text proposed by the `knowledge-manager` agent) lands uncommitted in `playbooks/<date>-<slug>.md`
for you to read.

## Real deploy (command target)

In `ORCH_HOME/config.json` (`.state/config.json` by default), under `repos["<abs path>"].deploy`:

| Key | Meaning |
|---|---|
| `command`, `rollback` | Plain commands, no shell operators, run without a shell. |
| `health_url` | http or https. |
| `environment` | `staging` (default) or `production`. |
| `env` | Names of host env vars the commands may read; values are never stored and are masked in the output. |
| `timeout_s` | Default 300, max 3600. |
| `max_latency_ms` | Default 2000. |
| `checks` | Optional, at most 10 `{method, path, expect_status, body?}`. `path` is relative to the origin of `health_url` (no query string). `expect_status` must match exactly (redirects are not followed). `body` is a JSON string. With `environment: "production"`, only GET/HEAD and no body. |
| `metrics_url` | Optional, http or https without credentials. It returns `{"requests": n, "errors_5xx": n}` (cumulative counters). |
| `max_error_rate` | Optional, 0 to 1, default 0.02. |
| `verify_minutes` | How long `verify_deploy` probes after the deploy, 0 to 60, default 5. |

Instead of these keys, `deploy` may hold `{ "staging": {...}, "production": {...} }`, each with the keys above except `environment` (set by the target; unknown keys are rejected). Staging is deployed and verified first; a healthy staging asks you to promote to production (below).

It is read only from this external file: a `deploy` key in the repo's `.orchestrator.json` is an error, because these
commands run on your machine with your credentials. A repo with a `deploy` block gets `deploy_target: command`; the
`deploy` node checks `.git/config` is unchanged, then runs the command in a fresh detached checkout of exactly the
commit you approved (never in the worktree the agent touched; it is removed afterwards), refusing a binary that exists
in that directory, with a hardened git/npm env and `ORCH_TICKET`, `ORCH_SHA` and `ORCH_PREVIOUS` set. `orch approve`
shows the environment and the exact `command`, `rollback`, `env` names and `health_url` (plus `checks`, `metrics_url` and `max_error_rate` when set), and the deploy refuses to run
if the external config no longer matches what the ticket started with. The command and any script it runs come from the
approved commit, so read the diff for deploy-related files before approving. `orch rollback` also checks `.git/config`
and runs from the main checkout; if you changed the config on purpose (a new remote, a fork), review it and run
`orch rollback <incident-id> --config-reviewed`. One outage keeps one incident and one hotfix even if the symptom
changes (the symptom is updated). A failing or timed-out command escalates and records no deploy (the masked output is
saved to `ORCH_HOME/deploy-logs/<id>.txt`, never sent to `NOTIFY_URL`); `orch rollback` runs the `rollback` command,
and a failed rollback stays proposed so you can retry.

After a deploy, the `verify_deploy` node probes the deployed service (same probe as `orch watch`) every 30 s for
`verify_minutes` minutes (default 5; `0` probes once). If it stays healthy the summary says so. On the first symptom it
opens the incident, proposes the rollback and notifies you, so you can run `orch rollback <incident-id>` right away; the
ticket stays `deployed`. Without a `health_url` the deploy is reported as not verified. This holds `orch approve` for that
long. If the open incident limit is reached, the ticket escalates with the symptom (status `escalated`; the deploy record stays, so `orch watch` keeps probing it). The hotfix still comes from `orch watch`.

With `deploy: { "staging": {...}, "production": {...} }` the ticket deploys staging, verifies it, and a healthy
staging pauses for you: `orch approve <id>` deploys to production, `orch reject <id>` stays on staging (status
`not_promoted`). A degraded staging ends with the staging rollback proposed and never reaches production. After a
promotion the deploy record for the ticket is the production one (staging's record and counters are gone), so
`orch watch` and `orch rollback` act on production only. A production deploy that fails can be retried with
`orch approve <id> retry`, which re-runs production, not staging; a config change between staging and the promotion
refuses the production deploy with "deploy settings changed".

## HTTP probe

For command deploys `orch watch` requests `health_url` and reports `http <status>` (redirects are not followed, so a
3xx is a symptom), `timeout after <n>ms`, `latency over <m>ms` or `unreachable: <code>`; the URL may not carry
credentials and never appears in a symptom. A command deploy without `health_url` has no health check and is not
monitored.

After health, each `checks` entry runs against the origin of `health_url` with the same timeout and latency limit. A
wrong status reads `http <status> on <METHOD> <path>`. Then `metrics_url` is read. The first probe after the deploy (normally verify_deploy's first poll) only records the
counters; later probes (the next polls and `orch watch`) compare against the last recorded counters (stored in `ORCH_HOME/deployed/metrics/<id>.json`), and
a 5xx share of the new requests above `max_error_rate` reads `error rate X% over Y%`. The error rate needs at least two polls (`verify_minutes: 0` never checks it during verification). A counter reset skips one run. No
new requests counts as healthy. An invalid payload reads `metrics: invalid payload`. The metrics endpoint can also read `http <status> on metrics`,
`unreachable: <code> on metrics` or `timeout after <n>ms on metrics`. The first failure is the symptom.
Unreachable/timeout symptoms (including on metrics) still propose only the rollback, like health, and the others also open the hotfix ticket.

## Design and webcheck nodes

UI tickets (`frontend`, `fullstack`) pass through `design` (read-only agent, reports only; the dev fixes in the
revision loop) after the reviewer, and through `webcheck` after QA. `webcheck` is code, not an agent: it starts the app
from the ticket worktree with the `serve` command, opens each path in Chromium (Playwright, a devDependency; run
`npx playwright install chromium` once) and checks, in the network log and `dataLayer`, that the expected GTM-/G-/AW-
ids load from Google hosts, plus LCP/CLS budgets. Config, external only like `deploy`, under
`repos["<abs path>"].webcheck`:

| Key | Meaning |
|---|---|
| `serve` | Plain command that starts the app. |
| `base_url` | localhost or 127.0.0.1 only. |
| `paths` | Default `["/"]`. |
| `gtm`, `ga4`, `ads` | Expected ids. |
| `lcp_ms`, `cls` | Budgets. |
| `timeout_s`, `env` | As in `deploy`. |

A failed check, or an app that does not start or load (serve exits, no answer, page timeout), goes back to the dev; a
port that already answers escalates to you; no `webcheck` configured, or Playwright or Chromium missing, skips with a
warning. INP needs real interaction, so there is no INP budget. Ads, Analytics and GTM are checked
only through the browser: no account APIs or credentials.

## Load and concurrency stage

Off by default. With `repos["<abs path>"].load` in the external config (never in `.orchestrator.json`), backend, fullstack,
integrations and data tickets pass through `load` after `webcheck`. It is code, not an agent: zero tokens. It starts
`serve` from the ticket worktree on the host, then runs three phases against `base_url`: a baseline of `fast_path`,
`concurrency` parallel writers for `duration_s`, and the same writers while a localhost proxy makes the dependency
`delay_ms` slower. The proxy address goes to the service in the env var named by `slow_dependency.env`; without
`target` it is an HTTP stub that answers 200 after the delay. A service that hardcodes its dependency address is reported
as "dependency not reached".

With `slow_dependency.outage: true` a fourth phase follows, `min(duration_s, 10)` seconds with the dependency down: the
proxy cuts its open connections and refuses new ones while the writers run and `fast_path` is probed. Any HTTP answer
(a 503 is fine) counts as controlled; a timeout (5s) or a reset counts as unanswered, apart from the main error rate.
Writes in flight when the phase ends are awaited, not cut. Then the dependency comes back and the first `writes` entry
must answer below 500 within `recover_s`. The `runner` mode does not run this phase.

| Key | Meaning |
|---|---|
| `serve`, `base_url`, `env`, `timeout_s` | As in `webcheck`; `timeout_s` (default 300, max 600) caps the whole stage. |
| `health_path`, `fast_path` | Default `/`; `fast_path` must not touch the dependency. |
| `writes` | 1 to 5 `{method, path, body?}`, body a static JSON string. |
| `slow_dependency` | `{env, target?, delay_ms, outage?}` or `null`; `target` is localhost:port; `outage` (default off) adds the dependency-down phase. |
| `concurrency`, `duration_s` | Defaults 20 and 20. |
| `thresholds` | `max_error_rate` 0.01, `max_fast_p95_ms` 500, `max_fast_p95_ratio` 5, `recover_s` 10. |
| `runner` | Optional plain command that replaces the built-in driver: gets `ORCH_LOAD_TARGET`, `ORCH_SLOW_DEP` (dependency slow for the whole run) and `ORCH_LOAD_DURATION`; exit 0 pass, 1 breach, other crash; last stdout line `{"requests":N,"errors":N,"p95_ms":N}`. |

A breach (error rate, fast path stalled while the dependency is slow or down, unanswered requests while it is down, no
recovery, service died) goes back to the dev as
`load: ...`; the whole run is re-run once before it counts. A pass puts one summary line in the PR body and in the
approval request, and the JSON report is saved as `ORCH_HOME/load-<id>.json`. A port that already answers or a runner
that crashes escalates to you; a runner or proxy that cannot start skips with a warning.

## Merge permission outside the orchestrator

With `merge: pr` the orchestrator publishes the PR and stops; the merge is yours. When the flow is driven from Claude Code, its permission classifier can deny `gh pr merge` ("Merge Without Review") until the user explicitly asks for that merge or adds a permission rule. `merge: auto` runs `gh` from the orchestrator process and is not affected. A ticket merged by hand stays unfinished in the state: answer its approval or `orch clean --force <id>`, and `orch clean --all` removes finished worktrees.

## See also

- Project docs (`project_docs`) updated by the `docs_pre` node: [10-project-docs.md](10-project-docs.md).
- Defenses and limits: [09-hardening.md](09-hardening.md).
- Removing the orchestrator (back to the old flow): [README.md](../README.md).
