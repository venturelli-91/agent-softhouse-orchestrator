import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { DEFAULT_TEST, safeCommand, TestSpec } from "./commands.ts";
import { orchHome } from "./daily-cap.ts";
import { ALLOWED_ENV, minimalEnv } from "./agent-env.ts";
import { safeGit } from "./guardrails.ts";
import { SPECIALTIES } from "./specialties.ts";
import { ProposedAgents } from "./team.ts";

const plain = safeCommand();
const urlPath = z.string().regex(/^\/(?!\/)[\w./-]*$/);
const jsonBody = z.string().refine((b) => { try { JSON.parse(b); return true; } catch { return false; } }, "body must be a JSON string");
const httpUrl = (name: string) => z.string().refine((u) => URL.canParse(u) && ((x) => /^https?:$/.test(x.protocol) && !x.username && !x.password)(new URL(u)),
  `${name} must be an http or https URL without credentials`);
export const DeployCheck = z.object({
  method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]),
  path: urlPath,
  expect_status: z.number().int().min(100).max(599),
  body: jsonBody.optional(),
}).refine((c) => c.body === undefined || !["GET", "HEAD"].includes(c.method), { message: "GET and HEAD checks cannot carry a body", path: ["body"] });
export type DeployCheck = z.infer<typeof DeployCheck>;
// Real deploy commands run on the host with credentials, so this block is accepted only from the external config.
const DeploySettings = z.object({
  command: plain,
  rollback: plain,
  health_url: httpUrl("health_url"),
  env: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/)).default([]),
  timeout_s: z.number().positive().max(3600).default(300),
  max_latency_ms: z.number().positive().default(2000),
  checks: z.array(DeployCheck).min(1).max(10).optional(),
  metrics_url: httpUrl("metrics_url").optional(),
  max_error_rate: z.number().min(0).max(1).optional(),
  verify_minutes: z.number().min(0).max(60).default(5),
});
const readOnlyChecks = (c: { checks?: DeployCheck[] }) => (c.checks ?? []).every((k) => k.method === "GET" || k.method === "HEAD");
const PRODUCTION_CHECKS = { message: "production checks must be GET or HEAD", path: ["checks"] };
export const DeployConfig = DeploySettings.extend({ environment: z.enum(["staging", "production"]).default("staging") })
  .refine((c) => c.environment !== "production" || readOnlyChecks(c), PRODUCTION_CHECKS);
export type DeployConfig = z.infer<typeof DeployConfig>;
// Pair form: staging runs first, production only after a promotion; a target never names its own environment.
export const PromotedDeploy = z.strictObject({
  staging: DeploySettings.strict(),
  production: DeploySettings.strict().refine(readOnlyChecks, PRODUCTION_CHECKS),
});
export type PromotedDeploy = z.infer<typeof PromotedDeploy>;
export const RepoDeploy = z.union([PromotedDeploy, DeployConfig]);
export type RepoDeploy = z.infer<typeof RepoDeploy>;
export const promotes = (c: RepoDeploy | null): c is PromotedDeploy => !!c && "staging" in c;
export const stageOf = (c: RepoDeploy, promoted: boolean): DeployConfig =>
  promotes(c) ? { ...(promoted ? c.production : c.staging), environment: promoted ? "production" : "staging" } : c;

// Names a setup command may read: an allowlist, since a blocklist always misses a credential shape (DSN, URI, proxy URL with user:pass@).
// Never a loader or tool hook prefix, and never a key minimalEnv already sets or passes (the hardening must not be overridable).
const reserved = new Set([...ALLOWED_ENV, ...Object.keys(minimalEnv("dev", {}))]);
const ALLOWED_NAME = /^(NO_PROXY|TZ|LC_[A-Z]+|[A-Z][A-Z0-9_]*_(HOST|PORT|VERSION))$/;
const HOOK_PREFIX = /^(AWS_|GIT_|NPM_CONFIG_|PIP_|PYTHON|LD_|DYLD_|ANTHROPIC_)/;
const hostName = z.string().refine(
  (n) => !reserved.has(n) && ALLOWED_NAME.test(n) && !HOOK_PREFIX.test(n),
  "env names must be a host, port or version setting (NAME_HOST, NAME_PORT, NAME_VERSION), NO_PROXY, TZ or LC_*",
);

const localUrl = (u: string) => URL.canParse(u) && /^https?:$/.test(new URL(u).protocol) && ["localhost", "127.0.0.1"].includes(new URL(u).hostname);
const tagId = (prefix: string) => z.array(z.string().regex(new RegExp(`^${prefix}-[A-Z0-9]+$`))).default([]);
// The app is started on the host from the ticket's worktree, so, like deploy, this block comes only from the external config.
export const WebcheckConfig = z.object({
  serve: plain,
  base_url: z.string().refine(localUrl, "base_url must be an http(s) URL on localhost or 127.0.0.1"),
  paths: z.array(urlPath).min(1).default(["/"]),
  gtm: tagId("GTM"),
  ga4: tagId("G"),
  ads: tagId("AW"),
  lcp_ms: z.number().positive().optional(),
  cls: z.number().positive().optional(),
  timeout_s: z.number().positive().max(600).default(60),
  env: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/)).default([]),
});
export type WebcheckConfig = z.infer<typeof WebcheckConfig>;

const Thresholds = z.object({
  max_error_rate: z.number().min(0).max(1).default(0.01),
  max_fast_p95_ms: z.number().positive().default(500),
  max_fast_p95_ratio: z.number().positive().default(5),
  recover_s: z.number().positive().default(10),
});
// Starts the service and a delaying proxy on the host from the ticket worktree: like deploy and webcheck, only from the external config.
export const LoadConfig = z.object({
  serve: plain,
  base_url: z.string().refine(localUrl, "base_url must be an http(s) URL on localhost or 127.0.0.1"),
  health_path: urlPath.default("/"),
  writes: z.array(z.object({
    method: z.enum(["POST", "PUT", "PATCH", "DELETE"]),
    path: urlPath,
    body: jsonBody.optional(),
  })).min(1).max(5),
  fast_path: urlPath.default("/"),
  slow_dependency: z.object({
    env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
    target: z.string().regex(/^(localhost|127\.0\.0\.1):\d{1,5}$/, "target must be localhost:port or 127.0.0.1:port").optional(),
    delay_ms: z.number().positive().max(30000),
    // ponytail: optional, not default(false), so configs and in-flight tickets without the key parse exactly as before.
    outage: z.boolean().optional(),
  }).nullable().default(null),
  concurrency: z.number().int().min(1).max(200).default(20),
  duration_s: z.number().positive().max(120).default(20),
  thresholds: Thresholds.default(Thresholds.parse({})),
  runner: plain.optional(),
  env: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/)).default([]),
  timeout_s: z.number().positive().max(600).default(300),
});
export type LoadConfig = z.infer<typeof LoadConfig>;

// Per-repo settings: defaults < `repos[<abs path>]` in ~/.orchestrator/config.json < `.orchestrator.json` at the base
// commit. The in-repo file is read from the base commit, never from the worktree: a ticket cannot rewrite its own rules.
export const RepoConfig = z.strictObject({
  // Plain command (no ;, &&, pipes, quotes or expansions): it runs on the host and goes into the dev's allowlist. A list runs every command.
  test: TestSpec.default(DEFAULT_TEST),
  // "auto" squash-merges after the CEO approves and the CI checks are green; "pr" leaves the PR to the CEO; "local" merges in the local clone.
  merge: z.enum(["pr", "auto", "local"]).default("pr"),
  publisher: z.enum(["github", "none"]).optional(),
  push_remote: z.string().regex(/^[A-Za-z0-9_.][\w.-]*$/, "push_remote must be a plain remote name").default("origin"),
  base_repo: z.string().regex(/^([A-Za-z0-9_.][\w.-]*\/[A-Za-z0-9_.][\w.-]*)?$/, "base_repo must be owner/name").default(""),
  disclosure: z.boolean().default(true),
  // Run `npm ci --ignore-scripts` on the host in each new worktree, from the base commit lockfile, so lint, tsc and build can be the test command.
  install: z.boolean().default(false),
  // Commands run on the host in each new worktree, in order; never in the dev's allowlist. Only from the external config, like deploy.
  // `install: true` is an alias for [DEFAULT_INSTALL], which runs first.
  setup: z.array(safeCommand("setup")).default([]),
  // Host variable names the setup commands may read; nothing else leaks from the operator's environment.
  env: z.array(hostName).default([]),
  deploy: RepoDeploy.nullable().default(null),
  webcheck: WebcheckConfig.nullable().default(null),
  load: LoadConfig.nullable().default(null),
  // The dev specialties triage may route to in this repo; the whole team by default.
  specialties: z.array(z.enum(SPECIALTIES)).min(1).default([...SPECIALTIES]),
  // The stack the team decided (`orch team`); goes into every dev's context next to the repo conventions.
  stack: z.string().max(400).default(""),
  proposed_agents: ProposedAgents.optional(),
  // Tracked docs of the repo (README, CHANGELOG...) the docs node may update on the ticket's branch, before review; exact relative .md paths.
  project_docs: z
    .array(z.string().regex(/^(?!.*(^|\/)\.\.?(\/|$))[\w.-]+(\/[\w.-]+)*\.md$/, "project_docs entries must be relative .md paths"))
    .max(10)
    .default([]),
});
export type RepoConfig = z.infer<typeof RepoConfig>;

function check(source: string, raw: unknown): Record<string, unknown> {
  const parsed = RepoConfig.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ");
    throw new Error(`${source}: ${issues} (accepted keys: ${Object.keys(RepoConfig.shape).join(", ")}; \`orch init\` writes a valid file)`);
  }
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
    for (const k of ["deploy", "webcheck", "load", "env", "setup"]) if (raw && typeof raw === "object" && k in raw) throw new Error(`.orchestrator.json: ${k} is only accepted in the external config`);
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

// Learning loop: the playbooks the CEO committed (postmortems, decisions, recurring failures) reach the dev and the reviewer, newest
// first, from the base commit only (an uncommitted postmortem is still under CEO review; a ticket cannot plant lessons).
// ponytail: newest-first under a cap; rank by relevance to the request if playbooks outgrow it.
export function loadPlaybooks(repo: string, ref: string, max = 6000): string {
  let blobs: string[];
  try {
    // Only blobs: a symlink or submodule entry named *.md is not a playbook.
    blobs = safeGit(repo, "ls-tree", "-z", ref, "--", "playbooks/").split("\0")
      .map((l) => l.split("\t"))
      .filter(([meta, n]) => meta?.startsWith("100") && meta.includes(" blob ") && /^playbooks\/[^/]+\.md$/i.test(n ?? ""))
      .map(([meta, n]) => `${n}\t${meta.split(" ")[2]}`);
  } catch {
    return "";
  }
  let out = "";
  for (const entry of blobs.sort().reverse()) {
    if (out.length >= max) break;
    const [n, sha] = entry.split("\t");
    try {
      out += `--- ${n}\n${safeGit(repo, "cat-file", "blob", sha).slice(0, max).trim()}\n\n`;
    } catch {}
  }
  return out.slice(0, max).trim();
}
