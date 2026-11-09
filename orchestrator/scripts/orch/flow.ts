// Commands that move a ticket through the graph: run, continue, approve, reject.
import { join, resolve } from "node:path";
import { workRoot } from "../../src/daily-cap.ts";
import { behindBy } from "../../src/git-remote.ts";
import { isBareApproval } from "../../src/ceo-node.ts";
import { createWorktree, resume } from "../../src/graph.ts";
import { safeGit, testFailure } from "../../src/guardrails.ts";
import { type Ctx, die } from "./ctx.ts";

export async function run(c: Ctx) {
  const request = c.positionals[0] ?? die('usage: orch run "<request>" [--repo <path>] [--id <id>]');
  c.needCap();
  c.needPrompts();
  const id = c.values.id ?? `T-${Date.now().toString(36)}`;
  const repo = resolve(c.values.repo ?? c.host);
  await c.locked(id, async () => {
    const behind = behindBy(repo);
    if (behind) console.warn(`warning: ${repo} is ${behind} commit(s) behind its upstream; the ticket will branch from a stale base`);
    const wt = createWorktree(repo, id, join(workRoot(), "worktrees", id), c.home);
    const red = testFailure(wt.worktree, wt.test);
    if (red) {
      safeGit(repo, "worktree", "remove", "--force", wt.worktree);
      safeGit(repo, "branch", "-D", `ticket/${id}`);
      die(`base is red before any agent ran (no tokens spent); fix it first: ${red}`);
    }
    await c.drive(id, { id, request, ...wt });
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

export async function reject(c: Ctx) {
  const id = c.positionals[0] ?? die('usage: orch reject <id> "<reason>"');
  await c.locked(id, async () => {
    const pending = await c.needPending(id);
    const reason = c.positionals[1] ?? (pending.type !== "approval" ? "abort" : die("rejecting an approval needs a reason"));
    if (reason !== "abort") c.needCap();
    await c.drive(id, resume(reason));
  });
}
