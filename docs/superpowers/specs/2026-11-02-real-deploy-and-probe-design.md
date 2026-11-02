# Real deploy target and HTTP probe — design

## Intent

`orch` already ends in a simulated deploy and watches a simulated failure. The CEO wants the foundations to deploy to a real place and detect a real failure, without choosing a platform yet. So the pieces must be platform-agnostic: a deploy target that runs commands the CEO configures, and a probe that checks a URL.

## Goals

- A `command` deploy target: runs a configured deploy command for the approved commit, and a configured rollback command when the CEO runs `orch rollback`.
- An HTTP probe for `orch watch`: reports a symptom when a health URL errors, times out or is slower than a limit.
- Works for Vercel, Fly, a script or `rsync` by changing only the configured commands.
- Every existing guarantee holds: nothing runs before `orch approve` / `orch rollback`, no automatic rollback, at most 5 active tickets, state per ticket.

## Non-goals

- No account, domain, secret or infrastructure provisioning on any platform.
- No built-in Vercel/Fly/other adapters, no log-based probe, no metrics.
- No change to `simulated` and `chaos`: they stay the only sandbox path.

## Anti-goals

- A ticket (the agent) must never be able to choose or alter what the deploy command is, or what it can read.
- A deploy that "succeeds" without the approved commit being what ran.
- Secrets copied into ticket state, evidence, PR text or logs.

## Decisions (CEO)

- Platform-agnostic, command-based deploy and an HTTP health probe (approved in chat).

## Calls made by the assistant (check these)

1. **Config lives outside the repo.** The `deploy` block is read only from `ORCH_HOME/config.json` under `repos[<abs path>]`, never from the repo's `.orchestrator.json`. The chat playback said `.orchestrator.json`; this is safer, because these commands run on the host with credentials and a repo file is something a ticket's code can influence over time.
2. **Staging by default.** `deploy.environment` is `"staging"` (default) or `"production"`. The CEO approval payload shows the environment; `production` must be written explicitly. The CEO did not answer the staging question; this is the conservative default.
3. **Chaos stays simulated-only.** A `command` target records `sandbox: false`, so `orch chaos` refuses it. Real failures come from the real probe.
4. **Credentials by name.** `deploy.env` is a list of host environment variable names passed to the commands; nothing else from the host env is passed. Values are never stored.
5. **Commands are plain argv, no shell.** Same style as `test`: `^[\w ./:=@-]+$`, split on spaces, run with `execFileSync`, never through a shell, with a timeout.

## Behavior

### Config (`ORCH_HOME/config.json`, per repo)

```json
{ "repos": { "/abs/path": { "deploy": {
  "command": "vercel deploy --prebuilt",
  "rollback": "vercel rollback",
  "health_url": "https://staging.example.com/health",
  "environment": "staging",
  "env": ["VERCEL_TOKEN"],
  "timeout_s": 300,
  "max_latency_ms": 2000
} } } }
```

`command` and `rollback` required together with `health_url` (`http`/`https` only). Ticket field `deploy_target` becomes `"command"` when the repo has a `deploy` block, else stays `"simulated"`.

### Deploy

The `deploy` node, for target `command`: refuses unless the ticket worktree `HEAD` equals `approved_sha`; runs `command` with cwd = the worktree, env = minimal env + names in `deploy.env` + `ORCH_TICKET`, `ORCH_SHA`, `ORCH_PREVIOUS`. A non-zero exit or timeout fails the node (escalates to the CEO) and writes no deploy record. On success it records the deploy with the command settings it needs later (`rollback`, `health_url`, `env`, `timeout_s`, `max_latency_ms`, `environment`, worktree path) and the last 300 characters of output as evidence. Final status is `deployed`.

### Rollback

`approveRollback` for a `command` record runs `rollback` the same way with `ORCH_SHA` = deployed sha and `ORCH_PREVIOUS`. If it fails, the error surfaces and the incident stays `proposed` so the CEO can retry; it is marked `done` only on success.

### Probe

`httpProbe`: GET `health_url` with a timeout; returns `null` when status is 2xx and latency ≤ `max_latency_ms`, else a symptom string (`http 503`, `timeout after Nms`, `latency Nms > Mms`, `unreachable: <code>`). `Probe` becomes allowed to return a Promise; `watch` awaits it. `orch watch` uses `httpProbe` for records that have a `health_url`, `simulatedProbe` otherwise.

### Approval payload

The CEO approval request includes `deploy: { target, environment }` so `orch approve` shows whether it is staging or production.

## Constraints

- Everything stays under `orchestrator/`; deleting it restores the old flow.
- No new dependency: `node:child_process`, global `fetch`.
- Tests use a recording fake command runner and a local `node:http` server; no real deploy, no external network.
- Existing tests keep passing.

## Left to the builder

Names of internal helpers, how the command runner is injected for tests, exact symptom wording, README wording.

## Known limits

- Output of a failing deploy command is truncated and may still contain sensitive text; the CEO should keep tokens out of command output.
- A single health URL per repo; no multi-environment promotion yet.
