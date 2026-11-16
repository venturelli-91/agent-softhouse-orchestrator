import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BacklogItem } from "../src/backlog.ts";
import { addTask, answer, ask, closeDemand, closingChecklist, createDemand, readDemand, type TaskState, waitingDays } from "../src/demand.ts";

const caveat = (ticket: string, status: BacklogItem["status"]): BacklogItem => ({ ticket, from: "reviewer", caveat: "x", time: "", status });

test("the decision log refuses unknown tasks, unknown or answered decisions, and reports how long it waits", () => {
  const home = mkdtempSync(join(tmpdir(), "demand-"));
  try {
    createDemand(home, { id: "D-1", title: "Export", repo: "/r" }, new Date("2026-01-01T00:00:00Z"));
    assert.throws(() => createDemand(home, { id: "D-1", title: "x", repo: "/r" }), /already exists/);
    addTask(home, "D-1", "T-1");
    assert.throws(() => ask(home, "D-1", { question: "drop it?", owner: "CEO", task: "T-9" }), /T-9 is not a task of D-1/);
    ask(home, "D-1", { question: "drop T-1?", owner: "CEO", task: "T-1" }, new Date("2026-01-02T00:00:00Z"));
    assert.equal(waitingDays(readDemand(home, "D-1"), Date.parse("2026-01-04T12:00:00Z")), 2.5);
    assert.throws(() => answer(home, "D-1", 2, "yes"), /no decision #2/);
    answer(home, "D-1", 1, "yes, out of scope");
    assert.throws(() => answer(home, "D-1", 1, "no"), /already answered/);
    assert.equal(waitingDays(readDemand(home, "D-1")), null);
    assert.deepEqual(readDemand(home, "D-1").history.map((h) => h.result), ["created", "task T-1", "asked #1 (CEO)", "answered #1"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("closingChecklist blocks on undecided tasks, open questions, open caveats, a dirty tree and missing evidence", () => {
  const home = mkdtempSync(join(tmpdir(), "demand-"));
  try {
    createDemand(home, { id: "D-1", title: "Export", repo: "/r" });
    for (const t of ["T-1", "T-2", "M-1", "T-3"]) addTask(home, "D-1", t);
    ask(home, "D-1", { question: "drop T-2?", owner: "CEO", task: "T-2" });
    ask(home, "D-1", { question: "which format?", owner: "PM" });
    const tasks: TaskState[] = [
      { id: "T-1", kind: "code", status: "merged", evidence: false },
      { id: "T-2", kind: "code", status: "aborted", evidence: false },
      { id: "M-1", kind: "manual", status: "open", evidence: false },
      { id: "T-3", kind: null },
    ];
    const bad = closingChecklist(readDemand(home, "D-1"), tasks, [caveat("T-1", "open"), caveat("T-9", "open")], " M x");
    assert.deepEqual(bad.map((k) => `${k.ok ? "ok" : "FAIL"} ${k.detail}`), [
      "FAIL T-2 aborted; M-1 open; T-3 missing",
      "FAIL #1 (CEO); #2 (PM)",
      "FAIL T-1: x",
      "FAIL /r has uncommitted changes",
      "FAIL T-1",
    ]);
    assert.equal(closeDemand(home, "D-1", bad).status, "open");
    answer(home, "D-1", 1, "yes");
    answer(home, "D-1", 2, "json");
    const done: TaskState[] = [
      { id: "T-1", kind: "code", status: "merged", evidence: true },
      { id: "T-2", kind: "code", status: "aborted", evidence: false },
      { id: "M-1", kind: "manual", status: "closed", evidence: true },
    ];
    const good = closingChecklist(readDemand(home, "D-1"), done, [caveat("T-1", "reviewed")], "");
    assert.ok(good.every((k) => k.ok), JSON.stringify(good));
    assert.equal(closingChecklist(readDemand(home, "D-1"), [], [], "")[0].detail, "the demand has no tasks");
    assert.equal(closeDemand(home, "D-1", good).status, "closed");
    assert.throws(() => addTask(home, "D-1", "T-4"), /demand D-1 is closed/);
    assert.deepEqual(readDemand(home, "D-1").history.slice(-4).map((h) => h.result.split(":")[0]), ["close refused", "answered #1", "answered #2", "closed"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
