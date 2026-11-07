// The real `orch` CLI as a subprocess over the real graph, with a fake executor and publisher preloaded (no model, no network).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createFixture } from "../scripts/fixture.ts";

const ROOT = resolve(import.meta.dirname, "..");
const PRELOAD = pathToFileURL(join(ROOT, "tests", "helpers", "cli-fake.ts")).href;

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "cli-"));
  const env = { ...process.env, EXECUTOR: "fake-cli", PUBLISHER: "fake-cli", TOKEN_BUDGET_TICKET: "100000",
    ORCH_HOME: join(dir, "home"), ORCH_WORK: join(dir, "work"), NOTIFY_URL: "", TOKEN_CAP_DAILY: "" };
  const orch = (...args: string[]) => {
    const r = spawnSync(process.execPath, ["--import", PRELOAD, "scripts/orch.ts", ...args], { cwd: ROOT, env, encoding: "utf8", timeout: 120_000 });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  return { orch, repo: createFixture(dir), done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("orch run stops at the CEO approval, and status shows the ticket waiting", () => {
  const sb = sandbox();
  try {
    const run = sb.orch("run", "Change the checkout button label to Submit order", "--repo", sb.repo, "--id", "T-1");
    assert.equal(run.code, 0, run.out);
    assert.match(run.out, /"type": "approval"/);
    const status = sb.orch("status", "T-1");
    assert.equal(status.code, 0, status.out);
    assert.match(status.out, /T-1\s+\S+\s+P2\s+.*waiting \(approval\)/);
  } finally {
    sb.done();
  }
});

test("orch reject sends the ticket back and it returns for approval; approve then finishes it, and a second approve is refused", () => {
  const sb = sandbox();
  try {
    assert.equal(sb.orch("run", "Change the checkout button label to Submit order", "--repo", sb.repo, "--id", "T-1").code, 0);
    const noReason = sb.orch("reject", "T-1");
    assert.equal(noReason.code, 1);
    assert.match(noReason.out, /rejecting an approval needs a reason/);
    const reject = sb.orch("reject", "T-1", "use a different label");
    assert.equal(reject.code, 0, reject.out);
    assert.match(reject.out, /"type": "approval"/);
    const approve = sb.orch("approve", "T-1");
    assert.equal(approve.code, 0, approve.out);
    assert.match(approve.out, /T-1: simulated_deploy/);
    const again = sb.orch("approve", "T-1");
    assert.equal(again.code, 1);
    assert.match(again.out, /T-1 is not waiting for an answer/);
  } finally {
    sb.done();
  }
});
