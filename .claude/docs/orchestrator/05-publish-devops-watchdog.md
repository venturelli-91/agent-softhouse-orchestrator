# Phase 2 (remainder) — publish, devops and watchdog

## Flow

`qa -> publish -> ceo_approval -> (approved) devops -> END`. Rejection goes back to the
dev; `devops` is only reachable with `status=approved`, which only `ceo_approval`
produces after `interrupt()`.

## publish (code, no agent) — `src/publish.ts`

- Re-verifies the evidence (commit, clean worktree, allowed paths, `npm test`), runs
  `git push --set-upstream origin ticket/<id>` and opens a **draft** PR with
  `gh pr create --draft`; if the PR already exists (review cycle), it only updates the
  branch. Merging remains the CEO's.
- The URL goes into `evidence` (`pr:<url>`) and shows up in the approval payload.
- `PUBLISHER` (env): `github` | `none`. Missing or unknown = `NodeFailure` (escalates to
  the CEO, nothing is sent). `.env.example` ships `none`; switch to `github` only when
  using a real target repo with `origin` and an authenticated `gh`. Same hook as the
  executor (`registerPublisher`), used by the tests.
- The push runs on the host with the user's credentials (`safeGit`, hooks disabled,
  `--no-verify`) and sends exactly the verified SHA to `refs/heads/ticket/<id>`, never
  the current HEAD; the dev agent still has no `git push`.

## devops

`devops-sre.md`, read-only role. Simulation: the agent describes status, rollback and
observability; it does not run a deploy or a merge. A node failure ends in
`status=escalated` (no new pause).

## watchdog — `src/watchdog.ts`

`watchdog(tickets, cwd)`: outside the graph, per call. Receives one line per ticket (id,
priority, status, revisions, tokens, last node), read-only role, returns
`{alerts, summary}`. There is no script/CLI: the state lives in the in-memory
checkpointer; the command arrives when there is a persistent checkpointer.

## Tests (fake nodes and publisher)

push/PR before the CEO and devops only after; rejection does not trigger devops; a
missing `PUBLISHER` escalates without publishing; a failing publisher escalates; the
watchdog returns alerts. Total: 31 tests.

## Not validated

The real `github` publisher (push + `gh pr create`) was not exercised against a remote:
it depends on `origin` and `gh`.
