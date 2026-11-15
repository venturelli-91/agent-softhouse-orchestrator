import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { adoptKeys, installDeps, testFailure, verifyEvidence } from "../src/guardrails.ts";
import { setupSnapshot } from "../src/evidence.ts";

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@x.local", ...a], { cwd, encoding: "utf8" }).trim();

// Fast stand-ins for `npm test`: the verification logic is the same, only the process chain is shorter. The default `npm test` path stays
// covered by the valid-commit test and the testFailure test below.
const GREEN = "node -e 0";
const RED = "node fail.js";

function repo(testScript = "node -e 0") {
  const d = mkdtempSync(join(tmpdir(), "ev-"));
  git(d, "init", "-q", "-b", "main");
  writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { test: testScript } }));
  writeFileSync(join(d, "fail.js"), "process.exit(1);");
  git(d, "add", "-A");
  git(d, "commit", "-q", "-m", "base");
  return { d, base: git(d, "rev-parse", "HEAD") };
}

test("without a new commit the evidence is rejected", () => {
  const { d, base } = repo();
  const r = verifyEvidence(d, base);
  rmSync(d, { recursive: true, force: true });
  assert.equal(r.ok, false);
});

test("a diff that touches package.json does not run npm test on the host", () => {
  const { d, base } = repo();
  writeFileSync(join(d, "package.json"), '{"scripts":{"test":"node -e 1"}}');
  git(d, "commit", "-qam", "change script");
  const r = verifyEvidence(d, base);
  rmSync(d, { recursive: true, force: true });
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /package\.json/);
});

test("a valid commit with passing tests yields verified evidence", () => {
  const { d, base } = repo();
  writeFileSync(join(d, "a.txt"), "x");
  git(d, "add", "-A");
  git(d, "commit", "-qm", "add a");
  const r = verifyEvidence(d, base);
  rmSync(d, { recursive: true, force: true });
  assert.equal(r.ok, true);
});

test("a diff that changes logic needs a test in the same diff", () => {
  const run = (files: string[]) => {
    const { d, base } = repo();
    for (const f of files) {
      mkdirSync(dirname(join(d, f)), { recursive: true });
      writeFileSync(join(d, f), "export const x = 1;\n");
    }
    git(d, "add", "-A");
    git(d, "commit", "-qm", "x");
    const r = verifyEvidence(d, base, GREEN);
    rmSync(d, { recursive: true, force: true });
    return r;
  };
  const untested = run(["src/total.ts"]);
  assert.equal(untested.ok, false);
  assert.match((untested as { reason: string }).reason, /without adding or changing a test \(src\/total\.ts\)/);
  assert.equal(run(["src/total.ts", "tests/total.test.ts"]).ok, true);
  assert.equal(run(["vite.config.ts", "types.d.ts", "page.html", "README.md"]).ok, true);
});

test("a diff that touches a forbidden path is refused", () => {
  for (const f of [".env", ".github/workflows/x.yml", "orchestrator/src/a.ts", "config/credentials.json"]) {
    const { d, base } = repo();
    mkdirSync(dirname(join(d, f)), { recursive: true });
    writeFileSync(join(d, f), "x");
    git(d, "add", "-A", "-f");
    git(d, "commit", "-qm", "x");
    const r = verifyEvidence(d, base);
    rmSync(d, { recursive: true, force: true });
    assert.equal(r.ok, false, f);
    assert.match((r as { reason: string }).reason, /forbidden/, f);
  }
});

test("a commit without a real passing test is rejected, even if the agent says it passed", () => {
  const { d, base } = repo();
  writeFileSync(join(d, "a.txt"), "x");
  git(d, "add", "-A");
  git(d, "commit", "-qm", "a");
  const r = verifyEvidence(d, base, RED);
  rmSync(d, { recursive: true, force: true });
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, new RegExp(`${RED} failed`));
});

test("testFailure flags a red base and passes a green one", () => {
  const red = repo('node -e "process.exit(1)"');
  const green = repo();
  const r = [testFailure(red.d, "npm test"), testFailure(green.d, "npm test")];
  rmSync(red.d, { recursive: true, force: true });
  rmSync(green.d, { recursive: true, force: true });
  assert.match(r[0], /npm test failed/);
  assert.equal(r[1], "");
});

test("on the base only, a pytest suite with no tests yet (exit 5) is not red", () => {
  const { d } = repo();
  const cmd = 'node -e "process.exit(5)" pytest';
  const r = [testFailure(d, cmd, true), testFailure(d, cmd), testFailure(d, 'node -e "process.exit(5)"', true)];
  rmSync(d, { recursive: true, force: true });
  assert.equal(r[0], "");
  assert.match(r[1], /failed/);
  assert.match(r[2], /failed/);
});

test("a worktree with an uncommitted change is rejected", () => {
  const { d, base } = repo();
  writeFileSync(join(d, "a.txt"), "x");
  git(d, "add", "-A");
  git(d, "commit", "-qm", "a");
  writeFileSync(join(d, "a.txt"), "changed");
  const r = verifyEvidence(d, base);
  rmSync(d, { recursive: true, force: true });
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /uncommitted changes/);
});

test("renaming a forbidden file does not hide the old path", () => {
  const { d } = repo();
  writeFileSync(join(d, ".env"), "SECRET=1");
  git(d, "add", "-A", "-f");
  git(d, "commit", "-qm", "env in base");
  const base = git(d, "rev-parse", "HEAD");
  git(d, "mv", ".env", "environment.txt");
  git(d, "commit", "-qm", "rename");
  const r = verifyEvidence(d, base);
  rmSync(d, { recursive: true, force: true });
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /forbidden/);
});

test("a test command that moves HEAD voids the verification", () => {
  const { d, base } = repo();
  writeFileSync(join(d, "a.txt"), "x");
  git(d, "add", "-A");
  git(d, "commit", "-qm", "add a");
  const r = verifyEvidence(d, base, "git commit --allow-empty -qm moved");
  rmSync(d, { recursive: true, force: true });
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /HEAD changed/);
});

test("a test command that dirties the worktree voids the verification", () => {
  const { d, base } = repo();
  writeFileSync(join(d, "dirty.test.js"), "require('fs').writeFileSync('fail.js', 'x');");
  git(d, "add", "-A");
  git(d, "commit", "-qm", "add dirty script");
  const r = verifyEvidence(d, base, "node dirty.test.js");
  rmSync(d, { recursive: true, force: true });
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /worktree changed during verification/);
});

function withCommit(lock = false, files: Record<string, string> = {}) {
  const d = mkdtempSync(join(tmpdir(), "ev-"));
  git(d, "init", "-q", "-b", "main");
  writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { test: "node -e 0" } }));
  writeFileSync(join(d, ".gitignore"), "node_modules\n.npmrc\n");
  if (lock) writeFileSync(join(d, "package-lock.json"), JSON.stringify({ name: "x", lockfileVersion: 3, packages: { "": {} } }));
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(dirname(join(d, f)), { recursive: true });
    writeFileSync(join(d, f), c);
  }
  git(d, "add", "-A");
  git(d, "commit", "-q", "-m", "base");
  const base = git(d, "rev-parse", "HEAD");
  writeFileSync(join(d, "a.txt"), "x");
  git(d, "add", "-A");
  git(d, "commit", "-qm", "work");
  return { d, base };
}

test("without install, an ignored node_modules tree blocks the evidence", () => {
  const { d, base } = withCommit();
  mkdirSync(join(d, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(d, "node_modules", "dep", "package.json"), "{}");
  const r = verifyEvidence(d, base);
  rmSync(d, { recursive: true, force: true });
  assert.equal(r.ok, false);
});

test("with install, ignored files the agent left are wiped before the test and never block", () => {
  const { d, base } = withCommit(true);
  mkdirSync(join(d, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(d, "node_modules", "dep", "evil.js"), "x");
  writeFileSync(join(d, ".npmrc"), "x=1");
  const r = verifyEvidence(d, base, "node -e 0", true);
  const left = existsSync(join(d, "node_modules", "dep", "evil.js")) || existsSync(join(d, ".npmrc"));
  rmSync(d, { recursive: true, force: true });
  assert.equal(r.ok, true);
  assert.equal(left, false);
});

test("with a custom setup, the ignored host files it left pass; new or edited ones fail verification", () => {
  const dep = (d: string, name: string, body = "{}") => {
    mkdirSync(join(d, "node_modules", name), { recursive: true });
    writeFileSync(join(d, "node_modules", name, "package.json"), body);
  };
  const { d, base } = withCommit();
  dep(d, "dep");
  const snap = setupSnapshot(d);
  assert.equal(snap.length, 1);
  assert.equal(verifyEvidence(d, base, "node -e 0", false, [], null, snap).ok, true);
  dep(d, "dep", '{"x":1}');
  assert.match((verifyEvidence(d, base, "node -e 0", false, [], null, snap) as { reason: string }).reason, /new or changed since setup/);
  dep(d, "dep");
  dep(d, "planted");
  const r = verifyEvidence(d, base, "node -e 0", false, [], null, snap);
  rmSync(d, { recursive: true, force: true });
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /planted/);
});

test("with install plus another setup, node_modules is rebuilt and the other setup's recorded output stays and passes", () => {
  const check = 'process.exit(require("node:fs").existsSync(".venv/out") ? 0 : 1);\n';
  const { d, base } = withCommit(true, { ".gitignore": "node_modules\n.venv\n", "check.cjs": check, "sub/keep.txt": "x" });
  mkdirSync(join(d, ".venv", "lib"), { recursive: true });
  writeFileSync(join(d, ".venv", "lib", "setup.py"), "x");
  writeFileSync(join(d, ".venv", "out"), "x");
  const snap = setupSnapshot(d, true);
  mkdirSync(join(d, "sub", "node_modules", "x"), { recursive: true });
  writeFileSync(join(d, "sub", "node_modules", "x", "package.json"), "{}");
  const r = verifyEvidence(d, base, "node check.cjs", true, [], null, snap);
  const [planted, kept] = [existsSync(join(d, "sub", "node_modules")), existsSync(join(d, ".venv", "lib", "setup.py"))];
  rmSync(d, { recursive: true, force: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([planted, kept], [false, true]);
});

test("with install plus another setup, a host file in a node_modules nested in another ignored dir is still caught", () => {
  const { d, base } = withCommit(true, { ".gitignore": "node_modules\n.venv\n" });
  const snap = setupSnapshot(d, true);
  mkdirSync(join(d, ".venv", "node_modules", "c"), { recursive: true });
  writeFileSync(join(d, ".venv", "node_modules", "c", "package.json"), "{}");
  const r = verifyEvidence(d, base, "node -e 0", true, [], null, snap);
  rmSync(d, { recursive: true, force: true });
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /new or changed since setup \(\.venv\/node_modules\/c\/package\.json@/);
});

test("a node_modules symlink never lets npm ci empty its target", (t) => {
  const { d, base } = withCommit(true);
  const outside = mkdtempSync(join(tmpdir(), "ev-target-"));
  writeFileSync(join(outside, "keep.txt"), "x");
  try {
    symlinkSync(outside, join(d, "node_modules"), "junction");
  } catch {
    rmSync(d, { recursive: true, force: true });
    return t.skip("cannot create symlinks here");
  }
  assert.throws(() => installDeps(d), /node_modules is a symlink/);
  const r = verifyEvidence(d, base, "node -e 0", true, [], null, []);
  const kept = existsSync(join(outside, "keep.txt"));
  rmSync(d, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  assert.equal(kept, true);
  assert.equal(r.ok, true, JSON.stringify(r));
});

test("an npm.cmd in the worktree root stops the install at verification", { skip: process.platform !== "win32" }, () => {
  const { d, base } = withCommit(true, { "npm.cmd": "@echo pwned > pwned.txt\n" });
  const r = verifyEvidence(d, base, "node -e 0", true);
  const ran = existsSync(join(d, "pwned.txt"));
  rmSync(d, { recursive: true, force: true });
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /npm exists in the worktree and would shadow the binary/);
  assert.equal(ran, false);
});

test("a node.cmd in the worktree root never runs in place of node during the install", { skip: process.platform !== "win32" }, () => {
  const { d } = withCommit(true, { "node.cmd": "@echo pwned > pwned.txt\n" });
  installDeps(d);
  const ran = existsSync(join(d, "pwned.txt"));
  rmSync(d, { recursive: true, force: true });
  assert.equal(ran, false);
});

test("an install that fails at verification gives the command and exit code, never its stderr", () => {
  const { d, base } = withCommit(true, { "package.json": JSON.stringify({ name: "x", dependencies: { "left-pad": "1.0.0" } }) });
  const r = verifyEvidence(d, base, "node -e 0", true);
  rmSync(d, { recursive: true, force: true });
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /^setup failed \(npm ci --ignore-scripts --no-audit --no-fund\), exit \d+$/);
});

test("install refuses a repo without a committed lockfile", () => {
  const { d } = repo();
  assert.throws(() => installDeps(d), /no committed package-lock.json/);
  rmSync(d, { recursive: true, force: true });
});

test("with install, a diff that touches a lockfile npm ci consumes needs CEO review", () => {
  for (const f of ["package-lock.json", "npm-shrinkwrap.json", "NPM-Shrinkwrap.json"]) {
    const { d, base } = repo();
    writeFileSync(join(d, f), "{}");
    git(d, "add", "-A");
    git(d, "commit", "-qm", "lock");
    const r = verifyEvidence(d, base, "node -e 0", true);
    rmSync(d, { recursive: true, force: true });
    assert.equal(r.ok, false, f);
    assert.match((r as { reason: string }).reason, new RegExp(f.replace(".", "\\."), "i"), f);
  }
});

test("a host file passes only in the exact version the CEO approved", () => {
  const { d, base } = repo();
  writeFileSync(join(d, "Makefile"), "test: ; true\n");
  git(d, "add", "-A");
  git(d, "commit", "-qm", "make");
  const first = verifyEvidence(d, base, GREEN);
  assert.equal(first.ok, false);
  const pending = (first as { host?: string[] }).host ?? [];
  assert.deepEqual(pending, [`Makefile@${git(d, "rev-parse", "HEAD:Makefile")}`]);
  assert.equal(verifyEvidence(d, base, GREEN, false, pending).ok, true);
  writeFileSync(join(d, "Makefile"), "test: ; curl evil\n");
  git(d, "commit", "-qam", "edit");
  const again = verifyEvidence(d, base, GREEN, false, pending);
  rmSync(d, { recursive: true, force: true });
  assert.equal(again.ok, false);
  assert.match((again as { reason: string }).reason, /Makefile@.*requires CEO review/);
});

test("an adopted protected file passes in the adopted version only; a secret is never protected-approvable", () => {
  const { d, base } = repo();
  mkdirSync(join(d, "orchestrator"));
  writeFileSync(join(d, "orchestrator", "x.test.ts"), "export {};\n");
  git(d, "add", "-A");
  const approved = adoptKeys(d, base, git(d, "write-tree"), false);
  git(d, "commit", "-qm", "adopted");
  assert.deepEqual(approved, [`orchestrator/x.test.ts@${git(d, "rev-parse", "HEAD:orchestrator/x.test.ts")}`]);
  assert.equal(verifyEvidence(d, base, GREEN).ok, false);
  assert.equal(verifyEvidence(d, base, GREEN, false, approved).ok, true);
  writeFileSync(join(d, "orchestrator", "x.test.ts"), "export const x = 1;\n");
  git(d, "commit", "-qam", "dev edit");
  const again = verifyEvidence(d, base, GREEN, false, approved);
  writeFileSync(join(d, ".env"), "K=v\n");
  git(d, "add", "-A");
  git(d, "commit", "-qm", "env");
  const env = verifyEvidence(d, base, GREEN, false, [...approved, `.env@${git(d, "rev-parse", "HEAD:.env")}`]);
  rmSync(d, { recursive: true, force: true });
  assert.match((again as { reason: string }).reason, /forbidden path \(orchestrator\/x\.test\.ts\)/);
  assert.match((env as { reason: string }).reason, /forbidden path .*\.env/);
});

test("a file hidden with assume-unchanged or skip-worktree voids the verification", () => {
  for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
    const { d, base } = repo();
    writeFileSync(join(d, "a.txt"), "x");
    git(d, "add", "-A");
    git(d, "commit", "-qm", "a");
    git(d, "update-index", flag, "a.txt");
    writeFileSync(join(d, "a.txt"), "tampered");
    const r = verifyEvidence(d, base);
    rmSync(d, { recursive: true, force: true });
    assert.equal(r.ok, false, flag);
    assert.match((r as { reason: string }).reason, /hidden from git/, flag);
  }
});

test("touched source files over the modularity limits are refused; untouched or non-source files are not", () => {
  const cases: [string, string, boolean][] = [
    ["a.test.ts", "x\n".repeat(301), false],
    ["b.test.ts", `${"x".repeat(161)}\n`, false],
    ["c.test.ts", "x\n".repeat(300), true],
    ["d.json", "x\n".repeat(500), true],
  ];
  for (const [f, body, ok] of cases) {
    const { d, base } = repo();
    writeFileSync(join(d, f), body);
    git(d, "add", "-A");
    git(d, "commit", "-qm", "x");
    const r = verifyEvidence(d, base, GREEN);
    rmSync(d, { recursive: true, force: true });
    assert.equal(r.ok, ok, f);
    if (!ok) assert.match((r as { reason: string }).reason, /modularity/, f);
  }
});

test("modularity check reads the committed blob: a dangling symlink and a deleted oversized file do not break it", () => {
  const { d } = repo();
  writeFileSync(join(d, "big.ts"), "x\n".repeat(301));
  git(d, "add", "-A");
  git(d, "commit", "-qm", "big");
  const base = git(d, "rev-parse", "HEAD");
  git(d, "rm", "-q", "big.ts");
  const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: d, input: "/nonexistent", encoding: "utf8" }).trim();
  git(d, "update-index", "--add", "--cacheinfo", `120000,${blob},link.test.ts`);
  git(d, "commit", "-qm", "delete big, add dangling symlink");
  git(d, "reset", "-q", "--hard");
  const r = verifyEvidence(d, base, GREEN);
  rmSync(d, { recursive: true, force: true });
  assert.equal(r.ok, true);
});

function linkedWorktree(d: string, file: string, content: string) {
  const wt = `${d}-wt`;
  git(d, "worktree", "add", "-q", "-b", "ticket/T-1", wt);
  writeFileSync(join(wt, file), content);
  git(wt, "add", "-A");
  git(wt, "commit", "-qm", "dev");
  return wt;
}

const cleanup = (...dirs: string[]) => dirs.forEach((x) => rmSync(x, { recursive: true, force: true }));

test("in a linked worktree, files the test run leaves untracked (e.g. __pycache__) are cleaned and do not void the verification", () => {
  const { d, base } = repo();
  const wt = linkedWorktree(d, "leave.test.js", "require('fs').mkdirSync('__pycache__');require('fs').writeFileSync('__pycache__/m.pyc','x');");
  const r = verifyEvidence(wt, base, "node leave.test.js");
  const left = existsSync(join(wt, "__pycache__"));
  cleanup(wt, d);
  assert.equal(r.ok, true);
  assert.equal(left, false);
});

test("in a main checkout nothing is deleted: leftovers still void the verification and user files survive", () => {
  const { d, base } = repo();
  writeFileSync(join(d, "leave.test.js"), "require('fs').writeFileSync('leftover.txt','x');");
  git(d, "add", "-A");
  git(d, "commit", "-qm", "dev");
  const r = verifyEvidence(d, base, "node leave.test.js");
  const kept = existsSync(join(d, "leftover.txt"));
  cleanup(d);
  assert.ok(!r.ok && /worktree changed during verification/.test(r.reason));
  assert.equal(kept, true);
});

const NONE = `node -e "console.log('Ran 0 tests in 0.000s')"`;
const zeros = { pass: 0, skip: 0, fail: 0 };
const some = { pass: 3, skip: 0, fail: 0 };

test("no tests collected: accepted and labelled only when the base positively had none; unknown or non-empty base rejects it", () => {
  const { d, base } = repo();
  writeFileSync(join(d, "a.txt"), "x");
  git(d, "add", "-A");
  git(d, "commit", "-qm", "change");
  const free = verifyEvidence(d, base, NONE, false, [], zeros);
  const unknown = verifyEvidence(d, base, NONE, false, [], null);
  const had = verifyEvidence(d, base, NONE, false, [], some);
  cleanup(d);
  assert.ok(free.ok && free.none && free.evidence.some((e) => e.endsWith("none collected")));
  assert.ok(!unknown.ok && /no tests collected/.test(unknown.reason));
  assert.ok(!had.ok && /no tests collected/.test(had.reason));
});

const PYS = ["python", "python3"].filter((x) => spawnSync(x, ["--version"]).status === 0);

function pyRepo(body: string) {
  const { d, base } = repo();
  mkdirSync(join(d, "tests"));
  writeFileSync(join(d, "tests", "test_a.py"), body);
  git(d, "add", "-A");
  git(d, "commit", "-qm", "py");
  return { d, base };
}

for (const py of PYS) test(`${py} unittest: pass, fail and none collected are three distinct outcomes`, () => {
  const cmd = `${py} -m unittest discover -s tests`;
  const pass = pyRepo("import unittest\nclass T(unittest.TestCase):\n    def test_a(self):\n        pass\n");
  const fail = pyRepo("import unittest\nclass T(unittest.TestCase):\n    def test_a(self):\n        self.fail('x')\n");
  const none = pyRepo("import unittest\n");
  const rp = verifyEvidence(pass.d, pass.base, cmd, false, [], zeros);
  const rf = verifyEvidence(fail.d, fail.base, cmd, false, [], zeros);
  const rn = verifyEvidence(none.d, none.base, cmd, false, [], zeros);
  const rnBad = verifyEvidence(none.d, none.base, cmd, false, [], some);
  cleanup(pass.d, fail.d, none.d);
  assert.ok(rp.ok && !rp.none && rp.counts?.pass === 1);
  assert.ok(!rf.ok && /failed/.test(rf.reason));
  assert.ok(rn.ok && rn.none);
  assert.ok(!rnBad.ok);
});
