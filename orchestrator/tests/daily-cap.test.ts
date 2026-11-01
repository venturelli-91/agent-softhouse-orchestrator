import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dailyCapReached, recordUsage, usedToday } from "../src/daily-cap.ts";

test("the daily cap counts only the last 24h and is off when unset", () => {
  const home = mkdtempSync(join(tmpdir(), "cap-"));
  const env = { ORCH_HOME: home, TOKEN_CAP_DAILY: "1000" };
  const now = Date.now();
  recordUsage(900, env, now - 25 * 3_600_000);
  recordUsage(600, env, now - 3_600_000);
  assert.equal(usedToday(env, now), 600);
  assert.equal(dailyCapReached(env, now), null);
  recordUsage(400, env, now);
  assert.match(dailyCapReached(env, now)!, /daily token cap reached \(1000 >= 1000/);
  assert.equal(dailyCapReached({ ORCH_HOME: home }, now), null);
  const off = { ORCH_HOME: mkdtempSync(join(tmpdir(), "cap-off-")) };
  recordUsage(5, off, now);
  assert.equal(usedToday(off, now), 0);
  rmSync(home, { recursive: true, force: true });
});
