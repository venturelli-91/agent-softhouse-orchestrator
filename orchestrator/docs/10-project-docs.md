# 10. Project docs written by the graph

Spec: `docs/superpowers/specs/2026-11-06-graph-project-docs-design.md` (repo root).

## What it does

Every ticket updates the project spec under `<repo>/.claude/docs/`. It is the running record
(ideas, decisions, what worked, what failed) and the explanation to reuse the work or present it
to teammates, leaders and stakeholders. It is local to the machine and never committed.

## Moving parts

- `src/docs.ts`: the writer. Validates what the agent returns (relative `.md` paths inside a
  topic directory, at most 3 levels, at most 150 lines per file, at most 40 files and 200 KB per
  call, no symlinks), writes atomically under a lock, skips a file that changed on disk since the
  agent saw it, and generates `README.md` (index) and `.nao-se-aplica.json` itself.
- `agents/docs.md`: the read-only `docs` role (no `Write`/`Edit`). It returns file contents.
- Graph: `START -> docs_start -> triage` and `publish -> docs_end -> ceo_approval`. Both nodes
  catch every failure into `docs_warnings`; they never change the ticket status.
- `ensureLocalOnly`: adds `.claude/` to `.git/info/exclude` and checks `git check-ignore`; if
  git would still track it (a repo `.gitignore` un-ignores `.claude/`), nothing is written.
- `loadConventions`: `.claude/CLAUDE.md` on disk first, then the root `CLAUDE.md` at the base commit.

## Modes

`scan` (no docs yet, repo has code), `greenfield` (nothing but orchestrator files), `update`.
The code decides the mode; the agent does not.

## Limits

- Local only, no backup: losing the machine loses the docs.
- Up to 5 tickets share one docs tree; a concurrent write is skipped with a warning, not merged.
- "What worked / what failed" is only as good as the evidence the graph passes in (commit,
  tests, reviewer and QA verdicts, revisions).
- The graph never writes `CLAUDE.md`: it is the rules channel to the dev.
