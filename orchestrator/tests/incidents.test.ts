import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprint, listIncidents, MAX_OPEN_INCIDENTS, openIncident, updateIncident } from "../src/incidents.ts";

let home = "";
beforeEach(() => void (home = mkdtempSync(join(tmpdir(), "inc-"))));
afterEach(() => rmSync(home, { recursive: true, force: true }));

test("same ticket and symptom open once", () => {
  const a = openIncident(home, "T-1", "http 500");
  const b = openIncident(home, "T-1", "http 500");
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(b.incident.id, a.incident.id);
  assert.equal(listIncidents(home).length, 1);
  assert.equal(fingerprint("T-1", "http 500").length, 12);
});

test("a different symptom opens another", () => {
  openIncident(home, "T-1", "http 500");
  assert.equal(openIncident(home, "T-1", "latency").created, true);
  assert.equal(listIncidents(home).length, 2);
});

test("a closed incident can be opened again", () => {
  const a = openIncident(home, "T-1", "http 500");
  updateIncident(home, a.incident.id, { status: "closed" });
  const b = openIncident(home, "T-1", "http 500");
  assert.equal(b.created, true);
  assert.equal(b.incident.status, "open");
  assert.equal(b.incident.hotfix, "");
  assert.equal(b.incident.rollback, "none");
});

test("the cap of open incidents throws", () => {
  for (let i = 0; i < MAX_OPEN_INCIDENTS; i++) openIncident(home, `T-${i}`, "x");
  assert.throws(() => openIncident(home, "T-new", "x"), /open incident limit reached/);
  assert.equal(openIncident(home, "T-0", "x").created, false);
});

test("updateIncident merges and listIncidents sorts by opened", () => {
  const a = openIncident(home, "T-1", "a").incident;
  const b = openIncident(home, "T-2", "b").incident;
  updateIncident(home, a.id, { opened: "2020-01-01T00:00:00.000Z" });
  const u = updateIncident(home, b.id, { hotfix: "T-9" });
  assert.equal(u.hotfix, "T-9");
  assert.equal(u.symptom, "b");
  assert.deepEqual(listIncidents(home).map((i) => i.id), [a.id, b.id]);
});
