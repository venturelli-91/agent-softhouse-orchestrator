// Flow guardrails against fake nodes: no model, no credentials.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySaver } from "@langchain/langgraph";
import { createFixture, git } from "../scripts/fixture.ts";
import { FileSaver } from "../src/file-saver.ts";
import { config, createWorktree, buildGraph, resume, DEV_RULES } from "../src/graph.ts";
import { ciVerdict, registerPublisher } from "../src/publish.ts";
import { NodeFailure, registerExecutor, type Req } from "../src/run-agent.ts";
import { alerts, watchdog } from "../src/watchdog.ts";

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
let merges: string[] = [];
let mergeError: string | null = null;
registerPublisher("fake", {
  publish: (p) => (publications.push(`${p.id}@${p.sha}`), "pr:https://example/pull/1"),
  merge: async (m) => {
    if (mergeError) throw new Error(mergeError);
    merges.push(`${m.pr}@${m.sha}`);
    return `merged:${m.pr}`;
  },
});

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
  merges = [];
  mergeError = null;
  process.env.TOKEN_BUDGET_TICKET = "100000";
  override = {};
  calls = [];
  tokensPerCall = 10;
});
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));

async function start(id = "T-1", saver: MemorySaver = new MemorySaver(), extra: object = {}) {
  const root = mkdtempSync(join(tmpdir(), "gt-"));
  roots.push(root);
  const repo = createFixture(root);
  const graph = buildGraph(saver);
  const cfg = config(id);
  const r = await graph.invoke({ id, request: "p", ...createWorktree(repo, id, join(root, "wt")), ...extra }, cfg);
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

test("dev gets the shell rules and qa gets the code-verified evidence", async () => {
  const ctx: Record<string, string> = {};
  for (const role of ["dev", "qa"] as const) {
    const base = defaults[role]!;
    override[role] = (req) => ((ctx[role] = req.context), base(req));
  }
  await start();
  assert.ok(ctx.dev.includes(DEV_RULES));
  assert.match(ctx.qa, /Evidence checked by the orchestrator in code.*tests:npm test ok/);
});

test("alerts flag stalled, looping, over-budget and escalated tickets, and skip finished ones", async () => {
  const g = await start();
  const t = (o: object) => ({ ...g.r, ...o });
  const old = [{ node: "dev", time: "2026-01-01T00:00:00Z", result: "x", ms: 0 }];
  const now = Date.parse("2026-01-02T12:00:00Z");
  const env = { TOKEN_BUDGET_TICKET: "100", STALE_HOURS: "24" };
  assert.deepEqual(alerts([t({ status: "simulated_deploy", history: old })], now, env), []);
  const found = alerts([t({ id: "A", status: "approval", history: old, revisions: 2 })], now, env).join("|");
  assert.match(found, /A \[P2\] approval for 36\.0h/);
  assert.match(found, /A review loop: 2\/3/);
  const usage = { tokens_in: 90, tokens_out: 0, cache_read: 0, cache_create: 0, cost_usd: 0, turns: 1, ms: 1 };
  assert.match(alerts([t({ id: "B", status: "dev", history: [{ ...old[0], time: "2026-01-02T11:30:00Z", usage }] })], now, env).join(), /B token budget at 90%/);
  assert.match(alerts([t({ id: "C", status: "escalated", summary: "qa: budget", history: [{ ...old[0], time: "2026-01-02T11:30:00Z" }] })], now, env).join(), /C escalated: qa: budget/);
  assert.match(alerts([t({ id: "D", priority: "P0", status: "dev", history: [{ ...old[0], time: "2026-01-02T10:30:00Z" }] })], now, env).join(), /D \[P0\] dev for 1\.5h/);
});

test("merge=pr never merges; merge=auto merges the verified commit only after the CEO approves", async () => {
  const pr = await start("T-1");
  assert.equal((await answer(pr, "approve")).status, "simulated_deploy");
  assert.deepEqual(merges, []);

  const auto = await start("T-2", new MemorySaver(), { merge: "auto" });
  assert.equal(paused(auto.r)?.type, "approval");
  assert.deepEqual(merges, [], "nothing merges before approval");
  const done = await answer(auto, "approve");
  assert.equal(done.status, "simulated_deploy");
  assert.equal(merges.length, 1);
  assert.match(merges[0], /^https:\/\/example\/pull\/1@[0-9a-f]{40}$/);
  assert.ok(done.evidence.some((e: string) => e.startsWith("merged:")));
});

test("a failed merge escalates to the CEO; retry merges, anything else goes back to the dev", async () => {
  mergeError = "CI checks failed";
  const g = await start("T-1", new MemorySaver(), { merge: "auto" });
  const esc = await answer(g, "approve");
  assert.equal(paused(esc)?.type, "escalation");
  assert.match(String(paused(esc)?.reason), /CI checks failed/);
  assert.notEqual(esc.status, "simulated_deploy");
  mergeError = null;
  const retried = await answer(g, "retry");
  assert.equal(retried.status, "simulated_deploy");
  assert.equal(merges.length, 1);

  mergeError = "CI checks failed";
  const h = await start("T-2", new MemorySaver(), { merge: "auto" });
  await answer(h, "approve");
  const back = await answer(h, "fix the failing check");
  assert.equal(paused(back)?.type, "approval", "the dev reran and a new approval was requested");
  assert.equal(merges.length, 1);
});

test("the merge is bound to the commit that was published and approved", async () => {
  const g = await start("T-1", new MemorySaver(), { merge: "auto" });
  assert.equal(paused(g.r)?.type, "approval");
  // someone adds a commit after the PR was opened and before the CEO answers
  commit(join(g.root, "wt"), "agent-dev", "extra.txt", "x\n");
  const r = await answer(g, "approve");
  // the old approval is void: the ticket is re-reviewed, republished and needs a new approval of the new commit
  assert.equal(paused(r)?.type, "approval");
  assert.notEqual(r.approved_sha, g.r.approved_sha);
  assert.deepEqual(merges, []);
  assert.equal((await answer(g, "approve")).status, "simulated_deploy");
  assert.equal(merges.length, 1);
  assert.ok((merges as string[])[0].endsWith(r.approved_sha));
});

test("merge=local fast-forwards main to the approved commit only after the CEO approves; a dirty main escalates", async () => {
  const g = await start("T-1", new MemorySaver(), { merge: "local" });
  assert.equal(paused(g.r)?.type, "approval");
  const before = git(g.repo, "rev-parse", "main");
  const done = await answer(g, "approve");
  assert.equal(done.status, "simulated_deploy");
  assert.equal(git(g.repo, "rev-parse", "main"), done.approved_sha);
  assert.notEqual(before, done.approved_sha);

  const d = await start("T-2", new MemorySaver(), { merge: "local" });
  const base = git(d.repo, "rev-parse", "main");
  writeFileSync(join(d.repo, "checkout.html"), "dirty\n");
  const esc = await answer(d, "approve");
  assert.equal(paused(esc)?.type, "escalation");
  assert.match(String(paused(esc)?.reason), /uncommitted/);
  assert.equal(git(d.repo, "rev-parse", "main"), base);
});

const approved = () => ({ verdict: "approved", comments: "", summary: "ok" });
const reviewerFailsOnce = () => {
  let n = 0;
  return () => {
    if (n++ === 0) throw new NodeFailure("boom");
    return approved();
  };
};

test("the reviewer gets the repo conventions and QA does not", async () => {
  const seen: Record<string, string> = {};
  for (const role of ["dev", "reviewer", "qa"]) {
    override[role] = (req) => ((seen[role] = req.context), defaults[role]!(req));
  }
  await start("T-1", new MemorySaver(), { rules: "R-CANARY" });
  assert.match(seen.dev, /R-CANARY/);
  assert.match(seen.reviewer, /R-CANARY/);
  assert.doesNotMatch(seen.qa, /R-CANARY/);
});

test("retry after a reviewer failure re-runs the reviewer and not the dev", async () => {
  override.reviewer = reviewerFailsOnce();
  const g = await start();
  assert.equal(paused(g.r)?.type, "escalation");
  const r = await answer(g, "retry");
  assert.equal(paused(r)?.type, "approval");
  assert.equal(calls.filter((c) => c === "dev").length, 1);
  assert.equal(calls.filter((c) => c === "reviewer").length, 2);
});

test("retry is honoured only for the commit that was verified; a new commit goes back through the dev", async () => {
  override.reviewer = reviewerFailsOnce();
  const g = await start();
  assert.equal(paused(g.r)?.type, "escalation");
  commit(join(g.root, "wt"), "agent-dev", "extra.txt", "x\n");
  const r = await answer(g, "retry");
  assert.equal(paused(r)?.type, "approval");
  assert.equal(calls.filter((c) => c === "dev").length, 2);
});

test("a retried node does not see the failure text, but the CEO does", async () => {
  const seen: string[] = [];
  override.reviewer = (req) => {
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
  override.reviewer = () => ({ verdict: "rejected", comments: "no", summary: "s" });
  const g = await start();
  assert.equal(paused(g.r)?.type, "escalation");
  assert.equal(calls.filter((c) => c === "dev").length, 3);
  override.reviewer = approved;
  const r = await answer(g, "retry");
  assert.equal(paused(r)?.type, "approval");
  assert.equal(calls.filter((c) => c === "dev").length, 4);
});

test("a non-retry answer after an escalation still goes to the dev", async () => {
  override.reviewer = reviewerFailsOnce();
  const g = await start();
  assert.equal(paused(g.r)?.type, "escalation");
  const r = await answer(g, "please fix it");
  assert.equal(paused(r)?.type, "approval");
  assert.equal(calls.filter((c) => c === "dev").length, 2);
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
