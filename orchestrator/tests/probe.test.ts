import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordDeploy } from "../src/deploy.ts";
import { defaultProbe, httpProbe } from "../src/probe.ts";

let server: Server;
let handler: (res: import("node:http").ServerResponse) => void = (res) => res.end("ok");
let url = "";
beforeEach(async () => {
  handler = (res) => res.end("ok");
  server = createServer((_req, res) => handler(res));
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/health`;
});
afterEach(() => {
  server.closeAllConnections();
  server.close();
});
const opts = { timeout_ms: 300, max_latency_ms: 100 };

test("a healthy answer is null", async () => assert.equal(await httpProbe(url, opts), null));

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

test("defaultProbe uses the simulated probe when the record has no health_url", async () => {
  const home = mkdtempSync(join(tmpdir(), "pr-"));
  recordDeploy(home, { id: "T-1", repo: "/r", sha: "a", previous: "b", target: "simulated", sandbox: true });
  assert.equal(await defaultProbe(home, "T-1"), null);
  rmSync(home, { recursive: true, force: true });
});

test("defaultProbe checks the health url of a command deploy", async () => {
  const home = mkdtempSync(join(tmpdir(), "pr-"));
  const cmd = { rollback: "x", health_url: url, env: [], timeout_s: 30, max_latency_ms: 2000, environment: "staging" as const, git_config_hash: "" };
  recordDeploy(home, { id: "T-1", repo: "/r", sha: "a", previous: "b", target: "command", sandbox: false, cmd });
  assert.equal(await defaultProbe(home, "T-1"), null);
  handler = (res) => (res.statusCode = 500, res.end());
  assert.equal(await defaultProbe(home, "T-1"), "http 500");
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
