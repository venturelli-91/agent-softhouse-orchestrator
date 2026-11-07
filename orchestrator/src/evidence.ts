// Evidence verified by code (zero token cost): what the agent claims does not count.
import { execSync } from "node:child_process";
import { minimalEnv } from "./agent-env.ts";
import { NODE_TIMEOUT_MS } from "./flow-limits.ts";
import { safeGit } from "./git-safe.ts";
import { MAX_FILE_LINES, MAX_LINE_COLS, modularityViolations } from "./modularity.ts";
import { DEFAULT_TEST } from "./permissions.ts";

// Paths no agent may change: secrets, CI and the orchestrator itself.
const FORBIDDEN = new RegExp(
  [String.raw`(^|\/)\.env`, String.raw`^\.github\/`, String.raw`^orchestrator\/`, String.raw`^\.orchestrator\.json$`,
    String.raw`(^|\/)(\.git-credentials|\.npmrc|id_rsa[^/]*)$`, String.raw`\.(pem|key)$`, "credential", "secret"].join("|"), "i",
);

// Files npm runs on the host: if the agent changed them, the ticket goes to the CEO instead of running.
const RUNS_ON_HOST = /(^|\/)(package\.json|\.npmrc|conftest\.py|setup\.py|setup\.cfg|pyproject\.toml|pytest\.ini|tox\.ini|Makefile)$/i;

type Verdict = { ok: true; author: string; sha: string; evidence: string[] } | { ok: false; reason: string };

export function verifyEvidence(wt: string, base: string, test = DEFAULT_TEST, install = false): Verdict {
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
  const forbidden = files.filter((f) => FORBIDDEN.test(f));
  if (forbidden.length) return { ok: false, reason: `diff touches forbidden path (${forbidden.join(", ")})` };
  const risky = files.filter((f) => RUNS_ON_HOST.test(f) || (install && /(^|\/)(package-lock|npm-shrinkwrap)\.json$/i.test(f)));
  if (risky.length) return { ok: false, reason: `diff touches a file that runs code on the host (${risky.join(", ")}): requires CEO review` };
  const oversized = modularityViolations(wt, diffFiles("--diff-filter=d"));
  if (oversized.length) {
    const limit = `${MAX_FILE_LINES} lines, ${MAX_LINE_COLS} cols`;
    return { ok: false, reason: `touched files break the modularity limit (${limit}): ${oversized.join(", ")}; split them` };
  }
  if (install) installDeps(wt);
  try {
    // execSync (shell) because npm is npm.cmd on Windows. `test` comes from .orchestrator.json at the base commit
    // (a ticket cannot edit it) and RepoConfig only accepts a plain command with no shell operators.
    execSync(test, { cwd: wt, env: minimalEnv("dev"), stdio: "pipe", timeout: NODE_TIMEOUT_MS });
  } catch (e) {
    return { ok: false, reason: `${test} failed: ${String((e as { stdout?: Buffer }).stdout ?? "").slice(-400)}` };
  }
  // npm test runs repo code: if it moved HEAD or dirtied the tree, the verification is void.
  if (git("rev-parse", "HEAD") !== sha) return { ok: false, reason: "HEAD changed during verification" };
  if (git("status", "--porcelain", "--untracked-files=all").length) return { ok: false, reason: "worktree changed during verification" };
  const evidence = [`commit:${git("rev-parse", "--short", sha)}`, `tests:${test} ok`];
  return { ok: true, sha, author: git("log", "-1", "--format=%an", sha), evidence };
}

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
