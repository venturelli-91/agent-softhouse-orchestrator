# Orchestrator (LangGraph.js) — overview

A thin orchestration layer over the software house. It lives in `orchestrator/` and
**does not change** `.claude/agents`, `.claude/commands` or `CLAUDE.md`: the graph only
reads those files. Deleting `orchestrator/` (and `.claude/docs/orchestrator/`) returns
the system to its previous state; `/request`, `/ticket` and `/demand` keep working.

Thesis: **flow control in code, not in prompts.** The agent prompt is the weakest layer;
the real barriers are code, CLI permissions, an isolated worktree and a minimal env.

## Index

| Doc | Contents |
|---|---|
| [01-executor.md](01-executor.md) | `run-agent.ts`, `guardrails.ts` (Section 2), real `claude -p` flags, measurements |
| [02-tracer-bullet-graph.md](02-tracer-bullet-graph.md) | `graph.ts`, state, nodes, edges, tracer with a real model, consumption baseline, bugs |
| [03-flow-guardrails.md](03-flow-guardrails.md) | `guardrails.ts` Section 1, escalation to the CEO, tests with fake nodes, CI, live regression |
| [04-planner.md](04-planner.md) | planner node, scope clarification with the CEO |
| [05-publish-devops-watchdog.md](05-publish-devops-watchdog.md) | push/PR by code, post-CEO devops, watchdog |
| [06-phase-3-and-final-report.md](06-phase-3-and-final-report.md) | publishing, live regression, final report |
| [07-metrics.md](07-metrics.md) | consolidated metrics for consumption, tests, code and process |

| [08-real-repo-validation.md](08-real-repo-validation.md) | runs on a real GitHub repo, ambiguous route, persistent approval, model-cost experiment |

## Decisions and findings (task 1)

- **Runtime dependencies:** `@langchain/langgraph` 1.6.0, `@langchain/core` 1.3.2
  (*required* peer of langgraph; not the `langchain` package) and `zod` 4. Dev:
  `typescript`, `@types/node`. No vitest/tsx: the tests use `node:test` and Node 24 runs
  `.ts`. LangGraph tree: `@langchain/langgraph-checkpoint`, `-sdk`, `protocol`,
  `standard-schema`.
- **Checkpointer:** `MemorySaver` in Phase 1 (CEO approval answered in the same
  process). Since Phase 4, `FileSaver` (`src/file-saver.ts`) persists it to a JSON file
  so approval can come from a later process; the official SQLite one pulls in
  `better-sqlite3` (a native module) and was not needed.
- **Ticket repository:** there is none (`playbooks/` only has `.gitkeep`, no GitHub
  issues configured here). The ticket state is the graph's own.
- **Git:** the folder was not a repo. `git init` was run, with `origin` pointing to
  GitHub (no push). The global `~/.config/git/ignore` excludes `.claude/`; the repo's
  `.gitignore` negates that (`!.claude/`) without touching the global config.
- **CEO** = the human user (see `CLAUDE.md`). The `ceo_approval` node is the pause where
  the graph waits for their decision.
- **Commits:** atomic, in English, no ticket prefix (there is no ticket), in the style
  `feat(orchestrator): ...`.
