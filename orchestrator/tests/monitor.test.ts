import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetDeploy, recordDeploy, registerDeployTarget } from "../src/deploy.ts";
import { listIncidents } from "../src/incidents.ts";
import { approveRollback, resolveIncident, watch } from "../src/monitor.ts";
import { createFixture, git } from "../scripts/fixture.ts";
import { gitConfigHash } from "../src/guardrails.ts";

let home = "";
let symptom: string | null = null;
let tickets = 0;
let limit = false;
const rollbacks: string[] = [];
const notes: string[] = [];
const deps = () => ({
  probe: () => symptom,
  makeHotfix: async () => {
    if (limit) throw new Error("active ticket limit reached");
    return `hot-${++tickets}`;
  },
  notify: async (t: string) => void notes.push(t),
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mon-"));
  symptom = "endpoints return HTTP 500";
  tickets = 0;
  limit = false;
  rollbacks.length = 0;
  notes.length = 0;
  registerDeployTarget("rec", { sandbox: true, deploy: () => "d", rollback: (d) => (rollbacks.push(d.id), "r") });
  recordDeploy(home, { id: "T-1", repo: "/r", sha: "a", previous: "b", target: "rec", sandbox: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

test("two watches on one failure make one incident, one ticket and one notification", async () => {
  await watch(home, deps());
  await watch(home, deps());
  const all = listIncidents(home);
  assert.equal(all.length, 1);
  assert.equal(all[0].hotfix, "hot-1");
  assert.equal(all[0].rollback, "proposed");
  assert.equal(tickets, 1);
  assert.equal(notes.length, 1);
});

test("a limit error leaves the incident waiting and the next watch creates the ticket", async () => {
  limit = true;
  await watch(home, deps());
  assert.equal(listIncidents(home)[0].status, "waiting");
  assert.equal(listIncidents(home)[0].hotfix, "");
  limit = false;
  await watch(home, deps());
  const i = listIncidents(home)[0];
  assert.equal(i.status, "open");
  assert.equal(i.hotfix, "hot-1");
  assert.equal(notes.length, 1);
});

test("the rollback target is not called until approveRollback", async () => {
  await watch(home, deps());
  assert.deepEqual(rollbacks, []);
  approveRollback(home, listIncidents(home)[0].id);
  assert.deepEqual(rollbacks, ["T-1"]);
});

test("approveRollback twice rolls back once", async () => {
  await watch(home, deps());
  const id = listIncidents(home)[0].id;
  approveRollback(home, id);
  assert.throws(() => approveRollback(home, id), /already rolled back/);
  assert.equal(rollbacks.length, 1);
});

test("approveRollback refuses when no rollback was proposed", async () => {
  limit = true;
  await watch(home, deps());
  assert.throws(() => approveRollback(home, listIncidents(home)[0].id), /not proposed/);
  assert.deepEqual(rollbacks, []);
});

test("a healthy probe closes the incident", async () => {
  await watch(home, deps());
  symptom = null;
  await watch(home, deps());
  assert.equal(listIncidents(home)[0].status, "closed");
});

test("a failing rollback command leaves the incident proposed and a retry succeeds", async () => {
  const cmd = { rollback: "node --nonexistent-flag", health_url: "http://127.0.0.1:1/h", env: [], timeout_s: 30, max_latency_ms: 2000, environment: "staging" as const, git_config_hash: "" };
  recordDeploy(home, { id: "T-2", repo: process.cwd(), sha: "a", previous: "b", target: "command", sandbox: false, cmd });
  await watch(home, { ...deps(), probe: (_h, id) => (id === "T-2" ? "http 503" : null) });
  const id = listIncidents(home).find((i) => i.ticket === "T-2")!.id;
  assert.throws(() => approveRollback(home, id), /nonexistent-flag/);
  assert.equal(listIncidents(home).find((i) => i.id === id)!.rollback, "proposed");
  recordDeploy(home, { id: "T-2", repo: process.cwd(), sha: "a", previous: "b", target: "command", sandbox: false, cmd: { ...cmd, rollback: "node --version" } });
  approveRollback(home, id);
  assert.equal(listIncidents(home).find((i) => i.id === id)!.rollback, "done");
});

test("watch awaits an async probe", async () => {
  await watch(home, { ...deps(), probe: async () => "async symptom" });
  assert.equal(listIncidents(home)[0].symptom, "async symptom");
});

test("a symptom that changes during one outage updates the incident instead of opening another", async () => {
  await watch(home, { ...deps(), probe: () => "unreachable: ECONNREFUSED" });
  await watch(home, { ...deps(), probe: () => "http 503" });
  const all = listIncidents(home);
  assert.equal(all.length, 1);
  assert.equal(all[0].symptom, "http 503");
  assert.equal(tickets, 1);
  assert.equal(notes.length, 1);
});

test("a changed .git/config blocks the rollback until it is reviewed", async () => {
  const root = mkdtempSync(join(tmpdir(), "mon-repo-"));
  try {
    const repo = createFixture(root);
    const cmd = { rollback: "node --version", health_url: "http://127.0.0.1:1/h", env: [], timeout_s: 30, max_latency_ms: 2000, environment: "staging" as const, git_config_hash: gitConfigHash(repo) };
    recordDeploy(home, { id: "T-3", repo, sha: "a", previous: "b", target: "command", sandbox: false, cmd });
    await watch(home, { ...deps(), probe: (_h, id) => (id === "T-3" ? "http 503" : null) });
    const id = listIncidents(home).find((i) => i.ticket === "T-3")!.id;
    git(repo, "config", "--local", "foo.bar", "x");
    assert.throws(() => approveRollback(home, id), /--config-reviewed/);
    approveRollback(home, id, { configReviewed: true });
    assert.equal(listIncidents(home).find((i) => i.id === id)!.rollback, "done");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unreachable service gets a proposed rollback and no hotfix ticket, and a second watch does not repeat it", async () => {
  symptom = "unreachable: ECONNREFUSED";
  await watch(home, deps());
  await watch(home, deps());
  const [i] = listIncidents(home);
  assert.equal(tickets, 0);
  assert.equal(i.hotfix, "");
  assert.equal(i.rollback, "proposed");
  assert.equal(approveRollback(home, i.id), "r");
});

test("resolveIncident closes an incident by hand and rejects an unknown id", async () => {
  await watch(home, deps());
  resolveIncident(home, listIncidents(home)[0].id);
  assert.equal(listIncidents(home)[0].status, "closed");
  assert.throws(() => resolveIncident(home, "inc-nope"), /unknown incident/);
});

test("forgetDeploy removes the record so watch stops probing the ticket", async () => {
  forgetDeploy(home, "T-1");
  await watch(home, deps());
  assert.equal(listIncidents(home).length, 0);
});

test("a watch after the rollback never reopens it, so a second approval is refused", async () => {
  symptom = "unreachable: ECONNREFUSED";
  await watch(home, deps());
  const id = listIncidents(home)[0].id;
  approveRollback(home, id);
  await watch(home, deps());
  symptom = "http 503";
  await watch(home, deps());
  assert.equal(listIncidents(home)[0].rollback, "done");
  assert.throws(() => approveRollback(home, id), /already rolled back/);
  assert.equal(rollbacks.length, 1);
});
