# Orchestrator

Flow control in code, not in prompts: a LangGraph.js graph orchestrates `claude -p` agents with code-verified guardrails.
Role prompts live in `agents/` (the single source; `.claude/agents` are pointer stubs to them).

## Quick start

```
npm ci --ignore-scripts && cp .env.example .env
npm run typecheck && npm run test:unit    # free; test:int adds the integration tests
npm run orch -- init                      # writes ../.orchestrator.json (commit it)
npm run orch -- run "request"             # then: orch status, orch approve <id>
```

Drop-in for another repo: `npm run orch -- setup <repo> [--team <name>] [--no-install] [--yes]` (copies this folder,
creates `.env`, installs, runs `init`). It uses the parent repo and keeps all state in `.state/` (gitignored).
Back to the old flow: delete `orchestrator/` and `.orchestrator.json`.

## Main commands and variables

| Item | Use |
|---|---|
| `orch run` / `status` / `continue` | Start a ticket, list tickets and incidents, resume a killed run |
| `orch approve` / `reject` | CEO decision; nothing is merged or deployed without it |
| `orch watch` / `rollback` / `chaos` | Operations: incidents, approved rollback, sandbox failures |
| `orch clean` | Remove finished tickets (worktree, branch, state) |
| `AGENTS_DIR` | Role prompts, default `agents`; pointing at the `.claude/agents` stubs fails loudly |
| `MODEL_*`, `EFFORT_*`, `TURNS_*` | Per-role model, effort and turn limits |
| `TOKEN_BUDGET_TICKET`, `TOKEN_CAP_DAILY` | Per-ticket budget, rolling 24h cap |
| `PUBLISHER`, `NOTIFY_URL`, `ORCH_HOME` | Draft PRs, alerts, state location |
| `.orchestrator.json` | Per-repo `test`, `merge`, `push_remote`, `base_repo`, `install` |

All commands, flags, variables and config keys: [docs/11-reference.md](docs/11-reference.md).

## Detail docs

- [docs/11-reference.md](docs/11-reference.md): commands, env vars, per-repo config, current graph
- [docs/12-operations.md](docs/12-operations.md): deploy, watch, webcheck, project docs, defenses, limits
- [docs/README.md](docs/README.md): index of the phase docs 01 to 10 (design, measurements, hardening)
