# Mandatory project documentation

Every project run by this software house keeps the documentation below **in the project's repository**, updated **in the same PR as the code** that makes it stale. It is not optional and it is not a final phase: a PR whose docs are stale is a blocking review comment.

## Required topics

Each topic is one or more Markdown files. Default paths; a project may rename them as long as `docs/README.md` maps them.

| Topic | Default path | Content | Audience |
|---|---|---|---|
| Docs map | `docs/README.md` | Every doc, its topic and audience; the rules below | everyone |
| Specs | `docs/specs/YYYY-MM-DD-<topic>-<kind>.md` | Intent, anti-goals, scope, requirement → ambiguity → decision → why, open questions | everyone |
| Architecture | `docs/architecture/` | Components, layers, flows (Mermaid), data model and invariants, runtime/deploy shape | engineering |
| Structural decisions | `docs/decisions/` | ADR log: context, decision, consequences; superseded entries marked, never deleted | engineering |
| Trade-offs | `docs/trade-offs.md` | Gained, gave up, when to revisit; rejected options | engineering, tech lead |
| Design | `docs/api-design.md` and/or `docs/design/` | API contract and error codes; UI design, heuristics and design system when the project has a UI | engineering, partners, design |
| Tests | `docs/testing.md` | Strategy, layers, requirement → test map, edge cases, what is not tested and why | engineering, QA |
| Code standards | `docs/code-standards.md` | Structure, language rules, comments, security/privacy, git and PR rules | engineering, AI agents |
| Checklists | `docs/checklist.md` | Definition of done per PR, domain/compliance checklist, delivery and release checklists | everyone who ships |
| Backlog | `docs/backlog.md` | Now / wishlist / later / out of scope, with status and dependencies | tech lead, product |
| Communication, non-technical | `docs/communication/non-technical.md` | Plain-language summary, what each group gets, decisions made on their behalf to confirm, what is not included | business stakeholders |
| Communication, technical | `docs/communication/technical.md` | Contract for integrators, maintenance guide, security posture and known gaps | engineering, partner IT, security |
| AI usage | `docs/ai/ai-usage.md` | Tools, models, skills, plugins, **external repositories in the workflow** (and which were deliberately not used), the flow, a dated session log, including AI work on the docs themselves | reviewers, auditors |
| AI errors | `docs/ai/ai-errors.md` | Every AI mistake caught (by review, QA, the CEO or self-audit): what it said or did, how it was caught, what changed, lesson | reviewers, auditors |
| STAR stories | `docs/star/` | Situation, Task, Action, Result for each relevant decision, incident or process change; results are facts, unfinished ones marked pending and filled by the PR that produces the evidence | interviews, walkthroughs, portfolio |
| Playbooks | `playbooks/` | Recurring failures and validated practices that outlive one project | the software house |

Topics that genuinely do not apply (for example UI design in a backend-only service) are listed in `docs/README.md` as "not applicable" with the reason, never silently skipped.

## Rules

1. **Same PR.** Behavior, decision, schema, API, test strategy or stakeholder impact changes → the matching docs change in the same PR.
2. **At most 150 lines per file.** When a topic grows, split it (`-1`, `-2`, or a subfolder) and update the map.
3. **Markdown only**; diagrams in Mermaid.
4. **No claim without evidence.** Numbers cite the command that produced them; plans are marked DRAFT until implemented.
5. **Decisions carry their why** and the context that produced them.
6. **Separate "given" from "decided".** What the requirements state and what the team added are labelled differently.
7. **AI mistakes are recorded, not hidden**, including mistakes in documentation and planning.
8. **Synthetic or anonymised data only** in examples.

## Who writes what, and when

| Flow step | Docs responsibility |
|---|---|
| Triage / Discovery | Open questions go to the spec's "open questions" |
| Demand Analyst, Product Manager | Spec: intent, anti-goals, scope, requirement → decision rows; non-technical communication draft |
| Tech Lead | Architecture, structural decisions, trade-offs, backlog, design (API/UI), technical communication |
| Dev (any) | Every doc the ticket makes stale, in the ticket's PR; tests doc when adding a test layer or rule |
| Code Reviewer | Blocks the PR if docs are stale or a file exceeds 150 lines; records caught AI errors |
| QA Automation | Verifies the checklist and the requirement → test map; records caught AI errors |
| Knowledge Manager | AI usage session log, STAR stories (new ones and pending results), playbooks, docs map consistency at the end of each delivery |
| CEO | Confirms decisions listed as "made on your behalf" |

## With the `orch` CLI

List every file of the docs map in `project_docs` of `.orchestrator.json`. The `docs_pre` node then updates them on the ticket's branch before review, from the evidence in the run. A new file (a split, a new topic) must be added to `project_docs` in the same PR, because `docs_pre` only edits files it is shown.
