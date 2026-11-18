import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockTicket, runningPid, runState, ticketFile, ticketIds } from "../src/ticket-store.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "tstore-"));

test("a second lock on the same id throws already running", () => {
  const home = tmp();
  lockTicket(home, "T-1");
  assert.throws(() => lockTicket(home, "T-1"), /T-1 is already running \(pid \d+\)/);
});

test("releasing allows locking again", () => {
  const home = tmp();
  lockTicket(home, "T-1")();
  lockTicket(home, "T-1")();
});

test("a lock whose pid is dead is replaced", () => {
  const home = tmp();
  const dead = spawnSync(process.execPath, ["-e", ""]);
  mkdirSync(join(home, "tickets"), { recursive: true });
  writeFileSync(join(home, "tickets", "T-1.lock"), String(dead.pid ?? 2 ** 22 - 1));
  lockTicket(home, "T-1")();
});

test("different ids do not block each other", () => {
  const home = tmp();
  lockTicket(home, "T-1");
  lockTicket(home, "T-2");
});

test("ids with path separators or dots are rejected", () => {
  const home = tmp();
  for (const id of ["../x", "a/b", "a\b", ".", "..", ""]) assert.throws(() => ticketFile(home, id), /invalid ticket id/);
});

test("ticketIds lists created files", () => {
  const home = tmp();
  assert.deepEqual(ticketIds(home), []);
  mkdirSync(join(home, "tickets"), { recursive: true });
  writeFileSync(ticketFile(home, "T-2"), "{}");
  writeFileSync(ticketFile(home, "T-1"), "{}");
  lockTicket(home, "T-1");
  assert.deepEqual(ticketIds(home), ["T-1", "T-2"]);
});

test("runningPid sees a live lock and ignores a released one or one left by a dead process", () => {
  const home = tmp();
  assert.equal(runningPid(home, "T-1"), null);
  const unlock = lockTicket(home, "T-1");
  assert.equal(runningPid(home, "T-1"), process.pid);
  unlock();
  assert.equal(runningPid(home, "T-1"), null);
  const dead = spawnSync(process.execPath, ["-e", ""]);
  lockTicket(home, "T-2", dead.pid);
  assert.equal(runningPid(home, "T-2"), null);
});

test("runState tells waiting, running, dead and done apart", () => {
  const home = tmp();
  assert.equal(runState(home, "T-1", null, "dev"), "dead");
  assert.equal(runState(home, "T-1", { type: "approval" }, "approval"), "waiting");
  assert.equal(runState(home, "T-1", null, "deployed"), "done");
  const unlock = lockTicket(home, "T-1");
  assert.equal(runState(home, "T-1", null, "dev"), "running");
  unlock();
  assert.equal(runState(home, "T-1", null, "dev"), "dead");
});

test("a killed process leaves a stale lock: dead until the ticket reaches a finished status", async () => {
  const home = tmp();
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  const exited = new Promise((r) => child.once("exit", r));
  lockTicket(home, "T-1", child.pid);
  assert.equal(runState(home, "T-1", null, "dev"), "running");
  child.kill();
  await exited;
  assert.equal(runState(home, "T-1", null, "dev"), "dead");
  assert.equal(runState(home, "T-1", null, "merged"), "done");
});

test("an empty, zero, negative or non-numeric lock reads as not running", () => {
  const home = tmp();
  mkdirSync(join(home, "tickets"), { recursive: true });
  for (const text of ["", "0", "-1", "abc"]) {
    writeFileSync(join(home, "tickets", "T-1.lock"), text);
    assert.equal(runningPid(home, "T-1"), null, `lock "${text}"`);
  }
});
