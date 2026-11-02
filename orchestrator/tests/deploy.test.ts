import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deployedIds, getDeployTarget, readDeploy, recordDeploy } from "../src/deploy.ts";

const rec = (id: string) => ({ id, repo: "/r", sha: "a".repeat(40), previous: "b".repeat(40), target: "simulated", sandbox: true });

test("simulated target is a sandbox and reports simulated", () => {
  const t = getDeployTarget("simulated");
  assert.equal(t.sandbox, true);
  assert.match(t.deploy({ id: "T-1", sha: "a" }), /^simulated:/);
  assert.match(t.rollback({ id: "T-1", sha: "a", previous: "b" }), /^simulated:/);
});

test("unknown target throws", () => assert.throws(() => getDeployTarget("nope"), /unknown deploy target/));

test("recordDeploy then readDeploy round-trips and deployedIds lists it", () => {
  const home = mkdtempSync(join(tmpdir(), "dp-"));
  try {
    assert.deepEqual(deployedIds(home), []);
    recordDeploy(home, rec("T-1"));
    assert.deepEqual(deployedIds(home), ["T-1"]);
    assert.deepEqual(readDeploy(home, "T-1"), rec("T-1"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("ids with path separators are rejected", () => {
  const home = mkdtempSync(join(tmpdir(), "dp-"));
  try {
    assert.throws(() => recordDeploy(home, rec("../x")), /invalid ticket id/);
    assert.throws(() => readDeploy(home, "a/b"), /invalid ticket id/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

import { commandEnv, commandTarget } from "../src/deploy.ts";

const cfg = (command: string, env: string[] = [], timeout_s = 30) => ({ command, rollback: "node --version", env, timeout_s });

test("commandEnv passes only listed names plus the ORCH_ variables", () => {
  const env = commandEnv(["TOKEN_A"], { id: "T-1", sha: "s", previous: "p" }, { TOKEN_A: "a", SECRET_B: "b", PATH: "/bin" });
  assert.equal(env.TOKEN_A, "a");
  assert.equal(env.SECRET_B, undefined);
  assert.equal(env.PATH, "/bin");
  assert.deepEqual([env.ORCH_TICKET, env.ORCH_SHA, env.ORCH_PREVIOUS], ["T-1", "s", "p"]);
});

test("a failing command throws with the output tail", () => {
  const t = commandTarget(cfg("node --nonexistent-flag"), process.cwd(), "p");
  assert.throws(() => t.deploy({ id: "T-1", sha: "s" }), /nonexistent-flag/);
});

test("a listed env value in the output is masked", () => {
  process.env.ORCH_TEST_SECRET = process.version;
  const out = commandTarget(cfg("node --version", ["ORCH_TEST_SECRET"]), process.cwd(), "p").deploy({ id: "T-1", sha: "s" });
  delete process.env.ORCH_TEST_SECRET;
  assert.match(out, /\*\*\*/);
  assert.ok(!out.includes(process.version));
});

test("a command over its timeout throws", () => {
  const t = commandTarget(cfg("node --version", [], 0.001), process.cwd(), "p");
  assert.throws(() => t.deploy({ id: "T-1", sha: "s" }), /timed out|ETIMEDOUT/);
});

test("a command target is not a sandbox", () => assert.equal(commandTarget(cfg("node --version"), process.cwd(), "p").sandbox, false));

test("a command whose binary exists in the working directory is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "dp-"));
  writeFileSync(join(dir, "node.cmd"), "echo pwned");
  try {
    assert.throws(() => commandTarget(cfg("node --version"), dir, "p").deploy({ id: "T-1", sha: "s" }), /shadow/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a command with shell operators is refused at run time too", () => {
  assert.throws(() => commandTarget(cfg("node --version && id"), process.cwd(), "p").deploy({ id: "T-1", sha: "s" }), /plain command/);
});
