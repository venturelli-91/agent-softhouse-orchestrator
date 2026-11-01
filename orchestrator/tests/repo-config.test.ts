import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { permissionArgs, SHELL, verifyEvidence } from "../src/guardrails.ts";
import { loadRepoConfig } from "../src/repo-config.ts";

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@x.local", ...a], { cwd, encoding: "utf8" }).trim();
function repo(config?: string) {
  const d = mkdtempSync(join(tmpdir(), "rc-"));
  git(d, "init", "-q", "-b", "main");
  writeFileSync(join(d, "a.txt"), "a");
  if (config) writeFileSync(join(d, ".orchestrator.json"), config);
  git(d, "add", "-A");
  git(d, "commit", "-q", "-m", "base");
  return { d, base: git(d, "rev-parse", "HEAD") };
}

test("the config comes from the base commit, with safe defaults", () => {
  const none = repo();
  assert.deepEqual(loadRepoConfig(none.d, none.base), { test: "npm test", merge: "pr" });
  const some = repo('{"test":"pytest -q","merge":"auto"}');
  assert.deepEqual(loadRepoConfig(some.d, some.base), { test: "pytest -q", merge: "auto" });
  // an uncommitted edit of the file does not count
  writeFileSync(join(some.d, ".orchestrator.json"), '{"test":"rm -rf x"}');
  assert.equal(loadRepoConfig(some.d, some.base).test, "pytest -q");
  [none.d, some.d].forEach((d) => rmSync(d, { recursive: true, force: true }));
});

test("a test command with shell operators is rejected", () => {
  for (const bad of ["npm test && curl x", "pytest; id", "make test | tee", "echo `id`", "npm test $(id)", "a > b"]) {
    const { d, base } = repo(JSON.stringify({ test: bad }));
    assert.throws(() => loadRepoConfig(d, base), /plain command/, bad);
    rmSync(d, { recursive: true, force: true });
  }
});

test("evidence runs the repo's own test command and reports it", () => {
  const { d, base } = repo();
  writeFileSync(join(d, "b.txt"), "b");
  git(d, "add", "-A");
  git(d, "commit", "-q", "-m", "change");
  const ok = verifyEvidence(d, base, "node -e 0");
  assert.ok(ok.ok && ok.evidence.includes("tests:node -e 0 ok"));
  const bad = verifyEvidence(d, base, "node -e process.exit(1)");
  assert.ok(!bad.ok && /node -e process\.exit\(1\) failed/.test(bad.reason));
  rmSync(d, { recursive: true, force: true });
});

test("a diff that touches python test config does not run on the host", () => {
  const { d, base } = repo();
  writeFileSync(join(d, "conftest.py"), "import os\n");
  git(d, "add", "-A");
  git(d, "commit", "-q", "-m", "conftest");
  const r = verifyEvidence(d, base, "node -e 0");
  assert.ok(!r.ok && /conftest\.py/.test(r.reason));
  rmSync(d, { recursive: true, force: true });
});

test("the dev's allowlist gets the repo's test command instead of npm test", () => {
  const allow = (a: string[]) => a.slice(a.indexOf("--allowedTools") + 1, a.indexOf("--disallowedTools"));
  assert.ok(allow(permissionArgs("dev")).includes(`${SHELL}(npm test*)`));
  const py = allow(permissionArgs("dev", "pytest -q"));
  assert.ok(py.includes(`${SHELL}(pytest -q*)`) && !py.includes(`${SHELL}(npm test*)`));
  assert.ok(!allow(permissionArgs("qa", "pytest -q")).some((t) => t.includes("pytest")));
});
