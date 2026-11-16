# 10. Project docs updated by the graph

Spec: `docs/superpowers/specs/2026-11-06-graph-project-docs-design.md` (repo root).

## What it does

Before review, the `docs_pre` node updates the repo's own tracked docs (the `project_docs`
the config lists, e.g. `README.md`, `docs/CHANGELOG.md`) so they match the delivered work.
They are committed on the ticket branch (`docs: update ...`), so review, QA and the pinned
sha all cover them. The node is a no-op when the config lists no `project_docs`.

## Moving parts

- `src/project-docs.ts`: the node. It passes the listed files and the evidence to the `docs`
  agent and writes only exact listed paths (no symlink in the path, no secret or protected
  path, 200 kB cap), commits them, and resets the tree on any failure. A problem becomes a
  `pre:` docs warning, never a stop.
- `agents/docs.md`: the read-only `docs` role (no `Write`/`Edit`). It returns file contents.
- `DocsOutput` and `MAX_BYTES`: the output schema and size cap, defined in `project-docs.ts`.

## Behavior

- Triggers after the dev passed and before `reviewer`, only when `project_docs` is set.
- The agent returns only files the delivery made stale (finished items, test counts, changed
  facts), each with its full new content and its path exactly as listed, relative to the repo
  root. Anything not listed is rejected.
- `project_docs` is read from the base commit, so a ticket cannot widen its own list;
  `orchestrator/`, `.github/` and secret paths are always refused.
- Problems are warnings (`docs!` in `orch status`), never a stop; docs usage is outside the
  ticket budget. `MODEL_DOCS` and `TURNS_DOCS` tune it.

## Limits

- Only the exact listed paths are writable; a file not in `project_docs`, a symlink in the
  path, or a secret/protected path is refused.
- The docs commit must not push the diff over the review limit; if it would, the node resets
  the tree and reports a warning.
- "What changed" is only as good as the evidence the graph passes in (commit, tests, reviewer
  and QA verdicts, revisions).
