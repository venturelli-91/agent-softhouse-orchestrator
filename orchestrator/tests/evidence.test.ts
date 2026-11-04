import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { installDeps, verifyEvidence } from "../src/guardrails.ts";

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@x.local", ...a], { cwd, encoding: "utf8" }).trim();

function repo(testScript = "node -e 0") {
  const d = mkdtempSync(join(tmpdir(), "ev-"));
  git(d, "init", "-q", "-b", "main");
  writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { test: testScript } }));
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
  const { d, base } = repo('node -e "process.exit(1)"');
  writeFileSync(join(d, "a.txt"), "x");
  git(d, "add", "-A");
  git(d, "commit", "-qm", "a");
  const r = verifyEvidence(d, base);
  rmSync(d, { recursive: true, force: true });
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /npm test failed/);
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

test("an npm test that moves HEAD voids the verification", () => {
  const { d, base } = repo("git commit --allow-empty -qm moved");
  writeFileSync(join(d, "a.txt"), "x");
  git(d, "add", "-A");
  git(d, "commit", "-qm", "add a");
  const r = verifyEvidence(d, base);
  rmSync(d, { recursive: true, force: true });
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /HEAD changed/);
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
  for (const f of ["package-lock.json", "npm-shrinkwrap.json"]) {
    const { d, base } = repo();
    writeFileSync(join(d, f), "{}");
    git(d, "add", "-A");
    git(d, "commit", "-qm", "lock");
    const r = verifyEvidence(d, base, "node -e 0", true);
    rmSync(d, { recursive: true, force: true });
    assert.equal(r.ok, false, f);
    assert.match((r as { reason: string }).reason, new RegExp(f.replace(".", "\\.")), f);
  }
});
