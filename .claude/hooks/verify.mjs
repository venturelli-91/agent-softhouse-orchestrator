// Stop: when the session changed logic files, the turn only ends with a test touched, and once the model was asked to run the suite.
// It never runs anything itself: the tests are session-written code, so they run through Bash, behind the permission prompt.
// ponytail: mirrors untestedLogic in orchestrator/src/test-report.ts (.claude/ ships without orchestrator/).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)(test_[^/]*|[^/]*_test)\.(py|go)$|Tests?\.(java|kt|cs|swift)$/i;
const LOGIC_FILE = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|swift|rb|php|cs|c|cpp)$/i;
const NO_LOGIC = /\.d\.[cm]?ts$|(^|\/)[^/]*\.config\.[cm]?[jt]s$/i;

const input = JSON.parse(readFileSync(0, "utf8") || "{}");
// A second stop in a row ends the turn: the model already got the request once, and a loop helps nobody.
if (input.stop_hook_active) process.exit(0);
const root = process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();
const git = (...a) => { try { return execFileSync("git", ["-c", "core.quotePath=false", ...a], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return ""; } };

// Uncommitted changes plus commits not yet on the default remote branch.
const base = git("merge-base", "HEAD", "origin/HEAD").trim();
// -z: paths come raw (no quoting); a rename entry is followed by its old path, which is skipped.
const status = git("status", "--porcelain", "-z", "--untracked-files=all").split("\0");
const changed = [];
for (let i = 0; i < status.length; i++) {
  if (!status[i]) continue;
  changed.push(status[i].slice(3));
  if (/^[RC]/.test(status[i])) i++;
}
const files = [
  ...changed,
  ...(base ? git("diff", "--name-only", "-z", "--diff-filter=d", `${base}..HEAD`).split("\0").filter(Boolean) : []),
];
const logic = files.filter((f) => LOGIC_FILE.test(f) && !NO_LOGIC.test(f) && !TEST_FILE.test(f));
if (!logic.length) process.exit(0);

const reason = files.some((f) => TEST_FILE.test(f))
  ? "Logic changed: run the repo's test command with Bash now and fix any failure before finishing (the hook does not run it for you)."
  : `Logic changed without a test (${logic.slice(0, 5).join(", ")}): write the test that fails without the change, then run the suite with Bash.`;
process.stdout.write(JSON.stringify({ decision: "block", reason }));
