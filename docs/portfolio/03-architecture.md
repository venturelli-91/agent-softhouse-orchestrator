> Part of the [Agent Softhouse Orchestrator case study](README.md) — architecture deep dive

## 6. Architecture deep dive

### 6.1 The executor: one agent = one subprocess

Each node builds a request (`role`, prompt files, minimal context assembled by code, a zod schema, a working directory) and `run-agent.ts`:

1. Loads role prompts from `AGENTS_DIR` (`orchestrator/agents/`, see §4), stripping frontmatter.
2. Builds `claude -p` arguments: `--system-prompt`, `--output-format json`, `--json-schema`, `--permission-mode dontAsk`, an explicit `--tools` / `--allowedTools` / `--disallowedTools` set, `--setting-sources ""`, `--strict-mcp-config`, `--disable-slash-commands`, `--no-session-persistence`.
3. Passes context via **stdin** and runs with a **whitelisted environment** and an `AbortSignal.timeout`.
4. Validates `structured_output` with zod. Anything wrong becomes a `NodeFailure`, which the graph escalates.
5. Transient API errors (overloaded, rate limited) are retried with backoff. Usage limits, turn limits and invalid output are **never** retried.

Executors are pluggable (`registerExecutor`), which is also how tests inject a fake executor with no module mocking.

### 6.2 Ticket state

A zod `Ticket` schema holds id, title, priority, specialty, flags, status, summary, `author_id`, `reviewer_id`, `qa_id`, `revisions`, `evidence`, `history` (with per-node token counts), plus the request, acceptance criteria, worktree path and base commit. Summaries are capped at 10 lines **by the code**, which truncates instead of failing the node (a bug found on a real run, see §14).

### 6.3 Persistence and resumability

- **Pause/resume across processes:** `FileSaver` persists the checkpointer to JSON, so a ticket paused at CEO approval can be answered by a completely separate process.
- **Per-ticket files and locks:** one `tickets/<id>.json` (under `ORCH_HOME`) plus `tickets/<id>.lock`. A second command on the same ticket refuses with "already running"; a lock left by a dead process is replaced.
- **`orch continue <id>`:** resumes a run that was killed mid-graph.
- **Retry re-runs the node that escalated**, not the whole pipeline, and reuses partial dev work.

### 6.4 Active tickets from git itself

The "max 5 active tickets" rule has no database: `activeTickets(repo)` counts git worktrees under `ticket/*`. State derived from the thing that already tracks it.

### 6.5 Per-repo configuration

`.orchestrator.json` at the repo root is read **from the base commit**, so a ticket cannot edit its own rules. It sets the test command, merge policy (`pr`, `auto` or `local` for solo repos), publisher, push remote, fork target (`base_repo`), whether the PR body discloses the automated origin, `install`, the dev `specialties` and the `stack`. The same keys can live in `<ORCH_HOME>/config.json` (default `orchestrator/.state/config.json`), and the in-repo file wins per key. `deploy` and `webcheck` are accepted only from that external file.


