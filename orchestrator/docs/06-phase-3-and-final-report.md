# Phase 3 and final report

## Phase 3 (publishing)

- `orchestrator/examples/agents/`: 18 generic prompts (≤7 lines), one per file the code
  loads (the brief said 8; the code references 18 names). `AGENTS_DIR=examples/agents`
  runs the project on its own.
- `scripts/check-secrets.sh`: keys/tokens and machine paths in the tree and the history;
  personal terms come from `PERSONAL_TERMS`, never from the public code. `LICENSE` MIT,
  `README.md` with the LangGraph diagram.
- Publishing: whole repo at `venturelli-91/venturelli-house` (public). Before that,
  `d:\...\skills` became `$SKILLS_DIR` across the whole history (`git filter-branch`).
  CI moved to `.github/workflows/ci.yml` (root), green.

## Live regression (default model, medium effort, all new nodes on the clear path)

| Node | Tokens | Turns | Time | US$ |
|---|---|---|---|---|
| triage | 15,994 | 4 | 8.9 s | 0.012 |
| dev | 40,583 | 5 | 11.0 s | 0.023 |
| reviewer | 11,513 | 3 | 8.7 s | 0.020 |
| qa | 11,824 | 4 | 11.0 s | 0.023 |
| devops | 5,332 | 2 | 6.7 s | 0.025 |
| **Total** | **85,246** | | **46.4 s** | **0.104** |

Task 3: 79,631 tokens / 36.0 s / US$ 0.063. The difference is `devops` (+5.3k tokens) and
the larger triage. The ambiguous route (planner) and the `github` publisher were not
exercised with a real model/remote at this point; Phase 4 did it
(`08-real-repo-validation.md`).

## What I reused

`orchestrator/agents/*.md` (since T3 the single prompt source, `.claude/agents` are stubs) and `CLAUDE.md` as the source of roles and rules (the guardrail
values mirror `CLAUDE.md`); the Claude Code login (no key); the LangGraph Mermaid;
`node:test` and Node 24 type stripping (no vitest/tsx); active-ticket state in git's own
worktrees (no database).

## What I deliberately left out

DeepSeek executor and direct LangChain executor (only the `registerExecutor` hook);
benchmark script; persistent checkpointer; watchdog command line; real deploy; knowledge
manager as a node.

## What did not need to be done

A database or ticket repository; executor abstraction beyond the registry; module mocks
(fake node through the executor); changing `.claude/agents`, `.claude/commands` or
`CLAUDE.md` for the graph to work.

## Known limits

The `Bash` allowlist is weak (the real barrier: a worktree without secrets and a minimal
env); `npm test` runs on the host; MemorySaver (approval only in the same process);
individual and local use, not a service for third parties.
