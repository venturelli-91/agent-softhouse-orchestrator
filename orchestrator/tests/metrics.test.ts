import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordMetrics, ticketMetrics } from "../src/metrics.ts";

const u = (tokens_in: number, tokens_out: number, cost_usd: number) => ({ tokens_in, tokens_out, cost_usd });
const ticket = {
  id: "T-1", status: "deployed", priority: "P1", specialty: "backend", revisions: 1, tasks: ["a", "b"],
  history: [
    { node: "triage", time: "t1", result: "clear", ms: 100, usage: u(10, 5, 0.01) },
    { node: "dev", time: "t2", result: "commit verified", ms: 400, usage: u(100, 20, 0.1) },
    { node: "reviewer", time: "t3", result: "rejected", ms: 50, usage: u(30, 5, 0.02) },
    { node: "dev", time: "t4", result: "escalated: budget", ms: 300, usage: u(80, 10, 0.08) },
    { node: "ceo_approval", time: "t5", result: "approved", ms: 0 },
  ],
};

test("metrics add up per node and count escalations, revisions and route", () => {
  const m = ticketMetrics(ticket);
  assert.equal(m.nodes.dev.runs, 2);
  assert.equal(m.nodes.dev.tokens, 210);
  assert.equal(m.tokens, 260);
  assert.equal(m.ms, 850);
  assert.equal(m.usd, 0.21);
  assert.equal(m.escalations, 1);
  assert.equal(m.revisions, 1);
  assert.equal(m.route, "clear");
  assert.equal(m.tasks, 2);
});

test("a planner run marks the ticket ambiguous; recordMetrics appends one JSON line per ticket", () => {
  const home = mkdtempSync(join(tmpdir(), "metrics-"));
  recordMetrics(home, { ...ticket, tasks: [], history: [...ticket.history, { node: "planner", time: "t6", result: "clear", ms: 1 }] });
  recordMetrics(home, ticket);
  const lines = readFileSync(join(home, "metrics.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].route, "ambiguous");
  assert.equal(lines[0].tasks, 1);
  assert.equal(lines[1].id, "T-1");
});
