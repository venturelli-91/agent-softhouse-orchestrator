// merge=local when main moved after the approval: rebase, re-verify, and only then merge. Real git, fake agents.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { MemorySaver } from "@langchain/langgraph";
import { git } from "../scripts/fixture.ts";
import { answer, BRIEF, commit, knobs, paused, start } from "./helpers/graph-harness.ts";

before(() => Object.assign(process.env, { GIT_COMMITTER_NAME: "orch", GIT_COMMITTER_EMAIL: "orch@x.local" }));
after(() => {
  delete process.env.GIT_COMMITTER_NAME;
  delete process.env.GIT_COMMITTER_EMAIL;
});

const onMain = (repo: string, file: string, content: string) => {
  writeFileSync(join(repo, file), content);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "human on main");
  return git(repo, "rev-parse", "main");
};

test("main moved on other files: the ticket is rebased, re-verified and merged without asking again", async () => {
  const g = await start("T-1", new MemorySaver(), { merge: "local" });
  const moved = onMain(g.repo, "other.txt", "y\n");
  const done = await answer(g, "approve");
  assert.equal(done.status, "simulated_deploy");
  assert.equal(git(g.repo, "rev-parse", "main"), done.approved_sha);
  assert.equal(git(g.repo, "rev-parse", "main~1"), moved);
  assert.equal(done.base, moved);
  assert.ok(done.history.some((h: { result: string }) => /^rebased onto [0-9a-f]{7} as [0-9a-f]{7}; merged:local@/.test(h.result)));
});

test("main changed a file of the ticket without conflict: the rebased commit needs a new approval", async () => {
  const page = (button: string, footer: string) => `<button>${button}</button>



<footer>${footer}</footer>
`;
  knobs.afterFixture = (repo) => onMain(repo, "checkout.html", page("Submit", "a"));
  knobs.override.dev = (req) => (commit(req.cwd, "agent-dev", "checkout.html", page("Submit order", "a")), { summary: "ok", brief: BRIEF });
  const g = await start("T-1", new MemorySaver(), { merge: "local" });
  onMain(g.repo, "checkout.html", page("Submit", "b"));
  const again = await answer(g, "approve");
  assert.equal(paused(again)?.type, "approval");
  assert.match(String(paused(again)?.last_node), /also changed checkout\.html: approve again/);
  const done = await answer(g, "approve");
  assert.equal(done.status, "simulated_deploy");
  assert.equal(git(g.repo, "show", "main:checkout.html"), page("Submit order", "b").trim());
});

test("a conflicting rebase escalates with the conflicting files and leaves both branches as they were", async () => {
  const g = await start("T-1", new MemorySaver(), { merge: "local" });
  const moved = onMain(g.repo, "checkout.html", "<button>Pay</button>\n");
  const ticket = git(g.repo, "rev-parse", "ticket/T-1");
  const esc = await answer(g, "approve");
  assert.equal(paused(esc)?.type, "escalation");
  assert.match(String(paused(esc)?.reason), /rebase onto [0-9a-f]{7} failed in checkout\.html; run `git rebase --onto/);
  assert.equal(git(g.repo, "rev-parse", "main"), moved);
  assert.equal(git(g.repo, "rev-parse", "ticket/T-1"), ticket);
});

test("a rebase that breaks the suite goes back to the dev as a revision", async () => {
  const g = await start("T-1", new MemorySaver(), { merge: "local" });
  const moved = onMain(g.repo, "test/checkout.test.js", 'import assert from "node:assert";\nassert.fail("main broke it");\n');
  knobs.calls = [];
  await answer(g, "approve");
  assert.equal(knobs.calls[0], "dev");
  assert.equal(git(g.repo, "rev-parse", "main"), moved);
});

test("a rebase resolved by hand in the worktree comes back for approval on retry, then merges", async () => {
  const g = await start("T-1", new MemorySaver(), { merge: "local" });
  const moved = onMain(g.repo, "checkout.html", "<button>Pay</button>\n");
  const esc = await answer(g, "approve");
  const wt = join(g.root, "wt");
  assert.throws(() => git(wt, "rebase", moved));
  writeFileSync(join(wt, "checkout.html"), "<button>Submit order</button>\n");
  git(wt, "add", "-A");
  git(wt, "-c", "core.editor=true", "rebase", "--continue");
  assert.equal(paused(esc)?.type, "escalation");
  const again = await answer(g, "retry");
  assert.equal(paused(again)?.type, "approval");
  assert.match(String(paused(again)?.last_node), /rebased by hand onto [0-9a-f]{7} as [0-9a-f]{7}: approve again/);
  const done = await answer(g, "approve");
  assert.equal(done.status, "simulated_deploy");
  assert.equal(git(g.repo, "rev-parse", "main~1"), moved);
});

test("a ticket whose change main already has is not merged twice", async () => {
  const g = await start("T-1", new MemorySaver(), { merge: "local" });
  const moved = onMain(g.repo, "checkout.html", "<button>Submit order</button>\n");
  const done = await answer(g, "approve");
  assert.equal(done.status, "simulated_deploy");
  assert.equal(git(g.repo, "rev-parse", "main"), moved);
  assert.ok(done.history.some((h: { result: string }) => /the ticket is already in main/.test(h.result)));
});
