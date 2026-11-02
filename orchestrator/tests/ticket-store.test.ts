import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockTicket, ticketFile, ticketIds } from "../src/ticket-store.ts";

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
