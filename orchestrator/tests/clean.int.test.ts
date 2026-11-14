import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createFixture, git } from "../scripts/fixture.ts";

const ROOT = resolve(import.meta.dirname, "..");
const PRELOAD = pathToFileURL(join(ROOT, "tests", "helpers", "cli-fake.ts")).href;

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "clean-"));
  const home = join(dir, "home");
  const work = join(dir, "work");
  const env = { ...process.env, EXECUTOR: "fake-cli", PUBLISHER: "fake-cli", TOKEN_BUDGET_TICKET: "100000", ORCH_HOME: home, ORCH_WORK: work, NOTIFY_URL: "", TOKEN_CAP_DAILY: "" };
  const orch = (...args: string[]) => {
    const r = spawnSync(process.execPath, ["--import", PRELOAD, "scripts/orch.ts", ...args], { cwd: ROOT, env, encoding: "utf8", timeout: 120_000 });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const mkRepo = (name: string) => {
    const root = join(dir, name);
    mkdirSync(root);
    const repo = createFixture(root);
    writeFileSync(join(repo, "test/checkout.test.js"), 'import { test } from "node:test";\ntest("ok", () => {});\n');
    writeFileSync(join(repo, "mine.txt"), "uncommitted work\n");
    git(repo, "add", "test");
    git(repo, "commit", "-qm", "green base");
    return repo;
  };
  const ticket = (repo: string, id: string, demand?: string) => {
    const r = orch("run", "Change the label", "--repo", repo, "--id", id, ...(demand ? ["--demand", demand] : []));
    assert.equal(r.code, 0, r.out);
    assert.equal(orch("reject", id).code, 0);
  };
  return { orch, home, work, mkRepo, ticket, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("clean --all removes every ticket and demand of the repo, leaves the repo and another repo's state alone", () => {
  const sb = sandbox();
  try {
    const a = sb.mkRepo("a");
    const b = sb.mkRepo("b");
    assert.equal(sb.orch("demand", "new", "da", "--repo", a, "--id", "D-A").code, 0);
    assert.equal(sb.orch("demand", "new", "db", "--repo", b, "--id", "D-B").code, 0);
    sb.ticket(a, "A-1", "D-A");
    sb.ticket(a, "A-2");
    sb.ticket(b, "B-1", "D-B");
    const before = readFileSync(join(sb.home, "tickets", "B-1.json"), "utf8");
    const open = sb.orch("clean", "--all", "--repo", a);
    assert.equal(open.code, 0, open.out);
    assert.match(open.out, /ok {3}A-1 branch delete/);
    assert.match(open.out, /cleaned A-2/);
    assert.equal(existsSync(join(sb.home, "demands", "D-A.json")), true, "an open demand needs --force");
    assert.equal(sb.orch("clean", "--all", "--repo", a, "--force").code, 0);
    const status = sb.orch("status").out;
    assert.doesNotMatch(status, /A-1|A-2|D-A/);
    assert.match(status, /B-1/);
    assert.match(status, /D-B/);
    assert.equal(readFileSync(join(sb.home, "tickets", "B-1.json"), "utf8"), before);
    assert.equal(git(a, "branch", "--list", "ticket/*"), "");
    assert.match(git(b, "branch", "--list", "ticket/*"), /ticket\/B-1/);
    assert.equal(readFileSync(join(a, "mine.txt"), "utf8"), "uncommitted work\n");
    assert.equal(existsSync(join(b, "mine.txt")), true);
  } finally {
    sb.done();
  }
});

test("clean refuses a ticket whose worktree is the repo, reports it, and still cleans the others", () => {
  const sb = sandbox();
  try {
    const a = sb.mkRepo("a");
    sb.ticket(a, "A-1");
    sb.ticket(a, "A-2");
    const file = join(sb.home, "tickets", "A-1.json");
    const point = `import { FileSaver } from "./src/file-saver.ts";import { buildGraph, config } from "./src/graph.ts";
      const saver = new FileSaver(process.argv[1]);await buildGraph(saver).updateState(config("A-1"), { worktree: process.argv[2] });`;
    const moved = spawnSync(process.execPath, ["--input-type=module", "-e", point, file, a], { cwd: ROOT, encoding: "utf8" });
    assert.equal(moved.status, 0, moved.stderr);
    const r = sb.orch("clean", "--all", "--repo", a);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /FAIL A-1 guard: refusing to remove/);
    assert.match(r.out, /kept A-1/);
    assert.match(r.out, /cleaned A-2/);
    assert.equal(existsSync(join(a, ".git")), true);
    assert.equal(readFileSync(join(a, "mine.txt"), "utf8"), "uncommitted work\n");
    assert.equal(existsSync(file), true);
    assert.equal(existsSync(join(sb.home, "tickets", "A-2.json")), false);
  } finally {
    sb.done();
  }
});

test("a worktree that cannot be removed (locked on Windows, read-only parent elsewhere) is a reported failure that does not stop the rest", async (t) => {
  if (process.platform !== "win32" && process.getuid?.() === 0) return t.skip("root ignores directory permissions");
  const sb = sandbox();
  let holder: ReturnType<typeof spawn> | undefined;
  const parent = join(sb.work, "worktrees");
  try {
    const a = sb.mkRepo("a");
    sb.ticket(a, "A-1");
    sb.ticket(a, "A-2");
    if (process.platform === "win32") {
      holder = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { cwd: join(parent, "A-1"), stdio: "ignore" });
      await new Promise((r) => setTimeout(r, 500));
    } else {
      writeFileSync(join(parent, "A-1", "x"), "");
      chmodSync(join(parent, "A-1"), 0o555);
    }
    const r = sb.orch("clean", "--all", "--repo", a);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /FAIL A-1 (worktree remove|remove directory)/);
    assert.match(r.out, /kept A-1/);
    assert.match(r.out, /cleaned A-2/);
    assert.equal(existsSync(join(sb.home, "tickets", "A-1.json")), true);
    assert.equal(existsSync(join(sb.home, "tickets", "A-2.json")), false);
    assert.equal(existsSync(join(a, "mine.txt")), true);
    assert.equal(git(a, "branch", "--list", "ticket/A-1"), "");
    if (process.platform === "win32") {
      holder?.kill();
      await new Promise((r) => setTimeout(r, 500));
    } else chmodSync(join(parent, "A-1"), 0o755);
    const retry = sb.orch("clean", "--all", "--repo", a);
    assert.equal(retry.code, 0, retry.out);
    assert.match(retry.out, /cleaned A-1/);
    assert.equal(existsSync(join(sb.home, "tickets", "A-1.json")), false);
  } finally {
    holder?.kill();
    if (process.platform !== "win32") chmodSync(join(parent, "A-1"), 0o755);
    await new Promise((r) => setTimeout(r, 200));
    sb.done();
  }
});

test("clean finishes a ticket whose worktree and branch are already gone (after a deploy), and a corrupt ticket of another repo is reported without stopping it", () => {
  const sb = sandbox();
  try {
    const a = sb.mkRepo("a");
    const b = sb.mkRepo("b");
    sb.ticket(a, "A-1");
    sb.ticket(b, "B-1");
    git(a, "worktree", "remove", "--force", join(sb.work, "worktrees", "A-1"));
    git(a, "branch", "-D", "ticket/A-1");
    writeFileSync(join(sb.home, "tickets", "B-1.json"), "{not json");
    const r = sb.orch("clean", "--all", "--repo", a);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /FAIL B-1 read/);
    assert.match(r.out, /cleaned A-1/);
    assert.doesNotMatch(r.out, /FAIL A-1/);
    assert.doesNotMatch(sb.orch("status").out, /A-1/);
    const b1 = join(sb.home, "tickets", "B-1.json");
    rmSync(b1);
    sb.ticket(a, "A-3");
    git(a, "worktree", "remove", "--force", join(sb.work, "worktrees", "A-3"));
    git(a, "branch", "-D", "ticket/A-3");
    const single = sb.orch("clean", "A-3");
    assert.equal(single.code, 0, single.out);
    assert.match(single.out, /cleaned A-3 \(\w+, /);
    assert.doesNotMatch(sb.orch("status").out, /A-3/);
  } finally {
    sb.done();
  }
});
