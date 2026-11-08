# Operations: deploy, watch, probe, chaos, webcheck

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

It is read only from this external file: a `deploy` key in the repo's `.orchestrator.json` is an error, because these
commands run on your machine with your credentials. A repo with a `deploy` block gets `deploy_target: command`; the
`deploy` node checks `.git/config` is unchanged, then runs the command in a fresh detached checkout of exactly the
commit you approved (never in the worktree the agent touched; it is removed afterwards), refusing a binary that exists
in that directory, with a hardened git/npm env and `ORCH_TICKET`, `ORCH_SHA` and `ORCH_PREVIOUS` set. `orch approve`
shows the environment and the exact `command`, `rollback`, `env` names and `health_url`, and the deploy refuses to run
if the external config no longer matches what the ticket started with. The command and any script it runs come from the
approved commit, so read the diff for deploy-related files before approving. `orch rollback` also checks `.git/config`
and runs from the main checkout; if you changed the config on purpose (a new remote, a fork), review it and run
`orch rollback <incident-id> --config-reviewed`. One outage keeps one incident and one hotfix even if the symptom
changes (the symptom is updated). A failing or timed-out command escalates and records no deploy (the masked output is
saved to `ORCH_HOME/deploy-logs/<id>.txt`, never sent to `NOTIFY_URL`); `orch rollback` runs the `rollback` command,
and a failed rollback stays proposed so you can retry.

## HTTP probe

For command deploys `orch watch` requests `health_url` and reports `http <status>` (redirects are not followed, so a
3xx is a symptom), `timeout after <n>ms`, `latency over <m>ms` or `unreachable: <code>`; the URL may not carry
credentials and never appears in a symptom; `orch chaos` still works only on the simulated target.

## Chaos (sandbox only)

`orch chaos <ticket-id> <scenario>` injects a failure that the simulated probe reports; `orch chaos <ticket-id> --clear`
removes it. It refuses any deploy whose target is not a sandbox and writes nothing. Scenarios: `broken-build`,
`missing-env`, `failed-migration`, `http-500`, `latency-spike`, `memory-growth`, `cert-expired`, `api-down`,
`api-timeout`, `rate-limit`, `db-down`, `regression`.

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
warning in the docs record. INP needs real interaction, so there is no INP budget. Ads, Analytics and GTM are checked
only through the browser: no account APIs or credentials.

## See also

- Project docs written by the `docs_*` nodes: [10-project-docs.md](10-project-docs.md).
- Defenses and limits: [09-hardening.md](09-hardening.md).
- Removing the orchestrator (back to the old flow): [README.md](../README.md).
