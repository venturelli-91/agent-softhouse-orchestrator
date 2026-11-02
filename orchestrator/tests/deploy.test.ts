import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
