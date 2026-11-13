import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { adoptKeys, installDeps, testFailure, verifyEvidence } from "../src/guardrails.ts";

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
  writeFileSync(join(d, "dirty.js"), "require('fs').writeFileSync('dirt.txt', 'x');");
  git(d, "add", "-A");
  git(d, "commit", "-qm", "add dirty script");
  const r = verifyEvidence(d, base, "node dirty.js");
  rmSync(d, { recursive: true, force: true });
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /worktree changed during verification/);
});

function withCommit(lock = false) {
  const d = mkdtempSync(join(tmpdir(), "ev-"));
  git(d, "init", "-q", "-b", "main");
  writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { test: "node -e 0" } }));
  writeFileSync(join(d, ".gitignore"), "node_modules\n.npmrc\n");
  if (lock) writeFileSync(join(d, "package-lock.json"), JSON.stringify({ name: "x", lockfileVersion: 3, packages: { "": {} } }));
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
  writeFileSync(join(d, "orchestrator", "x.ts"), "export {};\n");
  git(d, "add", "-A");
  const approved = adoptKeys(d, base, git(d, "write-tree"), false);
  git(d, "commit", "-qm", "adopted");
  assert.deepEqual(approved, [`orchestrator/x.ts@${git(d, "rev-parse", "HEAD:orchestrator/x.ts")}`]);
  assert.equal(verifyEvidence(d, base, GREEN).ok, false);
  assert.equal(verifyEvidence(d, base, GREEN, false, approved).ok, true);
  writeFileSync(join(d, "orchestrator", "x.ts"), "export const x = 1;\n");
  git(d, "commit", "-qam", "dev edit");
  const again = verifyEvidence(d, base, GREEN, false, approved);
  writeFileSync(join(d, ".env"), "K=v\n");
  git(d, "add", "-A");
  git(d, "commit", "-qm", "env");
  const env = verifyEvidence(d, base, GREEN, false, [...approved, `.env@${git(d, "rev-parse", "HEAD:.env")}`]);
  rmSync(d, { recursive: true, force: true });
  assert.match((again as { reason: string }).reason, /forbidden path \(orchestrator\/x\.ts\)/);
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
    ["a.ts", "x\n".repeat(301), false],
    ["b.ts", `${"x".repeat(161)}\n`, false],
    ["c.ts", "x\n".repeat(300), true],
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
  git(d, "update-index", "--add", "--cacheinfo", `120000,${blob},link.ts`);
  git(d, "commit", "-qm", "delete big, add dangling symlink");
  git(d, "reset", "-q", "--hard");
  const r = verifyEvidence(d, base, GREEN);
  rmSync(d, { recursive: true, force: true });
  assert.equal(r.ok, true);
});
