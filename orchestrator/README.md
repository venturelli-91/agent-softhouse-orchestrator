# Orchestrator

Flow control in code, not in prompts: a LangGraph.js graph runs `claude -p` agents with code-verified guardrails.
Role prompts live in `agents/` (the single source; `.claude/agents` are pointer stubs to them).

## Quick start

```
npm ci && cp .env.example .env
npm run typecheck && npm run test:unit    # free; test:int adds the integration tests
npm run orch -- init                      # writes ../.orchestrator.json (commit it)
npm run orch -- run "request"             # then: orch status, orch approve <id>
```

Drop-in for another repo: `npm run orch -- setup <repo> [--team <name>] [--no-install] [--yes]` (copies this folder,
creates `.env`, installs, runs `init`). It uses the parent repo and keeps all state in `.state/` (gitignored).
Back to the old flow: delete `orchestrator/` and `.orchestrator.json`.

## Top commands

Excerpt only; [docs/11-reference.md](docs/11-reference.md) is the single reference for every command, flag, variable and
config key.

| Item | Use |
|---|---|
| `orch run` / `status` / `approve` | Start a ticket, list tickets, give the CEO decision (needed to merge or deploy) |
| `orch setup <repo>` | Drop-in copy of this folder into another repo |
| `AGENTS_DIR`, `MODEL_*`, `TOKEN_BUDGET_TICKET` | Role prompts (default `agents`), per-role models, per-ticket budget |

## Detail docs

- [docs/11-reference.md](docs/11-reference.md): commands, env vars, per-repo config, current graph
- [docs/12-operations.md](docs/12-operations.md): deploy, watch, webcheck, project docs, defenses, limits
- [docs/README.md](docs/README.md): index of the phase docs 01 to 10 (design, measurements, hardening)
