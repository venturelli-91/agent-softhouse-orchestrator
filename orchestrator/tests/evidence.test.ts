import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { verifyEvidence } from "../src/guardrails.ts";

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
