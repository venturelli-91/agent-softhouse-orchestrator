import { devNull, safeGit } from "./guardrails.ts";

// Fast-forward only: the main checkout moves to exactly the commit the CEO approved, or nothing changes.
export function mergeLocal(repo: string, branch: string, sha: string): string {
  if (branch === "HEAD" || safeGit(repo, "rev-parse", "--abbrev-ref", "HEAD") !== branch) throw new Error(`branch ${branch
    || "(none)"} is not checked out in the main checkout`);
  if (safeGit(repo, "status", "--porcelain")) throw new Error("main checkout has uncommitted changes");
  try {
    safeGit(repo, "merge-base", "--is-ancestor", "HEAD", sha);
  } catch {
    throw new Error(`${branch} diverged from the approved commit`);
  }
  safeGit(repo, "-c", `core.hooksPath=${devNull}`, "merge", "--ff-only", "--no-overwrite-ignore", sha);
  return `merged:local@${sha.slice(0, 7)}`;
}
