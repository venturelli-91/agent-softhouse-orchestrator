import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetDeploy, readCounters, recordDeploy } from "../src/deploy.ts";
import { defaultProbe, httpProbe, unmonitored } from "../src/probe.ts";

let server: Server;
type Res = import("node:http").ServerResponse;
type Req = import("node:http").IncomingMessage;
let handler: (res: Res, req: Req) => void = (res) => res.end("ok");
let url = "";
beforeEach(async () => {
  handler = (res) => res.end("ok");
  server = createServer((req, res) => handler(res, req));
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/health`;
});
afterEach(() => {
  server.closeAllConnections();
  server.close();
});
const opts = { timeout_ms: 300, max_latency_ms: 100 };

test("a healthy answer is null", async () =>
  assert.equal(await httpProbe(url, { timeout_ms: 2000, max_latency_ms: 1000 }), null));

test("a 503 reports http 503", async () => {
  handler = (res) => (res.statusCode = 503, res.end());
  assert.equal(await httpProbe(url, opts), "http 503");
});

test("a slow answer reports latency over the limit", async () => {
  handler = (res) => void setTimeout(() => res.end("ok"), 150);
  assert.equal(await httpProbe(url, { timeout_ms: 1000, max_latency_ms: 50 }), "latency over 50ms");
});

test("a hanging answer reports a timeout", async () => {
  handler = () => {};
  assert.equal(await httpProbe(url, opts), "timeout after 300ms");
});

test("a closed port reports unreachable", async () => {
  server.close();
  assert.match((await httpProbe(url, opts))!, /^unreachable: /);
});

test("defaultProbe returns null (not monitored) when the record has no health_url", async () => {
  const home = mkdtempSync(join(tmpdir(), "pr-"));
  recordDeploy(home, { id: "T-1", repo: "/r", sha: "a", previous: "b", target: "simulated", sandbox: true });
  assert.equal(await defaultProbe(home, "T-1"), null);
  assert.deepEqual(unmonitored(home), ["T-1"]);
  rmSync(home, { recursive: true, force: true });
});

test("defaultProbe checks the health url of a command deploy", async () => {
  const home = mkdtempSync(join(tmpdir(), "pr-"));
  const cmd = { rollback: "x", health_url: url, env: [], timeout_s: 30, max_latency_ms: 2000, environment: "staging" as const, git_config_hash: "" };
  recordDeploy(home, { id: "T-1", repo: "/r", sha: "a", previous: "b", target: "command", sandbox: false, cmd });
  assert.equal(await defaultProbe(home, "T-1"), null);
  handler = (res) => (res.statusCode = 500, res.end());
  assert.equal(await defaultProbe(home, "T-1"), "http 500");
  assert.deepEqual(unmonitored(home), []);
  rmSync(home, { recursive: true, force: true });
});

test("a redirect is a symptom, not a success", async () => {
  handler = (res) => (res.statusCode = 302, res.setHeader("location", "http://127.0.0.1:1/other"), res.end());
  assert.equal(await httpProbe(url, opts), "http 302");
});

test("an unreachable symptom never carries the url", async () => {
  server.close();
  const symptom = (await httpProbe(url.replace("127.0.0.1", "user:pw@127.0.0.1"), opts))!;
  assert.ok(!symptom.includes("pw") && !symptom.includes("127.0.0.1"), symptom);
});

const deployWith = (home: string, extra: object) => recordDeploy(home, { id: "T-1", repo: "/r", sha: "a", previous: "b", target: "command", sandbox: false,
  cmd: { rollback: "x", health_url: url, env: [], timeout_s: 30, max_latency_ms: 2000, environment: "staging", git_config_hash: "", ...extra } });
let counters: unknown = { requests: 0, errors_5xx: 0 };
const metricsHandler = (res: Res, req: Req) => req.url === "/metrics" ? res.end(typeof counters === "string" ? counters : JSON.stringify(counters)) : res.end("ok");
const origin = () => new URL(url).origin;
const withHome = async (f: (home: string) => Promise<void>) => {
  const home = mkdtempSync(join(tmpdir(), "pr-"));
  try { await f(home); } finally { rmSync(home, { recursive: true, force: true }); }
};
const poll = (home: string, c: unknown) => (counters = c, defaultProbe(home, "T-1"));

test("a failing synthetic check is the symptom", () => withHome(async (home) => {
  deployWith(home, { checks: [{ method: "GET", path: "/login", expect_status: 200 }] });
  handler = (res, req) => (req.url === "/login" && (res.statusCode = 500), res.end("ok"));
  assert.equal(await defaultProbe(home, "T-1"), "http 500 on GET /login");
}));

test("a check matches its expected status exactly, with its method and body", () => withHome(async (home) => {
  deployWith(home, { checks: [{ method: "POST", path: "/items", expect_status: 201, body: '{"a":1}' }] });
  handler = (res, req) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => (res.statusCode = req.method === "POST" && b === '{"a":1}' ? 201 : 200, res.end()));
  };
  assert.equal(await defaultProbe(home, "T-1"), null);
  handler = (res) => (res.statusCode = 200, res.end());
  assert.equal(await defaultProbe(home, "T-1"), "http 200 on POST /items");
}));

test("a check may expect a redirect, which is not followed", () => withHome(async (home) => {
  deployWith(home, { checks: [{ method: "GET", path: "/r", expect_status: 302 }] });
  handler = (res, req) => req.url === "/r" ? (res.statusCode = 302, res.setHeader("location", "http://127.0.0.1:1/x"), res.end()) : res.end("ok");
  assert.equal(await defaultProbe(home, "T-1"), null);
}));

test("a dropped check connection keeps the unreachable prefix", () => withHome(async (home) => {
  deployWith(home, { checks: [{ method: "GET", path: "/x", expect_status: 200 }] });
  handler = (res, req) => req.url === "/x" ? req.socket.destroy() : res.end("ok");
  assert.match((await defaultProbe(home, "T-1"))!, /^unreachable: \S+ on GET \/x$/);
}));

test("a failing health url stops before the checks and the metrics", () => withHome(async (home) => {
  deployWith(home, { checks: [{ method: "GET", path: "/login", expect_status: 200 }], metrics_url: origin() + "/metrics" });
  const hits: Record<string, number> = { "/login": 0, "/metrics": 0 };
  handler = (res, req) => (hits[req.url!] !== undefined && hits[req.url!]++, res.statusCode = 500, res.end());
  assert.equal(await defaultProbe(home, "T-1"), "http 500");
  assert.deepEqual(hits, { "/login": 0, "/metrics": 0 });
  assert.equal(readCounters(home, "T-1"), null);
}));

test("an error rate over the limit is the symptom", () => withHome(async (home) => {
  deployWith(home, { metrics_url: origin() + "/metrics" });
  handler = metricsHandler;
  assert.equal(await poll(home, { requests: 100, errors_5xx: 0 }), null);
  assert.equal(await poll(home, { requests: 200, errors_5xx: 5 }), "error rate 5.0% over 2%");
}));

test("a healthy service with checks and metrics stays null across polls", () => withHome(async (home) => {
  deployWith(home, { checks: [{ method: "GET", path: "/ok", expect_status: 200 }], metrics_url: origin() + "/metrics" });
  handler = metricsHandler;
  assert.equal(await poll(home, { requests: 100, errors_5xx: 1 }), null);
  assert.equal(await poll(home, { requests: 200, errors_5xx: 2 }), null);
}));

test("an error rate exactly at the limit is healthy and a non-round limit prints cleanly", () => withHome(async (home) => {
  deployWith(home, { metrics_url: origin() + "/metrics", max_error_rate: 0.07 });
  handler = metricsHandler;
  assert.equal(await poll(home, { requests: 100, errors_5xx: 0 }), null);
  assert.equal(await poll(home, { requests: 200, errors_5xx: 7 }), null);
  assert.equal(await poll(home, { requests: 300, errors_5xx: 17 }), "error rate 10.0% over 7%");
}));

test("a counter reset skips that poll and becomes the new baseline", () => withHome(async (home) => {
  deployWith(home, { metrics_url: origin() + "/metrics" });
  handler = metricsHandler;
  assert.equal(await poll(home, { requests: 200, errors_5xx: 5 }), null);
  assert.equal(await poll(home, { requests: 10, errors_5xx: 9 }), null);
  assert.equal(await poll(home, { requests: 110, errors_5xx: 10 }), null);
  assert.equal(readCounters(home, "T-1")?.requests, 110);
}));

test("zero new requests is healthy", () => withHome(async (home) => {
  deployWith(home, { metrics_url: origin() + "/metrics" });
  handler = metricsHandler;
  assert.equal(await poll(home, { requests: 100, errors_5xx: 3 }), null);
  assert.equal(await poll(home, { requests: 100, errors_5xx: 3 }), null);
}));

test("an invalid metrics payload is a symptom", () => withHome(async (home) => {
  deployWith(home, { metrics_url: origin() + "/metrics" });
  handler = metricsHandler;
  for (const bad of [{ requests: "x", errors_5xx: 0 }, { requests: -1, errors_5xx: 0 }, { requests: 1 }, "not json"])
    assert.equal(await poll(home, bad), "metrics: invalid payload");
}));

test("a failing metrics endpoint is a symptom without the url", () => withHome(async (home) => {
  deployWith(home, { metrics_url: origin() + "/metrics" });
  handler = (res, req) => (req.url === "/metrics" && (res.statusCode = 503), res.end());
  assert.equal(await defaultProbe(home, "T-1"), "http 503 on metrics");
  deployWith(home, { metrics_url: "http://127.0.0.1:1/metrics" });
  const s = (await defaultProbe(home, "T-1"))!;
  assert.match(s, /^unreachable: \S+ on metrics$/);
  assert.ok(!s.includes("127.0.0.1"), s);
}));

test("forgetDeploy removes the counters", () => withHome(async (home) => {
  deployWith(home, { metrics_url: origin() + "/metrics" });
  handler = metricsHandler;
  await poll(home, { requests: 1, errors_5xx: 0 });
  assert.ok(readCounters(home, "T-1"));
  forgetDeploy(home, "T-1");
  assert.equal(readCounters(home, "T-1"), null);
}));

test("a check that times out keeps the timeout prefix", () => withHome(async (home) => {
  deployWith(home, { checks: [{ method: "GET", path: "/slow", expect_status: 200 }] });
  handler = (res, req) => req.url === "/slow" ? void 0 : res.end("ok");
  assert.match((await defaultProbe(home, "T-1"))!, /^timeout after \d+ms on GET \/slow$/);
}));
