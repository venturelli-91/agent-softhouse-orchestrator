#!/usr/bin/env node
// Daily-use CLI over the graph. Drop-in: copy this folder into a repo and it works on that repo (the folder's parent). State lives in ORCH_HOME (default ./.state, gitignored), one tickets/<id>.json per ticket.
//   orch init [repo]            write .orchestrator.json (commit it) and check for CLAUDE.md
//   orch run "<request>" [--repo <path>] [--id <id>]
//   orch status [id]            all tickets, or one with its pending question
//   orch approve <id> [text]    approve; for an escalation, text is the answer (e.g. retry, a clarification)
//   orch reject <id> [reason]   reject with a reason; on an escalation with no reason, abort
//   orch watch                  one monitor pass over deployed tickets (HTTP health check for command deploys, simulated probe otherwise): opens one P0 hotfix ticket per failure and proposes a rollback
//   orch chaos <id> <scenario>|--clear   inject (or clear) a failure on a ticket deployed to a sandbox target
//   orch rollback <incident-id> [--config-reviewed]  approve the proposed rollback of an incident; --config-reviewed accepts a changed .git/config after you looked at it
//   orch resolve <incident-id>  close an incident by hand (the service is back, or you handled it elsewhere)
//   orch clean <id>|--all [--force] [--remote]   remove worktree, branch, deploy record and state of finished (simulated_deploy/aborted) tickets; --remote also deletes ticket/<id> on the push remote
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { dailyCapReached, orchHome, usedToday, workRoot } from "../src/daily-cap.ts";
import { FileSaver } from "../src/file-saver.ts";
import { buildGraph, config, createWorktree, report, resume, Ticket } from "../src/graph.ts";
import { assertGitConfigUnchanged, repoOf, safeGit } from "../src/guardrails.ts";
import { behindBy, deleteRemoteBranch } from "../src/git-remote.ts";
import { recordMetrics } from "../src/metrics.ts";
import { notify } from "../src/notify.ts";
import { clearFailure, injectFailure, SCENARIOS } from "../src/chaos.ts";
import { defaultProbe } from "../src/probe.ts";
import { deployedIds, forgetDeploy } from "../src/deploy.ts";
import { listIncidents } from "../src/incidents.ts";
import { approveRollback, resolveIncident, watch } from "../src/monitor.ts";
import { lockTicket, ticketFile, ticketIds } from "../src/ticket-store.ts";

const ROOT = resolve(import.meta.dirname, "..");
if (existsSync(join(ROOT, ".env"))) process.loadEnvFile(join(ROOT, ".env"));
process.env.AGENTS_DIR = resolve(ROOT, process.env.AGENTS_DIR ?? "agents");

const HOST = resolve(ROOT, "..");
const die = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};
const [cmd, ...rest] = process.argv.slice(2);
const { values, positionals } = parseArgs({
  args: rest, allowPositionals: true,
  options: { repo: { type: "string" }, id: { type: "string" }, all: { type: "boolean" }, force: { type: "boolean" }, remote: { type: "boolean" }, clear: { type: "boolean" }, "config-reviewed": { type: "boolean" } },
});

const home = orchHome();
mkdirSync(home, { recursive: true });

// One state file per ticket, so commands on different tickets never touch the same file.
function open(id: string) {
  const saver = new FileSaver(ticketFile(home, id));
  return { saver, graph: buildGraph(saver) };
}

type Pending = { type: "approval" | "escalation"; reason: string | null; title: string; summary: string; evidence: string[] };
async function load(id: string) {
  const { saver, graph } = open(id);
  if (!saver.storage[id]) return die(`no ticket ${id}`);
  const state = await graph.getState(config(id));
  const pending = state.tasks.flatMap((t) => t.interrupts)[0]?.value as Pending | undefined;
  return { ticket: Ticket.parse(state.values), pending };
}

// Runs the graph until it ends or pauses for the CEO; a pause is announced outside the terminal too.
async function drive(id: string, input: unknown) {
  await open(id).graph.invoke(input as never, config(id));
  const { ticket, pending } = await load(id);
  console.log(report(ticket));
  if (pending) {
    console.log(JSON.stringify(pending, null, 1));
    const next = pending.type === "approval" ? `orch approve ${id}  |  orch reject ${id} "<reason>"` : `orch approve ${id} "<answer>"  |  orch reject ${id}`;
    await notify(`${id} waiting for you (${pending.type}): ${pending.title}\n${pending.reason ?? pending.summary}\n${next}`);
  } else console.log(`${id}: ${ticket.status}${ticket.status === "simulated_deploy" || ticket.status === "aborted" ? "" : ` - ${ticket.summary}`}`);
}

const needCap = () => {
  const capped = dailyCapReached();
  if (capped) die(capped);
};
const needPending = async (id: string) => (await load(id)).pending ?? die(`${id} is not waiting for an answer`);
// Takes the ticket's lock for the duration of one command; a second command on the same id refuses.
async function locked(id: string, fn: () => Promise<void>) {
  let unlock: () => void;
  try {
    unlock = lockTicket(home, id);
  } catch (e) {
    return die((e as Error).message);
  }
  try {
    await fn();
  } finally {
    unlock();
  }
}
const DONE = ["simulated_deploy", "deployed", "aborted"];

if (cmd === "init") {
  const repo = resolve(positionals[0] ?? HOST);
  const file = join(repo, ".orchestrator.json");
  if (existsSync(file)) console.log(`${file} already exists`);
  else {
    writeFileSync(file, `${JSON.stringify({ test: "npm test", merge: "pr" }, null, 2)}\n`);
    console.log(`wrote ${file}: set "test" to the repo's test command, then commit it (it is read from the base commit)`);
  }
  if (!existsSync(join(repo, "CLAUDE.md"))) console.log("no CLAUDE.md: the dev will have no repo conventions (commit format, style)");
} else if (cmd === "run") {
  const request = positionals[0] ?? die('usage: orch run "<request>" [--repo <path>] [--id <id>]');
  needCap();
  const id = values.id ?? `T-${Date.now().toString(36)}`;
  const repo = resolve(values.repo ?? HOST);
  await locked(id, async () => {
    const behind = behindBy(repo);
    if (behind) console.warn(`warning: ${repo} is ${behind} commit(s) behind its upstream; the ticket will branch from a stale base`);
    const wt = createWorktree(repo, id, join(workRoot(), "worktrees", id), home);
    await drive(id, { id, request, ...wt });
  });
} else if (cmd === "status") {
  const ids = positionals[0] ? [positionals[0]] : ticketIds(home);
  for (const id of ids) {
    const { ticket: t, pending } = await load(id);
    console.log(`${id.padEnd(12)} ${t.status.padEnd(16)} ${t.priority.padEnd(4)} ${t.title}${pending ? `  <- waiting (${pending.type})` : ""}`);
    if (positionals[0]) {
      console.log(report(t));
      if (pending) console.log(JSON.stringify(pending, null, 1));
    }
  }
  if (!ids.length) console.log("no tickets");
  if (!positionals[0])
    for (const i of listIncidents(home)) console.log(`${i.id.padEnd(16)} ${i.status.padEnd(8)} ${i.ticket} hotfix=${i.hotfix || "-"} rollback=${i.rollback}  ${i.symptom}`);
  if (process.env.TOKEN_CAP_DAILY) console.log(`tokens in the last 24h: ${usedToday()} / ${process.env.TOKEN_CAP_DAILY}`);
} else if (cmd === "continue") {
  // A run killed mid-graph (crash, out of memory) leaves a checkpoint that is not waiting for anyone: this picks it up where it stopped.
  const id = positionals[0] ?? die("usage: orch continue <id>");
  needCap();
  await locked(id, async () => {
    if ((await load(id)).pending) die(`${id} is waiting for an answer: use orch approve or orch reject`);
    await drive(id, null);
  });
} else if (cmd === "approve") {
  const id = positionals[0] ?? die('usage: orch approve <id> ["answer"]');
  await locked(id, async () => {
    await needPending(id);
    needCap();
    await drive(id, resume(positionals[1] ?? "approve"));
  });
} else if (cmd === "reject") {
  const id = positionals[0] ?? die('usage: orch reject <id> "<reason>"');
  await locked(id, async () => {
    const pending = await needPending(id);
    const reason = positionals[1] ?? (pending.type === "escalation" ? "abort" : die("rejecting an approval needs a reason"));
    if (reason !== "abort") needCap();
    await drive(id, resume(reason));
  });
} else if (cmd === "clean") {
  const ids = values.all ? ticketIds(home) : positionals[0] ? [positionals[0]] : die("usage: orch clean <id> | --all [--force] [--remote]");
  for (const id of ids)
    await locked(id, async () => {
      const { ticket: t } = await load(id);
      if (!DONE.includes(t.status) && !values.force) {
        if (!values.all) die(`${id} is ${t.status}, not finished (use --force to discard it)`);
        return;
      }
      if (existsSync(t.worktree)) {
        const repo = t.repo || repoOf(t.worktree);
        if (values.remote) {
          assertGitConfigUnchanged(repo, t.git_config_hash);
          console.log(`${id}: remote branch ${deleteRemoteBranch(repo, t.push_remote, id)}`);
        }
        safeGit(repo, "worktree", "remove", "--force", t.worktree);
        safeGit(repo, "branch", "-D", `ticket/${id}`);
      }
      recordMetrics(home, t);
      unlinkSync(ticketFile(home, id));
      forgetDeploy(home, id);
      console.log(`cleaned ${id} (${t.status})`);
    });
} else if (cmd === "watch") {
  if (!deployedIds(home).length) console.log("nothing is deployed");
  const incidents = await watch(home, {
    probe: defaultProbe,
    notify,
    makeHotfix: async ({ incident, repo }) => {
      needCap();
      const id = `H-${incident.id.slice(4)}`;
      await locked(id, async () => {
        const wt = createWorktree(repo, id, join(workRoot(), "worktrees", id), home);
        await drive(id, { id, request: `Hotfix for ${incident.ticket}: ${incident.symptom}. Fix the cause with the smallest safe change; a rollback is proposed separately to the CEO.`, incident: incident.id, ...wt });
      });
      return id;
    },
  });
  for (const i of incidents.filter((i) => i.status !== "closed")) console.log(`${i.id} ${i.status} ${i.ticket} hotfix=${i.hotfix || "-"} rollback=${i.rollback}: ${i.symptom}${i.rollback === "proposed" ? `  -> orch rollback ${i.id}` : ""}`);
} else if (cmd === "resolve") {
  const incidentId = positionals[0] ?? die("usage: orch resolve <incident-id>");
  resolveIncident(home, incidentId);
  console.log(`${incidentId} closed`);
} else if (cmd === "chaos") {
  const id = positionals[0];
  const scenario = positionals[1];
  if (!id || (!scenario && !values.clear)) die(`usage: orch chaos <ticket-id> <scenario> | orch chaos <ticket-id> --clear
scenarios: ${Object.keys(SCENARIOS).join(", ")}`);
  await locked(id, async () => {
    if (values.clear) clearFailure(home, id);
    else injectFailure(home, id, scenario);
    console.log(values.clear ? `${id}: failure cleared` : `${id}: injected ${scenario}`);
  });
} else if (cmd === "rollback") {
  const incidentId = positionals[0] ?? die("usage: orch rollback <incident-id>");
  const incident = listIncidents(home).find((i) => i.id === incidentId) ?? die(`no incident ${incidentId}`);
  await locked(incident.ticket, async () => console.log(approveRollback(home, incidentId, { configReviewed: values["config-reviewed"] })));
} else die("usage: orch init | run | status | continue | approve | reject | clean | watch | chaos | rollback | resolve");
