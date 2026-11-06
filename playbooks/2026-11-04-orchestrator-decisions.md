# Orchestrator: decisions and recurring failures

Source: specs and plans in `docs/superpowers/`, review rounds in the git history.

## Decisions
- Deploy commands come only from `~/.orchestrator/config.json`, never from the repo: they run on the CEO's machine with the CEO's credentials. A `deploy` key in `.orchestrator.json` is an error.
- Deploy runs in a fresh detached checkout of the approved commit, never in the agent's worktree. `orch approve` shows the exact command, rollback, env names and health URL; the deploy refuses if the config changed since the ticket started.
- Nothing reaches or changes production without `orch approve` / `orch rollback`. A failed rollback stays proposed for retry.
- A hotfix counts toward the 5 active tickets; at the limit the incident waits.
- One outage keeps one incident and one hotfix even if the symptom changes.
- `orch chaos` works only on sandbox targets.

## Recurring failure class (found by review, fixed in code)
Every hardening round was the same pattern: a git or process feature let repo content run code on the host. Fixes so far: hooks off for host-side git, `.git/config` snapshot and recheck, no ext protocols, shadow-binary check (PATHEXT, cwd), deploy output kept local and masked, postmortem text neutralised (HTML and link definitions), symlinked `playbooks/` refused.
Rule: any new host-side command must run with hooks off, a minimal env and a pinned working directory, and its output must not reach `NOTIFY_URL`, PR text or ticket state.

## Validated (2026-11-05, Liftoff staging)
- First real run of the command target and HTTP probe: ticket L-7 deployed to a local staging service (`127.0.0.1:4600`) and `orch watch` probed `/api/health`. The rollback test opened one incident (`unreachable: ECONNREFUSED`), proposed the rollback, `orch rollback` ran it once, the incident closed.
- It exposed three gaps, fixed in PR #8: an infra-only outage (`unreachable`, `timeout`) spawned a P0 hotfix dev that burned tokens, so it now only proposes the rollback; there was no way to close an incident by hand (`orch resolve`); `orch clean` left the deploy record, so `watch` kept probing cleaned tickets.
- Limits of this validation: one local service, one cycle, no hosted environment, no real credentials or `env` names.

## Open
- Run against a hosted staging service with real `env` names before trusting the command target there.
