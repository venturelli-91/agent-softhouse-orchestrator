// What the test command printed, read by code: passed, skipped and failed counts, and skips a ticket added.
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { minimalEnv } from "./agent-env.ts";
import { NODE_TIMEOUT_MS } from "./flow-limits.ts";
import { DEFAULT_TEST } from "./permissions.ts";

export const TestCounts = z.object({ pass: z.number(), skip: z.number(), fail: z.number() });
export type Counts = z.infer<typeof TestCounts>;

const KIND: Record<string, keyof Counts> = {
  pass: "pass", passed: "pass", xpassed: "pass",
  fail: "fail", failed: "fail", error: "fail", errors: "fail",
  skipped: "skip", todo: "skip", pending: "skip", xfailed: "skip",
};

// node --test (spec `ℹ pass 3`, TAP `# pass 3`), pytest (`== 3 passed, 1 skipped in 0.2s ==`), jest (`Tests: 1 skipped, 3 passed, 4 total`).
// Several runs in one command (e.g. unit && int) add up; output in none of these formats gives null.
export function parseCounts(out: string): Counts | null {
  const c: Counts = { pass: 0, skip: 0, fail: 0 };
  let found = false;
  const add = (kind: string, n: string) => {
    const k = KIND[kind];
    if (k) (c[k] += Number(n), (found = true));
  };
  for (const m of out.matchAll(/^[ℹ#] (pass|fail|skipped|todo) (\d+)\r?$/gm)) add(m[1], m[2]);
  for (const line of out.matchAll(/^=+ (.+?) in [\d.]+s\b.*=+\r?$|^Tests:\s+(.+ total)\r?$/gm))
    for (const m of (line[1] ?? line[2]).matchAll(/(\d+) (\w+)/g)) add(m[2], m[1]);
  return found ? c : null;
}

// Shell, because npm is npm.cmd on Windows; stderr is kept too, jest prints its summary there. `test` comes from .orchestrator.json
// at the base commit (a ticket cannot edit it) and RepoConfig only accepts a plain command with no shell operators.
// Also run on the untouched base before any agent runs: a red base would fail every ticket's verification.
// There, `noTestsOk` accepts a suite with no tests yet (pytest exits 5), which is not a red base.
export const testFailure = (wt: string, test: Test = DEFAULT_TEST, noTestsOk = false) => runTests(wt, test, noTestsOk).failure;

// `test` is one command or a list that must all pass (a matrix); an older ticket state may still hold a single string.
export type Test = string | string[];
export const commands = (test: Test) => [test].flat();

// Commands run in order and stop at the first failure; the counts of the commands that ran add up.
export function runTests(wt: string, test: Test = DEFAULT_TEST, noTestsOk = false): { failure: string; counts: Counts | null } {
  let out = "";
  for (const cmd of commands(test)) {
    const r = spawnSync(cmd, { cwd: wt, env: minimalEnv("dev"), shell: true, encoding: "utf8", timeout: NODE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
    out += `${r.stdout ?? ""}\n${r.stderr ?? ""}\n`;
    if (r.status === 0 || (noTestsOk && /\bpytest\b/.test(cmd) && r.status === 5)) continue;
    return { failure: `${cmd} failed: ${r.error ? `${r.error.message} ` : ""}${String(r.stdout || r.stderr || "").slice(-400)}`, counts: parseCounts(out) };
  }
  return { failure: "", counts: parseCounts(out) };
}

const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)(test_[^/]*|[^/]*_test)\.py$/i;
// Unconditional skips only: a `{ skip: <condition> }` or `skipif` stays allowed and shows up in the skipped count instead.
const SKIP = new RegExp(
  [String.raw`\.(skip|todo)\s*\(`, String.raw`\bx(it|describe|test)\s*\(`, String.raw`\b(skip|todo)\s*:\s*true\b`,
    String.raw`@pytest\.mark\.skip\b`, String.raw`\bpytest\.skip\s*\(`, String.raw`\bunittest\.skip\b`, String.raw`\.skipTest\s*\(`].join("|"),
);

// Lines a ticket's diff (-U0) adds to test files that skip a test: `file: line`.
// Hunk bodies are consumed by the counts in their `@@` header, so an added line that looks like a `+++ b/x` header cannot move the
// current file; a quoted (unparseable) path is checked as if it were a test file.
export function addedSkips(diff: string): string[] {
  let file = "";
  let quoted = false;
  let del = 0;
  let add = 0;
  const out: string[] = [];
  for (const l of diff.split("\n")) {
    if (del > 0 && l.startsWith("-")) del--;
    else if (add > 0 && l.startsWith("+")) {
      add--;
      if ((quoted || TEST_FILE.test(file)) && SKIP.test(l)) out.push(`${file}: ${l.slice(1).trim().slice(0, 80)}`);
    } else if ((del === 0 && add === 0) || l.startsWith("@@")) {
      const h = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(l);
      if (h) [del, add] = [h[1] === undefined ? 1 : Number(h[1]), h[2] === undefined ? 1 : Number(h[2])];
      else if (l.startsWith("+++ ")) {
        file = l.slice(4).replace(/\t$/, "");
        quoted = file.startsWith('"');
        file = file.replace(/^b\//, "");
      }
    }
  }
  return out;
}

export const skipAlerts = (base: Counts | null, now: Counts | null) =>
  base && now && now.skip > base.skip ? [`${now.skip} tests skipped, the base had ${base.skip}`] : [];
