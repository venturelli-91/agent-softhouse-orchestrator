import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Incident } from "../src/incidents.ts";
import { proposePostmortem, writePostmortem } from "../src/postmortem.ts";
import { registerExecutor, type Req } from "../src/run-agent.ts";

let repo = "";
const inc = (id: string, symptom: string): Incident => ({ id, ticket: "T-1", symptom, status: "open", hotfix: "", rollback: "none", opened: "2026-11-02T00:00:00Z" });
const day = new Date("2026-11-02T12:00:00Z");
beforeEach(() => void (repo = mkdtempSync(join(tmpdir(), "pm-"))));
afterEach(() => rmSync(repo, { recursive: true, force: true }));

test("the postmortem lands in playbooks with the date and slug", () => {
  const p = writePostmortem(repo, inc("inc-a", "Endpoints return HTTP 500"), "body", day);
  assert.equal(p, join(repo, "playbooks", "2026-11-02-endpoints-return-http-500.md"));
});

test("writing it twice keeps one file", () => {
  const i = inc("inc-a", "http 500");
  const a = writePostmortem(repo, i, "one", day);
  const b = writePostmortem(repo, i, "two", new Date("2026-11-05T00:00:00Z"));
  assert.equal(a, b);
  assert.equal(readdirSync(join(repo, "playbooks")).length, 1);
});

test("a symptom containing ../ stays inside playbooks", () => {
  const p = writePostmortem(repo, inc("inc-b", "../../x"), "body", day);
  assert.equal(dirname(p), join(repo, "playbooks"));
});

test("proposePostmortem uses the fake knowledge executor", async () => {
  const roles: string[] = [];
  registerExecutor("pm-fake", {
    async run<T>(req: Req<T>) {
      roles.push(req.role);
      return { output: req.schema.parse({ text: "T-CANARY" }), usage: { tokens_in: 1, tokens_out: 0, cache_read: 0, cache_create: 0, cost_usd: 0, turns: 1, ms: 1 } };
    },
  });
  process.env.EXECUTOR = "pm-fake";
  assert.equal(await proposePostmortem(inc("inc-a", "x"), "ctx"), "T-CANARY");
  assert.deepEqual(roles, ["knowledge"]);
});

test("a symlinked playbooks directory is refused", () => {
  const out = mkdtempSync(join(tmpdir(), "pm-out-"));
  try {
    symlinkSync(out, join(repo, "playbooks"), "junction");
    assert.throws(() => writePostmortem(repo, inc("inc-c", "x"), "body", day), /real directory/);
    assert.equal(readdirSync(out).length, 0);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("a marker inside another file or in the text does not count as the postmortem", () => {
  const i = inc("inc-d", "boom");
  mkdirSync(join(repo, "playbooks"));
  writeFileSync(join(repo, "playbooks", "other.md"), `# notes\n${"<!-- incident: inc-d -->"}\n`);
  const p = writePostmortem(repo, i, "x <!-- incident: inc-z --> y", day);
  assert.match(p, /boom\.md$/);
  assert.equal(readFileSync(p, "utf8").includes("<!-- incident: inc-z"), false);
});
