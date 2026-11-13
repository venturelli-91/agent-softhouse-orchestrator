// Evidence verified by code (zero token cost): what the agent claims does not count.
import { execSync } from "node:child_process";
import { minimalEnv } from "./agent-env.ts";
import { NODE_TIMEOUT_MS } from "./flow-limits.ts";
import { safeGit } from "./git-safe.ts";
import { MAX_FILE_LINES, MAX_LINE_COLS, modularityViolations } from "./modularity.ts";
import { DEFAULT_TEST } from "./permissions.ts";
import { addedSkips, commands, type Counts, runTests, type Test } from "./test-report.ts";
import type { T } from "./ticket.ts";

// Paths no agent may change: secrets (never, not even adopted), and CI and the orchestrator itself (only in a version `orch adopt` took
// from the CEO's own working tree, path@blob like a host file).
const SECRET = new RegExp(
  [String.raw`(^|\/)\.env`, String.raw`(^|\/)(\.git-credentials|\.npmrc|id_rsa[^/]*)$`, String.raw`\.(pem|key)$`, "credential", "secret"].join("|"), "i",
);
const PROTECTED = /^\.github\/|^orchestrator\/|^\.orchestrator\.json$/i;

// Files npm runs on the host: if the agent changed them, the ticket goes to the CEO instead of running.
// The CEO approves one content (path@blob at HEAD), so any later edit to the file asks again.
const RUNS_ON_HOST = /(^|\/)(package\.json|\.npmrc|conftest\.py|setup\.py|setup\.cfg|pyproject\.toml|pytest\.ini|tox\.ini|Makefile)$/i;

type Verdict = { ok: true; author: string; sha: string; evidence: string[]; counts: Counts | null } | { ok: false; reason: string; host?: string[] };

export function verifyEvidence(wt: string, base: string, test: Test = DEFAULT_TEST, install = false, hostApproved: string[] = []): Verdict {
  const git = (...a: string[]) => safeGit(wt, ...a);
  const sha = git("rev-parse", "HEAD");
  if (Number(git("rev-list", "--count", `${base}..HEAD`)) === 0) return { ok: false, reason: "no new commit in the worktree" };
  // With install, whatever the agent left outside the commit is wiped first and node_modules is rebuilt from the lockfile just before the test.
  if (install) git("clean", "-fdXq");
  // assume-unchanged / skip-worktree hide edits from `git status` and from the diff gate while npm still reads them from disk.
  if (git("ls-files", "-v").split("\n").some((l) => /^[a-zS] /.test(l))) {
    return { ok: false, reason: "worktree has files hidden from git (assume-unchanged or skip-worktree)" };
  }
  // npm test runs over the working tree: only what is committed counts, with no dirt and no ignored executable file.
  const dirt = git("status", "--porcelain", "--untracked-files=all", "--ignored").split("\n").filter(Boolean);
  if (dirt.some((l) => !l.startsWith("!!"))) return { ok: false, reason: "worktree has uncommitted changes" };
  if (dirt.some((l) => RUNS_ON_HOST.test(l.slice(3)))) return { ok: false, reason: "file that runs code on the host is outside the commit (ignored)" };
  const diffFiles = (...extra: string[]) =>
    git("-c", "core.quotePath=false", "diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", ...extra, `${base}..HEAD`).split("\0").filter(Boolean);
  const files = diffFiles();
  const forbidden = files.filter((f) => SECRET.test(f) || (PROTECTED.test(f) && !hostApproved.includes(`${f}@${blobAt(wt, f)}`)));
  if (forbidden.length) return { ok: false, reason: `diff touches forbidden path (${forbidden.join(", ")})` };
  const host = files
    .filter((f) => runsOnHost(f, install))
    .map((f) => `${f}@${blobAt(wt, f)}`)
    .filter((k) => !hostApproved.includes(k));
  if (host.length) return { ok: false, reason: `diff touches a file that runs code on the host (${host.join(", ")}): requires CEO review`, host };
  const oversized = modularityViolations(wt, diffFiles("--diff-filter=d"));
  if (oversized.length) {
    const limit = `${MAX_FILE_LINES} lines, ${MAX_LINE_COLS} cols`;
    return { ok: false, reason: `touched files break the modularity limit (${limit}): ${oversized.join(", ")}; split them` };
  }
  const skips = addedSkips(git("-c", "core.quotePath=false", "diff", "-U0", "--text", "--no-color", "--no-ext-diff", "--no-textconv", `${base}..HEAD`));
  if (skips.length) return { ok: false, reason: `the diff skips tests instead of making them pass (${skips.slice(0, 5).join("; ")})` };
  if (install) installDeps(wt);
  const { failure, counts } = runTests(wt, test);
  if (failure) return { ok: false, reason: failure };
  // npm test runs repo code: if it moved HEAD or dirtied the tree, the verification is void.
  if (git("rev-parse", "HEAD") !== sha) return { ok: false, reason: "HEAD changed during verification" };
  if (git("status", "--porcelain", "--untracked-files=all").length) return { ok: false, reason: "worktree changed during verification" };
  const tally = counts ? ` (pass ${counts.pass}, skip ${counts.skip}, fail ${counts.fail})` : "";
  const evidence = [`commit:${git("rev-parse", "--short", sha)}`, `tests:${commands(test).join(" + ")} ok${tally}`];
  return { ok: true, sha, author: git("log", "-1", "--format=%an", sha), evidence, counts };
}

const runsOnHost = (f: string, install: boolean) => RUNS_ON_HOST.test(f) || (install && /(^|\/)(package-lock|npm-shrinkwrap)\.json$/i.test(f));

export const secretPaths = (files: string[]) => files.filter((f) => SECRET.test(f));
export const protectedPaths = (files: string[]) => files.filter((f) => PROTECTED.test(f));

// `orch adopt`: the CEO's own changes (tree) against the base. Protected and host files of exactly this content are approved up front,
// so a later edit by the dev asks again.
export function adoptKeys(wt: string, base: string, tree: string, install: boolean): string[] {
  const files = safeGit(wt, "-c", "core.quotePath=false", "diff", "--name-only", "-z", "--no-renames", base, tree).split("\0").filter(Boolean);
  return files.filter((f) => PROTECTED.test(f) || runsOnHost(f, install)).map((f) => `${f}@${blobAt(wt, f, tree)}`);
}

// Agent-chosen names: literal pathspecs and an exact path match, or the gate fails closed.
function blobAt(wt: string, f: string, rev = "HEAD"): string {
  const out = safeGit(wt, "--literal-pathspecs", "ls-tree", "-z", rev, "--", f);
  if (!out) return "deleted";
  const [meta, path] = out.split("\0")[0].split("\t");
  if (path !== f) throw new Error(`ls-tree resolved ${f} to ${path}`);
  return meta.split(" ")[2];
}

export const verifyTicket = (t: Pick<T, "worktree" | "base" | "test" | "install" | "host_approved">, base = t.base) =>
  verifyEvidence(t.worktree, base, t.test, t.install, t.host_approved);


// Host-side install for repos that opt in (`install` in the repo config): the lockfile comes from the base commit and no package script runs.
export function installDeps(wt: string): void {
  try {
    safeGit(wt, "cat-file", "-e", "HEAD:package-lock.json");
  } catch {
    throw new Error("install: the repo has no committed package-lock.json");
  }
  try {
    execSync("npm ci --ignore-scripts --no-audit --no-fund", { cwd: wt, env: minimalEnv("dev"), stdio: "pipe", timeout: NODE_TIMEOUT_MS });
  } catch (e) {
    throw new Error(`install failed: ${String((e as { stderr?: Buffer }).stderr ?? "").slice(-400)}`);
  }
}
