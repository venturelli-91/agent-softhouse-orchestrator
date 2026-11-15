// Stop: when the session changed logic files, the turn only ends with a test touched and the suite green.
// ponytail: mirrors untestedLogic in orchestrator/src/test-report.ts (.claude/ ships without orchestrator/).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)(test_[^/]*|[^/]*_test)\.(py|go)$|Tests?\.(java|kt|cs|swift)$/i;
const LOGIC_FILE = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|swift|rb|php|cs|c|cpp)$/i;
const NO_LOGIC = /\.d\.[cm]?ts$|(^|\/)[^/]*\.config\.[cm]?[jt]s$/i;

const input = JSON.parse(readFileSync(0, "utf8") || "{}");
const root = process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();
const git = (...a) => execFileSync("git", ["-c", "core.quotePath=false", ...a], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const tryGit = (...a) => { try { return git(...a); } catch { return ""; } };

// Uncommitted changes plus commits not yet on the default remote branch.
const base = tryGit("merge-base", "HEAD", "origin/HEAD").trim();
const files = [
  ...tryGit("status", "--porcelain", "--untracked-files=all").split("\n").filter(Boolean).map((l) => l.slice(3).replace(/^.* -> /, "")),
  ...(base ? tryGit("diff", "--name-only", "--diff-filter=d", `${base}..HEAD`).split("\n").filter(Boolean) : []),
];
const logic = files.filter((f) => LOGIC_FILE.test(f) && !NO_LOGIC.test(f) && !TEST_FILE.test(f));
if (!logic.length) process.exit(0);

const block = (reason) => {
  // A second stop in a row only warns, so a hook failure the model cannot fix does not loop forever.
  const out = input.stop_hook_active ? { systemMessage: `verify.mjs: ${reason}` } : { decision: "block", reason };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
};

if (!files.some((f) => TEST_FILE.test(f))) block(`Logic changed without a test (${logic.slice(0, 5).join(", ")}): write the test that fails without the change.`);

// The command to run comes from the base commit, never from files the session can edit; with no remote, HEAD is the base.
const ref = base || "HEAD";
const committed = (f) => { try { return JSON.parse(git("show", `${ref}:${f}`)); } catch { return undefined; } };
const configured = committed(".orchestrator.json")?.test;
const baseScript = committed("package.json")?.scripts?.test;
const tests = configured ? [configured].flat() : baseScript ? ["npm test"] : [];
// npm runs the working-tree script: if the session changed it, running it would execute unreviewed code on the host.
const pkg = join(root, "package.json");
const liveScript = existsSync(pkg) ? JSON.parse(readFileSync(pkg, "utf8")).scripts?.test : undefined;
if (tests.includes("npm test") && liveScript !== baseScript) {
  process.stdout.write(JSON.stringify({ systemMessage: "verify.mjs: package.json test script changed in this session; not running it. Review it and run the tests yourself." }));
  process.exit(0);
}
for (const cmd of tests) {
  const r = spawnSync(cmd, { cwd: root, shell: true, encoding: "utf8", timeout: 600_000 });
  if (r.status !== 0) block(`${cmd} failed:\n${String(r.stdout + r.stderr).slice(-1500)}`);
}
