import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearFailure, injectFailure, SCENARIOS, simulatedProbe } from "../src/chaos.ts";
import { recordDeploy } from "../src/deploy.ts";

let home = "";
const rec = (id: string, sandbox: boolean) => ({ id, repo: "/r", sha: "a", previous: "b", target: "simulated", sandbox });
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ch-"));
  recordDeploy(home, rec("T-1", true));
  recordDeploy(home, rec("T-2", false));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

test("every catalog scenario injects and the probe reports its symptom", () => {
  assert.equal(Object.keys(SCENARIOS).length, 12);
  assert.equal(simulatedProbe(home, "T-1"), null);
  for (const [name, symptom] of Object.entries(SCENARIOS)) {
    injectFailure(home, "T-1", name);
    assert.equal(simulatedProbe(home, "T-1"), symptom);
  }
});

test("clearFailure makes the probe healthy", () => {
  injectFailure(home, "T-1", "http-500");
  clearFailure(home, "T-1");
  assert.equal(simulatedProbe(home, "T-1"), null);
  clearFailure(home, "T-1");
});

test("injecting on a non-sandbox deploy throws and writes nothing", () => {
  assert.throws(() => injectFailure(home, "T-2", "http-500"), /sandbox/);
  assert.equal(existsSync(join(home, "chaos", "T-2.json")), false);
});

test("an unknown scenario throws", () => {
  assert.throws(() => injectFailure(home, "T-1", "nope"), /unknown scenario/);
  assert.equal(existsSync(join(home, "chaos", "T-1.json")), false);
});
