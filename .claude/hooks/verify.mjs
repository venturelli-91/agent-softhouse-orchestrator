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

// The command and every file that decides what it runs come from the remote base, which the session cannot move: with no remote
// base nothing runs automatically. A changed host file (scripts and their pre/post hooks, npm config, lockfiles, make/pytest config)
// means unreviewed code would run on the host, so it is left to the CEO.
// ponytail: mirrors RUNS_ON_HOST in orchestrator/src/evidence.ts.
const HOST_FILES = [".orchestrator.json", "package.json", ".npmrc", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock",
  "Makefile", "conftest.py", "setup.py", "setup.cfg", "pyproject.toml", "pytest.ini", "tox.ini"];
const warn = (msg) => { process.stdout.write(JSON.stringify({ systemMessage: `verify.mjs: ${msg}` })); process.exit(0); };
if (!base) warn("no remote base (origin/HEAD) to trust the test command from; run the tests yourself.");
const changedHost = files.filter((f) => HOST_FILES.some((h) => f.toLowerCase().endsWith(h.toLowerCase())));
if (changedHost.length) warn(`files that decide what the tests run changed (${changedHost.slice(0, 5).join(", ")}); review them and run the tests yourself.`);
const committed = (f) => { try { return JSON.parse(git("show", `${base}:${f}`)); } catch { return undefined; } };
const configured = committed(".orchestrator.json")?.test;
const tests = configured ? [configured].flat() : committed("package.json")?.scripts?.test ? ["npm test"] : [];
for (const cmd of tests) {
  const r = spawnSync(cmd, { cwd: root, shell: true, encoding: "utf8", timeout: 600_000 });
  if (r.status !== 0) block(`${cmd} failed:\n${String(r.stdout + r.stderr).slice(-1500)}`);
}
