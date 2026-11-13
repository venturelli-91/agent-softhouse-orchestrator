import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addCaveats, readBacklog, reviewBacklog } from "../src/backlog.ts";

test("reviewBacklog appends a reviewed line, keeps numbering and stops the caveat from coming back as open", () => {
  const home = mkdtempSync(join(tmpdir(), "backlog-"));
  try {
    assert.equal(addCaveats("T-1", "reviewer", ["a", "b"], home), 2);
    assert.equal(addCaveats("T-2", "qa", ["c"], home), 1);
    assert.throws(() => reviewBacklog([2, 4], home), /no backlog item 4/);
    assert.throws(() => reviewBacklog([0], home), /no backlog item 0/);
    assert.equal(readFileSync(join(home, "backlog.jsonl"), "utf8").split("\n").filter(Boolean).length, 3);
    assert.deepEqual(reviewBacklog([2], home).map((i) => i.caveat), ["b"]);
    assert.deepEqual(readBacklog(home).map((i) => `${i.caveat}:${i.status}`), ["a:open", "b:reviewed", "c:open"]);
    assert.equal(addCaveats("T-1", "reviewer", ["b"], home), 0);
    assert.equal(readBacklog(home)[1].status, "reviewed");
    addCaveats("T-3", "qa", ["\u001b]8;;http://x\u0007click\u001b[2J\nnext"], home);
    assert.equal(readBacklog(home)[3].caveat, "]8;;http://x click [2J next");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
