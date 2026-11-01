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

// The target repo's CLAUDE.md, from the base commit (a ticket cannot edit its own rules). `claude -p` with our flags
// does not load it by itself, so the dev gets it in its context. Capped: it is paid for on every dev turn.
export function loadConventions(repo: string, ref: string, max = 8000): string {
  try {
    return safeGit(repo, "show", `${ref}:CLAUDE.md`).slice(0, max);
  } catch {
    return "";
  }
}
