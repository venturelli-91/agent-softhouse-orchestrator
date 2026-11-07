# The team

One roster, two surfaces. Every role exists as:

- **Subagent** (`.claude/agents/<role>.md`): full instructions and tools, used by the interactive flow (`/request`, `/ticket`, `/demand`).
- **Orchestrator prompt** (`orchestrator/agents/<role>.md`): short prompt that `orch` feeds to `claude -p`, one node of the graph per role.

The two are different on purpose (interactive vs headless), not copies that drifted. `orchestrator/tests/team.test.ts` fails if the graph asks for a role whose prompt is missing.

## Roster

| Tier | Role | When it runs in the graph |
|---|---|---|
| Intake | `triage` | every request: area, priority, flags, clear or ambiguous |
| Intake | `demand-analyst`, `product-manager`, `tech-lead` | only when triage says the request is ambiguous (planner node) |
| Intake | `prompt-engineer` | interactive flow only: turns tickets into prompts and playbooks |
| Build | `dev-frontend`, `dev-backend`, `dev-fullstack`, `dev-mobile`, `dev-integrations`, `ai-engineer`, `data-engineer` | one per ticket, chosen by triage `specialty` |
| Quality | `code-reviewer` | every ticket |
| Quality | `qa-automation` | every ticket, after the reviewer |
| Quality | `security`, `performance`, `evals-engineer` | added to the review when the ticket flags `touches_security`, `touches_performance`, `touches_ai` |
| Operate | `docs` | after QA, writes the project docs |
| Operate | `knowledge-manager` | postmortem of an incident |
| Operate | `watchdog` | `orch` watchdog pass over tickets |
| Operate | `devops-sre` | interactive flow only: deploy in the graph is done by code, after the CEO |

Nobody approves their own delivery: the reviewer and QA cannot be the commit author (checked in code).

## Using the team in another project

- **Interactive flow:** copy `.claude/` and `CLAUDE.md` to the project root.
- **Orchestrator:** copy `orchestrator/` to the project root, then `cd orchestrator && npm ci && cp .env.example .env`. The graph uses `orchestrator/agents/` by default; point `AGENTS_DIR` elsewhere to use your own prompts.
- **Per project:** the project's own `CLAUDE.md` (conventions) and `.orchestrator.json` (test command, merge mode, deploy) shape the team's behavior without editing any prompt.
- **Which devs a project has:** `specialties` in `.orchestrator.json` limits what triage may route to (default: all seven). `orch init --team <all|web|api|mobile|ai>` writes a ready-made list; edit it by hand for anything else. Triage is told the list and an answer outside it escalates to the CEO. The review gates (`security`, `performance`, `evals-engineer`) stay driven by the ticket's flags, so they need no per-project setting.
