# Orchestrator hardening: concurrency, resume, multi-repo, solo merge, disclosure

Status: draft for CEO approval. Scope: `orchestrator/` only.

## Intent

The `orch` CLI (see README) works for one ticket at a time in a repo the CEO owns. Before real use it must
(a) not lose state when several tickets or terminals are active, (b) not waste tokens when resuming,
(c) work on repos the CEO does not own, (d) work for a solo project with no PR, and (e) be honest about being
automated. Nothing here adds autonomy: the CEO still approves every ticket, and no agent touches `main`.

## Goals

1. Per-ticket state files; two tickets (or terminals) never overwrite each other. The same ticket cannot run twice at once.
2. After an escalation caused by the token cap, `retry` re-runs the node that stopped, not the dev.
3. The reviewer receives the target repo's `CLAUDE.md` (already given to the dev). QA does not.
4. `orch clean --remote` also deletes the remote `ticket/<id>` branch; without the flag nothing remote is touched.
5. Repos the CEO cannot push to: work through a fork.
6. Per-repo settings that live outside the target repo (`~/.orchestrator/config.json`), so a third-party repo needs no committed file.
7. `merge: local`: after the CEO approves, fast-forward the local `main` to the approved commit. No PR, no push.
8. Per-repo `publisher` instead of the global `PUBLISHER` only.
9. `disclosure` (default on): one line at the end of the PR body saying it was produced by an agent orchestrator and approved by the CEO.
10. `orch run` warns when the local base is behind its remote.

## Non-goals / anti-goals

- No automatic approval, ever. A change that lets a ticket merge or publish without `orch approve` is a failure even if it works.
- No change to who authors commits (stays `agent-<role>`); no author rewriting.
- No new daemon, database, or dependency. Files and `git`/`gh` only.
- Token-cap metric stays as is (the number is tuned by the CEO from `orch status`).
- Not a service for third parties; still individual and local.

## Constraints

- Everything stays under `orchestrator/`; deleting the folder must still restore the old flow.
- Per-repo settings are read from the base commit (`.orchestrator.json`) or from `~/.orchestrator/config.json`; never from the worktree, so a ticket cannot edit its own rules. When both exist, the file in the repo wins for keys it sets.
- Host-side git and `gh` calls keep going through `safeGit`/`gh` helpers with the minimal environment.
- Existing tests keep passing; each new behavior gets one test with fake nodes (no model, no network).

## Design

**State.** `ORCH_HOME/tickets/<id>.json` replaces the single `state.json`; `orch` builds one `FileSaver` per ticket id. A lock file `tickets/<id>.lock` (created exclusively, holds the PID) is taken by `run`, `approve`, `reject` and `clean` for that id; a stale lock whose PID is gone is replaced. `status` reads every ticket file without locking. The old `state.json`, if present, is not migrated (tickets from the previous version can be finished with the tracer or discarded).

**Retry after escalation.** `escalate` records the failing node in a new `Ticket.failed_node`. In `ceo_approval`, when the answer is `retry` and the ticket was escalated by a node (not a failed verification or the revision cap), status becomes `retry` and routing goes back to `failed_node`. Other answers keep today's behavior. The merge-retry path stays as is.

**Reviewer rules.** The reviewer context gets the same capped `CLAUDE.md` block as the dev.

**Clean.** `--remote` runs `git push origin --delete ticket/<id>` (via the configured push remote) for the ticket being cleaned; it is skipped, with a message, when the branch was already deleted by a merge.

**Settings.** `RepoConfig` gains `publisher` (`github|none`, falls back to env `PUBLISHER`), `merge` gains `local`, plus `push_remote` (default `origin`), `base_repo` (optional `owner/name` for the PR target), and `disclosure` (default `true`). A new loader merges `~/.orchestrator/config.json` (`{"repos": {"<absolute repo path>": {...}}}`) under the in-repo file. The resolved settings are copied into the ticket at creation, as `test` and `merge` are today.

**Fork.** With `push_remote` set to a fork remote (created by the CEO with `gh repo fork --remote`) and `base_repo` set, publish pushes the branch to `push_remote` and opens the draft PR against `base_repo` from `<fork-owner>:ticket/<id>`. The code does not create forks; the CEO does, once.

**Local merge.** A `merge_pr` branch for `merge: local`: verify evidence and `approved_sha` as in `auto`, then run `git merge --ff-only <approved_sha>` in the main checkout only if it is on the default branch, clean, and an ancestor of the approved commit. Any other state escalates with the reason. It never uses `--force` and never pushes.

**Disclosure.** `publish` appends one line to the PR body unless `disclosure` is `false`. Commit messages are untouched.

**Freshness.** `orch run` runs `git fetch` on the push remote's upstream of the current branch and prints a warning when HEAD is behind; it does not change the base.

## Left to the builder

Names of new fields and files beyond those above, error message wording, how the PID liveness check is done on Windows, test layout.

## Calls made by the author (not yet confirmed by the CEO)

- State split per ticket instead of a global lock.
- Config file keyed by absolute repo path, with the in-repo file winning.
- Fork support by remote name plus `base_repo`, with no automatic fork creation.
- Freshness is a warning, not a forced fetch-and-rebase of the base.
- The old `state.json` is not migrated.
- Author identity unchanged; only `disclosure` was approved by the CEO as an option.
