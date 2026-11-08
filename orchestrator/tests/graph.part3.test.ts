// Flow guardrails against fake nodes (part 3 of 4): no model, no credentials.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { MemorySaver } from "@langchain/langgraph";
import { ciVerdict } from "../src/publish.ts";
import { NodeFailure, type Req } from "../src/run-agent.ts";
import { BRIEF, commit, defaults, start, paused, answer, approved, reviewerFailsOnce, knobs } from "./helpers/graph-harness.ts";
import { setCollector, playwrightCollector } from "../src/webcheck.ts";
import { WebcheckConfig } from "../src/repo-config.ts";

test("the reviewer gets the repo conventions and QA does not", async () => {
  const seen: Record<string, string> = {};
  for (const role of ["dev", "reviewer", "qa"]) {
    knobs.override[role] = (req) => ((seen[role] = req.context), defaults[role]!(req));
  }
  await start("T-1", new MemorySaver(), { rules: "R-CANARY" });
  assert.match(seen.dev, /R-CANARY/);
  assert.match(seen.reviewer, /R-CANARY/);
  assert.doesNotMatch(seen.qa, /R-CANARY/);
});

test("retry after a reviewer failure re-runs the reviewer and not the dev", async () => {
  knobs.override.reviewer = reviewerFailsOnce();
  const g = await start();
  assert.equal(paused(g.r)?.type, "escalation");
  const r = await answer(g, "retry");
  assert.equal(paused(r)?.type, "approval");
  assert.equal(knobs.calls.filter((c) => c === "dev").length, 1);
  assert.equal(knobs.calls.filter((c) => c === "reviewer").length, 2);
});

test("retry is honoured only for the commit that was verified; a new commit goes back through the dev", async () => {
  knobs.override.reviewer = reviewerFailsOnce();
  const g = await start();
  assert.equal(paused(g.r)?.type, "escalation");
  commit(join(g.root, "wt"), "agent-dev", "extra.txt", "x\n");
  const r = await answer(g, "retry");
  assert.equal(paused(r)?.type, "approval");
  assert.equal(knobs.calls.filter((c) => c === "dev").length, 2);
});

test("a retried node does not see the failure text, but the CEO does", async () => {
  const seen: string[] = [];
  knobs.override.reviewer = (req) => {
    seen.push(req.context);
    if (seen.length === 1) throw new NodeFailure("SECRET-DETAIL");
    return approved();
  };
  const g = await start();
  assert.match(String(paused(g.r)?.summary), /SECRET-DETAIL/);
  await answer(g, "retry");
  assert.equal(seen.length, 2);
  assert.doesNotMatch(seen[1], /SECRET-DETAIL/);
});

test("retry on a revision-cap escalation still instructs the dev", async () => {
  knobs.override.reviewer = () => ({ verdict: "rejected", comments: "no", summary: "s" });
  const g = await start();
  assert.equal(paused(g.r)?.type, "escalation");
  assert.equal(knobs.calls.filter((c) => c === "dev").length, 3);
  knobs.override.reviewer = approved;
  const r = await answer(g, "retry");
  assert.equal(paused(r)?.type, "approval");
  assert.equal(knobs.calls.filter((c) => c === "dev").length, 4);
});

test("a non-retry answer after an escalation still goes to the dev", async () => {
  knobs.override.reviewer = reviewerFailsOnce();
  const g = await start();
  assert.equal(paused(g.r)?.type, "escalation");
  const r = await answer(g, "please fix it");
  assert.equal(paused(r)?.type, "approval");
  assert.equal(knobs.calls.filter((c) => c === "dev").length, 2);
});

test("CI is green only with a passing check, no failures, and a stable set of checks", () => {
  const c = (...b: string[]) => b.map((bucket) => ({ bucket }));
  assert.equal(ciVerdict(null, c("pass")), "wait", "first poll never merges");
  assert.equal(ciVerdict(1, c("pass")), "green");
  assert.equal(ciVerdict(1, c("pass", "pass")), "wait", "a check appeared since the last poll");
  assert.equal(ciVerdict(1, c("pass", "pending")), "wait");
  assert.equal(ciVerdict(1, c("skipping")), "wait", "all skipped is not proof");
  assert.equal(ciVerdict(0, c()), "wait", "no checks");
  assert.equal(ciVerdict(2, c("pass", "fail")), "fail");
  assert.equal(ciVerdict(2, c("pass", "cancel")), "fail");
});

test("the reviewer and qa explanations reach the approval request", async () => {
  knobs.override = {
    reviewer: () => ({ verdict: "approved", comments: "", summary: "ok", explanation: "R-EXPL" }),
    qa: () => ({ verdict: "approved", comments: "", summary: "ok", explanation: "Q-EXPL" }),
  };
  const g = await start();
  const expl = String(paused(g.r)?.explanation);
  assert.ok(expl.includes("R-EXPL") && expl.includes("Q-EXPL"), expl);
});

test("the planner's briefing and stories land on the ticket and in the dev context", async () => {
  let devCtx = "";
  knobs.override = {
    triage: () => ({ ...(defaults.triage!({} as Req<unknown>) as object), clear: false, criteria: [] }),
    planner: () => ({ ...(defaults.triage!({} as Req<unknown>) as object), question: "", briefing: "B-CANARY", stories: ["As a buyer I want X so that Y"] }),
    dev: (req) => ((devCtx = req.context), commit(req.cwd, "agent-dev"), { summary: "ok", brief: BRIEF }),
  };
  const g = await start();
  assert.ok(devCtx.includes("B-CANARY") && devCtx.includes("As a buyer I want X so that Y"), devCtx);
  const s = await g.graph.getState(g.cfg);
  assert.equal(s.values.briefing, "B-CANARY");
  assert.deepEqual(s.values.stories, ["As a buyer I want X so that Y"]);
});

test("a ticket with an incident keeps priority P0 even if triage says P2", async () => {
  const g = await start("T-1", new MemorySaver(), { incident: "inc-1" });
  const s = await g.graph.getState(g.cfg);
  assert.equal(s.values.priority, "P0");
  assert.equal(s.values.incident, "inc-1");
});

test("an explanation from a superseded commit does not reach the approval request", async () => {
  let r = 0, q = 0;
  knobs.override = {
    reviewer: () => ({ verdict: "approved", comments: "", summary: "ok", explanation: `R${++r}-EXPL` }),
    qa: () => (++q === 1 ? { verdict: "rejected", comments: "no", summary: "no" } : { verdict: "approved", comments: "", summary: "ok",
      explanation: "Q2-EXPL" }),
  };
  const g = await start();
  const expl = String(paused(g.r)?.explanation);
  assert.ok(expl.includes("R2-EXPL") && expl.includes("Q2-EXPL") && !expl.includes("R1-EXPL"), expl);
});

test("a UI ticket goes through the design review and a design rejection sends it back to the dev", async () => {
  let d = 0;
  knobs.override.design = () => (++d === 1 ? { verdict: "rejected", comments: "no focus ring", summary: "no" } : { verdict: "approved", comments: "", summary: "ok" });
  const g = await start();
  assert.equal(paused(g.r)?.type, "approval");
  assert.deepEqual(knobs.calls.filter((c) => ["reviewer", "design", "qa"].includes(c)), ["reviewer", "design", "reviewer", "design", "qa"]);
});

test("a backend ticket skips the design review", async () => {
  knobs.override.triage = () => ({ ...(defaults.triage!({} as Req<unknown>) as object), specialty: "backend" });
  await start();
  assert.ok(!knobs.calls.includes("design"));
});

const WEB = WebcheckConfig.parse({ serve: "npm start", base_url: "http://localhost:3000", gtm: ["GTM-ABC123"], lcp_ms: 2500 });
const page = (over: object = {}) => ({ url: "http://localhost:3000/", vitals: { lcp_ms: 1000 }, dataLayer: [{ event: "gtm.js" }], consoleErrors: [],
  requests: ["https://www.googletagmanager.com/gtm.js?id=GTM-ABC123"], ...over });

test("a UI ticket without webcheck configured passes with a warning, and a failing webcheck goes back to the dev", async () => {
  const skipped = await start();
  assert.equal(paused(skipped.r)?.type, "approval");
  assert.match(skipped.r.docs_warnings.join(), /webcheck skipped: no webcheck configured/);

  knobs.calls = [];
  let n = 0;
  setCollector(async () => [n++ === 0 ? page({ requests: [] }) : page()]);
  try {
    const g = await start("T-2", new MemorySaver(), { webcheck_cfg: WEB });
    assert.equal(paused(g.r)?.type, "approval");
    assert.equal(g.r.revisions, 1);
    assert.match(g.r.rejections.join(), /webcheck: GTM GTM-ABC123 was never requested/);
    assert.equal(knobs.calls.filter((c) => c === "dev").length, 2);
  } finally {
    setCollector(playwrightCollector);
  }
});

test("a collector crash does not block the ticket: it is skipped with a warning", async () => {
  setCollector(async () => { throw new Error("chromium missing"); });
  try {
    const g = await start("T-3", new MemorySaver(), { webcheck_cfg: WEB });
    assert.equal(paused(g.r)?.type, "approval");
    assert.match(g.r.docs_warnings.join(), /webcheck skipped: chromium missing/);
  } finally {
    setCollector(playwrightCollector);
  }
});
