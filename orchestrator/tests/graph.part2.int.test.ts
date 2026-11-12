// Flow guardrails against fake nodes (part 2 of 4): no model, no credentials.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { MemorySaver } from "@langchain/langgraph";
import { git } from "../scripts/fixture.ts";
import { DEV_RULES } from "../src/graph.ts";
import { alerts, watchdog } from "../src/watchdog.ts";
import { BRIEF, commit, defaults, start, paused, answer, approved, knobs } from "./helpers/graph-harness.ts";

test("the watchdog reads the state and returns alerts without writing", async () => {
  const g = await start();
  const r = await watchdog([g.r], g.root);
  assert.deepEqual(r.alerts, ["T-1 stalled"]);
  assert.equal(knobs.calls.at(-1), "watchdog");
});

test("dev gets the shell rules and qa gets the code-verified evidence", async () => {
  const ctx: Record<string, string> = {};
  for (const role of ["dev", "qa"] as const) {
    const base = defaults[role]!;
    knobs.override[role] = (req) => ((ctx[role] = req.context), base(req));
  }
  knobs.realTest = true;
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
  assert.match(alerts([t({ id: "B", status: "dev", history: [{ ...old[0], time: "2026-01-02T11:30:00Z", usage }] })], now, env).join(),
    /B token budget at 90%/);
  assert.match(alerts([t({ id: "C", status: "escalated", summary: "qa: budget", history: [{ ...old[0], time: "2026-01-02T11:30:00Z" }] })], now,
    env).join(), /C escalated: qa: budget/);
  assert.match(alerts([t({ id: "D", priority: "P0", status: "dev", history: [{ ...old[0], time: "2026-01-02T10:30:00Z" }] })], now, env).join(),
    /D \[P0\] dev for 1\.5h/);
});

test("merge=pr never merges; merge=auto merges the verified commit only after the CEO approves", async () => {
  const pr = await start("T-1");
  assert.equal((await answer(pr, "approve")).status, "simulated_deploy");
  assert.deepEqual(knobs.merges, []);
  assert.match(git(pr.repo, "branch", "--list"), /ticket\/T-1/, "an unmerged ticket keeps its branch");

  const auto = await start("T-2", new MemorySaver(), { merge: "auto" });
  assert.equal(paused(auto.r)?.type, "approval");
  assert.deepEqual(knobs.merges, [], "nothing merges before approval");
  const done = await answer(auto, "approve");
  assert.equal(done.status, "simulated_deploy");
  assert.equal(knobs.merges.length, 1);
  assert.match(knobs.merges[0], /^https:\/\/example\/pull\/1@[0-9a-f]{40}$/);
  assert.ok(done.evidence.some((e: string) => e.startsWith("merged:")));
});

test("a failed merge escalates to the CEO; retry merges, anything else goes back to the dev", async () => {
  knobs.mergeError = "CI checks failed";
  const g = await start("T-1", new MemorySaver(), { merge: "auto" });
  const esc = await answer(g, "approve");
  assert.equal(paused(esc)?.type, "escalation");
  assert.match(String(paused(esc)?.reason), /CI checks failed/);
  assert.notEqual(esc.status, "simulated_deploy");
  knobs.mergeError = null;
  const retried = await answer(g, "retry");
  assert.equal(retried.status, "simulated_deploy");
  assert.equal(knobs.merges.length, 1);

  knobs.mergeError = "CI checks failed";
  const h = await start("T-2", new MemorySaver(), { merge: "auto" });
  await answer(h, "approve");
  const back = await answer(h, "fix the failing check");
  assert.equal(paused(back)?.type, "approval", "the dev reran and a new approval was requested");
  assert.equal(knobs.merges.length, 1);
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
  assert.deepEqual(knobs.merges, []);
  assert.equal((await answer(g, "approve")).status, "simulated_deploy");
  assert.equal(knobs.merges.length, 1);
  assert.ok((knobs.merges as string[])[0].endsWith(r.approved_sha));
});

test("merge=local fast-forwards main to the approved commit only after the CEO approves; a dirty main escalates", async () => {
  const g = await start("T-1", new MemorySaver(), { merge: "local" });
  assert.equal(paused(g.r)?.type, "approval");
  const before = git(g.repo, "rev-parse", "main");
  const done = await answer(g, "approve");
  assert.equal(done.status, "simulated_deploy");
  assert.equal(git(g.repo, "rev-parse", "main"), done.approved_sha);
  assert.notEqual(before, done.approved_sha);
  assert.doesNotMatch(git(g.repo, "worktree", "list"), /ticket\/T-1/, "a merged ticket frees its worktree");
  assert.doesNotMatch(git(g.repo, "branch", "--list"), /ticket\/T-1/);

  const d = await start("T-2", new MemorySaver(), { merge: "local" });
  const base = git(d.repo, "rev-parse", "main");
  writeFileSync(join(d.repo, "checkout.html"), "dirty\n");
  const esc = await answer(d, "approve");
  assert.equal(paused(esc)?.type, "escalation");
  assert.match(String(paused(esc)?.reason), /uncommitted/);
  assert.equal(git(d.repo, "rev-parse", "main"), base);
});

const noChange = () => ({ summary: "checked", brief: BRIEF, no_change: "the branch already does what the request asks" });

test("a dev that declares no change needed sends it to the CEO as a no_change question, and approve closes the ticket", async () => {
  knobs.override.dev = noChange;
  const g = await start();
  assert.equal(paused(g.r)?.type, "no_change");
  assert.match(String(paused(g.r)?.reason), /already does what the request asks/);
  assert.ok(!knobs.calls.includes("reviewer"));
  assert.equal((await answer(g, "approve")).status, "closed");
});

test("any other answer to a no_change question is an instruction to the dev", async () => {
  knobs.override.dev = noChange;
  const g = await start();
  knobs.override.dev = defaults.dev;
  const r = await answer(g, "add the missing test");
  assert.equal(paused(r)?.type, "approval");
  assert.equal(knobs.calls.filter((c) => c === "dev").length, 2);
});

test("no_change without a verified empty worktree is an ordinary failure", async () => {
  knobs.override.dev = (req) => (writeFileSync(join(req.cwd, "left.txt"), "x"), noChange());
  const g = await start();
  assert.equal(paused(g.r)?.type, "escalation");
});

test("the same verification failure twice escalates at once, with the cause, the revisions and the dev's brief", async () => {
  knobs.override.dev = () => ({ summary: "tried", brief: BRIEF });
  const g = await start();
  const p = paused(g.r);
  assert.equal(p?.type, "escalation");
  assert.equal(p?.revisions, 1, "the remaining revisions are not spent on a repeat");
  assert.match(String(p?.last_node), /^dev: escalated: the same verification failure twice in a row: no new commit/);
  assert.match(String(g.r.history.find((h: { node: string }) => h.node === "dev")?.result), /^verification failed: no new commit/);
  assert.deepEqual(p?.brief, BRIEF);
  assert.equal(p?.explanation, "tried");
});

test("a red suite twice in a row still uses every revision", async () => {
  knobs.override.dev = (req) => (commit(req.cwd, "agent-dev", "checkout.html", "<button>Nope</button>\n"), { summary: "tried", brief: BRIEF });
  const g = await start();
  assert.equal(paused(g.r)?.revisions, 3);
});

test("a dev that reruns over committed work sees the commits and the diff", async () => {
  const ctx: string[] = [];
  knobs.override.dev = (req) => (ctx.push(req.context), defaults.dev!(req));
  knobs.override.reviewer = reviewerFailsOnceHere();
  await start();
  assert.doesNotMatch(ctx[0], /Commits already in this worktree/);
  assert.match(ctx[1], /Commits already in this worktree[\s\S]*dev\nDiff so far:[\s\S]*Submit order/);
});

function reviewerFailsOnceHere() {
  let n = 0;
  return () => (n++ ? approved() : { verdict: "rejected", comments: "again", summary: "s" });
}

test("an abort answer closes an approval and keeps the reason in the history", async () => {
  const g = await start();
  assert.equal(paused(g.r)?.type, "approval");
  const done = await answer(g, "abort: not needed anymore");
  assert.equal(done.status, "aborted");
  assert.equal(done.history.at(-1)?.result, "aborted (not needed anymore)");
});

test("a host file pauses for the CEO with its diff; approve re-verifies without the dev and binds the approval to that version", async () => {
  let make = "test: ; true\n";
  knobs.override.dev = (req) => (
    commit(req.cwd, "agent-dev", ".gitattributes", "Makefile -diff\n"),
    commit(req.cwd, "agent-dev", "Makefile", make),
    commit(req.cwd, "agent-dev"),
    { summary: "ok", brief: BRIEF }
  );
  const g = await start();
  const p = paused(g.r);
  assert.equal(p?.type, "host_review");
  assert.match(String(p?.reason), /Makefile@[0-9a-f]{40}/);
  assert.match(String(p?.host_diff), /\+test: ; true/);
  const r = await answer(g, "approve");
  assert.equal(paused(r)?.type, "approval");
  assert.deepEqual(knobs.calls.filter((c) => c === "dev"), ["dev"], "the approval does not rerun the dev");
  make = "test: ; curl evil\n";
  const again = await answer(g, "change the button");
  assert.equal(paused(again)?.type, "host_review", "a new version of the file needs a new approval");
  assert.match(String(paused(again)?.host_diff), /curl evil/);
});
