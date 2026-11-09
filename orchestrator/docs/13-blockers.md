# Blockers observed running the orchestrator on a real repo

Consolidated 2026-11-09 from one session on a Next.js repo (Node 24, `EXECUTOR=claude-subscription`, `merge: pr`, `publisher: github`). Each blocker lists evidence, cause and what was done. Items marked "by design" are not bugs; they are listed because they cost time or tokens.

Runs used as evidence, each named by what it asked:

| Run | Request | Outcome |
|---|---|---|
| Review run | Verify and review an existing feature branch, fix issues, prepare it for approval | `dev_failed`, aborted. 692,277 tokens, US$0.85 |
| First feature run | Free choice of a small feature (became a read endpoint for one cohort) | PR merged. 265,517 tokens, US$0.74 |
| Second feature run | Free choice of a small feature (became duplicate-materials validation) | PR merged. 253,433 tokens, US$0.61 |

## Status

| # | Blocker | Kind | State |
|---|---|---|---|
| 1 | No backlog | Gap | Pending: not implemented |
| 2 | `orchestrator/` breaks the host repo's `verify` | Env | `orch setup` prints the exclusions |
| 3 | `PUBLISHER` ceiling | By design | Documented |
| 4 | Review-only requests cannot succeed | Guardrail | `no_change` outcome |
| 5 | `approve` on an escalation is not an approval | UX | CLI refuses a bare `approve` |
| 6 | Docs agent output rejected on every run | Bug | Prompt states the path rule; unwritable files hidden |
| 7 | Observability gaps | Gap | Escalation payload carries revisions, last node, explanation and brief |
| 8 | Resume produces a contradictory brief | Bug | Dev gets the commits and diff; brief covers the whole ticket |
| 9 | Build is sensitive to `NODE_ENV` | Env | `NODE_ENV` kept out of the agent env; dev told never to set it |
| 10 | `PUBLISHER` ceiling error is unclear | UX | Message says how to downgrade |
| 11 | A closed session kills the run silently | Gap | `orch status` flags a ticket with no live process |
| 12 | Merge step needs permission outside the orchestrator | Env | Documented in [12-operations.md](12-operations.md) |
| - | Briefs versus evidence | Gap | Pending: not implemented |

## 1. No backlog: nothing moves without a request

- `orch status` returned `no tickets`; `.state/` started empty.
- The orchestrator only advances on `orch run "request"`. There is no queue of next tickets.
- Effect: the orchestrator does not dictate project progress until a human writes each request.
- Not implemented. It is a new feature, not a fix: it needs a decision on where requests come from (a file in the repo, GitHub issues) and how a ticket is picked from it.

## 2. `orchestrator/` breaks the host repo's `npm run verify`

`orchestrator/` and `.vscode/` were untracked inside the host repo, and its Biome and `tsc` scanned them.

- `npx biome check .`: 159 errors, 77 warnings, 4 infos, all in `orchestrator/scripts/*` and `.vscode/settings.json`.
- `next build` failed at typecheck in `orchestrator/tests/run-agent.test.ts`: `Property 'NODE_ENV' is missing in type ... but required in type 'ProcessEnv'` (stricter `@types/node` than the host's). The agent env is now typed as a plain record, so this no longer fails.
- The host's own `src`, `tests` and `scripts` passed Biome, and its `npm test` passed.
- Fix applied in the host: `!orchestrator` and `!.vscode` in `biome.json`, `orchestrator` in the `tsconfig.json` `exclude`.
- Change here: `orch setup` prints those lines for the target repo's `biome.json` and `tsconfig.json`. It only suggests; it does not edit the files.

## 3. `PUBLISHER` ceiling (by design)

`src/publish.ts:effectivePublisher`: the env `PUBLISHER` is a ceiling the operator sets. The repo config may match it or downgrade to `none`, never escalate past it.

- Supported dry run: `PUBLISHER=github` in the env and `"publisher": "none"` in the repo config (or `ORCH_HOME/config.json`).
- A shell `PUBLISHER=none` with a repo config of `github` fails at `publish` with `publisher github not allowed by PUBLISHER=none`. This happened on the first feature run; recovery was `orch approve <id> retry` without the override, which pushed the branch and opened the PR.
- A shell `PUBLISHER=none` does override `.env`.

## 4. A review-only request cannot succeed

- Request on the review run: verify the branch, review the diff, fix issues, prepare for approval.
- `dev` ran 3 times (11, 12, 11 turns) and the run ended with `cap of 3 revisions reached: verification: no new commit in the worktree` (371,941 tokens, US$0.50, 166 s).
- Cause: `src/evidence.ts` requires at least one new commit (`rev-list --count base..HEAD`). A guardrail by design, but the graph had no route for "no change needed". Check, review and audit requests were structurally impossible.
- Change: the dev may set `no_change` (what it verified and why) and commit nothing. With no new commit and a clean worktree, the ticket goes to the CEO as a new pending type, `no_change`, with no revision spent. `orch approve <id>` closes the ticket (status `closed`); any other text is an instruction for the dev, as on an escalation (and aborts when the ticket has no criteria). With dirty files or commits present, `no_change` is ignored and the usual verification applies. Not available in multi-task tickets.

## 5. Escalation handling is unforgiving

From `src/ceo-node.ts`: on an escalation, the word `approve` is not an approval. Anything other than `abort`, `retry` (node errors on the same commit), a merge `retry` or an ambiguous-request clarification is passed to the dev as an instruction (`CEO instructed: <text>`) with revisions reset to 0.

- On the review run, `orch approve <id> approve` reran `dev` 3 more times with the instruction "approve": 371,941 to 692,277 tokens (US$0.50 to US$0.85) and the same escalation.
- If the ticket has no `criteria`, any non-abort answer aborts the ticket.
- Change: `orch approve` refuses a bare `approve` (also `ok`, `yes`, `lgtm`) on an escalation and says what to answer.

## 6. Docs agent output rejected on every run

- Every run printed `docs warning: ... must be inside a topic directory, at most 3 levels` for flat files such as `09-backlog.md` and `07-testing-and-quality.md`.
- The docs agent runs 2 to 3 times per ticket (about 25k to 34k tokens each, US$0.10 to US$0.16) and its files were rejected by the topic-directory rule: roughly US$0.25 to US$0.45 per ticket of docs spend with a failure surfaced only as `docs!` in `orch status`.
- Change: the docs prompt states the path rule, and files the agent cannot write are hidden from it.

## 7. Observability gaps

- Run output is only visible at the end when piped through `tail`; there was no live progress. Not changed.
- The escalation JSON on the review run had empty `explanation`, `brief` and `evidence`, so it did not say what the dev tried or why it made no commit.
- `orch status` shows one line with no revision count, tokens or last node.
- `history` is empty in `.state/tickets/*.json` (only `storage` and `writes`), so a ticket cannot be audited after the fact from that file. Not changed.
- Change: the pending payload now carries `revisions` and `last_node` (the last non-docs node and its result). When verification fails, the dev's `explanation` (its summary) and `brief` are kept instead of being blanked.

## 8. Resume produces a contradictory brief

- The first feature run was killed mid-run after `dev` had committed. `orch continue` reran `dev` over the committed work.
- The resumed dev brief said "nothing to add ... I made no edits" while the ticket diff added 2 files. The reviewer summary had to flag the mismatch itself.
- Cause: the second `dev` pass found the files already in place and had no way to know they were its own.
- Change: `dev` still runs on resume, because the brief only exists if it runs. It now receives the log and the diff (capped at 20,000 characters) of the commits already in the worktree, and is told the `brief` must describe the whole ticket and never claim "no edits". The same block reaches the dev on a review revision.

## 9. Build is sensitive to `NODE_ENV`

- The same brief said the Next build failed prerendering `/_global-error`. Reproduced only with a non-standard value: `NODE_ENV=development npm run build` fails with `Error occurred prerendering page "/_global-error"`. `npm run verify` and `npm run build` pass without it.
- Where the dev's `NODE_ENV` came from was not identified: the agent env does not whitelist it and the shell had none; likely the `claude` subprocess.
- Change: `NODE_ENV` is kept out of the agent env, and the dev rules say never to set it, since CI does not.

## 10. `PUBLISHER` error message

Follows from item 3. The error now reads: `publisher github not allowed by PUBLISHER=none: raise the env ceiling, or set "publisher": "none" in the repo config for a dry run`.

## 11. A closed session kills the run silently

- A background `orch run` is a child of the Claude session. Closing the session left the first feature run at `dev` with no process; `orch status` still listed it as `dev`.
- `orch continue <id>` recovers it, but nothing detected the dead run (the watchdog is a separate command).
- Change: `orch status` flags a ticket that is not finished, not waiting and has no live process: `no process running: orch continue <id>`.

## 12. Merge permission outside the orchestrator

- The first `gh pr merge` was denied by the Claude Code auto-mode permission classifier ("Merge Without Review"). It succeeded after the user explicitly asked for the merges.
- Effect: a flow driven from Claude Code still needs a human or a permission rule for the merge step, even with `merge: pr`. `merge: auto` runs `gh` from the orchestrator process and is not affected.
- A ticket merged by hand stays unfinished in the orchestrator state. `orch clean --all` removes finished worktrees.
- Documented in [12-operations.md](12-operations.md).

## Brief versus evidence

Across tickets, agent briefs state facts that were not checked against the code or the run:

| Run | Brief claim | Reality |
|---|---|---|
| First feature run | Next build failed on `/_global-error`; "I made no edits" | `verify` exit 0, 28/28 tests; diff adds 2 files (items 8, 9) |
| Second feature run | Duplicates return "the existing 400 error shape" | Invalid payloads return **422** (the host's `src/lib/trigger.ts` and its `CLAUDE.md`); the 400s are only invalid JSON and one other API |
| Second feature run | Reviewer: "I did not run the tests myself" | The review rests on the orchestrator's `verify ok` |

Only the `evidence` list (`commit:`, `tests:`, `pr:`) is produced by the orchestrator itself. Treat briefs as claims and evidence as facts.

Not implemented: have the reviewer run `test` itself, and flag a brief whose claims contradict `evidence`. It changes the reviewers, which is a separate piece of work.
