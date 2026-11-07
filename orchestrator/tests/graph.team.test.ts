// A repo's own team: which specialties triage may route to.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixture, git } from "../scripts/fixture.ts";
import { loadRepoConfig } from "../src/repo-config.ts";
import { SPECIALTIES } from "../src/specialties.ts";
import { defaults, knobs, paused, start } from "./helpers/graph-harness.ts";

function repoWith(config: object | null) {
  const root = mkdtempSync(join(tmpdir(), "team-"));
  const repo = createFixture(root);
  if (config) {
    writeFileSync(join(repo, ".orchestrator.json"), JSON.stringify(config));
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "config");
  }
  return { repo, ref: git(repo, "rev-parse", "HEAD"), done: () => rmSync(root, { recursive: true, force: true }) };
}

test("a repo without a team in its config gets the whole team", () => {
  const r = repoWith(null);
  try {
    assert.deepEqual(loadRepoConfig(r.repo, r.ref, join(r.repo, "no-home")).specialties, [...SPECIALTIES]);
  } finally {
    r.done();
  }
});

test("a repo can list a subset of the specialties; unknown or empty lists are refused", () => {
  const ok = repoWith({ specialties: ["backend", "fullstack"] });
  try {
    assert.deepEqual(loadRepoConfig(ok.repo, ok.ref, join(ok.repo, "no-home")).specialties, ["backend", "fullstack"]);
  } finally {
    ok.done();
  }
  for (const specialties of [["backend", "telepathy"], []]) {
    const bad = repoWith({ specialties });
    try {
      assert.throws(() => loadRepoConfig(bad.repo, bad.ref, join(bad.repo, "no-home")), /specialties/);
    } finally {
      bad.done();
    }
  }
});

test("triage answering a specialty the repo does not have is a failure: it escalates and the dev does not run", async () => {
  const g = await start("T-1", undefined, { specialties: ["backend", "fullstack"] });
  assert.equal(paused(g.r)?.type, "escalation");
  assert.ok(!knobs.calls.includes("dev"));
});

test("triage told the repo's team routes within it, and the dev prompt is the chosen specialty's", async () => {
  let seen = "";
  knobs.override.triage = (req) => ((seen = req.context), { ...(defaults.triage!(req) as object), specialty: "backend" });
  knobs.override.dev = (req) => (seen += ` | dev:${req.files.join(",")}`, defaults.dev!(req));
  const g = await start("T-1", undefined, { specialties: ["backend", "fullstack"] });
  assert.equal(paused(g.r)?.type, "approval");
  assert.match(seen, /Specialties available in this repo: backend, fullstack\./);
  assert.match(seen, /dev:dev-backend/);
});

test("the whole team adds no note to the triage prompt", async () => {
  let seen = "";
  knobs.override.triage = (req) => ((seen = req.context), defaults.triage!(req));
  await start();
  assert.ok(seen.length > 0);
  assert.doesNotMatch(seen, /Specialties available/);
});
