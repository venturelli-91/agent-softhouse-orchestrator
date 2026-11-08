// The real `orch` CLI as a subprocess over the real graph, with a fake executor and publisher preloaded (no model, no network).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createFixture, git } from "../scripts/fixture.ts";

const ROOT = resolve(import.meta.dirname, "..");
const PRELOAD = pathToFileURL(join(ROOT, "tests", "helpers", "cli-fake.ts")).href;

function sandbox(green = true) {
  const dir = mkdtempSync(join(tmpdir(), "cli-"));
  const env = { ...process.env, EXECUTOR: "fake-cli", PUBLISHER: "fake-cli", TOKEN_BUDGET_TICKET: "100000",
    ORCH_HOME: join(dir, "home"), ORCH_WORK: join(dir, "work"), NOTIFY_URL: "", TOKEN_CAP_DAILY: "" };
  const orch = (...args: string[]) => {
    const r = spawnSync(process.execPath, ["--import", PRELOAD, "scripts/orch.ts", ...args], { cwd: ROOT, env, encoding: "utf8", timeout: 120_000 });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const repo = createFixture(dir);
  // The fixture starts red on purpose (the tracer needs a failing test); `orch run` refuses a red base, so green it unless asked.
  if (green) {
    writeFileSync(join(repo, "test/checkout.test.js"), 'import { test } from "node:test";\ntest("ok", () => {});\n');
    git(repo, "commit", "-qam", "green base");
  }
  return { orch, repo, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("orch run refuses a red base before any agent runs and leaves no worktree behind", () => {
  const sb = sandbox(false);
  try {
    const run = sb.orch("run", "Change the checkout button label to Submit order", "--repo", sb.repo, "--id", "T-1");
    assert.equal(run.code, 1, run.out);
    assert.match(run.out, /base is red/);
    assert.equal(git(sb.repo, "worktree", "list").split("\n").length, 1);
    assert.equal(git(sb.repo, "branch", "--list", "ticket/*"), "");
  } finally {
    sb.done();
  }
});

test("orch run stops at the CEO approval, and status shows the ticket waiting", () => {
  const sb = sandbox();
  try {
    const run = sb.orch("run", "Change the checkout button label to Submit order", "--repo", sb.repo, "--id", "T-1");
    assert.equal(run.code, 0, run.out);
    assert.match(run.out, /"type": "approval"/);
    const status = sb.orch("status", "T-1");
    assert.equal(status.code, 0, status.out);
    assert.match(status.out, /T-1\s+\S+\s+P2\s+.*waiting \(approval\)/);
  } finally {
    sb.done();
  }
});

test("orch reject sends the ticket back and it returns for approval; approve then finishes it, and a second approve is refused", () => {
  const sb = sandbox();
  try {
    assert.equal(sb.orch("run", "Change the checkout button label to Submit order", "--repo", sb.repo, "--id", "T-1").code, 0);
    const noReason = sb.orch("reject", "T-1");
    assert.equal(noReason.code, 1);
    assert.match(noReason.out, /rejecting an approval needs a reason/);
    const reject = sb.orch("reject", "T-1", "use a different label");
    assert.equal(reject.code, 0, reject.out);
    assert.match(reject.out, /"type": "approval"/);
    const approve = sb.orch("approve", "T-1");
    assert.equal(approve.code, 0, approve.out);
    assert.match(approve.out, /T-1: simulated_deploy/);
    const again = sb.orch("approve", "T-1");
    assert.equal(again.code, 1);
    assert.match(again.out, /T-1 is not waiting for an answer/);
  } finally {
    sb.done();
  }
});

test("orch init --team writes that team's specialties, refuses an unknown team and never overwrites an existing config", () => {
  const sb = sandbox();
  try {
    const bad = sb.orch("init", sb.repo, "--team", "nope");
    assert.equal(bad.code, 1);
    assert.match(bad.out, /unknown team nope: all, web, api, mobile, ai/);
    const web = sb.orch("init", sb.repo, "--team", "web");
    assert.equal(web.code, 0, web.out);
    const file = join(sb.repo, ".orchestrator.json");
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).specialties, ["frontend", "fullstack"]);
    const again = sb.orch("init", sb.repo, "--team", "api");
    assert.match(again.out, /already exists: set "specialties" there by hand/);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).specialties, ["frontend", "fullstack"]);
  } finally {
    sb.done();
  }
});

test("orch setup copies the folder into a git repo without secrets or state, runs init, and never overwrites", () => {
  const sb = sandbox();
  try {
    const bare = join(sb.repo, "..", "not-a-repo");
    mkdirSync(bare);
    const nogit = sb.orch("setup", bare, "--no-install");
    assert.equal(nogit.code, 1);
    assert.match(nogit.out, /is not the root of a git repo/);

    const ok = sb.orch("setup", sb.repo, "--no-install", "--team", "web");
    assert.equal(ok.code, 0, ok.out);
    const dest = join(sb.repo, "orchestrator");
    assert.ok(existsSync(join(dest, "agents", "design-reviewer.md")));
    assert.ok(existsSync(join(dest, ".env")));
    assert.ok(!existsSync(join(dest, "node_modules")) && !existsSync(join(dest, ".state")));
    assert.deepEqual(JSON.parse(readFileSync(join(sb.repo, ".orchestrator.json"), "utf8")).specialties, ["frontend", "fullstack"]);

    const again = sb.orch("setup", sb.repo, "--no-install");
    assert.equal(again.code, 1);
    assert.match(again.out, /already exists: nothing copied/);
  } finally {
    sb.done();
  }
});
