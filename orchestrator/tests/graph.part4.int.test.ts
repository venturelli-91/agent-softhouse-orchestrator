// Flow guardrails against fake nodes (part 4 of 4): no model, no credentials.
import { workRoot } from "../src/daily-cap.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MemorySaver } from "@langchain/langgraph";
import { git } from "../scripts/fixture.ts";
import { readDeploy } from "../src/deploy.ts";
import { config, report, deployTicket, Ticket } from "../src/graph.ts";
import { NodeFailure } from "../src/run-agent.ts";
import { BRIEF, FLAGS, commit, start, paused, answer, approved, CMD_CFG, writeExternal, commandTicket, DOC_FILE, knobs, FAST_TEST } from "./helpers/graph-harness.ts";

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

test("docs run first, in the middle and last, land in .claude/docs of the main checkout and never dirty it", async () => {
  knobs.override = { docs: () => DOC_FILE };
  const g = await start();
  assert.equal(paused(g.r)?.type, "approval");
  assert.equal(readFileSync(join(g.repo, ".claude", "docs", "arquitetura", "visao.md"), "utf8"), "# Visao\n");
  assert.equal(git(g.repo, "status", "--porcelain"), "");
  assert.equal(knobs.docsCalls.length, 3);
  assert.match(knobs.docsContexts[0], /Mode: scan/);
  assert.match(knobs.docsContexts[1], /Phase: mid/);
  assert.match(knobs.docsContexts[1], /Revisions: 0/);
  assert.match(knobs.docsContexts[2], /Phase: end/);
  assert.match(knobs.docsContexts[2], /commit:[0-9a-f]+/);
  assert.match(knobs.docsContexts[2], new RegExp(`tests:${FAST_TEST.replaceAll(".", "\\.")} ok`));
  assert.ok((g.r.history as { node: string }[]).filter((h) => h.node === "docs").length === 3);
});

test("a ticket that escalates still gets its progress recorded by docs_mid, and docs_end does not run", async () => {
  knobs.override = { docs: () => DOC_FILE };
  knobs.override.dev = (req) => (commit(req.cwd, "agent-dev"), commit(req.cwd, "agent-dev", "big.txt", "x".repeat(70_000)), { summary: "ok", brief: BRIEF });
  const g = await start();
  assert.equal(paused(g.r)?.type, "escalation");
  assert.equal(knobs.docsCalls.length, 2);
  assert.match(knobs.docsContexts[1], /Phase: mid/);
  assert.match(knobs.docsContexts[1], /diff too large/);
});

test("docs_mid receives the full text of a reviewer rejection, not only the short history", async () => {
  let n = 0;
  knobs.override = {
    docs: () => DOC_FILE,
    reviewer: () => (++n === 1 ? { verdict: "rejected", comments: "REJECT-WHY: login skips the csrf check", summary: "x" } : { verdict: "approved", comments: "", summary: "ok" }),
  };
  const g = await start();
  assert.equal(paused(g.r)?.type, "approval");
  assert.match(knobs.docsContexts[1], /Phase: mid[\s\S]*Rejections[\s\S]*reviewer: REJECT-WHY: login skips the csrf check/);
});

test("a failing or invalid docs agent only adds warnings; the ticket still reaches approval", async () => {
  for (const docs of [() => { throw new NodeFailure("boom"); }, () => ({ files: "nope" })]) {
    knobs.override = { docs };
    const g = await start();
    assert.equal(paused(g.r)?.type, "approval");
    const w = g.r.docs_warnings as string[];
    assert.ok(["start: ", "mid: ", "end: "].every((p) => w.some((x) => x.startsWith(p))), w.join("|"));
    assert.match(report(Ticket.parse(g.r)), /docs/);
  }
});

test("docs are not written when git would not ignore .claude", async () => {
  knobs.afterFixture = (repo) => {
    writeFileSync(join(repo, ".gitignore"), "!.claude/\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "unignore");
  };
  knobs.override = { docs: () => DOC_FILE };
  const g = await start();
  assert.equal(paused(g.r)?.type, "approval");
  assert.equal(existsSync(join(g.repo, ".claude", "docs", "arquitetura", "visao.md")), false);
  assert.ok((g.r.docs_warnings as string[]).some((x) => /not ignored/.test(x)));
  assert.equal(knobs.docsCalls.length, 0);
});

test("docs usage does not count against the ticket token budget", async () => {
  knobs.tokensPerCall = 20;
  process.env.TOKEN_BUDGET_TICKET = "110";
  const g = await start();
  assert.equal(paused(g.r)?.type, "approval");
  assert.equal(g.r.status, "approval");
});
