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
import { type Req } from "../src/run-agent.ts";
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

test("the cap of 3 revisions escalates to the CEO", async () => {
  knobs.override.reviewer = () => ({ verdict: "rejected", comments: "redo it", summary: "x" });
  const g = await start();
  assert.equal(knobs.calls.filter((c) => c === "dev").length, 3);
  assert.equal(paused(g.r)?.type, "escalation");
  assert.match(String(paused(g.r)?.reason), /cap of 3/);
});

test("invalid node output is a failure: it escalates and does not advance", async () => {
  knobs.override.triage = () => ({ junk: 1 });
  const g = await start();
  assert.equal(paused(g.r)?.type, "escalation");
  assert.ok(!knobs.calls.includes("dev"));
});

test("an ambiguous request goes through the planner and proceeds to the dev once it closes the criteria", async () => {
  knobs.override.triage = ambiguous;
  const g = await start();
  assert.deepEqual(knobs.calls.slice(0, 2), ["triage", "planner"]);
  assert.equal(paused(g.r)?.type, "approval");
});

test("a planner without criteria escalates with the question; the CEO's answer returns to the planner", async () => {
  knobs.override.triage = ambiguous;
  let rounds = 0;
  let seenRequest = "";
  knobs.override.planner = (req) => {
    seenRequest = req.context;
    return ++rounds === 1
      ? { ...(ambiguous() as object), question: "which button?", criteria: [] }
      : { ...(defaults.planner!(req) as object) };
  };
  const g = await start();
  assert.equal(paused(g.r)?.type, "escalation");
  assert.match(String(paused(g.r)?.reason), /which button\?/);
  assert.ok(!knobs.calls.includes("dev"));
  const r2 = await answer(g, "the checkout one");
  assert.match(seenRequest, /CEO clarification: the checkout one/);
  assert.equal(paused(r2)?.type, "approval");
});

test("the CEO aborts when the planner asks for clarification", async () => {
  knobs.override.triage = ambiguous;
  knobs.override.planner = () => ({ ...(ambiguous() as object), question: "?", criteria: [] });
  const g = await start();
  assert.equal((await answer(g, "abort")).status, "aborted");
  assert.ok(!knobs.calls.includes("dev"));
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
