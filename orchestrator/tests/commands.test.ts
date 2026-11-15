import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_INSTALL, DEFAULT_TEST, isSafeCommand } from "../src/commands.ts";
import { commandTarget } from "../src/deploy.ts";
import { installDeps } from "../src/guardrails.ts";
import { DeployConfig, RepoConfig } from "../src/repo-config.ts";
import { runTests } from "../src/test-report.ts";
import { TeamProposal } from "../src/team.ts";
import { Ticket } from "../src/ticket.ts";

const ACCEPT = [
  "npm test", "pytest -q", "python -m unittest", "python -m pytest tests/unit -x", "npm run test:unit -- --ci",
  "pytest tests/test_a.py::test_b", ".venv/bin/python -m pytest", ".venv\\Scripts\\python -m pytest", "C:\\tools\\py.exe -m pytest", "make test", "pytest -k a,b",
];
const REJECT = [
  "a; b", "a && b", "a || b", "a | b", "a & b", "a > f", "a < f", "`a`", "$(a)", "$A", "%A%", "a ^ b", "a !b", '"a b"', "'a'", "a*", "a?",
  "a[1]", "a{1,2}", "~/a", "a # c", "a\nb", "a\\\nb", "a\tb", "", "   ",
];

const verdicts = (c: string) => [
  RepoConfig.safeParse({ test: c }).success,
  RepoConfig.safeParse({ test: [c] }).success,
  TeamProposal.safeParse({ specialties: ["backend"], stack: "", existing_stack: true, test: c, rationale: "" }).success,
  Ticket.safeParse({ id: "T-1", request: "r", worktree: "w", base: "b", test: c }).success,
  DeployConfig.safeParse({ command: c, rollback: c, health_url: "https://x.test" }).success,
  isSafeCommand(c),
];

test("every accepted command validates the same way in RepoConfig, TeamProposal, Ticket and the deploy config", () => {
  for (const c of ACCEPT) assert.deepEqual(verdicts(c), Array(6).fill(true), JSON.stringify(c));
});

test("every shell operator, quote, expansion, newline and blank command is rejected everywhere", () => {
  for (const c of REJECT) assert.deepEqual(verdicts(c), Array(6).fill(false), JSON.stringify(c));
});

test("the deploy runner rejects a command with an operator before running it", () => {
  const t = commandTarget({ command: "a && b", rollback: "a", env: [], timeout_s: 5 }, process.cwd(), "p");
  assert.throws(() => t.deploy({ id: "T-1", sha: "s" }), /plain command/);
});

test("the defaults are the npm ones", () => {
  assert.equal(DEFAULT_TEST, "npm test");
  assert.equal(RepoConfig.parse({}).test, DEFAULT_TEST);
  assert.match(DEFAULT_INSTALL, /^npm ci /);
});

test("installDeps runs the command it is given", () => {
  const d = mkdtempSync(join(tmpdir(), "cmd-"));
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@x.local", ...a], { cwd: d });
  try {
    git("init", "-q", "-b", "main");
    writeFileSync(join(d, "package-lock.json"), "{}");
    writeFileSync(join(d, "mark.js"), "require('fs').writeFileSync('ran.txt','x')");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    installDeps(d, "node mark.js");
    assert.equal(execFileSync("node", ["-p", "require('fs').existsSync('ran.txt')"], { cwd: d, encoding: "utf8" }).trim(), "true");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("runTests runs a configured command through the shell", () => {
  assert.equal(runTests(process.cwd(), "node -e 0").failure, "");
  assert.match(runTests(process.cwd(), "node -e process.exit(1)").failure, /failed/);
});
