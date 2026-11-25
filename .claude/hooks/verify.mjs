// Stop: when this session edited logic files, the turn only ends with a test touched and a test command run after the last logic edit.
// It never runs anything itself: the tests are session-written code, so they run through Bash, behind the permission prompt.
// Edits come from this session's transcript, not git: unmerged commits from earlier sessions on the branch never trigger it.
// ponytail: only Write/Edit/NotebookEdit count; read shell writes (sed, heredocs) too if that gap ever lets untested logic through.
// ponytail: mirrors untestedLogic in orchestrator/src/test-report.ts (.claude/ ships without orchestrator/).
import { readFileSync } from "node:fs";
import { relative } from "node:path";

const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)(test_[^/]*|[^/]*_test)\.(py|go)$|Tests?\.(java|kt|cs|swift)$/i;
const LOGIC_FILE = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|swift|rb|php|cs|c|cpp)$/i;
const NO_LOGIC = /\.d\.[cm]?ts$|(^|\/)[^/]*\.config\.[cm]?[jt]s$/i;
const TEST_RUN = /\b(?:(?:npm|pnpm|yarn|bun)(?: run)? test|pytest|vitest|jest|node --test|go test|cargo test)\b/;

const input = JSON.parse(readFileSync(0, "utf8") || "{}");
// A second stop in a row ends the turn: the model already got the request once, and a loop helps nobody.
if (input.stop_hook_active || !input.transcript_path) process.exit(0);
const root = process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();

const logic = new Set();
let lastLogic = -1, lastRun = -1, tested = false;
readFileSync(input.transcript_path, "utf8").split("\n").forEach((line, i) => {
  if (!line.includes('"tool_use"')) return;
  for (const use of JSON.parse(line).message?.content ?? []) {
    if (use.type !== "tool_use") continue;
    if (TEST_RUN.test(use.input?.command ?? "")) lastRun = i;
    const file = use.input?.file_path ?? use.input?.notebook_path;
    if (!file) continue;
    const rel = relative(root, file).replaceAll("\\", "/");
    if (TEST_FILE.test(rel)) tested = true;
    else if (LOGIC_FILE.test(rel) && !NO_LOGIC.test(rel)) {
      logic.add(rel);
      lastLogic = i;
    }
  }
});
if (lastLogic < 0 || lastRun > lastLogic) process.exit(0);

const reason = tested
  ? "Logic changed: run the repo's test command with Bash now and fix any failure before finishing (the hook does not run it for you)."
  : `Logic changed without a test (${[...logic].slice(0, 5).join(", ")}): write the test that fails without the change, then run the suite with Bash.`;
process.stdout.write(JSON.stringify({ decision: "block", reason }));
