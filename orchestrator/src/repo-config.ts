import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { orchHome } from "./daily-cap.ts";
import { safeGit } from "./guardrails.ts";

const plain = z.string().regex(/^[\w ./:=@-]+$/, "must be a plain command without shell operators");
// Real deploy commands run on the host with credentials, so this block is accepted only from the external config.
export const DeployConfig = z.object({
  command: plain,
  rollback: plain,
  health_url: z.string().refine((u) => URL.canParse(u) && /^https?:$/.test(new URL(u).protocol) && !new URL(u).username && !new URL(u).password, "health_url must be an http or https URL without credentials"),
  environment: z.enum(["staging", "production"]).default("staging"),
  env: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/)).default([]),
  timeout_s: z.number().positive().max(3600).default(300),
  max_latency_ms: z.number().positive().default(2000),
});
export type DeployConfig = z.infer<typeof DeployConfig>;

// Per-repo settings: defaults < `repos[<abs path>]` in ~/.orchestrator/config.json < `.orchestrator.json` at the base
// commit. The in-repo file is read from the base commit, never from the worktree: a ticket cannot rewrite its own rules.
export const RepoConfig = z.object({
  // Plain command (no ;, &&, pipes, quotes or expansions): it runs on the host and goes into the dev's allowlist.
  test: z.string().regex(/^[\w ./:=@-]+$/, "test must be a plain command without shell operators").default("npm test"),
  // "auto" squash-merges after the CEO approves and the CI checks are green; "pr" leaves the PR to the CEO; "local" merges in the local clone.
  merge: z.enum(["pr", "auto", "local"]).default("pr"),
  publisher: z.enum(["github", "none"]).optional(),
  push_remote: z.string().regex(/^[A-Za-z0-9_.][\w.-]*$/, "push_remote must be a plain remote name").default("origin"),
  base_repo: z.string().regex(/^([A-Za-z0-9_.][\w.-]*\/[A-Za-z0-9_.][\w.-]*)?$/, "base_repo must be owner/name").default(""),
  disclosure: z.boolean().default(true),
  deploy: DeployConfig.nullable().default(null),
});
export type RepoConfig = z.infer<typeof RepoConfig>;

function check(source: string, raw: unknown): Record<string, unknown> {
  const parsed = RepoConfig.safeParse(raw);
  if (!parsed.success) throw new Error(`${source}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return raw as Record<string, unknown>;
}

function readJson(source: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${source}: ${(e as Error).message}`);
  }
}

function external(repo: string, home: string): Record<string, unknown> {
  const file = join(home, "config.json");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return {};
  }
  const entry = (readJson(file, text) as { repos?: Record<string, unknown> } | null)?.repos?.[resolve(repo)];
  return entry === undefined ? {} : check(file, entry);
}

export function loadRepoConfig(repo: string, ref: string, home = orchHome()): RepoConfig {
  let inRepo: Record<string, unknown> = {};
  try {
    const text = safeGit(repo, "show", `${ref}:.orchestrator.json`);
    const raw = readJson(".orchestrator.json", text);
    if (raw && typeof raw === "object" && "deploy" in raw) throw new Error(".orchestrator.json: deploy is only accepted in the external config");
    inRepo = check(".orchestrator.json", raw);
  } catch (e) {
    if ((e as Error).message.startsWith(".orchestrator.json:")) throw e;
  }
  return RepoConfig.parse({ ...external(repo, home), ...inRepo });
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
