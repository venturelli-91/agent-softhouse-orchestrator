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

test("orch run fails on AGENTS_DIR pointing at stubs before creating a worktree or branch", () => {
  const sb = sandbox();
  try {
    const stubs = join(ROOT, "..", ".claude", "agents");
    const r = spawnSync(process.execPath, ["--import", PRELOAD, "scripts/orch.ts", "run", "x", "--repo", sb.repo, "--id", "T-1"],
      { cwd: ROOT, env: { ...process.env, AGENTS_DIR: stubs, EXECUTOR: "fake-cli", ORCH_HOME: join(sb.repo, "..", "home"), ORCH_WORK: join(sb.repo, "..", "work"), TOKEN_CAP_DAILY: "" }, encoding: "utf8" });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /^AGENTS_DIR=.* holds pointer stubs/);
    assert.doesNotMatch(r.stderr.trim(), /\n/);
    assert.equal(git(sb.repo, "worktree", "list").split(/\n/).length, 1);
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

test("orch request-changes sends the ticket back and it returns for approval; approve then finishes it, and a second approve is refused", () => {
  const sb = sandbox();
  try {
    assert.equal(sb.orch("run", "Change the checkout button label to Submit order", "--repo", sb.repo, "--id", "T-1").code, 0);
    const noReason = sb.orch("request-changes", "T-1");
    assert.equal(noReason.code, 1);
    assert.match(noReason.out, /usage: orch request-changes/);
    const closing = sb.orch("request-changes", "T-1", "abort: not needed");
    assert.equal(closing.code, 1);
    assert.match(closing.out, /to close T-1 use orch reject T-1/);
    const reject = sb.orch("request-changes", "T-1", "use a different label");
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

test("orch reject closes a ticket waiting for approval", () => {
  const sb = sandbox();
  try {
    assert.equal(sb.orch("run", "Change the checkout button label to Submit order", "--repo", sb.repo, "--id", "T-1").code, 0);
    const reject = sb.orch("reject", "T-1", "not needed anymore");
    assert.equal(reject.code, 0, reject.out);
    assert.match(reject.out, /T-1: aborted/);
    assert.match(sb.orch("status", "T-1").out, /T-1\s+aborted/);
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

test("orch adopt turns the dirty main checkout into a ticket the dev only commits, and leaves main clean", () => {
  const sb = sandbox();
  try {
    writeFileSync(join(sb.repo, "checkout.html"), "<button>Submit order</button>\n");
    mkdirSync(join(sb.repo, "orchestrator"));
    writeFileSync(join(sb.repo, "orchestrator", "note.md"), "adopted\n");
    const warned = sb.orch("run", "x", "--repo", sb.repo, "--id", "T-0");
    assert.match(warned.out, /uncommitted changes the ticket will not see.*orch adopt/);
    sb.orch("reject", "T-0");
    const r = sb.orch("adopt", "--title", "Rename the checkout button", "--repo", sb.repo, "--id", "T-1");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /"type": "approval"/);
    assert.equal(git(sb.repo, "status", "--porcelain"), "");
    assert.equal(git(sb.repo, "stash", "list"), "");
    assert.equal(git(sb.repo, "show", "ticket/T-1:orchestrator/note.md"), "adopted");
    assert.equal(git(sb.repo, "show", "ticket/T-1:checkout.html"), "<button>Submit order</button>");
  } finally {
    sb.done();
  }
});

test("orch adopt refuses secrets and a clean checkout before creating anything", () => {
  const sb = sandbox();
  try {
    const clean = sb.orch("adopt", "--repo", sb.repo, "--id", "T-1");
    assert.equal(clean.code, 1);
    assert.match(clean.out, /nothing to adopt/);
    writeFileSync(join(sb.repo, ".env"), "TOKEN=x\n");
    const secret = sb.orch("adopt", "--repo", sb.repo, "--id", "T-1");
    assert.equal(secret.code, 1);
    assert.match(secret.out, /look like secrets \(\.env\)/);
    assert.equal(git(sb.repo, "worktree", "list").split("\n").length, 1);
    assert.equal(git(sb.repo, "stash", "list"), "");
    assert.match(git(sb.repo, "status", "--porcelain"), /\.env/);
  } finally {
    sb.done();
  }
});

test("orch manual creates a ticket no agent runs; orch evidence rejects bad evidence, closes on good, and status lists it", () => {
  const sb = sandbox();
  try {
    const usage = sb.orch("manual", "Export customers");
    assert.equal(usage.code, 1);
    assert.match(usage.out, /usage: orch manual/);
    const made = sb.orch("manual", "Export customers", "--command", "psql -f export.sql > out.json", "--criteria", "one row per customer",
      "--expect", "out.json", "--id", "M-1");
    assert.equal(made.code, 0, made.out);
    assert.match(made.out, /psql -f export\.sql > out\.json[\s\S]*one row per customer[\s\S]*orch evidence M-1 out\.json --exit/);
    assert.match(sb.orch("status").out, /M-1\s+open\s+manual Export customers\s+<- waiting: orch evidence M-1/);
    const out = join(sb.repo, "out.json");
    writeFileSync(out, "secret-row");
    const bad = sb.orch("evidence", "M-1", out, "--exit", "0");
    assert.equal(bad.code, 1);
    assert.match(bad.out, /out\.json: not valid JSON/);
    assert.doesNotMatch(bad.out, /secret-row/);
    assert.match(sb.orch("evidence", "M-1", out).out, /usage: orch evidence/);
    assert.match(sb.orch("evidence", "M-9", out, "--exit", "0").out, /no manual ticket M-9/);
    writeFileSync(out, '[{"id":1}]');
    const good = sb.orch("evidence", "M-1", out, "--exit", "0");
    assert.equal(good.code, 0, good.out);
    assert.match(good.out, /M-1: closed - evidence: exit 0; out\.json 10 B sha256:/);
    const one = sb.orch("status", "M-1");
    assert.match(one.out, /M-1\s+closed[\s\S]*evidence rejected \(out\.json: not valid JSON\)[\s\S]*evidence: exit 0/);
    assert.equal(git(sb.repo, "worktree", "list").split("\n").length, 1);
  } finally {
    sb.done();
  }
});
