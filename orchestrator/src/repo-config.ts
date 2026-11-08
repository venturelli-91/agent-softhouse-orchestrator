import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { orchHome } from "./daily-cap.ts";
import { safeGit } from "./guardrails.ts";
import { SPECIALTIES } from "./specialties.ts";

const plain = z.string().regex(/^[\w ./:=@-]+$/, "must be a plain command without shell operators");
// Real deploy commands run on the host with credentials, so this block is accepted only from the external config.
export const DeployConfig = z.object({
  command: plain,
  rollback: plain,
  health_url: z.string().refine((u) => URL.canParse(u) && /^https?:$/.test(new URL(u).protocol) && !new URL(u).username && !new URL(u).password,
    "health_url must be an http or https URL without credentials"),
  environment: z.enum(["staging", "production"]).default("staging"),
  env: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/)).default([]),
  timeout_s: z.number().positive().max(3600).default(300),
  max_latency_ms: z.number().positive().default(2000),
});
export type DeployConfig = z.infer<typeof DeployConfig>;

const tagId = (prefix: string) => z.array(z.string().regex(new RegExp(`^${prefix}-[A-Z0-9]+$`))).default([]);
// The app is started on the host from the ticket's worktree, so, like deploy, this block comes only from the external config.
export const WebcheckConfig = z.object({
  serve: plain,
  base_url: z.string().refine((u) => URL.canParse(u) && /^https?:$/.test(new URL(u).protocol) && ["localhost", "127.0.0.1"].includes(new URL(u).hostname),
    "base_url must be an http(s) URL on localhost or 127.0.0.1"),
  paths: z.array(z.string().regex(/^\/(?!\/)[\w./-]*$/)).min(1).default(["/"]),
  gtm: tagId("GTM"),
  ga4: tagId("G"),
  ads: tagId("AW"),
  lcp_ms: z.number().positive().optional(),
  cls: z.number().positive().optional(),
  timeout_s: z.number().positive().max(600).default(60),
  env: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/)).default([]),
});
export type WebcheckConfig = z.infer<typeof WebcheckConfig>;

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
  // Run `npm ci --ignore-scripts` on the host in each new worktree, from the base commit lockfile, so lint, tsc and build can be the test command.
  install: z.boolean().default(false),
  deploy: DeployConfig.nullable().default(null),
  webcheck: WebcheckConfig.nullable().default(null),
  // The dev specialties triage may route to in this repo; the whole team by default.
  specialties: z.array(z.enum(SPECIALTIES)).min(1).default([...SPECIALTIES]),
  // The stack the team decided (`orch team`); goes into every dev's context next to the repo conventions.
  stack: z.string().max(400).default(""),
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
    for (const k of ["deploy", "webcheck"]) if (raw && typeof raw === "object" && k in raw) throw new Error(`.orchestrator.json: ${k} is only accepted in the external config`);
    inRepo = check(".orchestrator.json", raw);
  } catch (e) {
    if ((e as Error).message.startsWith(".orchestrator.json:")) throw e;
  }
  return RepoConfig.parse({ ...external(repo, home), ...inRepo });
}

// A bare `node --test` scans the whole tree, so it would also run orchestrator/tests inside every ticket worktree.
export function bareNodeTest(repo: string): boolean {
  try {
    return /^node\s+--test(\s+--[\w-]+)*\s*$/.test(JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).scripts?.test);
  } catch {
    return false;
  }
}

// The target repo rules: .claude/CLAUDE.md on disk, else the root CLAUDE.md from the base commit (a ticket cannot edit its own rules). `claude -p`
// with our flags
// does not load it by itself, so the dev gets it in its context. Capped: it is paid for on every dev turn.
export function loadConventions(repo: string, ref: string, max = 8000): string {
  // .claude/ is local only (never committed), so its CLAUDE.md is read from disk; the agent cannot edit it from its worktree.
  // A copy committed at the base commit went through a PR, not through the CEO's own disk: it is not trusted over the root file.
  // Matched case-insensitively (the disk read is) and against the index too, in case another ticket merged it after this base was cut.
  const isRules = (names: string) => names.split("\0").some((n) => n.toLowerCase() === ".claude/claude.md");
  let tracked: boolean;
  try {
    // Only the .claude directory is listed (any case): a full listing can overflow the git output buffer on a big repo.
    const dirs = safeGit(repo, "ls-tree", "-z", "--name-only", ref).split("\0").filter((n) => n.toLowerCase() === ".claude");
    tracked = dirs.some((d) => isRules(safeGit(repo, "ls-tree", "-r", "-z", "--name-only", ref, "--", d)))
      || isRules(safeGit(repo, "ls-files", "-z", "--", ":(icase).claude"));
  } catch {
    tracked = true; // fail closed: if git cannot tell, do not trust the disk copy
  }
  try {
    const local = join(repo, ".claude", "CLAUDE.md");
    if (!tracked && !lstatSync(join(repo, ".claude")).isSymbolicLink() && lstatSync(local).isFile()) return readFileSync(local, "utf8").slice(0, max);
  } catch {}
  try {
    return safeGit(repo, "show", `${ref}:CLAUDE.md`).slice(0, max);
  } catch {
    return "";
  }
}
