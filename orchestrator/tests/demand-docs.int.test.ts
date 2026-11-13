// `orch demand close` against the repo's project_docs (coherence check), through the real CLI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createFixture, git } from "../scripts/fixture.ts";

const ROOT = resolve(import.meta.dirname, "..");
const PRELOAD = pathToFileURL(join(ROOT, "tests", "helpers", "cli-fake.ts")).href;

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "cli-"));
  const env = { ...process.env, EXECUTOR: "fake-cli", PUBLISHER: "fake-cli", ORCH_HOME: join(dir, "home"), ORCH_WORK: join(dir, "work"),
    NOTIFY_URL: "", TOKEN_CAP_DAILY: "" };
  const orch = (...args: string[]) => {
    const r = spawnSync(process.execPath, ["--import", PRELOAD, "scripts/orch.ts", ...args], { cwd: ROOT, env, encoding: "utf8", timeout: 120_000 });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const repo = createFixture(dir);
  return { orch, repo, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("orch demand close refuses while a project doc still lists a delivered task as pending, and closes once it is fixed", () => {
  const sb = sandbox();
  try {
    writeFileSync(join(sb.repo, ".orchestrator.json"), '{"project_docs":["README.md"]}\n');
    writeFileSync(join(sb.repo, "README.md"), "# Fixture\n\n- [ ] M-1 export the customers\n");
    git(sb.repo, "add", "-A");
    git(sb.repo, "commit", "-qm", "docs");
    assert.equal(sb.orch("demand", "new", "Customer export", "--repo", sb.repo, "--id", "D-1").code, 0);
    assert.equal(sb.orch("manual", "Export", "--command", "node out.js", "--criteria", "one row each", "--id", "M-1", "--demand", "D-1").code, 0);
    writeFileSync(join(sb.repo, "out.json"), "[]");
    assert.equal(sb.orch("evidence", "M-1", join(sb.repo, "out.json"), "--exit", "0").code, 0);
    rmSync(join(sb.repo, "out.json"));
    const refused = sb.orch("demand", "close", "D-1");
    assert.equal(refused.code, 1, refused.out);
    assert.match(refused.out, /FAIL project docs match the delivery: README\.md: "- \[ \] M-1 export the customers" is pending but M-1 is delivered/);
    writeFileSync(join(sb.repo, "README.md"), "# Fixture\n\n- [x] M-1 export the customers\n");
    git(sb.repo, "commit", "-qam", "docs");
    const closed = sb.orch("demand", "close", "D-1");
    assert.equal(closed.code, 0, closed.out);
    assert.match(closed.out, /ok {3}project docs match the delivery: 1 doc\(s\)[\s\S]*D-1: closed/);
  } finally {
    sb.done();
  }
});
