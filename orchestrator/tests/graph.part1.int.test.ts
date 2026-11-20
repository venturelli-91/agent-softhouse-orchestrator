// Flow guardrails against fake nodes (part 1 of 4): no model, no credentials.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixture } from "../scripts/fixture.ts";
import { FileSaver } from "../src/file-saver.ts";
import { createWorktree, buildGraph, resume } from "../src/graph.ts";
import { registerPublisher } from "../src/publish.ts";
import { MemorySaver } from "@langchain/langgraph";
import { NodeFailure, type Req } from "../src/run-agent.ts";
import { readBacklog } from "../src/backlog.ts";
import { alerts } from "../src/watchdog.ts";
import { roots, BRIEF, FLAGS, commit, defaults, start, paused, answer, ambiguous, approved, knobs } from "./helpers/graph-harness.ts";

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

test("a pending approval survives the process and can be answered by a new graph", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "gt-")), "state.json");
  roots.push(join(file, ".."));
  const g = await start("T-1", new FileSaver(file));
  assert.equal(paused(g.r)?.type, "approval");
  const later = buildGraph(new FileSaver(file));
  assert.equal(((await later.getState(g.cfg)).tasks[0]?.interrupts[0]?.value as { type: string }).type, "approval");
  assert.equal((await later.invoke(resume("approve") as never, g.cfg)).status, "simulated_deploy");
});

test("a summary over 10 lines is truncated, not a node failure", async () => {
  const long = Array.from({ length: 15 }, (_, i) => `line ${i}`).join("\n");
  knobs.override.qa = () => ({ verdict: "approved", comments: "", summary: long });
  const g = await start();
  assert.equal(paused(g.r)?.type, "approval");
  assert.equal(String(paused(g.r)?.summary).split("\n").length, 10);
});

test("an approval flag reaches the CEO as an active flag", async () => {
  knobs.override.triage = () => ({ ...(defaults.triage!({} as Req<unknown>) as object), flags: { ...FLAGS, touches_schema: true } });
  const g = await start();
  assert.deepEqual(paused(g.r)?.active_flags, ["touches_schema"]);
});

test("self-approval blocked: reviewer equal to the author does not even run", async () => {
  knobs.override.dev = (req) => (commit(req.cwd, "agent-reviewer"), { summary: "ok", brief: BRIEF });
  const g = await start();
  assert.equal(paused(g.r)?.type, "escalation");
  assert.match(String(paused(g.r)?.reason), /its own delivery/);
  assert.ok(!knobs.calls.includes("reviewer"));
  assert.equal((await answer(g, "abort")).status, "aborted");
});

test("the cap of 2 attempts escalates to the CEO and a third never starts", async () => {
  knobs.override.reviewer = () => ({ verdict: "rejected", comments: "redo it", summary: "x" });
  const g = await start();
  assert.equal(knobs.calls.filter((c) => c === "dev").length, 2);
  assert.equal(paused(g.r)?.type, "escalation");
  const reason = String(paused(g.r)?.reason);
  assert.match(reason, /cap of 2/);
  assert.match(reason, /Changed files:\nM\tcheckout\.html/);
  assert.match(reason, /Diff stat:\n checkout\.html \| 2 \+-\n 1 file changed/);
});

test("invalid node output is a failure: it escalates and does not advance", async () => {
  knobs.override.triage = () => ({ junk: 1 });
  const g = await start();
  assert.equal(paused(g.r)?.type, "escalation");
  assert.ok(!knobs.calls.includes("dev"));
});

const q = (n: number) => ({ block: "scope", question: `which q${n}?`, why: "changes scope", default: `d${n}` });
const discoveryCalls = () => knobs.calls.filter((c) => c === "discovery").length;
const recordDiscovery = (reply: (n: number) => object) => {
  const contexts: string[] = [];
  knobs.override.discovery = (req) => (contexts.push(req.context), { problem: "the problem", briefing: {}, ...reply(contexts.length) });
  return contexts;
};

test("an unclear request goes through discovery and the planner, then the dev", async () => {
  knobs.override.triage = ambiguous;
  const g = await start();
  assert.deepEqual(knobs.calls.slice(0, 3), ["triage", "discovery", "planner"]);
  assert.equal(paused(g.r)?.type, "approval");
});

test("discovery questions pause for the CEO; the answers go back to discovery and the briefing reaches the planner", async () => {
  knobs.override.triage = ambiguous;
  const contexts = recordDiscovery((n) => (n === 1 ? { ready: false, questions: [q(1)] } : { ready: true, questions: [], briefing: { problem: "cart abandon" } }));
  let plannerCtx = "";
  knobs.override.planner = (req) => ((plannerCtx = req.context), defaults.planner!(req));
  const g = await start();
  const p = paused(g.r);
  assert.equal(p?.type, "discovery");
  assert.equal((p?.questions as { default: string }[])[0].default, "d1");
  assert.ok(!knobs.calls.includes("planner"));
  const r2 = await answer(g, "1: only mobile");
  assert.match(contexts[1], /CEO answers \(round 1\): 1: only mobile/);
  assert.match(plannerCtx, /## Problem\ncart abandon/);
  assert.equal(paused(r2)?.type, "approval");
  assert.equal(r2.request, "p");
});

test("free-text answer reaches discovery verbatim", async () => {
  knobs.override.triage = ambiguous;
  const contexts = recordDiscovery((n) => (n === 1 ? { ready: false, questions: [q(1)] } : { ready: true, questions: [] }));
  const g = await start();
  await answer(g, "mobile only, launch friday");
  assert.ok(contexts[1].includes("mobile only, launch friday"), contexts[1]);
});

test("bare approve accepts every default", async () => {
  knobs.override.triage = ambiguous;
  const contexts = recordDiscovery((n) => (n === 1 ? { ready: false, questions: [q(1)] } : { ready: true, questions: [] }));
  const g = await start();
  const r2 = await answer(g, "approve");
  assert.match(contexts[1], /accept every default/);
  assert.equal(paused(r2)?.type, "approval");
});

test("after two pauses the open questions take their defaults", async () => {
  knobs.override.triage = ambiguous;
  recordDiscovery(() => ({ ready: false, questions: [q(1)] }));
  let plannerCtx = "";
  knobs.override.planner = (req) => ((plannerCtx = req.context), defaults.planner!(req));
  const g = await start();
  assert.equal(paused(await answer(g, "a1"))?.type, "discovery");
  const r3 = await answer(g, "a2");
  assert.equal(paused(r3)?.type, "approval");
  assert.match(plannerCtx, /## Assumed defaults\n- which q1\? → d1/);
  assert.equal(discoveryCalls(), 3);
});

test("the planner's own briefing does not overwrite the discovery briefing", async () => {
  knobs.override.triage = ambiguous;
  recordDiscovery(() => ({ ready: false, questions: [q(1)] }));
  knobs.override.planner = (req) => ({ ...(defaults.planner!(req) as object), briefing: "PLANNER" });
  const g = await start();
  await answer(g, "a1");
  await answer(g, "a2");
  const { briefing } = (await g.graph.getState(g.cfg)).values;
  assert.match(briefing, /## Assumed defaults/);
  assert.notEqual(briefing, "PLANNER");
});

test("discovery with nothing to ask goes to the planner", async () => {
  knobs.override.triage = ambiguous;
  recordDiscovery(() => ({ ready: false, questions: [] }));
  const g = await start();
  assert.notEqual(paused(g.r)?.type, "discovery");
  assert.ok(knobs.calls.includes("planner"));
  const s = await g.graph.getState(g.cfg);
  assert.ok(s.values.history.some((h: { node: string; result: string }) => h.node === "discovery" && h.result === "nothing to ask"));
});

test("the CEO can abort at the discovery questions", async () => {
  knobs.override.triage = ambiguous;
  recordDiscovery(() => ({ ready: false, questions: [q(1)] }));
  const g = await start();
  assert.equal((await answer(g, "abort")).status, "aborted");
  assert.ok(!knobs.calls.includes("dev"));
});

test("a planner that still cannot close the criteria escalates and aborts", async () => {
  knobs.override.triage = ambiguous;
  knobs.override.planner = () => ({ ...(ambiguous() as object), criteria: [] });
  const g = await start();
  assert.equal(paused(g.r)?.type, "escalation");
  assert.equal((await answer(g, "whatever")).status, "aborted");
  assert.equal(knobs.calls.filter((c) => c === "planner").length, 1);
});

test("an unclear incident ticket skips discovery", async () => {
  knobs.override.triage = () => ({ ...(ambiguous() as object), summary: "TRIAGE-CANARY" });
  let plannerCtx = "";
  knobs.override.planner = (req) => ((plannerCtx = req.context), defaults.planner!(req));
  await start("T-1", new MemorySaver(), { incident: "inc-1" });
  assert.match(plannerCtx, /Triage: TRIAGE-CANARY/);
  assert.ok(!knobs.calls.includes("discovery"));
});

test("a failed discovery can be retried", async () => {
  knobs.override.triage = ambiguous;
  let n = 0;
  knobs.override.discovery = (req) => {
    if (n++ === 0) throw new NodeFailure("boom");
    return defaults.discovery!(req);
  };
  const g = await start();
  assert.equal(paused(g.r)?.type, "escalation");
  const r = await answer(g, "retry");
  assert.equal(discoveryCalls(), 2);
  assert.equal(paused(r)?.type, "approval");
});

test("an exceeded token budget interrupts the ticket", async () => {
  process.env.TOKEN_BUDGET_TICKET = "50";
  knobs.tokensPerCall = 40;
  const g = await start();
  assert.equal(paused(g.r)?.type, "escalation");
  assert.match(String(paused(g.r)?.reason), /budget/);
  assert.ok(!knobs.calls.includes("reviewer"));
});

test("evidence declared by the dev without a real passing test is rejected", async () => {
  knobs.realTest = true;
  knobs.override.dev = (req) => (commit(req.cwd, "agent-dev", "other.txt", "x"), { summary: "done, tests pass", brief: BRIEF });
  const g = await start();
  assert.ok(!knobs.calls.includes("reviewer"));
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

test("push and PR come from the graph's code, after QA and before the CEO; deploy only after the CEO", async () => {
  const g = await start();
  assert.equal(knobs.publications.length, 1);
  assert.match(knobs.publications[0], /^T-1@[0-9a-f]{40}$/);
  assert.ok((paused(g.r)?.evidence as string[]).includes("pr:https://example/pull/1"));
  assert.ok(!knobs.calls.includes("devops"));
  const end = await answer(g, "approve");
  assert.equal(end.status, "simulated_deploy");
  assert.ok(!knobs.calls.includes("devops"));
});

test("CEO rejection does not trigger the deploy", async () => {
  const g = await start();
  await answer(g, "did not like it");
  assert.ok(!knobs.calls.includes("devops"));
});

test("a missing PUBLISHER escalates to the CEO and nothing is published", async () => {
  delete process.env.PUBLISHER;
  const g = await start();
  assert.equal(paused(g.r)?.type, "escalation");
  assert.match(String(paused(g.r)?.reason), /PUBLISHER/);
  assert.equal(knobs.publications.length, 0);
});

test("a failing publisher escalates to the CEO", async () => {
  process.env.PUBLISHER = "broken";
  registerPublisher("broken", { publish: () => { throw new Error("push refused"); } });
  const g = await start();
  assert.equal(paused(g.r)?.type, "escalation");
  assert.match(String(paused(g.r)?.reason), /push refused/);
});

const withTest = (extra: string) => [
  'import { test } from "node:test";', 'import assert from "node:assert";', 'import { readFileSync } from "node:fs";',
  'test("checkout button", () => assert.match(readFileSync("checkout.html", "utf8"), />Submit order</));', extra, "",
].join("\n");

test("a ticket that skips a test fails verification and goes back to the dev", async () => {
  knobs.override.dev = (req) => (
    commit(req.cwd, "agent-dev", "test/checkout.test.js", withTest('test.skip("total", () => {});')),
    commit(req.cwd, "agent-dev"),
    { summary: "ok", brief: BRIEF }
  );
  const g = await start();
  const p = paused(g.r);
  assert.equal(p?.type, "escalation");
  assert.match(String(p?.last_node), /same verification failure twice.*skips tests.*test\/checkout\.test\.js: test\.skip/);
});

test("more skipped tests than the base is a warning in the evidence, the approval and the watchdog", async () => {
  knobs.override.dev = (req) => (
    commit(req.cwd, "agent-dev", "test/checkout.test.js", withTest('test("tax", { skip: process.env.NEVER === undefined }, () => {});')),
    commit(req.cwd, "agent-dev"),
    { summary: "ok", brief: BRIEF }
  );
  const g = await start("T-1", undefined, { test_base: { pass: 1, skip: 0, fail: 0 } });
  const p = paused(g.r);
  assert.equal(p?.type, "approval");
  assert.deepEqual(p?.test_alerts, ["1 tests skipped, the base had 0"]);
  assert.ok((p?.evidence as string[]).some((e) => /^tests:.* ok \(pass 1, skip 1, fail 0\)$/.test(e)));
  assert.ok(alerts([g.r as never]).includes("T-1 1 tests skipped, the base had 0"));
  assert.deepEqual((g.r as { test_last?: unknown }).test_last, { pass: 1, skip: 1, fail: 0 });
});

test("a run that collects no tests passes when the base had none and says so in the evidence and the alerts", async () => {
  knobs.override.dev = (req) => (
    commit(req.cwd, "agent-dev", "test/checkout.test.js", 'console.log("Ran 0 tests in 0.000s");'),
    commit(req.cwd, "agent-dev"),
    { summary: "ok", brief: BRIEF, criteria_tests: [{ criterion: "button says Submit order", test: "manual: the repo collects no tests" }] }
  );
  const g = await start("T-1", undefined, { test_base: { pass: 0, skip: 0, fail: 0 } });
  const p = paused(g.r);
  assert.equal(p?.type, "approval");
  assert.deepEqual(p?.test_alerts, ["no tests collected"]);
  assert.ok((p?.evidence as string[]).some((e) => /^tests:.* none collected$/.test(e)));
  assert.ok(alerts([g.r as never]).includes("T-1 no tests collected"));
});

test("caveats of an approving reviewer become backlog items with the ticket, once per revision loop", async () => {
  knobs.override.reviewer = (req) => ({ ...(defaults.reviewer!(req) as object), caveats: ["name the magic number", " ", "name the magic number"] });
  const g = await start();
  assert.equal(paused(g.r)?.type, "approval");
  assert.ok(g.r.history.some((h: { node: string; result: string }) => h.node === "reviewer" && h.result === "approved (1 caveats to backlog)"));
  await answer(g, "did not like it");
  assert.deepEqual(readBacklog().map(({ ticket, from, caveat, status }) => ({ ticket, from, caveat, status })), [
    { ticket: "T-1", from: "reviewer", caveat: "name the magic number", status: "open" },
  ]);
});
