> Part of the [Agent Softhouse Orchestrator case study](README.md) — guardrails and security

## 7. Guardrails: what the model cannot do

| Rule | Enforced by |
|---|---|
| Max 3 revisions per ticket | Router sends to `ceo_approval` at `revisions >= 3` |
| Max 5 active tickets | `createWorktree` refuses the 6th (hotfixes count too) |
| Author ≠ reviewer ≠ QA | `selfApproval()` checked **before** spending tokens; `author_id` comes from the git commit author injected via env |
| Evidence verified by code | `verifyEvidence()` at dev, again at reviewer, at QA, and before honoring CEO approval |
| Forbidden paths | `.env*`, `.github/`, `orchestrator/`, `.orchestrator.json`, keys/credentials; `package.json`, `.npmrc`, lockfiles require CEO review because they execute code on the host |
| Merge/deploy only with the CEO | The deploy state is only reachable from `ceo_approval` after `interrupt()` |
| Escalation | Ambiguity, node failure, revision cap, budget and invalid evidence all become an `interrupt({type:"escalation"})` |
| Token budget | Summed from `history` before each node (`TOKEN_BUDGET_TICKET`); one extra budget is granted per code-verified atomic task, up to 7 |
| Daily cap | Rolling 24h token cap across every agent call |
| Large diffs | A diff over the review limit escalates instead of being silently truncated |
| Modularity | Touching a file above 300 lines or 160 columns blocks the ticket (`src/modularity.ts`) |
| No hard-coded model | A test scans `src/` for model names; model, effort and turns come only from the environment |

The approval flags (`touches_schema`, `touches_public_api`, `touches_permissions`, `touches_external_integration`, `touches_cost`) don't change the route (every merge/deploy already goes through the CEO), but they surface in the approval payload so the human decides with context.

---

## 8. Security model

An agent with a shell and a repository is a code-execution surface on the developer's own machine. The defense is layered because no single layer is strong enough:

1. **Isolation:** one git worktree per ticket, outside the repo (`ORCH_WORK`). Ignored files (including `.env`) don't exist in a fresh checkout.
2. **Minimal environment:** the subprocess env is a *whitelist*, with no `ANTHROPIC_*` and no credentials; `GIT_CONFIG_GLOBAL`/`NOSYSTEM` are neutralized so `git push` cannot authenticate.
3. **Per-role permissions:** read-only roles get `Read, Grep, Glob`. The dev additionally gets `Write(./**)`, `Edit(./**)` and a narrow shell allowlist, with explicit denies for `git push/remote/config`, `npx`, `npm publish`, writes to `.git/**`, and reads of `.env*`, `~/.ssh`, `~/.npmrc` and similar.
4. **Host-side git is hardened:** hooks off, `core.fsmonitor=false`, `core.pager=cat`, no external diff or textconv, no ext protocols, `.git/config` snapshotted per ticket and rechecked after tests.
5. **Push and PR are done by code,** never by the agent. The pushed ref is the verified SHA, not "whatever HEAD is now".
6. **Deploy commands live outside the repo** (`<ORCH_HOME>/config.json`). A `deploy` key inside `.orchestrator.json` is an error. The deploy runs in a **fresh detached checkout of the approved commit**, with a shadow-binary check (PATHEXT and cwd aware), masked output, and a check that the config hasn't changed since the ticket started.
7. **Outputs are sanitized:** failed deploy output stays local (never sent to `NOTIFY_URL`); postmortem text is neutralized (HTML comments, raw HTML, link definitions); a symlinked `playbooks/` directory is refused; the brief escapes markdown/HTML and flattens every line terminator.

### The recurring failure class

Every hardening round found the same pattern: a git or process feature that let *repository content run code on the host*. The standing rule that came out of it:

> Any new host-side command must run with hooks off, a minimal env and a pinned working directory, and its output must not reach `NOTIFY_URL`, PR text or ticket state.

### Residual risks (documented, not hidden)

A `Bash`/`PowerShell` allowlist is a weak barrier; `npm test` still runs the target's tests on the host (an OS/container sandbox is the full mitigation and is listed as future work).


