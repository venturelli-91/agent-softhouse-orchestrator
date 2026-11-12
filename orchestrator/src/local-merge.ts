import { devNull, repoOf, safeGit, verifyTicket } from "./guardrails.ts";
import { log } from "./graph-kit.ts";
import type { T } from "./ticket.ts";

function assertMergeable(repo: string, branch: string): void {
  if (branch === "HEAD" || safeGit(repo, "rev-parse", "--abbrev-ref", "HEAD") !== branch) throw new Error(`branch ${branch
    || "(none)"} is not checked out in the main checkout`);
  if (safeGit(repo, "status", "--porcelain")) throw new Error("main checkout has uncommitted changes");
}

const isAncestor = (repo: string, a: string, b: string) => {
  try {
    safeGit(repo, "merge-base", "--is-ancestor", a, b);
    return true;
  } catch {
    return false;
  }
};

// Fast-forward only: the main checkout moves to exactly the commit the CEO approved, or nothing changes.
export function mergeLocal(repo: string, branch: string, sha: string): string {
  assertMergeable(repo, branch);
  if (!isAncestor(repo, "HEAD", sha)) throw new Error(`${branch} diverged from the approved commit`);
  safeGit(repo, "-c", `core.hooksPath=${devNull}`, "merge", "--ff-only", "--no-overwrite-ignore", sha);
  return `merged:local@${sha.slice(0, 7)}`;
}

// Replays only the ticket's own commits (from..HEAD) on top of `onto`, so a rewritten main never brings old commits back.
// On any failure the branch is left as it was.
function rebaseOnto(wt: string, onto: string, from: string): string[] | null {
  try {
    safeGit(wt, "rebase", "--no-autosquash", "--onto", onto, from);
    return null;
  } catch {
    const conflicts = safeGit(wt, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
    try {
      safeGit(wt, "rebase", "--abort");
    } catch {}
    return conflicts;
  }
}

const changed = (cwd: string, from: string, to: string) =>
  safeGit(cwd, "-c", "core.quotePath=false", "diff", "--name-only", "--no-renames", from, to).split("\n").filter(Boolean);

// Main moved after the approval: rebase onto it and run the suite again. The CEO approved the ticket's content, so a new
// approval is needed only when main changed one of the ticket's own files; a suite that breaks goes back to the dev.
export function mergeLocalTicket(t: T): Partial<T> {
  const repo = t.repo || repoOf(t.worktree);
  assertMergeable(repo, t.base_branch);
  const main = safeGit(repo, "rev-parse", "HEAD");
  if (isAncestor(repo, main, t.approved_sha)) {
    const merged = mergeLocal(repo, t.base_branch, t.approved_sha);
    return { evidence: [...t.evidence, merged], history: log(t, "merge_pr", merged) };
  }
  const conflicts = rebaseOnto(t.worktree, main, t.base);
  if (conflicts) {
    const where = conflicts.length ? ` in ${conflicts.join(", ")}` : "";
    throw new Error(`${t.base_branch} moved and the rebase onto ${main.slice(0, 7)} failed${where}; ` +
      `run \`git rebase --onto ${main.slice(0, 7)} ${t.base.slice(0, 7)}\` in ${t.worktree}, resolve, then answer retry (it comes back for approval)`);
  }
  const sha = safeGit(t.worktree, "rev-parse", "HEAD");
  const note = `rebased onto ${main.slice(0, 7)} as ${sha.slice(0, 7)}`;
  if (sha === main) return { base: main, approved_sha: sha, history: log(t, "merge_pr", `${note}: the ticket is already in ${t.base_branch}`) };
  const v = verifyTicket(t, main);
  if (!v.ok && v.host)
    return { base: main, status: "host_review", host_pending: v.host, history: log(t, "merge_pr", `${note}; the rebase changed host files: approve again`) };
  if (!v.ok)
    return {
      base: main, status: "dev_failed", revisions: t.revisions + 1,
      summary: `${t.base_branch} moved; the ticket was rebased onto it and the verification failed: ${v.reason}`.slice(0, 500),
      history: log(t, "merge_pr", `${note}; verification failed`),
    };
  const evidence = [...v.evidence, ...t.evidence.filter((e) => !/^(commit|tests):/.test(e))];
  const onMain = new Set(changed(repo, t.base, main));
  const overlap = changed(t.worktree, main, sha).filter((f) => onMain.has(f));
  const moved = { base: main, approved_sha: sha, evidence };
  if (overlap.length)
    return { ...moved, status: "approval", history: log(t, "merge_pr", `${note}; ${t.base_branch} also changed ${overlap.join(", ")}: approve again`) };
  const merged = mergeLocal(repo, t.base_branch, sha);
  return { ...moved, evidence: [...evidence, merged], history: log(t, "merge_pr", `${note}; ${merged}`) };
}

// The ticket's commits are on `upstream`: merged there by hand, or each one with an equivalent patch (a hand cherry-pick).
// ponytail: per-commit patch-ids; a hand squash of several commits is not detected.
export function landedOn(repo: string, upstream: string, id: string, base: string): boolean {
  try {
    const tip = safeGit(repo, "rev-parse", `ticket/${id}`);
    if (tip !== base && isAncestor(repo, tip, upstream)) return true;
    const lines = safeGit(repo, "cherry", upstream, tip).split("\n").filter(Boolean);
    return lines.length > 0 && lines.every((l) => l.startsWith("-"));
  } catch {
    return false;
  }
}

// The CEO resolved a failed rebase by hand: the new HEAD sits on top of main. It is verified against main like any ticket
// and goes back for approval, since its content is no longer the commit that was approved.
export function handRebased(t: T): Partial<T> {
  const repo = t.repo || repoOf(t.worktree);
  const main = safeGit(repo, "rev-parse", t.base_branch);
  const head = safeGit(t.worktree, "rev-parse", "HEAD");
  if (head === main || !isAncestor(repo, main, head)) throw new Error("commit changed since it was published");
  const v = verifyTicket(t, main);
  if (!v.ok) throw new Error(`invalid evidence: ${v.reason}`);
  return {
    status: "approval", base: main, approved_sha: v.sha,
    evidence: [...v.evidence, ...t.evidence.filter((e) => !/^(commit|tests):/.test(e))],
    history: log(t, "merge_pr", `rebased by hand onto ${main.slice(0, 7)} as ${v.sha.slice(0, 7)}: approve again`),
  };
}
