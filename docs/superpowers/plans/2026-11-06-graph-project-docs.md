# Graph-written project docs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The graph writes and updates the project spec under `<repo>/.claude/docs/` (local only, never committed) on every ticket, without ever blocking a ticket.

**Architecture:** A read-only `docs` agent returns file contents as JSON; a pure, tested writer in `src/docs.ts` validates and writes them into the main checkout. Two graph nodes run it (`docs_start` before triage, `docs_end` after publish); they catch every failure into `docs_warnings` and never escalate.

**Tech Stack:** TypeScript on Node 24 (`node --test`), zod, LangGraph.js, existing `safeGit`.

**Spec:** `docs/superpowers/specs/2026-11-06-graph-project-docs-design.md`

## Global Constraints

- Every `.md` under `.claude/docs/` has at most 150 lines (`MAX_LINES = 150`); 150 passes, 151 is rejected.
- At most 40 files and 200 KB per agent call; depth at most 3 below `docs/`; `.md` only; relative paths only.
- The `docs` role is read-only (`Read`, `Grep`, `Glob`) with the `SECRETS` deny list; no `Write`/`Edit`.
- Docs problems are warnings in `docs_warnings`; the docs node never throws and never changes `status`.
- Docs are written to the main checkout (`t.repo`), never to the worktree, and never when git would not ignore them.
- The graph never writes `CLAUDE.md`. Mandatory topic slugs: `arquitetura`, `backlog`, `checklist`, `design-patterns`, `features`, `testes`, `trade-offs`, `comunicacao`, `aprendizados`.
- Commits: `type(orchestrator): description`, English, ending with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

- Agent path `../x.md`, `/abs.md`, `C:\x.md`, `a\..\..\x.md`, or a path through a symlinked dir: nothing is written outside `.claude/docs/`.
- A repo whose own `.gitignore` un-ignores `.claude/` (`!.claude/`): docs are not written and a warning says why.
- The CEO edits a doc by hand between "shown to the agent" and "written": that file is skipped, the rest are written.
- Executor throws, output is invalid, or the daily cap is reached: the ticket proceeds to triage and later nodes as if docs did not exist.
- No `CLAUDE.md` anywhere, or `.claude/CLAUDE.md` over 8000 chars: dev still runs; rules are empty or capped.

---

### Task 1: Docs writer (pure module)

**Files:**
- Create: `orchestrator/src/docs.ts`
- Test: `orchestrator/tests/docs.test.ts`

**Interfaces:**
- Produces:
  - `MAX_LINES`, `MAX_FILES`, `MAX_BYTES`, `MAX_DEPTH`, `TOPICS` (as in Global Constraints)
  - `DocsOutput` zod schema + type: `{ files: {path: string; content: string}[]; not_applicable: {topic: string; reason: string}[]; notes: string }` (`files` max `MAX_FILES`; `not_applicable` and `notes` default empty)
  - `docsDir(repo: string): string` -> `<repo>/.claude/docs`
  - `snapshot(repo: string, cap?: number): { index: string; seen: Record<string, string>; shown: Record<string, string> }` — `shown`: path -> content for files whose contents fit in `cap` total chars (default 60_000); `seen`: path -> sha256 of those; `index`: one line per existing doc (path, first heading, line count)
  - `writeDocs(repo: string, out: DocsOutput, seen: Record<string, string>, lockDir: string): { written: string[]; warnings: string[] }`
  - `coverage(repo: string): string[]` — one warning per mandatory topic that has no `.md` under its directory and no entry in the stored not-applicable list

- [ ] **Step 1: Write failing tests in `tests/docs.test.ts`** (temp dir as `repo`, `lockDir`, helper `out(files)`):
  - writes `arquitetura/visao.md` and creates parents; returns it in `written`
  - rejects, warns, writes nothing for: `../x.md`, `/abs.md`, `C:\x.md`, `a/../../x.md`, `x.txt`, `README.md`, a path of depth 4, `.claude/docs` containing a symlinked subdir (skip the symlink case on `process.platform === "win32"` if symlink creation throws)
  - 150 lines (also with CRLF and a trailing newline) is written; 151 lines is rejected and the previous version stays on disk
  - 41 files, or total content over 200_000 bytes: nothing written, one warning
  - existing file whose on-disk sha256 differs from `seen[path]` (or has no `seen` entry): skipped with a warning, other files still written
  - `not_applicable` entries persist in `.nao-se-aplica.json` and a second call keeps earlier entries; `coverage()` warns for each topic without a directory/entry and is empty when all nine are covered by a mix of files and entries
  - `README.md` index is written by `writeDocs` (lists directories with file counts and not-applicable reasons, at most 150 lines even with 400 files on disk)
  - `snapshot` shows contents up to the cap and omits the rest from `shown`/`seen` but keeps them in `index`
- [ ] **Step 2: Run** `cd orchestrator && node --test tests/docs.test.ts` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement `src/docs.ts`** with the signatures above. Validate with `path.posix`/`win32`-safe checks (reject any `\`, drive letter, leading `/`, `..` segment); `lstat` each existing component under `.claude/` and refuse symlinks; write via temp file + `rename`; hold a lock file in `lockDir` (reuse the pattern in `src/ticket-store.ts` `lockTicket`, with a fixed id `docs`) around the whole write; count lines as `content.replace(/\r?\n$/, "").split(/\r?\n/).length`.
- [ ] **Step 4: Run** `node --test tests/docs.test.ts` — Expected: all PASS.
- [ ] **Step 5: Commit** `feat(orchestrator): add the validated docs writer`

### Task 2: Local-only guard and mode detection

**Files:**
- Modify: `orchestrator/src/docs.ts`
- Test: `orchestrator/tests/docs.test.ts`

**Interfaces:**
- Consumes: `safeGit` from `src/guardrails.ts`
- Produces:
  - `ensureLocalOnly(repo: string): string | null` — creates `.claude/docs/`; adds `.claude/` to the repo's `info/exclude` (path from `git rev-parse --git-path info/exclude`) when `git check-ignore -q .claude/docs/x` fails; returns `null` when ignored, otherwise a warning string (docs must not be written)
  - `docsMode(repo: string): "scan" | "greenfield" | "update"`

- [ ] **Step 1: Write failing tests** (real temp git repos, `git init -q -b main`):
  - fresh repo: `ensureLocalOnly` returns `null`, `.claude/docs` exists, `git status --porcelain` is empty after a file is written there, `.gitignore` is untouched
  - repo whose `.gitignore` contains `!.claude/`: returns a string mentioning "not ignored"; calling it twice does not duplicate the exclude line
  - `docsMode`: repo with only `.gitignore`, `README.md`, `orchestrator/x`, `.orchestrator.json` tracked -> `greenfield`; with `src/a.ts` tracked -> `scan`; with any `.md` under `.claude/docs` -> `update` (checked first)
- [ ] **Step 2: Run** `node --test tests/docs.test.ts` — Expected: new tests FAIL.
- [ ] **Step 3: Implement both functions.** `docsMode` uses `git ls-files`, ignoring the greenfield-allowed names above.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat(orchestrator): keep .claude out of git and detect the docs mode`

### Task 3: `docs` role, agent prompt, env defaults

**Files:**
- Modify: `orchestrator/src/guardrails.ts` (`Role`, `PERMISSIONS`), `orchestrator/.env.example`
- Create: `orchestrator/agents/docs.md`
- Test: `orchestrator/tests/run-agent.test.ts` (or the file that already tests `permissionArgs`)

**Interfaces:**
- Produces: `Role` includes `"docs"`; `PERMISSIONS.docs` = same as `knowledge` (read-only, `SECRETS` deny); env keys `MODEL_DOCS`, `EFFORT_DOCS`, `TURNS_DOCS`.

- [ ] **Step 1: Write failing test:** `permissionArgs("docs")` passes `--tools Read,Grep,Glob` and contains no `Write`/`Edit`; the `--disallowedTools` list includes `Read(**/.env*)`; `loadPrompt(["docs"], "agents")` is non-empty and mentions `150`, every mandatory slug, `CLAUDE.md`, and `not_applicable`.
- [ ] **Step 2: Run** the file with `node --test` — Expected: FAIL.
- [ ] **Step 3: Implement.** `agents/docs.md` (frontmatter `name`, `description`, like the other agents) tells the agent: modes `scan`/`greenfield`/`update`; one directory per topic, max 150 lines per file, files readable alone; cover the nine slugs or list `not_applicable` with a reason, and add directories the project needs; write for teammates, leaders and stakeholders; what worked / what failed only from the evidence in the context; reuse and update existing docs instead of duplicating; never write `CLAUDE.md`; answer only in the structured format. `.env.example`: `MODEL_DOCS=claude-haiku-5-5`, `TURNS_DOCS=15`.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat(orchestrator): add the read-only docs role and its prompt`

### Task 4: Graph nodes `docs_start` and `docs_end`

**Files:**
- Modify: `orchestrator/src/graph.ts` (`Ticket`, `guarded`, `buildGraph`, `report`), `orchestrator/tests/graph.test.ts`

**Interfaces:**
- Consumes: Tasks 1-3; `dailyCapReached` from `src/daily-cap.ts`; `repoOf` from `src/guardrails.ts`; `runAgent`.
- Produces: `Ticket.docs_warnings: string[]` (default `[]`); `docsNode(phase: "start" | "end"): (t: T) => Promise<Partial<T>>`; edges `START -> docs_start -> triage` and `publish -> docs_end -> ceo_approval` (publish's conditional edge targets `docs_end` instead of `ceo_approval` for the success case; its failure routing is unchanged).

- [ ] **Step 1: Test harness:** in the fake executor of `tests/graph.test.ts`, do not push `docs` into `calls` (record it in `docsCalls`); add a default `docs` behavior returning `{ files: [], not_applicable: [], notes: "" }`. Run the whole file — Expected: existing tests still PASS (confirms the harness change is neutral).
- [ ] **Step 2: Write failing tests** (fixture repo from `createFixture`):
  - happy path: `docs` returns one `arquitetura/visao.md`; after the run the file exists under `<repo>/.claude/docs/arquitetura/`, `git status --porcelain` in the repo is empty, `docsCalls.length === 2` (start and end), ticket reaches the approval pause
  - `docs_start` context contains the request and mode `greenfield`/`scan`; `docs_end` context contains the final commit short sha and `tests:` evidence
  - executor throws `NodeFailure` in `docs`: ticket still reaches approval, `docs_warnings` has an entry starting `start:`; no escalation
  - invalid docs output (schema mismatch): same, no escalation
  - `TOKEN_CAP_DAILY` already reached (write the ledger via `recordUsage`): docs skipped with a warning, ticket proceeds
  - fixture `.gitignore` with `!.claude/`: nothing written, warning says not ignored
  - `tokensPerCall` large enough that docs usage alone would exceed `TOKEN_BUDGET_TICKET`: the dev still runs (docs usage excluded from `budgetExceeded`)
  - `report(t)` prints each `docs_warnings` entry after the TOTAL line
- [ ] **Step 3: Run** `node --test tests/graph.test.ts` — Expected: new tests FAIL.
- [ ] **Step 4: Implement** `docsNode` as: guard (`ensureLocalOnly`) -> mode -> `snapshot` -> `runAgent({ role: "docs", files: ["docs"], cwd: t.worktree, schema: DocsOutput, context })` -> `writeDocs(repo, output, snapshot.seen, orchHome())` -> `coverage(repo)`; wrap everything in one `try/catch` that converts any error to a warning. Warnings from the same phase replace the previous ones (prefix `start: ` / `end: `). Log history under node `docs` with the usage. In `guarded`, filter `h.node !== "docs"` before `budgetExceeded`. `repo` is `t.repo || repoOf(t.worktree)`.
- [ ] **Step 5: Run** `node --test tests/graph.test.ts` then `npm test` and `npm run typecheck` — Expected: all PASS.
- [ ] **Step 6: Commit** `feat(orchestrator): write the project docs from the graph without blocking tickets`

### Task 5: `CLAUDE.md` from `.claude/`

**Files:**
- Modify: `orchestrator/src/repo-config.ts` (`loadConventions`), `orchestrator/tests/conventions.test.ts`

**Interfaces:**
- Produces: `loadConventions(repo, ref, max = 8000)` reads `<repo>/.claude/CLAUDE.md` from disk first, then the root `CLAUDE.md` at `ref`, else `""`; the cap applies to both.

- [ ] **Step 1: Add failing tests:** `.claude/CLAUDE.md` on disk (untracked) wins over a committed root `CLAUDE.md`; with only the root file the old behavior holds (existing test stays green); a 9000-char `.claude/CLAUDE.md` is cut to 8000; neither file -> `""`.
- [ ] **Step 2: Run** `node --test tests/conventions.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** with `readFileSync` in a `try`, falling through to the existing `git show`.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat(orchestrator): read the repo rules from .claude/CLAUDE.md first`

### Task 6: CLI surface and docs

**Files:**
- Modify: `orchestrator/scripts/orch.ts` (`init`, `status`), `orchestrator/README.md`
- Create: `orchestrator/docs/10-project-docs.md`

**Interfaces:**
- Consumes: `ensureLocalOnly`, `Ticket.docs_warnings`.

- [ ] **Step 1: Implement:** `orch init` also calls `ensureLocalOnly(repo)` and prints the result (created and ignored, or the warning); the `status` list line gets a trailing `  docs!` when `docs_warnings` is non-empty; `status <id>` already prints `report(t)`, which now carries the warnings.
- [ ] **Step 2: Docs:** README bullet (what is written, where, local only, `MODEL_DOCS`/`TURNS_DOCS`, warnings never block, `CLAUDE.md` lookup order, the graph never writes it) and `docs/10-project-docs.md` (design recap, limits: no backup, stale-write skip, one shared tree for up to 5 tickets).
- [ ] **Step 3: Verify end to end** in a temp repo with the drop-in folder: `npm run orch -- init` creates and ignores `.claude/docs`; a small `orch run` leaves `.claude/docs/README.md` plus topic directories, `git status` of the host stays clean, `orch status` shows no `docs!` or shows the warnings. Expected: as stated; report real cost.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `docs(orchestrator): document the project docs node and surface its warnings`
