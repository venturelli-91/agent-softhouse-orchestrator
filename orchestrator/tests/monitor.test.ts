import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordDeploy, registerDeployTarget } from "../src/deploy.ts";
import { listIncidents } from "../src/incidents.ts";
import { approveRollback, watch } from "../src/monitor.ts";

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
  const cmd = { rollback: "node --nonexistent-flag", health_url: "http://127.0.0.1:1/h", env: [], timeout_s: 30, max_latency_ms: 2000, environment: "staging" as const };
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
