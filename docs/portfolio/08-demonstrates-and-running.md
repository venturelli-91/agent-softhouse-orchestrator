> Part of the [Agent Softhouse Orchestrator case study](README.md) — what it demonstrates and how to run

## 17. What this demonstrates

- **Agent orchestration and graph engineering:** conditional routing, loops with caps, human-in-the-loop interrupts, checkpoint/resume, fail-closed error handling.
- **Defensive engineering around LLMs:** treating model output and agent-touched files as untrusted; layered isolation; least-privilege tool sets.
- **Evaluation discipline:** scoring models against known answers and hidden tests, reporting where the eval is weak, and making model choice data-driven.
- **Cost awareness:** measuring where tokens go and acting on it (per-stage models, budgets, caps).
- **Production thinking:** pre- and post-production loops, staging→production promotion, incident dedupe, rollback proposals, postmortems.
- **Engineering process:** written designs and plans before code, atomic commits, CI, security review rounds with regression tests, honest documentation of limits.

---

## 18. Running it

```bash
# Once
cd orchestrator
cp .env.example .env
npm ci
npm test
npm link            # exposes the `orch` command

# In any target repo
orch init           # writes .orchestrator.json (commit it)
orch run "Add an isEmpty helper with tests"
orch status
orch approve <id>   # or: orch reject <id> "reason"
orch continue <id>  # resume a run killed mid-graph
orch clean <id>     # remove worktree, branch and state

# Operations
orch watch                       # one monitor pass
orch rollback <incident-id>      # your approval of the proposed rollback
orch resolve <incident-id>       # close an incident by hand
```

Requirements: Node 24, the Claude Code CLI (logged in), and an authenticated `gh` if you want draft PRs. `AGENTS_DIR` is `agents` in `.env.example` (resolved against `orchestrator/`, so `orchestrator/agents/`, the single prompt source; see §4). `npm test` runs `test:unit` and `test:int`; each can be run on its own. Other commands: `orch setup <repo>` (drop-in copy), `orch team "<need>"`, `orch demand` (multi-ticket demands with a closing checklist), `orch manual` / `orch evidence` (human-run tickets no agent may see), `orch backlog` (reviewers' caveats), `orch request-changes <id>`.

---

