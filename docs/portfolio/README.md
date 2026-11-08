# Agent Softhouse Orchestrator — An AI Software House Controlled by a LangGraph State Machine

> **Flow control in code, not in prompts.**
> A TypeScript orchestrator where a [LangGraph.js](https://langchain-ai.github.io/langgraphjs/) graph runs a team of AI agents (triage, planner, dev, reviewer, design, QA, webcheck, docs) with guardrails that the model cannot talk its way around.

**Repository:** Agent Softhouse Orchestrator (URL pending the repo rename)
**Role:** Solo author (design, implementation, security hardening, evaluation)
**Timeline:** Oct 31 – Nov 8, 2026 · 213 commits · 31 merged PRs (counts as of 2026-11-08, see [VERIFIED.md](VERIFIED.md))
**Stack:** TypeScript, Node 24, LangGraph.js, zod, Claude Code CLI (`claude -p`), GitHub CLI, GitHub Actions
**License:** MIT


## 1. TL;DR

The project started as a "framework" of 20 role prompts (`.claude/agents/`) and a rulebook (`CLAUDE.md`) for running an AI-powered software house with Claude Code. The rules lived in prose: *"no agent approves its own delivery"*, *"never deploy without CEO approval"*, *"at most 5 active tickets"*.

Prose is a weak enforcement layer. A model can forget, misread, or be persuaded to skip a rule.

So I built an **orchestrator** that turns those rules into a **graph**. Each role is a node, each rule is an edge or a code check, and the human (the "CEO") is a first-class `interrupt()` in the graph. The agents do the thinking; the code decides what is allowed to happen next.

Result: a CLI (`orch`) that takes a plain-English request, drives it through triage → (planning) → dev → review → QA → publish (draft PR) → CEO approval → merge/deploy, and then watches the deployed product, opening P0 hotfix tickets and rollback proposals when it fails.

*Counts in this table are as of 2026-11-08.*

| Metric | Value |
|---|---|
| Source (`orchestrator/src`) | ~2,400 lines of TypeScript in 38 files |
| Automated tests | 242 defined (81 unit, 161 integration; 2 integration tests skip where symlinks are unavailable; `node:test`, no network, no model, no credentials) |
| Runtime dependencies | 3 (`@langchain/langgraph`, `@langchain/core`, `zod`) |
| Graph nodes | 14 (triage, planner, dev, reviewer, design, qa, webcheck, publish, ceo_approval, merge_pr, deploy, docs_start, docs_mid, docs_end) |
| Agent prompts | 21 in `orchestrator/agents/` |
| Cost per ticket | to be measured (`orch clean` appends per-ticket numbers to `ORCH_HOME/metrics.jsonl`; none are recorded in this repo) |


## Documentation index

| # | File | Contents |
|---|---|---|
| 1 | [01-problem-and-thesis.md](01-problem-and-thesis.md) | The problem and the design thesis |
| 2 | [02-system-overview.md](02-system-overview.md) | Graph, components, how a ticket flows |
| 3 | [03-architecture.md](03-architecture.md) | Executor, state, persistence, per-repo config |
| 4 | [04-guardrails-and-security.md](04-guardrails-and-security.md) | Enforced rules and the security model |
| 5 | [05-operations-and-cost.md](05-operations-and-cost.md) | Post-production loop, chaos, cost controls |
| 6 | [06-evaluation-and-testing.md](06-evaluation-and-testing.md) | Model evals, tests, build timeline |
| 7 | [07-lessons-and-limits.md](07-lessons-and-limits.md) | Bugs, decisions, honest limitations |
| 8 | [08-demonstrates-and-running.md](08-demonstrates-and-running.md) | Skills shown and how to run it |

*Repository: Agent Softhouse Orchestrator (URL pending the repo rename)*
