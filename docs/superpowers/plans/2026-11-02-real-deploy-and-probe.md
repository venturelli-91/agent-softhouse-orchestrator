# Real Deploy Target and HTTP Probe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `orch` deploy the approved commit through CEO-configured commands and let `orch watch` detect a real failure through an HTTP health check, without choosing a platform.

**Architecture:** A `deploy` block in `ORCH_HOME/config.json` (never in the repo) makes the ticket's `deploy_target` `"command"`. The existing `deploy` node runs the configured command by code (no shell, minimal env) and records the settings needed later in the deploy record; `approveRollback` and the new `defaultProbe` read them from that record.

**Tech Stack:** Node 24 (type stripping, `node --test`), TypeScript, zod, `node:child_process`, global `fetch`.

**Spec:** `docs/superpowers/specs/2026-11-02-real-deploy-and-probe-design.md`

## Global Constraints

- Everything stays under `orchestrator/`; deleting it restores the old flow. No new dependency; no real deploy or external network in tests.
- The `deploy` block is read only from `ORCH_HOME/config.json` `repos[<abs path>]`; a `deploy` key in the repo's `.orchestrator.json` is an error.
- Commands match `^[\w ./:=@-]+$`, are split on spaces and run with `execFileSync` (no shell) with a timeout.
- Only env names listed in `deploy.env`, plus the `ALLOWED_ENV` base set, `ORCH_TICKET`, `ORCH_SHA`, `ORCH_PREVIOUS`, reach a command. Values are never stored.
- `environment` is `"staging"` (default) or `"production"`; a `command` deploy records `sandbox: false`, so `orch chaos` refuses it.
- Nothing runs before `orch approve` / `orch rollback`; no automatic rollback; at most 5 active tickets; per-ticket state.
- Existing tests keep passing (119 today). Commits: Conventional Commits in English, scope `orchestrator`, one per task, no attribution lines.
- Run single test files while working; `npm test` (about 200 s) and `npm run typecheck` at the end of Task 4.

## Review Focus

- A `deploy` key in `.orchestrator.json` is rejected, and `health_url` with a scheme other than `http`/`https` is rejected (Task 1).
- The deploy command exits non-zero or times out: no deploy record, the ticket escalates, nothing is marked deployed (Task 2).
- Worktree `HEAD` differs from `approved_sha`: the command is not run (Task 2).
- A secret value that appears in the command output is masked in the evidence (Task 2).
- Rollback command fails: the incident stays `proposed` and a later `orch rollback` retries it (Task 2).
- Health URL answers 503, times out, is slower than `max_latency_ms` or refuses the connection: each gives a distinct symptom; a healthy answer gives `null` (Task 3).

---

### Task 1: Deploy settings in the per-repo config

**Files:**
- Modify: `orchestrator/src/repo-config.ts` (`RepoConfig`, `loadRepoConfig`), `orchestrator/src/graph.ts` (`Ticket`, `createWorktree`)
- Test: `orchestrator/tests/repo-config.test.ts`

**Interfaces:**
- Produces: `DeployConfig` (zod, exported from `repo-config.ts`): `{ command: string; rollback: string; health_url: string; environment: "staging" | "production" (default "staging"); env: string[] (default [], each `^[A-Z_][A-Z0-9_]*$`); timeout_s: number (default 300, max 3600); max_latency_ms: number (default 2000) }`. `RepoConfig.deploy: DeployConfig | null` (default `null`). `Ticket.deploy_cfg: DeployConfig | null` (default `null`); `createWorktree` returns `deploy_cfg` and `deploy_target: "command"` when the config has a `deploy` block.

- [ ] **Step 1: Write failing tests** in `repo-config.test.ts`: `a deploy block in the external config is loaded with defaults` (environment `staging`, `timeout_s` 300); `a deploy key in .orchestrator.json is rejected` (message names `deploy`); `health_url must be http or https` (`file:///x` throws); `a command with shell operators is rejected` (`vercel deploy && rm x`); `env names must be upper-case identifiers`.
- [ ] **Step 2: Run** `node --test tests/repo-config.test.ts`; expect the new tests to fail.
- [ ] **Step 3: Implement.** Add `DeployConfig` and the `deploy` field to `RepoConfig`; in `loadRepoConfig`, throw `.orchestrator.json: deploy is only accepted in the external config` when the in-repo object has a `deploy` key before merging. Add `deploy_cfg` to `Ticket` and set it plus `deploy_target` in `createWorktree` from the loaded config.
- [ ] **Step 4: Run** `node --test tests/repo-config.test.ts` and `npm run typecheck`; expect green.
- [ ] **Step 5: Commit** `feat(orchestrator): deploy settings in the external per-repo config`

### Task 2: Command deploy target, deploy node and rollback

**Files:**
- Modify: `orchestrator/src/deploy.ts`, `orchestrator/src/guardrails.ts` (export `ALLOWED_ENV`), `orchestrator/src/graph.ts` (`deploy` node, approval `interrupt` payload), `orchestrator/src/monitor.ts` (`approveRollback`)
- Test: `orchestrator/tests/deploy.test.ts`, `orchestrator/tests/graph.test.ts`, `orchestrator/tests/monitor.test.ts`

**Interfaces:**
- Consumes: `DeployConfig` (Task 1).
- Produces in `deploy.ts`: `type CommandSettings = { rollback: string; health_url: string; env: string[]; timeout_s: number; max_latency_ms: number; environment: "staging" | "production" }`; `DeployRecord.cmd?: CommandSettings`; `commandEnv(env: string[], ctx: { id: string; sha: string; previous: string }, src?: NodeJS.ProcessEnv): Record<string, string>`; `commandTarget(cfg: { command: string; rollback: string; env: string[]; timeout_s: number }, cwd: string, previous: string): DeployTarget` with `sandbox: false`, `deploy` and `rollback` throwing `Error` on non-zero exit or timeout with the output tail (last 300 chars, values of `cfg.env` masked as `***`) in the message and returning that tail on success.
- Produces: the approval `interrupt` payload gains `deploy: { target: string; environment: string }`.

- [ ] **Step 1: Write failing tests.**
  - `deploy.test.ts`: `commandEnv passes only listed names plus the ORCH_ variables` (an unlisted `SECRET_A` in `src` is absent, a listed one is present, `ORCH_TICKET/ORCH_SHA/ORCH_PREVIOUS` are set); `a failing command throws with the output tail` (`node --nonexistent-flag`); `a listed env value in the output is masked` (`node --version` with `env: ["ORCH_TEST_SECRET"]` and `process.env.ORCH_TEST_SECRET = process.version`: the returned tail contains `***` and not the version); `a command over its timeout throws` (`timeout_s: 0.001`, `node --version`, throws `/timed out|ETIMEDOUT/`).
  - `graph.test.ts` (ticket extra `deploy_target: "command"` and `deploy_cfg` with `command: "node --version"`): `a command deploy runs only after approval and ends in deployed with cmd settings in the record`; `a failing deploy command escalates and writes no record` (`node --nonexistent-flag`); `the deploy command is not run when the worktree HEAD moved after approval` (while paused at approval, add an empty commit in the worktree, then resume: escalation, no record); `the approval request shows the environment` (`deploy.environment` is `staging`).
  - `monitor.test.ts`: `a failing rollback command leaves the incident proposed and a retry succeeds` (record with `cmd` and a failing rollback, `approveRollback` throws and `rollback` stays `proposed`; rewrite the record with a passing rollback and call again: `done`).
- [ ] **Step 2: Run** the three files; expect the new tests to fail.
- [ ] **Step 3: Implement** `commandEnv`, `commandTarget` (split on spaces, `execFileSync`, `timeout: timeout_s * 1000`, `encoding: "utf8"`, `stdio: "pipe"`, `windowsHide: true`) and the `cmd` field in `deploy.ts`. In the `deploy` node, for `deploy_target === "command"`: require `safeGit(t.worktree, "rev-parse", "HEAD") === t.approved_sha` (else `NodeFailure`), build `commandTarget(t.deploy_cfg, t.worktree, t.base)`, deploy, record with `cmd` (settings from `t.deploy_cfg`) and `target: "command"`, status `deployed`. In `approveRollback`, use `commandTarget({ ...record.cmd, command: "" }, record.repo, record.previous)` when `record.cmd` is set, else `getDeployTarget`; set `rollback: "done"` only after a successful call (already the case). Export `ALLOWED_ENV`.
- [ ] **Step 4: Run** the three files and `npm run typecheck`; expect green.
- [ ] **Step 5: Commit** `feat(orchestrator): command deploy target with masked output, HEAD check and rollback`

### Task 3: HTTP probe

**Files:**
- Create: `orchestrator/src/probe.ts`
- Modify: `orchestrator/src/chaos.ts` (`Probe` type), `orchestrator/src/monitor.ts` (await the probe)
- Test: `orchestrator/tests/probe.test.ts`, `orchestrator/tests/monitor.test.ts`

**Interfaces:**
- Consumes: `readDeploy`, `DeployRecord.cmd` (Task 2); `simulatedProbe` (existing).
- Produces: `type Probe = (home: string, id: string) => string | null | Promise<string | null>` (in `chaos.ts`); `httpProbe(url: string, opts: { timeout_ms: number; max_latency_ms: number }): Promise<string | null>` returning `null` for a 2xx within the latency limit, else `http <status>`, `timeout after <n>ms`, `latency <n>ms > <m>ms` or `unreachable: <code or message>`; `defaultProbe: Probe` using `httpProbe` with `timeout_ms = 10000` when the deploy record has `cmd.health_url`, else `simulatedProbe`.

- [ ] **Step 1: Write failing tests** in `probe.test.ts` against a local `node:http` server on `127.0.0.1`: `a healthy answer is null`; `a 503 reports http 503`; `a slow answer reports latency over the limit`; `a hanging answer reports a timeout`; `a closed port reports unreachable`; `defaultProbe uses the simulated probe when the record has no health_url`. In `monitor.test.ts`: `watch awaits an async probe`.
- [ ] **Step 2: Run** the two files; expect failures.
- [ ] **Step 3: Implement** `probe.ts` with global `fetch` and `AbortSignal.timeout`; widen `Probe`; `await deps.probe(...)` in `watch`.
- [ ] **Step 4: Run** the two files and `npm run typecheck`; expect green.
- [ ] **Step 5: Commit** `feat(orchestrator): http health probe for the monitor`

### Task 4: CLI, docs and acceptance

**Files:**
- Modify: `orchestrator/scripts/orch.ts` (`watch` uses `defaultProbe`), `orchestrator/README.md`
- Test: `orchestrator/tests/operations.test.ts`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write failing acceptance test** in `operations.test.ts`: `a command deploy with a failing health url opens one hotfix and rolls back only on approval` (local `node:http` server that answers 200 then 503; ticket with `deploy_cfg.command` `node --version`, `rollback` `node --version`, `health_url` of the server; deliver, flip the server to 503, `watch` with `defaultProbe` makes one incident and one P0 hotfix, a second `watch` makes none, `approveRollback` runs once and a second call throws `already rolled back`); and `chaos is refused on a command deploy`.
- [ ] **Step 2: Run** `node --test tests/operations.test.ts`; expect the new tests to fail.
- [ ] **Step 3: Use `defaultProbe` in `orch watch`** (replace `simulatedProbe`); update the usage comment.
- [ ] **Step 4: Update `README.md`:** the `deploy` block (all keys and defaults) in `~/.orchestrator/config.json`, why it is not read from the repo, `staging` vs `production`, `deploy.env` credentials by name, the `ORCH_*` variables, the probe symptoms, and that `chaos` only works on the simulated target.
- [ ] **Step 5: Verify** `npm test`, `npm run typecheck`, then `ORCH_HOME=<tmp> node scripts/orch.ts watch` prints `nothing is deployed` and exits 0.
- [ ] **Step 6: Commit** `feat(orchestrator): orch watch uses the http probe for command deploys`
