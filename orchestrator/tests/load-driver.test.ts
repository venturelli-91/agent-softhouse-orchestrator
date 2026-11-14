import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { evaluateLoad, p95, type LoadReport } from "../src/load-driver.ts";
import { startDelayProxy } from "../src/load-proxy.ts";
import { LoadConfig } from "../src/repo-config.ts";

const cfg = LoadConfig.parse({ serve: "node s.js", base_url: "http://127.0.0.1:4000", writes: [{ method: "POST", path: "/w" }],
  slow_dependency: { env: "DEP_URL", delay_ms: 2000 } });
const ok: LoadReport = { requests: 1000, errors: 5, baseline_p95_ms: 100, slowed_p95_ms: 200, recovered: true, dep_connections: 40 };

test("thresholds: a healthy report passes and each breach is reported on its own", () => {
  assert.deepEqual(evaluateLoad(ok, cfg), []);
  assert.match(evaluateLoad({ ...ok, errors: 20 }, cfg).join(), /error rate 2\.0% over 1000 requests/);
  assert.match(evaluateLoad({ ...ok, slowed_p95_ms: 4200, baseline_p95_ms: 310 }, cfg).join(), /fast_path p95 4200ms vs 310ms baseline.*lock or pool held across the call/);
  assert.match(evaluateLoad({ ...ok, recovered: false }, cfg).join(), /did not answer within 10s/);
  assert.match(evaluateLoad({ ...ok, dep_connections: 0 }, cfg).join(), /dependency not reached/);
});

test("thresholds: slow p95 needs to break both the absolute limit and the ratio", () => {
  assert.deepEqual(evaluateLoad({ ...ok, baseline_p95_ms: 400, slowed_p95_ms: 1900 }, cfg), []);
  assert.deepEqual(evaluateLoad({ ...ok, baseline_p95_ms: 10, slowed_p95_ms: 400 }, cfg), []);
  assert.equal(evaluateLoad({ ...ok, baseline_p95_ms: 10, slowed_p95_ms: 600 }, cfg).length, 1);
  assert.equal(p95([1, 2, 3, 4, 5, 6, 7, 8, 9, 100]), 100);
  assert.equal(p95([]), 0);
});

test("the stub proxy really delays and close frees the port", async () => {
  const p = await startDelayProxy();
  const url = `http://127.0.0.1:${p.port}/`;
  let t0 = Date.now();
  await fetch(url).then((r) => r.text());
  const fast = Date.now() - t0;
  p.delay_ms = 400;
  t0 = Date.now();
  await fetch(url).then((r) => r.text());
  assert.ok(Date.now() - t0 >= 350 && fast < 300, `${fast} / ${Date.now() - t0}`);
  assert.equal(p.connections, 2);
  await p.close();
  await assert.rejects(fetch(url));
});

test("the TCP proxy forwards to its target and delays the bytes toward it", async () => {
  const target = createServer((_, res) => res.end("from-target"));
  await new Promise<void>((ok) => target.listen(0, "127.0.0.1", ok));
  const p = await startDelayProxy(`127.0.0.1:${(target.address() as { port: number }).port}`);
  const url = `http://127.0.0.1:${p.port}/`;
  assert.equal(await fetch(url).then((r) => r.text()), "from-target");
  p.delay_ms = 400;
  const t0 = Date.now();
  assert.equal(await fetch(url, { headers: { connection: "close" } }).then((r) => r.text()), "from-target");
  assert.ok(Date.now() - t0 >= 350, `${Date.now() - t0}`);
  await p.close();
  target.closeAllConnections();
  await new Promise((ok) => target.close(ok));
  await assert.rejects(fetch(url));
});
