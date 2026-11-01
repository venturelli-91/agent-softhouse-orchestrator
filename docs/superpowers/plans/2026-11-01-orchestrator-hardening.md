# Orchestrator Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `orch` safe with several tickets, cheap to resume, usable on repos the CEO does not own and on solo repos, and honest about being automated.

**Architecture:** Per-ticket state files plus a per-ticket lock replace the single `state.json`. Per-repo settings (in-repo file or `~/.orchestrator/config.json`) are resolved once at ticket creation and copied into the ticket, as `test` and `merge` already are. New behavior lives in small modules (`ticket-store`, `local-merge`, `git-remote`) wired into `graph.ts`, `publish.ts` and `scripts/orch.ts`.

**Tech Stack:** Node 24 (type stripping, `node --test`), TypeScript, LangGraph.js, zod, `git`, `gh`.

**Spec:** `docs/superpowers/specs/2026-11-01-orchestrator-hardening-design.md`

## Global Constraints

- Everything stays under `orchestrator/` (plus these docs); deleting `orchestrator/` must still restore the old flow.
- No new dependency, daemon or database. Files, `git` and `gh` only.
- No automatic approval: nothing merges or publishes without `orch approve`. No change to commit authorship (`agent-<role>`).
- Per-repo settings are read from the base commit (`.orchestrator.json`) or `~/.orchestrator/config.json`, never from the worktree; the in-repo file wins for keys it sets.
- Host-side git/`gh` calls go through `safeGit` / the `gh` helper in `publish.ts`.
- Existing tests keep passing; each new behavior gets a test with fake nodes (no model, no network).
- Commits: Conventional Commits in English with scope `orchestrator` (`feat(orchestrator): ...`), one per task, **no co-author or attribution lines**.
- Do not run anything against the real model or a real GitHub repo.
- Run tests with `cd orchestrator && npm test` and `npm run typecheck`.

## Review Focus

- Two commands on the same ticket at once: the second refuses with "already running", never corrupts state (Task 6).
- A lock left by a crashed process: replaced, not a permanent block (Task 6).
- A malformed `~/.orchestrator/config.json`: error naming that file, not a stack trace or a silent default (Task 1).
- `merge: local` with a dirty or moved main checkout: escalates, never overwrites work (Task 3).
- `retry` on a ticket with no `failed_node` (verification failure, revision cap): behaves as today (Task 4).
- Offline or no-upstream repo on `orch run`: freshness check never blocks the run (Task 7).

---

### Task 1: Settings resolution

**Files:**
- Modify: `orchestrator/src/repo-config.ts`, `orchestrator/src/graph.ts` (`Ticket`, `createWorktree`)
- Test: `orchestrator/tests/repo-config.test.ts`

**Interfaces:**
- Produces: `RepoConfig` gains `merge: "pr"|"auto"|"local"`, `publisher?: "github"|"none"`, `push_remote: string` (default `"origin"`, regex `^[\w.-]+$`), `base_repo: string` (default `""`, regex `^([\w.-]+/[\w.-]+)?$`), `disclosure: boolean` (default `true`).
- Produces: `loadRepoConfig(repo: string, ref: string, home = orchHome()): RepoConfig`. Precedence: defaults < `home/config.json` entry `repos[resolve(repo)]` < `.orchestrator.json` at `ref`. Any invalid source throws an error that names the file.
- Produces: `Ticket` gains `merge` (extended enum), `publisher: string` (default `""`), `push_remote`, `base_repo`, `disclosure`, `base_branch: string` (default `""`).
- Produces: `createWorktree(repo, id, dir, home?)` returns the previous fields plus `publisher`, `push_remote`, `base_repo`, `disclosure`, `base_branch` (output of `git rev-parse --abbrev-ref HEAD` in `repo`, taken before the worktree is added).
- Consumes: `orchHome` from `src/daily-cap.ts`.

- [ ] **Step 1: Write failing tests** in `tests/repo-config.test.ts`: `external config applies when the repo has no file`; `the in-repo file wins per key over the external one` (external sets `test` and `disclosure:false`, repo sets `test` only: result has repo's `test`, external's `disclosure`); `a malformed external config.json throws an error naming config.json`; `push_remote with a space is rejected`; `merge local is accepted`. Use a temp dir as `home`.
- [ ] **Step 2: Run** `node --test tests/repo-config.test.ts` and confirm the new tests fail.
- [ ] **Step 3: Extend `RepoConfig` and implement `loadRepoConfig` as specified.** Parse each source with `RepoConfig.partial()` first so errors name the source, then merge and parse with `RepoConfig`.
- [ ] **Step 4: Add the `Ticket` fields and extend `createWorktree`** (signature above). Existing callers keep working because `home` is optional.
- [ ] **Step 5: Run** `npm test` and `npm run typecheck`; expect all green.
- [ ] **Step 6: Commit** `feat(orchestrator): resolve per-repo settings from the repo file or ~/.orchestrator/config.json`

### Task 2: Per-ticket publisher, fork target and disclosure

**Files:**
- Modify: `orchestrator/src/publish.ts`, `orchestrator/src/graph.ts` (`publishNode`, `mergeNode`)
- Test: `orchestrator/tests/publish.test.ts` (create)

**Interfaces:**
- Produces: `Pub` gains `remote: string`, `baseRepo: string`, `disclosure: boolean`.
- Produces: `DISCLOSURE` (exported string: "Produced with an agent orchestrator and approved by a human before publishing."), `prBody(body: string, disclosure: boolean): string` (appends `\n\n---\n` + `DISCLOSURE` when true), `remoteOwner(url: string): string` (owner from an https or ssh GitHub remote URL), `ghPrCreateArgs(p: Pub, owner: string): string[]`.
- Produces: `publish(p: Pub, publisher?: string)` and `mergePr(m, publisher?: string)`: `publisher || process.env.PUBLISHER` picks the implementation; the missing-name failure is unchanged.
- Consumes: Ticket fields from Task 1.

- [ ] **Step 1: Write failing tests** in `tests/publish.test.ts`: `prBody appends the disclosure line only when enabled`; `remoteOwner parses https and ssh urls` (`https://github.com/me/x.git` and `git@github.com:me/x.git` → `me`); `ghPrCreateArgs without base_repo is the current draft command` (`--draft --head ticket/T-1`, no `--repo`); `with base_repo it targets it from the fork` (contains `--repo up/stream` and `--head me:ticket/T-1`); `a ticket publisher of none overrides PUBLISHER=github` (returns `pr:none`).
- [ ] **Step 2: Run** `node --test tests/publish.test.ts`; expect failures.
- [ ] **Step 3: Implement the functions above and use them in the `github` publisher:** push to `p.remote` (`<remote> <sha>:refs/heads/ticket/<id>`), look up the existing PR with `--repo p.baseRepo` when set, build the body with `prBody`, get `owner` from `remoteOwner(safeGit(cwd,"remote","get-url",p.remote))`. `mergeGithub` also passes `--repo` when the ticket has a `base_repo` (add `baseRepo` to its argument object).
- [ ] **Step 4: In `graph.ts`** pass the ticket's `push_remote`, `base_repo`, `disclosure` and `publisher` to `publish`/`mergePr`.
- [ ] **Step 5: Run** `npm test` and `npm run typecheck`; expect green.
- [ ] **Step 6: Commit** `feat(orchestrator): per-repo publisher, fork target and PR disclosure line`

### Task 3: Local merge for solo repos

**Files:**
- Create: `orchestrator/src/local-merge.ts`
- Modify: `orchestrator/src/guardrails.ts`, `orchestrator/src/graph.ts` (`mergeNode`)
- Test: `orchestrator/tests/local-merge.test.ts`

**Interfaces:**
- Produces: `repoOf(worktree: string): string` in `guardrails.ts` (main checkout: `dirname` of `resolve(worktree, git rev-parse --git-common-dir)`).
- Produces: `mergeLocal(repo: string, branch: string, sha: string): string` in `local-merge.ts`. Throws `Error` with the reason unless: `branch` is not `"HEAD"` and is the checked-out branch of `repo`; `git status --porcelain` is empty; HEAD is an ancestor of `sha`. Then `git merge --ff-only <sha>` with `core.hooksPath` set to `devNull`; returns `merged:local@<7-char sha>`.
- Consumes: `Ticket.base_branch`, `Ticket.merge === "local"` (Task 1); `safeGit`, `devNull`.

- [ ] **Step 1: Write failing tests** with `createFixture` and temp repos: `ff-merges main to the approved commit`; `refuses when main has uncommitted changes` (message matches `/uncommitted/`); `refuses when main moved past the base` (`/diverged/`); `refuses when another branch is checked out` (`/branch/`); `repoOf returns the main checkout from a worktree`. Add a graph test in `tests/graph.test.ts`: with `merge: "local"` passed through `start(..., extra)`, approving ends at `simulated_deploy` and the fixture's `main` contains the dev commit; with a dirty main it escalates and `main` is unchanged.
- [ ] **Step 2: Run** the new files; expect failures.
- [ ] **Step 3: Implement `repoOf` and `mergeLocal`.**
- [ ] **Step 4: In `mergeNode`,** treat `t.merge === "local"` like `auto` up to the `approved_sha` check, then call `mergeLocal(repoOf(t.worktree), t.base_branch, t.approved_sha)`, wrapping errors as `NodeFailure("merge: " + message)`; `pr` still skips, `auto` unchanged. Add `local` to the escalation retry path (the existing "retry" answer after a failed merge already re-runs `merge_pr`).
- [ ] **Step 5: Run** `npm test` and `npm run typecheck`; expect green.
- [ ] **Step 6: Commit** `feat(orchestrator): merge local for solo repos, fast-forward only after the CEO approves`

### Task 4: Retry the node that stopped

**Files:**
- Modify: `orchestrator/src/graph.ts` (`Ticket`, `escalate`, `ceoApproval`, `afterCeo`, `buildGraph` edge targets)
- Test: `orchestrator/tests/graph.test.ts`

**Interfaces:**
- Produces: `Ticket.failed_node: string` (default `""`); `escalate` sets it to the node name; new status `"retry"`.
- Rule: in `ceoApproval`, an answer of `retry` on a ticket with `status === "escalated"` and `failed_node` in `triage, planner, dev, reviewer, qa, publish, devops` returns status `retry`; `afterCeo` routes `retry` to `failed_node`. `merge_pr` keeps its existing retry path; every other answer is unchanged. Add those nodes to the `ceo_approval` conditional-edge target list.

- [ ] **Step 1: Write failing tests:** `retry after a reviewer failure re-runs the reviewer and not the dev` (override `reviewer` to throw `NodeFailure` once; after answering `retry`, `calls` has no second `dev` and ends at approval); `retry on a revision-cap escalation still instructs the dev` (existing behavior: `dev` runs again); `a non-retry answer after an escalation still goes to the dev`.
- [ ] **Step 2: Run** `node --test tests/graph.test.ts`; expect the first test to fail.
- [ ] **Step 3: Implement as specified.**
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`; expect green.
- [ ] **Step 5: Commit** `feat(orchestrator): retry re-runs the node that escalated instead of restarting the dev`

### Task 5: Reviewer receives the repo's CLAUDE.md

**Files:**
- Modify: `orchestrator/src/graph.ts`
- Test: `orchestrator/tests/graph.test.ts`

**Interfaces:**
- Produces: `rulesBlock(t: T): string[]` (empty array when `t.rules` is empty, otherwise the single "Target repo conventions" block now built inline for the dev); used by `dev` and by `reviewStep` only when `name === "reviewer"`.

- [ ] **Step 1: Write failing test** `the reviewer gets the repo conventions and QA does not`: pass `rules: "R-CANARY"` via `start(..., extra)`, capture `req.context` per role through `override`, assert reviewer and dev contexts include `R-CANARY` and qa does not.
- [ ] **Step 2: Run;** expect failure.
- [ ] **Step 3: Extract `rulesBlock`, use it in `dev`, and add it to the reviewer's context.**
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`; expect green.
- [ ] **Step 5: Commit** `feat(orchestrator): give the reviewer the target repo's conventions`

### Task 6: Per-ticket state and lock

**Files:**
- Create: `orchestrator/src/ticket-store.ts`
- Test: `orchestrator/tests/ticket-store.test.ts`

**Interfaces:**
- Produces: `ticketFile(home: string, id: string): string` → `home/tickets/<id>.json`; rejects ids not matching `^[\w.-]+$` or equal to `.`/`..` (throws).
- Produces: `ticketIds(home: string): string[]` (ids of existing ticket files, sorted).
- Produces: `lockTicket(home: string, id: string, pid = process.pid): () => void`: creates `tickets/<id>.lock` with `wx`; if it exists and its PID is alive (`process.kill(pid, 0)`), throws `Error("<id> is already running (pid N)")`; if the PID is dead, replaces it. The returned function removes the lock.

- [ ] **Step 1: Write failing tests:** `a second lock on the same id throws already running`; `releasing allows locking again`; `a lock whose pid is dead is replaced` (spawn a short child, wait for exit, write its pid into the lock file); `different ids do not block each other`; `ids with path separators or dots are rejected`; `ticketIds lists created files`.
- [ ] **Step 2: Run;** expect failures.
- [ ] **Step 3: Implement the three functions.**
- [ ] **Step 4: Run** `node --test tests/ticket-store.test.ts`, then `npm test`; expect green.
- [ ] **Step 5: Commit** `feat(orchestrator): per-ticket state files and a per-ticket lock`

### Task 7: Wire the CLI, clean --remote, freshness warning, docs

**Files:**
- Create: `orchestrator/src/git-remote.ts`
- Modify: `orchestrator/scripts/orch.ts`, `orchestrator/README.md`
- Test: `orchestrator/tests/git-remote.test.ts`

**Interfaces:**
- Produces: `behindBy(repo: string): number | null`: fetches the current branch's upstream and returns how many commits HEAD is behind; `null` when there is no upstream or the fetch fails (never throws).
- Produces: `deleteRemoteBranch(repo: string, remote: string, id: string): "deleted" | "absent"`: checks `ls-remote --heads <remote> ticket/<id>`, deletes with `git push <remote> --delete ticket/<id>` only if present.
- Consumes: `ticketFile`, `ticketIds`, `lockTicket` (Task 6); `repoOf` (Task 3); `Ticket.push_remote` (Task 1).

- [ ] **Step 1: Write failing tests** using a local bare repo as the remote: `behindBy is 0, then 2 after another clone pushes`; `behindBy is null with no upstream`; `deleteRemoteBranch deletes an existing branch and then reports absent`.
- [ ] **Step 2: Run;** expect failures.
- [ ] **Step 3: Implement `git-remote.ts`** with `safeGit`.
- [ ] **Step 4: Rewrite the state handling in `orch.ts`:** a helper builds `{ saver, graph }` for one id from `ticketFile(home, id)`; `status` iterates `ticketIds(home)`; `run`, `approve`, `reject` and `clean` take `lockTicket` for the ticket and release it in a `finally`; `run` passes `home` to `createWorktree` and prints a warning when `behindBy(repo)` is greater than 0; `clean --remote` calls `deleteRemoteBranch(repo, t.push_remote, id)` before removing the worktree and prints the result; `clean` deletes the ticket file instead of calling `deleteThread`.
- [ ] **Step 5: Update `README.md` and the usage comment in `orch.ts`:** the new settings keys, `~/.orchestrator/config.json` with an example for a repo that needs a fork (`gh repo fork --remote`, then `push_remote` and `base_repo`), `merge: local`, `disclosure`, `clean --remote`, per-ticket state.
- [ ] **Step 6: Verify** `npm test`, `npm run typecheck`, then a smoke with a throwaway home: `ORCH_HOME=<tmp> node scripts/orch.ts status` prints `no tickets` and `clean` without arguments exits 1 with usage.
- [ ] **Step 7: Commit** `feat(orchestrator): wire per-ticket state into orch, add clean --remote and a stale-base warning`
