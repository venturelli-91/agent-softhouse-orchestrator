# Task 1 — Executor (`run-agent.ts`) and per-node defenses (`guardrails.ts`, Section 2)

## What exists

- `orchestrator/src/guardrails.ts` — per-role permission table, minimal subprocess env,
  reading model/effort/turns from the environment.
- `orchestrator/src/run-agent.ts` — `Executor` interface, `claude-subscription`
  executor, `runAgent` (picks by `EXECUTOR`, default `claude-subscription`),
  `NodeFailure`.
- `orchestrator/tests/run-agent.test.ts` — 6 tests, no model and no credentials.
- `orchestrator/.env.example` — model, effort, turns, `AGENTS_DIR`, budget.

## Flow of a call

1. The **node** (task 2) builds `Req`: `role`, `files` (names in `AGENTS_DIR`, without
   `.md`), `context` (minimal text assembled by the code), `schema` (zod) and `cwd`
   (worktree).
2. `loadPrompt` reads the `.md` files, strips the frontmatter (the `tools:` line belongs
   to Claude Code, not to the executor) and concatenates them. No prompt is duplicated.
3. `claudeArgs` builds the `claude -p` arguments; the context goes through **stdin**.
4. The subprocess runs with `minimalEnv` and `AbortSignal.timeout(NODE_TIMEOUT_MS)`.
5. The `--output-format json` output is read; `structured_output` goes through zod.
6. Any error (exit ≠ 0, timeout, `is_error`, `error_max_turns`, JSON outside the schema)
   becomes `NodeFailure`. The graph treats it as a fail-closed failure and escalates to
   the CEO.

## Flags used (confirmed in `claude --help` 2.1.316 and the official CLI reference)

| Goal | Flag |
|---|---|
| Non-interactive | `-p` |
| Model / effort | `--model`, `--effort` (low, medium, high, xhigh, max) |
| Turn limit | `--max-turns N` (**documented, but absent from the local `--help`**) |
| Role prompt | `--system-prompt` (replaces the default prompt) |
| Output | `--output-format json`, `--json-schema` |
| Permissions | `--permission-mode dontAsk`, `--tools`, `--allowedTools`, `--disallowedTools` |
| Trim context | `--setting-sources ""`, `--strict-mcp-config`, `--disable-slash-commands` |
| No disk | `--no-session-persistence` |

Deliberately discarded:

- `--bare`: skips hooks and CLAUDE.md, but **only accepts `ANTHROPIC_API_KEY`** (never
  reads OAuth or the keychain), which defeats the goal of using the subscription.
- `--max-budget-usd`: a dollar budget; the project's budget is in tokens, measured by
  the code.

## Pitfalls found

- `z.toJSONSchema` emits a draft 2020-12 `$schema` and the CLI rejects it
  (`no schema with key or ref ...2020-12/schema`). The `$schema` is removed.
- `--json-schema` consumes 1 turn (the `StructuredOutput` tool). Hence
  `--max-turns = TURNS_<ROLE> + 1`.
- `ANTHROPIC_*` is not "removed": the subprocess env is a **whitelist** (`PATH`,
  `USERPROFILE`, `APPDATA`, ...), so nothing outside it reaches `claude`. The
  subscription login is still findable via `USERPROFILE`/`APPDATA`.

## Permission table

| Role | Tools | Note |
|---|---|---|
| triage, reviewer, qa | `Read, Grep, Glob` | read-only; reviewer/qa receive the diff in the context |
| dev | + `Write(./**)`, `Edit(./**)` and shell (`PowerShell` on Windows, `Bash` on POSIX; see `SHELL`) | shell only with `git add/commit/status/diff`, `npm test`, `npm run typecheck`; denies `git push/remote/config`, `rm -r`, `npm exec/npx/config/publish/pkg`, writes to `.git/**`, `.gitattributes`, `.gitmodules`; all roles deny reading `.env*`, `~/.ssh`, `~/.claude`, `~/.npmrc`, `~/.git-credentials`, `.git/config` |

**Known limit:** a `Bash` allowlist/denylist is a weak barrier (alternative commands
can bypass a pattern). The strong barriers are: a worktree without `.env` (ignored files
do not exist in the checkout), an env without credentials and `GIT_CONFIG_GLOBAL`/
`NOSYSTEM` neutralized (no credential helper, so `git push` does not authenticate). The
push and the PR are done by the graph's code (Phase 2), never by the agent.

**Hardening after the security review:** `GIT_CONFIG_COUNT` forces neutral
`core.hooksPath` and `core.fsmonitor` (config by env beats the repo's) and
`NPM_CONFIG_USERCONFIG` points to the null device.

The dev's `Write`/`Edit` are restricted to the worktree (`./**`); there is **no** deny
of `~/**` because the Windows temp worktree lives inside the home; `core.pager` and
`GIT_EXTERNAL_DIFF` are neutralized by env. Filters/textconv/`sshCommand` require a
definition in a config the agent cannot write (`.git/**` denied, null global config, no
`git config`/`git -c` in the allowlist).

**Residual risks (accepted and documented):** (1) `npm test`/`typecheck` run
`package.json` scripts, which the dev can edit; the mitigation is for the diff to reject
`package.json` scripts outside the scope (task 3) and, ideally, an OS/container
sandbox; (2) the real `HOME`/`USERPROFILE` remain in the env because the subscription
login lives there; the `~/...` denies are best-effort; (3) the exact semantics of the
deny patterns will be exercised in the tracer bullet with a dev that tries `git push`
and reading `.env`.

The subprocess's git gets the identity `agent-<role>`; this becomes the `author_id`
verifiable by code (task 3).

## Reference measurement (real smoke, `triage` role, trivial request)

| Metric | Value |
|---|---|
| Context created (`cache_create`) | 4,400 tokens |
| Output | 650 tokens |
| Turns | 2 |
| Time | 7.4 s |
| Equivalent cost | US$ 0.024 |

With Haiku and an empty prompt, the floor of a lean `claude -p` was ~1,900 tokens, so
the role prompt, the schema and the request make up the rest. This is the Phase 1
baseline.

## Environment variables

`EXECUTOR`, `AGENTS_DIR`, `MODEL_DEFAULT`, `EFFORT_DEFAULT`, `TURNS_DEFAULT`,
`TOKEN_BUDGET_TICKET`, and overrides `MODEL_<ROLE>`, `EFFORT_<ROLE>`, `TURNS_<ROLE>`.
Missing = error (fail closed). No model name in the code (a test guarantees this). The
real `.env` is ignored by git.

## How to run

```
cd orchestrator
cp .env.example .env
npm run typecheck && npm test
```
