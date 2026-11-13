// Commands that move a ticket through the graph: run, adopt, continue, approve, reject.
import { join, resolve } from "node:path";
import { workRoot } from "../../src/daily-cap.ts";
import { behindBy } from "../../src/git-remote.ts";
import { isBareApproval } from "../../src/ceo-node.ts";
import { createWorktree, resume } from "../../src/graph.ts";
import { adoptKeys, runTests, safeGit, secretPaths } from "../../src/guardrails.ts";
import { type Ctx, die } from "./ctx.ts";
import { attach, demandOf } from "./demand.ts";

export async function run(c: Ctx) {
  const request = c.positionals[0] ?? die('usage: orch run "<request>" [--repo <path>] [--id <id>] [--demand <id>]');
  c.needCap();
  c.needPrompts();
  const id = c.values.id ?? `T-${Date.now().toString(36)}`;
  const repo = resolve(c.values.repo ?? c.host);
  const demand = demandOf(c);
  if (safeGit(repo, "status", "--porcelain"))
    console.warn(`warning: ${repo} has uncommitted changes the ticket will not see; to ship them through a ticket: orch adopt --title "<what they do>"`);
  await c.locked(id, async () => {
    const wt = prepare(c, repo, id);
    await attach(c, demand, id);
    await c.drive(id, { id, request, ...wt });
  });
}

// Branches from HEAD and refuses a red base before any agent runs (no tokens spent).
function prepare(c: Ctx, repo: string, id: string, onFail = "") {
  const behind = behindBy(repo);
  if (behind) console.warn(`warning: ${repo} is ${behind} commit(s) behind its upstream; the ticket will branch from a stale base`);
  const wt = createWorktree(repo, id, join(workRoot(), "worktrees", id), c.home);
  const { failure: red, counts: test_base } = runTests(wt.worktree, wt.test, true);
  if (red) drop(repo, wt.worktree, id, `base is red before any agent ran (no tokens spent); fix it first: ${red}${onFail}`);
  return { ...wt, test_base };
}

const drop = (repo: string, worktree: string, id: string, msg: string): never => {
  safeGit(repo, "worktree", "remove", "--force", worktree);
  safeGit(repo, "branch", "-D", `ticket/${id}`);
  return die(msg);
};

// The CEO's uncommitted changes in the main checkout become a ticket: stashed there, applied in the ticket worktree, committed by the dev
// without changing a byte, then reviewed, tested and approved like any other ticket. The main checkout ends clean.
export async function adopt(c: Ctx) {
  c.needCap();
  c.needPrompts();
  const id = c.values.id ?? `T-${Date.now().toString(36)}`;
  const repo = resolve(c.values.repo ?? c.host);
  const names = (...a: string[]) => safeGit(repo, "-c", "core.quotePath=false", ...a).split("\0").filter(Boolean);
  const changed = [...names("diff", "--name-only", "-z", "HEAD"), ...names("ls-files", "-z", "--others", "--exclude-standard")];
  if (!changed.length) die(`nothing to adopt: ${repo} has no uncommitted changes`);
  const secrets = secretPaths(changed);
  if (secrets.length) die(`refusing to adopt files that look like secrets (${secrets.join(", ")}): move them out of the working tree first`);
  const title = c.values.title?.trim() || "Adopt the uncommitted changes of the main checkout";
  const demand = demandOf(c);
  await c.locked(id, async () => {
    safeGit(repo, "stash", "push", "--include-untracked", "-q", "-m", `orch adopt ${id}`);
    const stash = safeGit(repo, "rev-parse", "refs/stash");
    const keep = `\nyour changes are kept in the stash: git stash apply ${stash}`;
    const wt = prepare(c, repo, id, keep);
    let tree = "";
    try {
      safeGit(wt.worktree, "stash", "apply", "-q", stash);
      safeGit(wt.worktree, "add", "-A");
      tree = safeGit(wt.worktree, "write-tree");
      safeGit(wt.worktree, "reset", "-q");
    } catch (e) {
      drop(repo, wt.worktree, id, `adopt failed: ${(e as Error).message}${keep}`);
    }
    if (safeGit(repo, "rev-parse", "stash@{0}") === stash) safeGit(repo, "stash", "drop", "-q");
    const request = `${title}\n\nAlready written by the CEO and left uncommitted in the worktree; the dev only commits it:\n` +
      safeGit(wt.worktree, "diff", "--stat", wt.base, tree);
    await attach(c, demand, id);
    await c.drive(id, { id, request, ...wt, adopt_tree: tree, host_approved: adoptKeys(wt.worktree, wt.base, tree, wt.install) });
  });
}

// A run killed mid-graph (crash, out of memory) leaves a checkpoint that is not waiting for anyone: this picks it up where it stopped.
export async function resumeRun(c: Ctx) {
  const id = c.positionals[0] ?? die("usage: orch continue <id>");
  c.needCap();
  await c.locked(id, async () => {
    if ((await c.load(id)).pending) die(`${id} is waiting for an answer: use orch approve or orch reject`);
    await c.drive(id, null);
  });
}

export async function approve(c: Ctx) {
  const id = c.positionals[0] ?? die('usage: orch approve <id> ["answer"]');
  await c.locked(id, async () => {
    const pending = await c.needPending(id);
    const answer = c.positionals[1];
    if (pending.type === "escalation" && isBareApproval(answer))
      die(`${id} is an escalation, not an approval: "approve" would send the dev back to work with that word as its instruction.
Answer with retry, abort, or what the dev should do: orch approve ${id} "<answer>"`);
    c.needCap();
    await c.drive(id, resume(answer ?? "approve"));
  });
}

// Closes the ticket, whatever it was waiting for; the reason only goes into its history.
export async function reject(c: Ctx) {
  const id = c.positionals[0] ?? die('usage: orch reject <id> ["reason"]');
  await c.locked(id, async () => {
    await c.needPending(id);
    const reason = c.positionals[1]?.trim();
    await c.drive(id, resume(reason ? `abort: ${reason}` : "abort"));
  });
}

// Sends the ticket back to the dev with the reason as its instruction.
export async function requestChanges(c: Ctx) {
  const usage = 'usage: orch request-changes <id> "<what the dev should change>"';
  const id = c.positionals[0] ?? die(usage);
  const reason = c.positionals[1]?.trim() || die(usage);
  if (/^abort(:|$)/i.test(reason)) die(`to close ${id} use orch reject ${id}`);
  await c.locked(id, async () => {
    await c.needPending(id);
    c.needCap();
    await c.drive(id, resume(reason));
  });
}
