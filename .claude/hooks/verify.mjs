// Stop: when this session edited logic files, the turn only ends with a test touched and a test command run after the last logic edit.
// It never runs anything itself: the tests are session-written code, so they run through Bash, behind the permission prompt.
// Edits come from this session's transcripts (main + subagents), not git: unmerged commits from earlier sessions never trigger it.
// ponytail: only Write/Edit/NotebookEdit count as edits; read shell writes (sed, heredocs) too if that gap ever lets untested logic through.
// ponytail: TEST_RUN is a loose match (a denied or unrelated command naming a test tool counts): it nudges, it does not prove.
// ponytail: mirrors untestedLogic in orchestrator/src/test-report.ts (.claude/ ships without orchestrator/).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)(test_[^/]*|[^/]*_test)\.(py|go)$|Tests?\.(java|kt|cs|swift)$/i;
const LOGIC_FILE = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|swift|rb|php|cs|c|cpp)$/i;
const NO_LOGIC = /\.d\.[cm]?ts$|(^|\/)[^/]*\.config\.[cm]?[jt]s$/i;
const EDIT = /^(Write|Edit|NotebookEdit)$/;
const TEST_RUN = /\btest\b|pytest|vitest|jest|rspec|phpunit/;

const input = JSON.parse(readFileSync(0, "utf8") || "{}");
// A second stop in a row ends the turn: the model already got the request once, and a loop helps nobody.
if (input.stop_hook_active || !input.transcript_path) process.exit(0);
const root = process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();

// Subagents write their tool calls to <transcript>/subagents/agent-*.jsonl; timestamps order calls across files.
const subagents = input.transcript_path.replace(/\.jsonl$/, "/subagents");
const transcripts = [input.transcript_path, ...(existsSync(subagents) ? readdirSync(subagents).filter((f) => f.endsWith(".jsonl")).map((f) => join(subagents, f)) : [])];

const logic = new Set();
let lastLogic = "", lastRun = "", tested = false;
for (const line of transcripts.flatMap((t) => readFileSync(t, "utf8").split("\n"))) {
  if (!line.includes('"tool_use"')) continue;
  const { timestamp, message } = JSON.parse(line);
  for (const use of message?.content ?? []) {
    if (use.type !== "tool_use") continue;
    if (TEST_RUN.test(use.input?.command ?? "") && timestamp > lastRun) lastRun = timestamp;
    if (!EDIT.test(use.name)) continue;
    const rel = relative(root, use.input.file_path ?? use.input.notebook_path).replaceAll("\\", "/");
    if (rel.startsWith("../") || isAbsolute(rel)) continue;
    if (TEST_FILE.test(rel)) tested = true;
    else if (LOGIC_FILE.test(rel) && !NO_LOGIC.test(rel)) {
      logic.add(rel);
      if (timestamp > lastLogic) lastLogic = timestamp;
    }
  }
}
if (!lastLogic || lastRun > lastLogic) process.exit(0);

const reason = tested
  ? "Logic changed: run the repo's test command with Bash now and fix any failure before finishing (the hook does not run it for you)."
  : `Logic changed without a test (${[...logic].slice(0, 5).join(", ")}): write the test that fails without the change, then run the suite with Bash.`;
process.stdout.write(JSON.stringify({ decision: "block", reason }));
