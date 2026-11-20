// Evidence verified by code (zero token cost): what the agent claims does not count.
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { minimalEnv } from "./agent-env.ts";
import { NODE_TIMEOUT_MS } from "./flow-limits.ts";
import { shadowsBin } from "./platform.ts";
import { safeGit } from "./git-safe.ts";
import { MAX_FILE_LINES, MAX_LINE_COLS, modularityViolations } from "./modularity.ts";
import { commands, DEFAULT_INSTALL, DEFAULT_TEST, type Test } from "./commands.ts";
import { addedSkips, type Counts, runTests, untestedLogic } from "./test-report.ts";

export const UNTESTED = "the diff changes logic without adding or changing a test";
export const CRITERIA_GAP = "acceptance criteria without a test at HEAD in criteria_tests";
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

type Verdict = { ok: true; author: string; sha: string; evidence: string[]; counts: Counts | null; none: boolean } | { ok: false; reason: string; host?: string[] };

export function verifyEvidence(wt: string, base: string, test: Test = DEFAULT_TEST, install = false, hostApproved: string[] = [], baseTests: Counts | null = null, setupIgnored: string[] | null = null, env: string[] = [], criteria: string[] = [], links: T["criteria_tests"] = []): Verdict {
  const git = (...a: string[]) => safeGit(wt, ...a);
  const sha = git("rev-parse", "HEAD");
  if (Number(git("rev-list", "--count", `${base}..HEAD`)) === 0) return { ok: false, reason: "no new commit in the worktree" };
  // With install, whatever the agent left outside the commit is wiped first and node_modules is rebuilt from the lockfile just before the test.
  // Another setup's output is not rebuilt (it would run agent-edited code on the host), so then only node_modules goes and the snapshot guards the rest.
  if (install && !setupIgnored) git("clean", "-fdXq");
  else if (install) {
    const deps = ignoredDeps(wt);
    if (deps.length) git("--literal-pathspecs", "clean", "-fdXq", "--", ...deps);
  }
  // assume-unchanged / skip-worktree hide edits from `git status` and from the diff gate while npm still reads them from disk.
  if (git("ls-files", "-v").split("\n").some((l) => /^[a-zS] /.test(l))) {
    return { ok: false, reason: "worktree has files hidden from git (assume-unchanged or skip-worktree)" };
  }
  // npm test runs over the working tree: only what is committed counts, with no dirt and no ignored executable file.
  // `-z` keeps paths unquoted, so an ignored host file with a space (or any special char) cannot slip past RUNS_ON_HOST.
  const dirt = git("status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored").split("\0").filter(Boolean);
  if (dirt.some((l) => !l.startsWith("!!"))) return { ok: false, reason: "worktree has uncommitted changes" };
  if (setupIgnored) {
    const fresh = setupSnapshot(wt, install).filter((k) => !setupIgnored.includes(k));
    if (fresh.length) return { ok: false, reason: `ignored file that runs code on the host is new or changed since setup (${fresh.slice(0, 5).join(", ")})` };
  } else if (dirt.some((l) => RUNS_ON_HOST.test(l.slice(3)))) return { ok: false, reason: "file that runs code on the host is outside the commit (ignored)" };
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
  const untested = untestedLogic(diffFiles("--diff-filter=d"));
  if (untested.length) return { ok: false, reason: `${UNTESTED} (${untested.slice(0, 5).join(", ")})` };
  const gaps = unique(criteria).map((c) => criterionGap(wt, c, links)).filter(Boolean);
  if (gaps.length) return { ok: false, reason: `${CRITERIA_GAP} (${gaps.slice(0, 5).join("; ")})` };
  try {
    if (install) installDeps(wt, DEFAULT_INSTALL, env, false);
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  const baseNone = !!baseTests && baseTests.pass + baseTests.skip + baseTests.fail === 0;
  const { failure, counts, none } = runTests(wt, test, baseNone);
  if (failure) return { ok: false, reason: failure };
  if (none && !baseNone) return { ok: false, reason: "no tests collected: the base suite had tests (or its count is unknown) and this run found none" };
  // npm test runs repo code: if it moved HEAD or dirtied the tree, the verification is void.
  if (git("rev-parse", "HEAD") !== sha) return { ok: false, reason: "HEAD changed during verification" };
  const linked = resolve(wt, git("rev-parse", "--git-dir")) !== resolve(wt, git("rev-parse", "--git-common-dir"));
  if (linked) git("clean", "-fdq");
  if (git("status", "--porcelain", linked ? "--untracked-files=no" : "--untracked-files=all").length) return { ok: false, reason: "worktree changed during verification" };
  const tally = counts ? ` (pass ${counts.pass}, skip ${counts.skip}, fail ${counts.fail})` : "";
  const evidence = [`commit:${git("rev-parse", "--short", sha)}`, `tests:${commands(test).join(" + ")} ${none ? "none collected" : `ok${tally}`}`];
  return { ok: true, sha, author: git("log", "-1", "--format=%an", sha), evidence, counts, none };
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

const MANUAL = /^manual:\s*(\S[\s\S]*)$/;
const unique = (criteria: string[]) => [...new Set(criteria.map((c) => c.trim()))];
const testsOf = (c: string, links: T["criteria_tests"]) => links.filter((l) => l.criterion.trim() === c).map((l) => l.test.trim());

// A criterion is listed as manual only when none of its links is a valid test.
export const manualCriteria = (wt: string, criteria: string[], links: T["criteria_tests"]) =>
  unique(criteria).flatMap((c) => {
    const tests = testsOf(c, links);
    const m = tests.some((x) => !testGap(wt, x)) ? null : tests.map((x) => MANUAL.exec(x)).find(Boolean);
    return m ? [`${c}: ${m[1]}`] : [];
  });

// Met when any link is a valid test or a manual reason; otherwise the first link's problem is reported.
function criterionGap(wt: string, c: string, links: T["criteria_tests"]): string {
  const tests = testsOf(c, links);
  if (tests.some((x) => MANUAL.test(x) || !testGap(wt, x))) return "";
  return `${c}: ${tests.length ? testGap(wt, tests[0]) : "no test linked"}`;
}

// ponytail: "the test name appears in the file" is a substring check, not a parsed test declaration; QA judges whether the test covers the criterion.
function testGap(wt: string, test: string): string {
  const at = test.indexOf("::");
  const file = test.slice(0, at);
  const name = test.slice(at + 2).trim();
  if (at < 1 || !file || !name) return "no test linked";
  let body: string;
  try {
    const blob = blobAt(wt, file);
    if (blob === "deleted") return `${file} not at HEAD`;
    body = safeGit(wt, "cat-file", "blob", blob);
  } catch {
    return `${file} not at HEAD`;
  }
  return body.includes(name) ? "" : `test name not found in ${file}`;
}

export const verifyTicket = (
  t: Pick<T, "worktree" | "base" | "test" | "install" | "host_approved" | "test_base" | "setup_ignored" | "setup_env" | "criteria" | "criteria_tests">,
  base = t.base,
) => verifyEvidence(t.worktree, base, t.test, t.install, t.host_approved, t.test_base, t.setup_ignored, t.setup_env, t.criteria, t.criteria_tests);

// The ignored node_modules dirs git lists on their own (a symlink comes without the trailing slash); one nested in another ignored dir is not.
function ignoredDeps(wt: string): string[] {
  return safeGit(wt, "ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory").split("\0").filter((f) => /(^|\/)node_modules\/?$/.test(f));
}

// What setup left behind: ignored files npm or pip would run, as path@sha1. Verification tolerates exactly these and rejects anything new or edited.
// With install, node_modules is rebuilt before every verification, so it is left out.
export function setupSnapshot(wt: string, install = false): string[] {
  const deps = install ? ignoredDeps(wt).map((d) => (d.endsWith("/") ? d : `${d}/`)) : [];
  return safeGit(wt, "ls-files", "-z", "--others", "--ignored", "--exclude-standard").split("\0")
    .filter((f) => f && RUNS_ON_HOST.test(f) && !deps.some((d) => f.startsWith(d)))
    .map((f) => {
      let sha = "unreadable";
      try {
        sha = createHash("sha1").update(readFileSync(join(wt, f))).digest("hex");
      } catch {}
      return `${f}@${sha}`;
    });
}


// Host-side install for repos that opt in (`install` in the repo config): the lockfile comes from the base commit and no package script runs.
// The stderr can echo the env values, so the verification (whose reason the agent reads) leaves it out.
export function installDeps(wt: string, install = DEFAULT_INSTALL, envNames: string[] = [], stderr = true): void {
  if (install === DEFAULT_INSTALL) {
    try {
      safeGit(wt, "cat-file", "-e", "HEAD:package-lock.json");
    } catch {
      throw new Error("install: the repo has no committed package-lock.json");
    }
    // npm ci empties node_modules, and through a symlink or junction it would empty the target.
    if (lstatSync(join(wt, "node_modules"), { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("install: node_modules is a symlink");
    // A workspace's node_modules is emptied too; a tracked symlink there would be followed. `git clean` cannot
    // remove it (it is tracked), so refuse before npm ci runs.
    const trackedSymlink = safeGit(wt, "ls-files", "-s", "-z").split("\0").filter(Boolean)
      .some((l) => l.startsWith("120000 ") && /(^|\/)node_modules$/.test(l.split("\t")[1] ?? ""));
    if (trackedSymlink) throw new Error("install: a tracked node_modules symlink would let npm ci empty its target");
  }
  const bin = install.split(" ")[0];
  if (shadowsBin(wt, bin)) throw new Error(`setup refused (${install}): ${bin} exists in the worktree and would shadow the binary`);
  const env = minimalEnv("dev");
  env.NoDefaultCurrentDirectoryInExePath = "1";
  for (const k of envNames) if (!(k in env) && process.env[k] !== undefined) env[k] = process.env[k];
  try {
    execSync(install, { cwd: wt, env, stdio: "pipe", timeout: NODE_TIMEOUT_MS });
  } catch (e) {
    const err = e as { status?: number | null; signal?: string | null; stderr?: Buffer };
    const tail = stderr ? `: ${String(err.stderr ?? "").slice(-400)}` : "";
    throw new Error(`setup failed (${install}), exit ${err.status ?? err.signal}${tail}`);
  }
}
