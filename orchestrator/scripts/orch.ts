#!/usr/bin/env node
// Daily-use CLI over the graph. Drop-in: copy this folder into a repo and it works on that repo (the folder's parent).
// State lives in ORCH_HOME (default ./.state, gitignored), one tickets/<id>.json per ticket.
//   orch init [repo]            write .orchestrator.json (commit it) and check for CLAUDE.md
//   orch run "<request>" [--repo <path>] [--id <id>]
//   orch status [id]            all tickets, or one with its pending question
//   orch approve <id> [text]    approve; for an escalation, text is the answer (e.g. retry, a clarification)
//   orch reject <id> [reason]   reject with a reason; on an escalation with no reason, abort
//   orch watch                  one monitor pass over deployed tickets (HTTP health check for command deploys, simulated probe otherwise):
//                               opens one P0 hotfix ticket per failure and proposes a rollback
//   orch chaos <id> <scenario>|--clear   inject (or clear) a failure on a ticket deployed to a sandbox target
//   orch rollback <incident-id> [--config-reviewed]  approve the proposed rollback of an incident;
//                               --config-reviewed accepts a changed .git/config after you looked at it
//   orch resolve <incident-id>  close an incident by hand (the service is back, or you handled it elsewhere)
//   orch clean <id>|--all [--force] [--remote]   remove worktree, branch, deploy record and state of finished
//                               (simulated_deploy/aborted) tickets; --remote also deletes ticket/<id> on the push remote

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { approve, reject, resumeRun, run } from "./orch/flow.ts";
import { clean, init, status } from "./orch/admin.ts";
import { type Ctx, die, makeCtx } from "./orch/ctx.ts";
import { chaos, resolveByHand, rollback, watchDeployed } from "./orch/ops.ts";

const ROOT = resolve(import.meta.dirname, "..");
if (existsSync(join(ROOT, ".env"))) process.loadEnvFile(join(ROOT, ".env"));
process.env.AGENTS_DIR = resolve(ROOT, process.env.AGENTS_DIR ?? "agents");

const commands: Record<string, (c: Ctx) => void | Promise<void>> = {
  init, run, status, continue: resumeRun, approve, reject, clean, watch: watchDeployed, resolve: resolveByHand, chaos, rollback,
};

const ctx = makeCtx(process.argv.slice(2), resolve(ROOT, ".."));
const command = ctx.cmd !== undefined && Object.hasOwn(commands, ctx.cmd) ? commands[ctx.cmd] : undefined;
if (command) await command(ctx);
else die("usage: orch init | run | status | continue | approve | reject | clean | watch | chaos | rollback | resolve");
