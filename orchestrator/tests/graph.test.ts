// Flow guardrails against fake nodes: no model, no credentials.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySaver } from "@langchain/langgraph";
import { createFixture, git } from "../scripts/fixture.ts";
import { config, createWorktree, buildGraph, resume } from "../src/graph.ts";
import { registerPublisher } from "../src/publish.ts";
import { NodeFailure, registerExecutor, type Req } from "../src/run-agent.ts";
import { watchdog } from "../src/watchdog.ts";

type Behavior = Partial<Record<string, (req: Req<unknown>) => unknown>>;
let override: Behavior = {};
let calls: string[] = [];
let tokensPerCall = 10;
const roots: string[] = [];

const FLAGS = { touches_security: false, touches_performance: false, touches_ai: false, touches_schema: false, touches_public_api: false, touches_permissions: false, touches_external_integration: false, touches_cost: false };
const commit = (cwd: string, author: string, file = "checkout.html", content = "<button>Submit order</button>\n") => {
  writeFileSync(join(cwd, file), content);
  git(cwd, "add", "-A");
  git(cwd, "-c", `user.name=${author}`, "commit", "-q", "--allow-empty", "-m", "dev");
};
const defaults: Behavior = {
  triage: () => ({ title: "t", priority: "P2", specialty: "frontend", clear: true, flags: FLAGS, criteria: ["button says Submit order"], summary: "ok" }),
  planner: () => ({ ...(defaults.triage!({} as Req<unknown>) as object), question: "" }),
  dev: (req) => (commit(req.cwd, "agent-dev"), { summary: "ok" }),
  reviewer: () => ({ verdict: "approved", comments: "", summary: "ok" }),
  qa: () => ({ verdict: "approved", comments: "", summary: "ok" }),
  devops: () => ({ summary: "simulated deploy" }),
  watchdog: () => ({ alerts: ["T-1 stalled"], summary: "ok" }),
};
let publications: string[] = [];
registerPublisher("fake", { publish: (p) => (publications.push(`${p.id}@${p.sha}`), "pr:https://example/pull/1") });

registerExecutor("fake", {
  async run<T>(req: Req<T>) {
    calls.push(req.role);
    const raw = (override[req.role] ?? defaults[req.role]!)(req as Req<unknown>);
    const output = req.schema.safeParse(raw);
    if (!output.success) throw new NodeFailure(`${req.role}: invalid output`);
    return { output: output.data, usage: { tokens_in: tokensPerCall, tokens_out: 0, cache_read: 0, cache_create: 0, cost_usd: 0, turns: 1, ms: 1 } };
  },
});

beforeEach(() => {
  process.env.EXECUTOR = "fake";
  process.env.PUBLISHER = "fake";
  publications = [];
  process.env.TOKEN_BUDGET_TICKET = "100000";
  override = {};
  calls = [];
  tokensPerCall = 10;
});
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));

async function start(id = "T-1") {
  const root = mkdtempSync(join(tmpdir(), "gt-"));
  roots.push(root);
  const repo = createFixture(root);
  const graph = buildGraph(new MemorySaver());
  const cfg = config(id);
  const r = await graph.invoke({ id, request: "p", ...createWorktree(repo, id, join(root, "wt")) }, cfg);
  return { graph, cfg, r, repo, root };
}
const paused = (r: unknown) => (r as { __interrupt__?: { value: Record<string, unknown> }[] }).__interrupt__?.[0]?.value;
const answer = (g: Awaited<ReturnType<typeof start>>, reply: string) => g.graph.invoke(resume(reply) as never, g.cfg);

test("deploy only happens after CEO approval; rejection goes back to the dev", async () => {
  const g = await start();
  assert.equal(paused(g.r)?.type, "approval");
  assert.notEqual(g.r.status, "simulated_deploy");
  const rej = await answer(g, "did not like it");
  assert.equal(paused(rej)?.type, "approval");
  assert.equal(rej.revisions, 1);
  assert.notEqual(rej.status, "simulated_deploy");
  assert.equal((await answer(g, "approve")).status, "simulated_deploy");
});

test("a summary over 10 lines is truncated, not a node failure", async () => {
  const long = Array.from({ length: 15 }, (_, i) => `line ${i}`).join("\n");
  override.qa = () => ({ verdict: "approved", comments: "", summary: long });
  const g = await start();
  assert.equal(paused(g.r)?.type, "approval");
  assert.equal(String(paused(g.r)?.summary).split("\n").length, 10);
});

test("an approval flag reaches the CEO as an active flag", async () => {
  override.triage = () => ({ ...(defaults.triage!({} as Req<unknown>) as object), flags: { ...FLAGS, touches_schema: true } });
  const g = await start();
  assert.deepEqual(paused(g.r)?.active_flags, ["touches_schema"]);
});

test("self-approval blocked: reviewer equal to the author does not even run", async () => {
  override.dev = (req) => (commit(req.cwd, "agent-reviewer"), { summary: "ok" });
  const g = await start();
  assert.equal(paused(g.r)?.type, "escalation");
  assert.match(String(paused(g.r)?.reason), /its own delivery/);
  assert.ok(!calls.includes("reviewer"));
  assert.equal((await answer(g, "abort")).status, "aborted");
});

test("the cap of 3 revisions escalates to the CEO", async () => {
  override.reviewer = () => ({ verdict: "rejected", comments: "redo it", summary: "x" });
  const g = await start();
  assert.equal(calls.filter((c) => c === "dev").length, 3);
  assert.equal(paused(g.r)?.type, "escalation");
  assert.match(String(paused(g.r)?.reason), /cap of 3/);
});

test("invalid node output is a failure: it escalates and does not advance", async () => {
  override.triage = () => ({ junk: 1 });
  const g = await start();
  assert.equal(paused(g.r)?.type, "escalation");
  assert.ok(!calls.includes("dev"));
});

const ambiguous = () => ({ ...(defaults.triage!({} as Req<unknown>) as object), clear: false, criteria: [] });

test("an ambiguous request goes through the planner and proceeds to the dev once it closes the criteria", async () => {
  override.triage = ambiguous;
  const g = await start();
  assert.deepEqual(calls.slice(0, 2), ["triage", "planner"]);
  assert.equal(paused(g.r)?.type, "approval");
});

test("a planner without criteria escalates with the question; the CEO's answer returns to the planner", async () => {
  override.triage = ambiguous;
  let rounds = 0;
  let seenRequest = "";
  override.planner = (req) => {
    seenRequest = req.context;
    return ++rounds === 1
      ? { ...(ambiguous() as object), question: "which button?", criteria: [] }
      : { ...(defaults.planner!(req) as object) };
  };
  const g = await start();
  assert.equal(paused(g.r)?.type, "escalation");
  assert.match(String(paused(g.r)?.reason), /which button\?/);
  assert.ok(!calls.includes("dev"));
  const r2 = await answer(g, "the checkout one");
  assert.match(seenRequest, /CEO clarification: the checkout one/);
  assert.equal(paused(r2)?.type, "approval");
});

test("the CEO aborts when the planner asks for clarification", async () => {
  override.triage = ambiguous;
  override.planner = () => ({ ...(ambiguous() as object), question: "?", criteria: [] });
  const g = await start();
  assert.equal((await answer(g, "abort")).status, "aborted");
  assert.ok(!calls.includes("dev"));
});

test("an exceeded token budget interrupts the ticket", async () => {
  process.env.TOKEN_BUDGET_TICKET = "50";
  tokensPerCall = 40;
  const g = await start();
  assert.equal(paused(g.r)?.type, "escalation");
  assert.match(String(paused(g.r)?.reason), /budget/);
  assert.ok(!calls.includes("reviewer"));
});

test("evidence declared by the dev without a real passing test is rejected", async () => {
  override.dev = (req) => (commit(req.cwd, "agent-dev", "other.txt", "x"), { summary: "done, tests pass" });
  const g = await start();
  assert.ok(!calls.includes("reviewer"));
  assert.equal(paused(g.r)?.type, "escalation");
  assert.match(String(paused(g.r)?.reason), /npm test failed/);
});

test("limit of 5 active tickets", async () => {
  const root = mkdtempSync(join(tmpdir(), "gt-"));
  roots.push(root);
  const repo = createFixture(root);
  for (let i = 1; i <= 5; i++) createWorktree(repo, `T-${i}`, join(root, `wt${i}`));
  assert.throws(() => createWorktree(repo, "T-6", join(root, "wt6")), /limit of 5/);
});

test("push and PR come from the graph's code, after QA and before the CEO; devops only after the CEO", async () => {
  const g = await start();
  assert.equal(publications.length, 1);
  assert.match(publications[0], /^T-1@[0-9a-f]{40}$/);
  assert.ok((paused(g.r)?.evidence as string[]).includes("pr:https://example/pull/1"));
  assert.ok(!calls.includes("devops"));
  const end = await answer(g, "approve");
  assert.equal(end.status, "simulated_deploy");
  assert.equal(calls.at(-1), "devops");
});

test("CEO rejection does not trigger devops", async () => {
  const g = await start();
  await answer(g, "did not like it");
  assert.ok(!calls.includes("devops"));
});

test("a missing PUBLISHER escalates to the CEO and nothing is published", async () => {
  delete process.env.PUBLISHER;
  const g = await start();
  assert.equal(paused(g.r)?.type, "escalation");
  assert.match(String(paused(g.r)?.reason), /PUBLISHER/);
  assert.equal(publications.length, 0);
});

test("a failing publisher escalates to the CEO", async () => {
  process.env.PUBLISHER = "broken";
  registerPublisher("broken", { publish: () => { throw new Error("push refused"); } });
  const g = await start();
  assert.equal(paused(g.r)?.type, "escalation");
  assert.match(String(paused(g.r)?.reason), /push refused/);
});

test("the watchdog reads the state and returns alerts without writing", async () => {
  const g = await start();
  const r = await watchdog([g.r], g.root);
  assert.deepEqual(r.alerts, ["T-1 stalled"]);
  assert.equal(calls.at(-1), "watchdog");
});
