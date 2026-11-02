import { safeGit, safeRemoteGit } from "./guardrails.ts";

// Never throws: offline or no upstream just means "unknown", and must not block a run.
export function behindBy(repo: string): number | null {
  try {
    const upstream = safeGit(repo, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}");
    safeRemoteGit(repo, "-c", "gc.auto=0", "fetch", "-q", "--no-recurse-submodules", "--", upstream.split("/")[0]);
    return Number(safeGit(repo, "rev-list", "--count", "HEAD..@{u}"));
  } catch {
    return null;
  }
}

export function deleteRemoteBranch(repo: string, remote: string, id: string): "deleted" | "absent" {
  const ref = `ticket/${id}`;
  if (!safeRemoteGit(repo, "ls-remote", "--heads", "--", remote, ref)) return "absent";
  safeRemoteGit(repo, "push", "--no-verify", "--", remote, `:refs/heads/${ref}`);
  return "deleted";
}
