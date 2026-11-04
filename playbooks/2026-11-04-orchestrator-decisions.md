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

## Open
- The command deploy target and HTTP probe are not proven against a live service. First real staging run is the next validation.
