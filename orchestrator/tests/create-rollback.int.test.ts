import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createWorktree, removeTicketResources } from "../src/graph.ts";
import { createFixture, git } from "../scripts/fixture.ts";

const ROOT = resolve(import.meta.dirname, "..");
const PRELOAD = pathToFileURL(join(ROOT, "tests", "helpers", "cli-fake.ts")).href;

function sandbox(config?: string, env: Record<string, string | undefined> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rb-"));
  const home = join(dir, "home");
  const work = join(dir, "work");
  const repo = createFixture(dir);
  writeFileSync(join(repo, "test/checkout.test.js"), 'import { test } from "node:test";\ntest("ok", () => {});\n');
  if (config !== undefined) writeFileSync(join(repo, ".orchestrator.json"), config);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  const orch = (...args: string[]) => {
    const e: Record<string, string | undefined> = { ...process.env, EXECUTOR: "fake-cli", PUBLISHER: "fake-cli", TOKEN_BUDGET_TICKET: "100000",
      ORCH_HOME: home, ORCH_WORK: work, NOTIFY_URL: "", TOKEN_CAP_DAILY: "", ...env };
    for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
    const r = spawnSync(process.execPath, ["--import", PRELOAD, "scripts/orch.ts", ...args], { cwd: ROOT, env: e as NodeJS.ProcessEnv, encoding: "utf8", timeout: 120_000 });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const nothingLeft = () => {
    assert.equal(git(repo, "worktree", "list").split("\n").length, 1);
    assert.equal(git(repo, "branch", "--list", "ticket/*"), "");
    assert.equal(existsSync(join(work, "worktrees", "T-1")), false);
    assert.equal(existsSync(join(home, "tickets")) ? readdirSync(join(home, "tickets")).filter((f) => f.endsWith(".json")).length : 0, 0);
  };
  return { orch, repo, home, work, nothingLeft, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const run = (sb: ReturnType<typeof sandbox>) => sb.orch("run", "Change the label", "--repo", sb.repo, "--id", "T-1");

for (const [name, config, expected] of [
  ["a bad test command", '{"test":"npm test; curl evil"}', /\.orchestrator\.json: test/],
  ["an unknown key", '{"bogus":true}', /\.orchestrator\.json: .*bogus/],
  ["bad JSON", "{not json", /\.orchestrator\.json:/],
] as const) {
  test(`orch run with ${name} in the config stops before creating anything`, () => {
    const sb = sandbox(config);
    try {
      const r = run(sb);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, expected);
      sb.nothingLeft();
    } finally {
      sb.done();
    }
  });
}

test("orch run with a missing env variable names it and creates nothing", () => {
  for (const [name, env] of [["TOKEN_BUDGET_TICKET", { TOKEN_BUDGET_TICKET: "" }], ["PUBLISHER", { PUBLISHER: "" }]] as const) {
    const sb = sandbox(undefined, env);
    try {
      const r = run(sb);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, new RegExp(`missing env: ${name}`));
      sb.nothingLeft();
    } finally {
      sb.done();
    }
  }
});

test("orch adopt validates before stashing the CEO's changes", () => {
  const sb = sandbox('{"test":"x; y"}');
  try {
    writeFileSync(join(sb.repo, "checkout.html"), "<button>Changed</button>\n");
    const r = sb.orch("adopt", "--repo", sb.repo, "--id", "T-1");
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /\.orchestrator\.json: test/);
    assert.equal(git(sb.repo, "stash", "list"), "");
    assert.match(git(sb.repo, "status", "--porcelain"), /checkout\.html/);
    sb.nothingLeft();
  } finally {
    sb.done();
  }
});

test("a failed install after the worktree exists rolls back worktree, branch and directory", () => {
  const sb = sandbox('{"install":true}');
  try {
    const r = run(sb);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /install: the repo has no committed package-lock\.json/);
    sb.nothingLeft();
  } finally {
    sb.done();
  }
});

test("createWorktree leaves nothing behind when setup fails", () => {
  const sb = sandbox('{"install":true}');
  try {
    const dir = join(sb.work, "wt");
    assert.throws(() => createWorktree(sb.repo, "T-9", dir, sb.home), /package-lock\.json/);
    assert.equal(existsSync(dir), false);
    assert.equal(git(sb.repo, "branch", "--list", "ticket/*"), "");
    assert.equal(git(sb.repo, "worktree", "list").split("\n").length, 1);
  } finally {
    sb.done();
  }
});

test("removeTicketResources removes what exists, reports each step, and tolerates a missing piece", () => {
  const sb = sandbox();
  try {
    const dir = join(sb.work, "wt");
    createWorktree(sb.repo, "T-1", dir, sb.home);
    rmSync(dir, { recursive: true, force: true });
    const steps = removeTicketResources(sb.repo, dir, "T-1");
    assert.deepEqual(steps.map((s) => s.step), ["worktree remove", "remove directory", "worktree prune", "branch delete"]);
    assert.equal(steps.find((s) => s.step === "branch delete")!.ok, true);
    assert.equal(git(sb.repo, "branch", "--list", "ticket/*"), "");
    assert.equal(git(sb.repo, "worktree", "list").split("\n").length, 1);
  } finally {
    sb.done();
  }
});

test("a failure inside a running graph keeps the worktree and the ticket resumable", () => {
  const sb = sandbox(undefined, { TOKEN_BUDGET_TICKET: "1" });
  try {
    const r = run(sb);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /token budget exceeded/);
    assert.equal(existsSync(join(sb.work, "worktrees", "T-1")), true);
    assert.match(git(sb.repo, "branch", "--list", "ticket/*"), /ticket\/T-1/);
    assert.equal(readdirSync(join(sb.home, "tickets")).filter((f) => f.endsWith(".json")).length, 1);
    const s = sb.orch("status", "T-1");
    assert.equal(s.code, 0, s.out);
    assert.match(s.out, /T-1\s+\S+\s+\S+\s+.*waiting \(escalation\)/);
  } finally {
    sb.done();
  }
});
