// Flow guardrails against fake nodes (part 4 of 4): no model, no credentials.
import { workRoot } from "../src/daily-cap.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MemorySaver } from "@langchain/langgraph";
import { git } from "../scripts/fixture.ts";
import { createServer } from "node:http";
import { readCounters, readDeploy, recordCounters } from "../src/deploy.ts";
import { listIncidents, MAX_OPEN_INCIDENTS, openIncident } from "../src/incidents.ts";
import { deployTicket, Ticket } from "../src/graph.ts";
import { BRIEF, FLAGS, commit, start, paused, answer, approved, CMD_CFG, writeExternal, commandTicket, knobs } from "./helpers/graph-harness.ts";

test("after approval the deploy node runs the ticket's target and ends in simulated_deploy", async () => {
  const g = await start();
  assert.throws(() => readDeploy(process.env.ORCH_HOME!, "T-1"));
  const end = await answer(g, "approve");
  assert.equal(end.status, "simulated_deploy");
  const d = readDeploy(process.env.ORCH_HOME!, "T-1");
  assert.equal(d.sandbox, true);
  assert.equal(d.target, "simulated");
  assert.equal(d.sha, end.approved_sha);
  assert.equal(d.previous, end.base);
  assert.ok(end.evidence.some((e: string) => e.startsWith("deploy:simulated:")));
  assert.ok(!knobs.calls.includes("devops"));
});

test("a command deploy runs only after approval and ends in deployed with cmd settings in the record", async () => {
  const g = await start("T-1", new MemorySaver(), { deploy_target: "command", deploy_cfg: CMD_CFG });
  assert.throws(() => readDeploy(process.env.ORCH_HOME!, "T-1"));
  const end = await answer(g, "approve");
  assert.equal(end.status, "deployed");
  const d = readDeploy(process.env.ORCH_HOME!, "T-1");
  assert.equal(d.target, "command");
  assert.equal(d.sandbox, false);
  assert.deepEqual(d.cmd, { rollback: "node --version", health_url: CMD_CFG.health_url, env: [], timeout_s: 30, max_latency_ms: 2000,
    environment: "staging", git_config_hash: end.git_config_hash });
  assert.ok(end.evidence.some((e: string) => e.startsWith("deploy:")));
});

test("a failing deploy command escalates and writes no record", async () => {
  const g = await start("T-1", new MemorySaver(), { deploy_target: "command", deploy_cfg: { ...CMD_CFG, command: "node --nonexistent-flag" } });
  const end = await answer(g, "approve");
  assert.notEqual(end.status, "deployed");
  assert.equal(end.status, "escalated");
  assert.match(end.summary, /deploy command failed/);
  assert.ok(!end.summary.includes("nonexistent-flag"), "command output must not reach the escalation text");
  assert.match(readFileSync(join(process.env.ORCH_HOME!, "deploy-logs", "T-1.txt"), "utf8"), /nonexistent-flag/);
  assert.throws(() => readDeploy(process.env.ORCH_HOME!, "T-1"));
  assert.ok(!end.history.some((h: { node: string }) => h.node === "verify_deploy"));
});

test("the deploy command is not run when the approved commit cannot be checked out", async () => {
  const { t } = await commandTicket();
  await assert.rejects(() => deployTicket(Ticket.parse({ ...t, approved_sha: "0".repeat(40) })), /approved commit/);
  assert.throws(() => readDeploy(process.env.ORCH_HOME!, "T-1"));
});

test("the approval request shows the deploy environment", async () => {
  const g = await start("T-1", new MemorySaver(), { deploy_target: "command", deploy_cfg: { ...CMD_CFG, environment: "production" } });
  assert.deepEqual(paused(g.r)?.deploy, { target: "command", environment: "production", command: "node --version", rollback: "node --version",
    env: [], health_url: CMD_CFG.health_url });
});

test("the command runs in a checkout of the approved commit and the checkout is gone afterwards", async () => {
  const { t, sha } = await commandTicket({ command: "git rev-parse HEAD" });
  const out = await deployTicket(t);
  assert.ok((out.evidence as string[]).some((e) => e === `deploy:${sha}`), String(out.evidence));
  assert.deepEqual(readdirSync(join(workRoot(), "deploy-work")), []);
});

test("a git hook in the repo does not run during the deploy checkout", async () => {
  const { t, repo, root } = await commandTicket();
  const marker = join(root, "hook-ran");
  mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
  writeFileSync(join(repo, ".git", "hooks", "post-checkout"), `#!/bin/sh\necho x > "${marker.split("\\").join("/")}"\n`);
  await deployTicket(t);
  assert.equal(existsSync(marker), false);
});

test("a changed .git/config blocks the deploy", async () => {
  const { t, repo } = await commandTicket();
  git(repo, "config", "--local", "foo.bar", "x");
  await assert.rejects(() => deployTicket(t), /\.git\/config changed/);
  assert.throws(() => readDeploy(process.env.ORCH_HOME!, "T-1"));
});

test("deploy settings that changed after the ticket started are refused", async () => {
  const { t, repo } = await commandTicket();
  writeExternal(repo, { ...CMD_CFG, command: "node --help" });
  await assert.rejects(() => deployTicket(t), /settings changed/);
  assert.throws(() => readDeploy(process.env.ORCH_HOME!, "T-1"));
});

test("the dev is told its turn limit, and about partial work left by a previous attempt", async () => {
  const { devRules, partialWork } = await import("../src/graph.ts");
  assert.match(devRules("npm test", 40), /at most 40 turns/);
  assert.doesNotMatch(devRules("npm test"), /turns/);
  assert.deepEqual(partialWork("  \n"), []);
  assert.match(partialWork("?? src/server/a.ts\n")[0], /uncommitted work from a previous attempt[\s\S]*src\/server\/a\.ts/);
});

test("the brief (why, how, where it applies) is mandatory for the dev output and renders as PR sections", async () => {
  const { Brief, briefMarkdown, devRules } = await import("../src/graph.ts");
  assert.equal(Brief.safeParse({ why: "short", how: "x", where: "y" }).success, false);
  const b = { why: "Monitoring needs a liveness probe", how: "Added checkHealth with injectable db check", where: "src/lib/health.ts and /api/health only" };
  assert.equal(Brief.safeParse(b).success, true);
  const md = briefMarkdown(b);
  assert.match(md, /## Why\nMonitoring[\s\S]*## How\nAdded[\s\S]*## Where it applies\nsrc\/lib/);
  assert.match(devRules(), /`brief`/);
  assert.equal(Brief.safeParse({ ...b, why: "x".repeat(601) }).success, false);
  const hostile = briefMarkdown({ ...b, how: "# Fake heading\n![p](http://evil/x.png) cc @someone\n## Another" });
  assert.equal(hostile.match(/^## /gm)?.length, 3);
  assert.doesNotMatch(hostile, /(^|[^\\])!\[|@someone/);
  const tricky = briefMarkdown({ ...b, why: "!![a](http://evil/x.png) <img src=http://evil/y.png> `x`" });
  assert.doesNotMatch(tricky, /<img|(^|[^\\])!\[|(^|[^\\])\[a\]/);
  const breaks = briefMarkdown({ ...b, where: "ok\r---\r===\u2028# H\u0085## H2\v\f### H3" });
  assert.equal(breaks.match(/^## /gm)?.length, 3);
  assert.doesNotMatch(breaks, /[\r\v\f\u0085]/);
  assert.ok(!breaks.includes(String.fromCharCode(0x2028)));
});

test("a request that needs several commits is split into atomic tasks run one at a time, then reviewed as a whole", async () => {
  knobs.override.triage = () => ({ title: "t", priority: "P2", specialty: "fullstack", clear: true, flags: FLAGS, criteria: ["c"], summary: "ok",
    split: ["engine and store", "API routes", "ops UI"] });
  const ctxs: string[] = [];
  let n = 0;
  knobs.override.dev = (req) => (ctxs.push(req.context), commit(req.cwd, "agent-dev"), n++, { summary: "ok", brief: BRIEF });
  const g = await start();
  assert.equal(paused(g.r)?.type, "approval");
  assert.equal(knobs.calls.filter((c) => c === "dev").length, 3);
  assert.equal(knobs.calls.filter((c) => c === "reviewer").length, 1);
  assert.match(ctxs[0], /Task 1 of 3[\s\S]*engine and store[\s\S]*Later tasks[\s\S]*2\. API routes/);
  assert.match(ctxs[1], /Task 2 of 3[\s\S]*Already committed[\s\S]*1\. engine and store/);
  assert.match(ctxs[2], /Task 3 of 3[\s\S]*ops UI[\s\S]*last task[\s\S]*whole ticket/);
});

test("a task that ends without a new commit is a failed revision, not progress", async () => {
  knobs.override.triage = () => ({ title: "t", priority: "P2", specialty: "fullstack", clear: true, flags: FLAGS, criteria: ["c"], summary: "ok",
    split: ["one", "two"] });
  let n = 0;
  knobs.override.dev = (req) => (++n === 1 ? commit(req.cwd, "agent-dev") : undefined, { summary: "ok", brief: BRIEF });
  const g = await start();
  assert.notEqual(paused(g.r)?.type, "approval");
  assert.equal(knobs.calls.filter((c) => c === "reviewer").length, 0);
});

test("a diff over the review limit escalates instead of being cut, and no reviewer runs", async () => {
  knobs.override.dev = (req) => (commit(req.cwd, "agent-dev"), commit(req.cwd, "agent-dev", "big.txt", "x".repeat(70_000)), { summary: "ok", brief: BRIEF });
  const g = await start();
  assert.equal(paused(g.r)?.type, "escalation");
  assert.match(String(paused(g.r)?.reason), /diff too large to review in full/);
  assert.ok(!knobs.calls.includes("qa"));
});

test("the token budget grows only with verified tasks, up to a fixed ceiling", async () => {
  const { budgetExceeded } = await import("../src/guardrails.ts");
  const u = { tokens_in: 150, tokens_out: 0, cache_read: 0, cache_create: 0, cost_usd: 0, turns: 1, ms: 1 };
  const env = { TOKEN_BUDGET_TICKET: "100" };
  assert.match(String(budgetExceeded([u], env)), /budget exceeded/);
  assert.equal(budgetExceeded([u], env, 1), null);
  assert.match(String(budgetExceeded([u, u, u], env, 1)), /budget exceeded \(450 > 200\)/);
  assert.match(String(budgetExceeded([u], env, -3)), /budget exceeded \(150 > 100\)/);
  assert.match(String(budgetExceeded(Array(100).fill(u), env, 999)), /> 800\)/);
});

test("checks, metrics_url and max_error_rate are snapshotted into the record and shown in the approval", async () => {
  const extra = { checks: [{ method: "GET" as const, path: "/login", expect_status: 200 }], metrics_url: "http://127.0.0.1:1/metrics", max_error_rate: 0.05 };
  const g = await start("T-1", new MemorySaver(), { deploy_target: "command", deploy_cfg: { ...CMD_CFG, ...extra } });
  assert.deepEqual(paused(g.r)?.deploy, { target: "command", environment: "staging", command: "node --version", rollback: "node --version",
    env: [], health_url: CMD_CFG.health_url, ...extra });
  const end = await answer(g, "approve");
  assert.deepEqual(readDeploy(process.env.ORCH_HOME!, "T-1").cmd, { rollback: "node --version", health_url: CMD_CFG.health_url, env: [], timeout_s: 30,
    max_latency_ms: 2000, environment: "staging", git_config_hash: end.git_config_hash, ...extra });
});

test("a simulated deploy is not verified and says so", async () => {
  const end = await answer(await start(), "approve");
  assert.equal(end.status, "simulated_deploy");
  assert.equal(end.summary, "deploy not verified: no health check configured");
  assert.equal(end.history.at(-1)?.node, "verify_deploy");
});

test("a healthy command deploy is verified and opens no incident", async () => {
  const server = createServer((_, res) => res.end("ok"));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const cfg = { ...CMD_CFG, health_url: `http://127.0.0.1:${(server.address() as { port: number }).port}/health` };
    const end = await answer(await start("T-1", new MemorySaver(), { deploy_target: "command", deploy_cfg: cfg }), "approve");
    assert.equal(end.status, "deployed");
    assert.equal(end.summary, "deploy verified: healthy for 0 min");
    assert.deepEqual(listIncidents(process.env.ORCH_HOME!), []);
  } finally {
    server.close();
  }
});

test("a degraded command deploy opens an incident with the rollback proposed", async () => {
  const end = await answer(await start("T-1", new MemorySaver(), { deploy_target: "command", deploy_cfg: CMD_CFG }), "approve");
  const [inc] = listIncidents(process.env.ORCH_HOME!);
  assert.equal(end.status, "deployed");
  assert.equal(inc.rollback, "proposed");
  assert.match(end.summary, new RegExp(`^deploy degraded: unreachable: .*; incident ${inc.id} opened, rollback proposed -> orch rollback ${inc.id}$`));
});

test("a degraded deploy with the open incident limit reached escalates from verify_deploy", async () => {
  for (let i = 0; i < MAX_OPEN_INCIDENTS; i++) openIncident(process.env.ORCH_HOME!, `OTHER-${i}`, "http 500");
  const end = await answer(await start("T-1", new MemorySaver(), { deploy_target: "command", deploy_cfg: CMD_CFG }), "approve");
  assert.equal(end.status, "escalated");
  assert.equal(end.failed_node, "verify_deploy");
  assert.match(end.summary, /^verify_deploy: deploy degraded \(unreachable: .*\) but the open incident limit is reached$/);
});

// A healthy server whose health_url verifies quickly (verify_minutes 0 in the pair targets below).
const healthyServer = async () => {
  const server = createServer((_, res) => res.end("ok"));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/health` };
};
// A staging/production pair: targets never name their own environment (CMD_CFG's is dropped), commands stay SAFE_COMMAND-safe.
const CMD_NO_ENV = (() => { const { environment: _e, ...rest } = CMD_CFG; return rest; })();
const pair = (stagingUrl: string, productionUrl: string, prodOver: Record<string, unknown> = {}) => ({
  staging: { ...CMD_NO_ENV, health_url: stagingUrl },
  production: { ...CMD_NO_ENV, health_url: productionUrl, ...prodOver },
});
type DeployView = { environment: string; production?: { environment: string } };

test("with a staging and production pair a healthy staging asks the CEO to promote, and approve deploys production", async () => {
  const { server, url } = await healthyServer();
  try {
    const g = await start("T-1", new MemorySaver(), { deploy_target: "command", deploy_cfg: pair(url, url) });
    const first = paused(g.r)?.deploy as DeployView | undefined;
    assert.equal(first?.environment, "staging");
    assert.equal(first?.production?.environment, "production");
    const ask = await answer(g, "approve");
    assert.equal(paused(ask)?.type, "promote");
    assert.equal((paused(ask)?.deploy as { environment: string } | undefined)?.environment, "production");
    assert.equal(readDeploy(process.env.ORCH_HOME!, "T-1").cmd?.environment, "staging");
    const end = await answer(g, "approve");
    assert.equal(end.status, "deployed");
    assert.equal(end.promoted, true);
    assert.equal(readDeploy(process.env.ORCH_HOME!, "T-1").cmd?.environment, "production");
    assert.equal(end.history.filter((h) => h.node === "deploy").length, 2);
    assert.equal(end.history.at(-1)?.node, "verify_deploy");
  } finally {
    server.close();
  }
});

test("a degraded staging never reaches production", async () => {
  const { server, url } = await healthyServer();
  try {
    const g = await start("T-1", new MemorySaver(), { deploy_target: "command", deploy_cfg: pair("http://127.0.0.1:1/health", url) });
    const end = await answer(g, "approve");
    assert.equal(paused(end), undefined);
    assert.equal(end.promoted, false);
    assert.equal(readDeploy(process.env.ORCH_HOME!, "T-1").cmd?.environment, "staging");
    assert.equal(end.history.filter((h) => h.node === "deploy").length, 1);
    assert.equal(listIncidents(process.env.ORCH_HOME!)[0].rollback, "proposed");
  } finally {
    server.close();
  }
});

test("rejecting the promotion ends the ticket on staging as not_promoted", async () => {
  const { server, url } = await healthyServer();
  try {
    const g = await start("T-1", new MemorySaver(), { deploy_target: "command", deploy_cfg: pair(url, url) });
    await answer(g, "approve"); // merge approval -> promote pause
    const end = await answer(g, "abort: not today");
    assert.equal(end.status, "not_promoted");
    assert.equal(end.summary, "not promoted: not today");
    assert.equal(readDeploy(process.env.ORCH_HOME!, "T-1").cmd?.environment, "staging");
  } finally {
    server.close();
  }
});

test("the production deploy drops staging's metric counters", async () => {
  const { server, url } = await healthyServer();
  try {
    const g = await start("T-1", new MemorySaver(), { deploy_target: "command", deploy_cfg: pair(url, url) });
    await answer(g, "approve"); // merge approval -> promote pause
    recordCounters(process.env.ORCH_HOME!, "T-1", { ts: "x", requests: 10, errors_5xx: 0 });
    const end = await answer(g, "approve"); // promote -> production deploy
    assert.equal(end.status, "deployed");
    assert.equal(readCounters(process.env.ORCH_HOME!, "T-1"), null);
  } finally {
    server.close();
  }
});

test("a failed production deploy is retried as production", async () => {
  const { server, url } = await healthyServer();
  try {
    const g = await start("T-1", new MemorySaver(), { deploy_target: "command", deploy_cfg: pair(url, url, { command: "node --nonexistent-flag" }) });
    await answer(g, "approve"); // merge approval -> promote pause
    const failed = await answer(g, "approve"); // promote -> production deploy fails
    assert.equal(failed.status, "escalated");
    assert.equal(failed.failed_node, "deploy");
    const again = await answer(g, "retry"); // must not throw in sameCommit (ticket worktree removed by the staging deploy)
    assert.equal(again.status, "escalated");
    assert.equal(again.failed_node, "deploy");
    assert.equal(again.promoted, true);
    assert.equal(again.history.filter((h) => h.node === "deploy").length, 3);
    assert.equal(readDeploy(process.env.ORCH_HOME!, "T-1").cmd?.environment, "staging");
  } finally {
    server.close();
  }
});

test("a config change before the promotion is refused at the production deploy", async () => {
  const { server, url } = await healthyServer();
  try {
    const g = await start("T-1", new MemorySaver(), { deploy_target: "command", deploy_cfg: pair(url, url) });
    await answer(g, "approve"); // merge approval -> promote pause
    writeExternal(g.repo, pair(url, url, { command: "node --help" })); // changed production command
    const end = await answer(g, "approve"); // promote -> production deploy refuses the drift
    assert.equal(end.status, "escalated");
    assert.match(end.summary, /deploy settings changed since the ticket started/);
  } finally {
    server.close();
  }
});

test("a flat config healthy deploy never asks to promote", async () => {
  const { server, url } = await healthyServer();
  try {
    const end = await answer(await start("T-1", new MemorySaver(), { deploy_target: "command", deploy_cfg: { ...CMD_CFG, health_url: url } }), "approve");
    assert.equal(end.status, "deployed");
    assert.equal(end.promoted, false);
    assert.equal(paused(end), undefined);
  } finally {
    server.close();
  }
});
