import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkEvidence, createManual, readManual, recordEvidence } from "../src/manual.ts";

test("checkEvidence verifies exit code, expected names, size and JSON without leaking the content", () => {
  const dir = mkdtempSync(join(tmpdir(), "manual-"));
  try {
    const f = (name: string, body: string) => {
      writeFileSync(join(dir, name), body);
      return join(dir, name);
    };
    const ok = f("out.json", '{"cpf":"123"}');
    const bad = f("bad.json", "cpf=123.456.789-00");
    const empty = f("empty.csv", "");
    assert.equal(checkEvidence({ expect: ["out.json"] }, [ok], 0).ok, true);
    assert.match(checkEvidence({ expect: [] }, [ok], 0).result, /^evidence: exit 0; out\.json 13 B sha256:[0-9a-f]{64}$/);
    const r = checkEvidence({ expect: ["out.json", "report.csv"] }, [bad, empty, join(dir, "nope.txt")], 2);
    assert.equal(r.ok, false);
    for (const p of [/exit code 2/, /missing expected files: out\.json, report\.csv/, /bad\.json: not valid JSON/, /empty\.csv: empty/])
      assert.match(r.result, p);
    assert.match(r.result, /nope\.txt: not a file/);
    assert.doesNotMatch(r.result, /cpf|123/);
    mkdirSync(join(dir, "folder.json"));
    assert.match(checkEvidence({ expect: [] }, [join(dir, "folder.json")], 0).result, /folder\.json: not a file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recordEvidence keeps a failed attempt in the history, closes on a pass and refuses a closed ticket", () => {
  const home = mkdtempSync(join(tmpdir(), "manual-home-"));
  try {
    createManual(home, { id: "M-1", title: "Export", command: "psql -f export.sql", criteria: ["one row per customer"], expect: ["out.json"] });
    assert.throws(() => createManual(home, { id: "M-1", title: "x", command: "x", criteria: ["x"], expect: [] }), /already exists/);
    const out = join(home, "out.json");
    writeFileSync(out, "[]");
    assert.equal(recordEvidence(home, "M-1", [out], 1).ok, false);
    assert.equal(readManual(home, "M-1").status, "open");
    assert.equal(recordEvidence(home, "M-1", [out], 0).ok, true);
    const m = readManual(home, "M-1");
    assert.equal(m.status, "closed");
    assert.deepEqual(m.history.map((h) => h.result.split(" ")[0]), ["created", "evidence", "evidence:"]);
    assert.match(recordEvidence(home, "M-1", [out], 0).result, /already closed/);
    assert.equal(readManual(home, "M-1").history.length, 3);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
