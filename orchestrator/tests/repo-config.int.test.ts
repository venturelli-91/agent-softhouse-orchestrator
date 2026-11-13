import { SPECIALTIES } from "../src/specialties.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { permissionArgs, SHELL, verifyEvidence } from "../src/guardrails.ts";
import { loadRepoConfig, WebcheckConfig } from "../src/repo-config.ts";

process.env.ORCH_HOME = mkdtempSync(join(tmpdir(), "rc-home-"));
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
  assert.deepEqual(loadRepoConfig(none.d, none.base), { test: "npm test", merge: "pr", push_remote: "origin", base_repo: "", disclosure: true,
    install: false, deploy: null, webcheck: null, specialties: [...SPECIALTIES], stack: "" });
  const some = repo('{"test":"pytest -q","merge":"auto"}');
  assert.deepEqual(loadRepoConfig(some.d, some.base), { test: "pytest -q", merge: "auto", push_remote: "origin", base_repo: "", disclosure: true,
    install: false, deploy: null, webcheck: null, specialties: [...SPECIALTIES], stack: "" });
  // an uncommitted edit of the file does not count
  writeFileSync(join(some.d, ".orchestrator.json"), '{"test":"rm -rf x"}');
  assert.equal(loadRepoConfig(some.d, some.base).test, "pytest -q");
  [none.d, some.d].forEach((d) => rmSync(d, { recursive: true, force: true }));
});

test("an invalid value names the accepted values and keys and points to orch init", () => {
  const { d, base } = repo('{"merge":"nope"}');
  assert.throws(() => loadRepoConfig(d, base), /expected one of "pr"\|"auto"\|"local".*accepted keys: test, merge,.*`orch init` writes a valid file/);
  rmSync(d, { recursive: true, force: true });
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

test("a list of test commands must all pass: the first failing one is the reason", () => {
  const { d, base } = repo(JSON.stringify({ test: ["node -e 0", "node missing.js"] }));
  const cfg = loadRepoConfig(d, base);
  assert.deepEqual(cfg.test, ["node -e 0", "node missing.js"]);
  writeFileSync(join(d, "b.txt"), "b");
  git(d, "add", "-A");
  git(d, "commit", "-q", "-m", "change");
  const bad = verifyEvidence(d, base, cfg.test);
  assert.ok(!bad.ok && /^node missing.js failed/.test(bad.reason));
  const ok = verifyEvidence(d, base, ["node -e 0", "node -e 0"]);
  assert.ok(ok.ok && ok.evidence.includes("tests:node -e 0 + node -e 0 ok"));
  for (const bad of [[], ["npm test", "pytest; id"]]) {
    const r = repo(JSON.stringify({ test: bad }));
    assert.throws(() => loadRepoConfig(r.d, r.base), /test/, JSON.stringify(bad));
    rmSync(r.d, { recursive: true, force: true });
  }
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
  const both = allow(permissionArgs("dev", ["npm test", "npm run lint"]));
  assert.ok(both.includes(`${SHELL}(npm test*)`) && both.includes(`${SHELL}(npm run lint*)`));
});

function home(cfg: string) {
  const h = mkdtempSync(join(tmpdir(), "rc-home-"));
  mkdirSync(h, { recursive: true });
  writeFileSync(join(h, "config.json"), cfg);
  return h;
}

test("external config applies when the repo has no file", () => {
  const { d, base } = repo();
  const h = home(JSON.stringify({ repos: { [resolve(d)]: { test: "pytest -q", merge: "local", disclosure: false } } }));
  const c = loadRepoConfig(d, base, h);
  assert.deepEqual([c.test, c.merge, c.disclosure], ["pytest -q", "local", false]);
  [d, h].forEach((x) => rmSync(x, { recursive: true, force: true }));
});

test("the in-repo file wins per key over the external one", () => {
  const { d, base } = repo('{"test":"make check"}');
  const h = home(JSON.stringify({ repos: { [resolve(d)]: { test: "pytest -q", disclosure: false } } }));
  const c = loadRepoConfig(d, base, h);
  assert.deepEqual([c.test, c.disclosure], ["make check", false]);
  [d, h].forEach((x) => rmSync(x, { recursive: true, force: true }));
});

test("a malformed external config.json throws an error naming config.json", () => {
  const { d, base } = repo();
  const h = home("{nope");
  assert.throws(() => loadRepoConfig(d, base, h), /config\.json/);
  const h2 = home(JSON.stringify({ repos: { [resolve(d)]: { merge: "yolo" } } }));
  assert.throws(() => loadRepoConfig(d, base, h2), /config\.json/);
  [d, h, h2].forEach((x) => rmSync(x, { recursive: true, force: true }));
});

test("push_remote with a space is rejected", () => {
  const { d, base } = repo('{"push_remote":"my remote"}');
  assert.throws(() => loadRepoConfig(d, base), /push_remote/);
  rmSync(d, { recursive: true, force: true });
});

test("merge local is accepted", () => {
  const { d, base } = repo('{"merge":"local"}');
  assert.equal(loadRepoConfig(d, base).merge, "local");
  rmSync(d, { recursive: true, force: true });
});

const withDeploy = (deploy: object, repoConfig?: string) => {
  const { d, base } = repo(repoConfig);
  const h = home(JSON.stringify({ repos: { [resolve(d)]: { deploy } } }));
  return { d, base, h, done: () => [d, h].forEach((x) => rmSync(x, { recursive: true, force: true })) };
};
const okDeploy = { command: "vercel deploy", rollback: "vercel rollback", health_url: "https://x.example/health" };

test("a deploy block in the external config is loaded with defaults", () => {
  const t = withDeploy(okDeploy);
  const c = loadRepoConfig(t.d, t.base, t.h);
  assert.deepEqual(c.deploy, { ...okDeploy, environment: "staging", env: [], timeout_s: 300, max_latency_ms: 2000 });
  assert.equal(loadRepoConfig(repo().d, repo().base).deploy, null);
  t.done();
});

test("a deploy key in .orchestrator.json is rejected", () => {
  const { d, base } = repo(JSON.stringify({ deploy: okDeploy }));
  assert.throws(() => loadRepoConfig(d, base), /deploy is only accepted in the external config/);
  rmSync(d, { recursive: true, force: true });
});

test("health_url must be http or https", () => {
  for (const bad of ["file:///etc/passwd", "ftp://x/y", "not a url"]) {
    const t = withDeploy({ ...okDeploy, health_url: bad });
    assert.throws(() => loadRepoConfig(t.d, t.base, t.h), /health_url/, bad);
    t.done();
  }
});

test("a deploy command with shell operators is rejected", () => {
  for (const key of ["command", "rollback"]) {
    const t = withDeploy({ ...okDeploy, [key]: "vercel deploy && rm x" });
    assert.throws(() => loadRepoConfig(t.d, t.base, t.h), /plain command/, key);
    t.done();
  }
});

test("deploy env names must be upper-case identifiers", () => {
  const t = withDeploy({ ...okDeploy, env: ["lower-case"] });
  assert.throws(() => loadRepoConfig(t.d, t.base, t.h), /env/);
  t.done();
});

test("health_url with credentials is rejected", () => {
  const t = withDeploy({ ...okDeploy, health_url: "https://user:pw@x.example/health" });
  assert.throws(() => loadRepoConfig(t.d, t.base, t.h), /without credentials/);
  t.done();
});

test("webcheck is validated and only accepted from the external config", () => {
  assert.throws(() => WebcheckConfig.parse({ serve: "npm start; rm -rf x", base_url: "http://localhost:3000" }));
  assert.throws(() => WebcheckConfig.parse({ serve: "npm start", base_url: "http://example.com" }));
  assert.throws(() => WebcheckConfig.parse({ serve: "npm start", base_url: "http://localhost:3000", gtm: ["nope"] }));
  assert.throws(() => WebcheckConfig.parse({ serve: "npm start", base_url: "http://localhost:3000", paths: ["//evil.com"] }));
  assert.equal(WebcheckConfig.parse({ serve: "npm start", base_url: "http://127.0.0.1:3000" }).paths[0], "/");
});
