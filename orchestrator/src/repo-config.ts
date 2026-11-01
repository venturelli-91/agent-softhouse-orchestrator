import { z } from "zod";
import { safeGit } from "./guardrails.ts";

// Per-repo settings in `.orchestrator.json` at the repo root. Read from the base commit, never from the
// worktree: a ticket cannot rewrite its own rules. Missing file = the defaults below.
export const RepoConfig = z.object({
  // Plain command (no ;, &&, pipes, quotes or expansions): it runs on the host and goes into the dev's allowlist.
  test: z.string().regex(/^[\w ./:=@-]+$/, "test must be a plain command without shell operators").default("npm test"),
  // "auto" squash-merges after the CEO approves and the CI checks are green; "pr" leaves the PR to the CEO.
  merge: z.enum(["pr", "auto"]).default("pr"),
});
export type RepoConfig = z.infer<typeof RepoConfig>;

export function loadRepoConfig(repo: string, ref: string): RepoConfig {
  let raw: string;
  try {
    raw = safeGit(repo, "show", `${ref}:.orchestrator.json`);
  } catch {
    return RepoConfig.parse({});
  }
  const parsed = RepoConfig.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error(`.orchestrator.json: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return parsed.data;
}
