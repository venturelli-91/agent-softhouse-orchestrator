# AI Agent Software House — Framework

This repository is the software house's **reusable skeleton**: roles (`.claude/agents/`),
flows (`.claude/commands/`) and rules (this file). It has no product code.

**How to use it in a real project**: copy `.claude/` and this `CLAUDE.md` to the root of
the project's repository. The commands (`/demand`, `/ticket`, `/daily-brief`,
`/daily-report`, `/watchdog-scan`) then run against that actual code.

The CEO is the human user. They set vision, priorities, budget and critical approvals.
Each agent below organizes one part of the delivery, but no decision in the "Autonomy
matrix" (section below) may be taken without them.

## Principles

1. Do not start building without a goal, a user and acceptance criteria.
2. Break large demands into small, independent, verifiable tickets.
3. No agent reviews, tests or approves its own delivery.
4. Never deploy to production, perform a critical merge, make a destructive change,
   process payments, change permissions or expose data without explicit CEO approval.
5. Every delivery must have evidence: PR, tests, report, screenshot, video or logs.
6. If there is relevant ambiguity, stop and escalate the decision to the CEO.
7. Keep at most 5 tickets active at the same time.
8. Priorities:
   - **P0**: incident, security, revenue, blocked customer or critical deadline
   - **P1**: important this week
   - **P2**: improvement or exploration
   - **Bugs**: regressions and failures
9. The goal is validated value, not volume of code.
10. Always record decisions, recurring failures and improvements in the playbooks
    (`playbooks/`).

## Mandatory flow

```
CEO request → Triage
            → [clear]     → Specialized dev → Code Review → QA Automation
            → [ambiguous] → Demand Analyst → Product Manager → Tech Lead
                            → Evals Engineer
                            → Specialized dev → Code Review → QA Automation
        → Security / Performance / AI (when applicable)
        → CEO approval → DevOps / Deploy → Watchdog → Knowledge Manager
```

`/request` runs Triage first and decides on its own between the two routes. If you
already know the request is a clear ticket (e.g. "adjust the spacing of card X") or you
already know it needs scoping, you can call `/ticket` or `/demand` directly and skip
Triage.

**Do not force the whole chain when the request is already a clear ticket.** A
frontend-only ticket, for example, triggers only `dev-frontend` → `code-reviewer` →
`qa-automation`; `security`/`performance`/`ai-engineer` only come in if the ticket
really touches those areas. `demand-analyst`/`product-manager`/`tech-lead` only come in
when the goal/scope/acceptance criteria are missing — Triage (or you) decides that, it is
not a fixed rule of "always go through everyone". `code-reviewer` and `qa-automation` are
not optional even on small tickets (principle 3: nobody approves their own delivery) —
that is the only fixed cost, and it is low (2 agents, not all of them).

## Ticket routing

The full roster by tier, where each role runs in the orchestrator graph and how to reuse
the team in another project is in `TEAM.md`.

| Type of work | Agent |
|---|---|
| UI, screens, components, UX | `dev-frontend` |
| API, database, rules and permissions | `dev-backend` |
| Small end-to-end change | `dev-fullstack` |
| Mobile app | `dev-mobile` |
| External integration, webhook, OAuth | `dev-integrations` |
| LLM, agents, tool calling, memory | `ai-engineer` |
| RAG, embeddings, data and pipelines | `data-engineer` |
| Security and sensitive data | `security` |
| Latency, scale and cost | `performance` |
| Pipeline, deploy, logs and incident | `devops-sre` |
| Tests and final validation | `qa-automation` |
| Every PR | `code-reviewer` |
| Quality of prompts, agents and workflows | `evals-engineer` |
| Visual/UX review and Nielsen's heuristics | `dev-frontend` (build) + `qa-automation` (independent audit) |

## Skills and plugins

Each agent lists, in its own file (`.claude/agents/<role>.md`), the skills and plugins
specific to its work. Two sources are available to all:

- **Skills already registered in this Claude Code instance** (invocable with the `Skill`
  tool, by name) — e.g. `frontend-design`, `impeccable`, `security-review`,
  `code-review`, `simplify`, `claude-api`, `superpowers:writing-skills`.
- **Personal skill library in `$SKILLS_DIR`** — reference `SKILL.md` files that are NOT
  registered as skills in this session (the `Skill` tool does not invoke them by name).
  Each relevant agent points to the exact path to read with `Read` before doing the
  work. If that folder is moved, update the paths cited in the agents.

**Plugins/MCP used by the software house**:
- **Playwright MCP** (`mcp__plugin_playwright_playwright__*`) — open the locally running
  application and actually navigate/inspect it, used by `dev-frontend` and
  `qa-automation`.
- **Figma MCP** (`mcp__claude_ai_Figma__*`) — when the demand comes with a Figma link,
  used by `dev-frontend` (design-to-code) and `product-manager`/`tech-lead` (design
  system).
- **context7** — up-to-date library/framework documentation, used by `tech-lead` and any
  dev before using an API they do not know by heart.

## Autonomy matrix

**Can execute without approval**: research code/documentation, create a branch,
implement, run tests, open a PR, create documentation, generate reports, analyze
authorized logs.

**Must ask for approval first**: merge, deploy, schema change, new paid dependency,
public API change, permissions, external integration, sending external communication,
a change with a relevant cost impact.

**Never execute without explicit instruction**: direct production, data deletion,
payments, contracts, exposing or sharing sensitive data, credential rotation, legal,
tax or regulatory action.

## Ponytail audit (every PR)

`code-reviewer` runs `ponytail:ponytail-review` on every PR, no exception — it covers
both unnecessary complexity (speculative abstraction, superfluous dependency) and
**excessive defensiveness** (validation/try-catch for states that cannot occur, repeated
checking of the same invariant). The yardstick is the trust boundary: validating user
input, external APIs and network data remains mandatory — what gets flagged is
validating something the code's own type/flow already guarantees. For an audit of the
whole repository (not just a PR's diff), any agent with `Read`/`Grep`/`Glob` can run
`ponytail:ponytail-audit` on demand.

## CEO rituals

- `/daily-brief` — P0, active tickets, PRs awaiting review, CI/QA failures, alerts,
  abnormal costs, pending decisions, top 3 risks, next actions.
- `/daily-report` — delivered, in progress, blocked, new bugs, quality/tests, production
  changes, costs and AI usage, learnings.
- `/watchdog-scan` — ad-hoc sweep at any time of day.
- `/request` — single entry point: runs Triage and routes to `/ticket` or `/demand` on
  its own, when you do not want to decide that manually.
