// The load stage against real fixture services (node only) and, through the graph, with a stubbed runner.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySaver } from "@langchain/langgraph";
import { setLoadRunner, realLoad } from "../src/load.ts";
import { LoadConfig } from "../src/repo-config.ts";
import { AppFailure, InfraError } from "../src/webcheck.ts";
import type { Req } from "../src/run-agent.ts";
import { defaults, knobs, paused, start } from "./helpers/graph-harness.ts";

const SERVICE = join(import.meta.dirname, "helpers", "load-service.mjs");

const freePort = () =>
  new Promise<number>((ok) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => ok(port));
    });
  });

async function fixture(mode: string, over: object = {}) {
  const port = await freePort();
  // The CI runner's tmpdir is an 8.3 short name (RUNNER~1); `~` is not allowed in a plain command, so expand it.
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "load-")));
  const info = join(dir, "info.json");
  const cfg = LoadConfig.parse({ serve: `node ${SERVICE} ${port} ${mode} ${info}`, base_url: `http://127.0.0.1:${port}`, writes: [{ method: "POST", path: "/w" }],
    slow_dependency: { env: "DEP_URL", delay_ms: 300 }, duration_s: 2, concurrency: 10, thresholds: { recover_s: 5 }, timeout_s: 60, ...over });
  return { cfg, dir, info, port };
}

async function assertCleanedUp(f: Awaited<ReturnType<typeof fixture>>) {
  const { pid, dep } = JSON.parse(readFileSync(f.info, "utf8"));
  const alive = () => { try { return process.kill(pid, 0); } catch { return false; } };
  for (let i = 0; i < 40 && alive(); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(alive(), false, "the service process is still running");
  await assert.rejects(fetch(f.cfg.base_url, { signal: AbortSignal.timeout(1000) }), "the service port is still open");
  await assert.rejects(fetch(dep, { signal: AbortSignal.timeout(1000) }), "the proxy port is still open");
  // Windows can release the cwd handle a moment after the process is gone; retry the removal.
  for (let i = 0; ; i++) {
    try {
      rmSync(f.dir, { recursive: true, force: true });
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EPERM" || i === 10) throw e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

const run = (f: Awaited<ReturnType<typeof fixture>>) => realLoad(f.cfg, f.dir, { id: "T-1", sha: "abc" });

test("a global lock held across the slow dependency call fails the stage", async () => {
  const f = await fixture("lock");
  const out = await run(f);
  assert.match(out.findings.join("\n"), /fast_path p95 \d+ms vs \d+ms baseline while dependency slow/);
  await assertCleanedUp(f);
});

test("a service that calls the dependency outside any lock passes the stage", async () => {
  const f = await fixture("free");
  const out = await run(f);
  assert.deepEqual(out.findings, []);
  assert.match(out.summary, /requests, error rate .* fast p95 \d+ms baseline vs \d+ms with the dependency slowed/);
  assert.ok((out.report as { dep_connections: number }).dep_connections > 0);
  await assertCleanedUp(f);
});

const OUTAGE = { slow_dependency: { env: "DEP_URL", delay_ms: 300, outage: true } };

test("a service that times out the dead dependency, answers 503 and reconnects passes the outage phase", async () => {
  const f = await fixture("guarded", OUTAGE);
  const out = await run(f);
  assert.deepEqual(out.findings, []);
  const r = out.report as { outage_requests: number; outage_uncontrolled: number; outage_recovered: boolean };
  assert.ok(r.outage_requests > 0 && r.outage_uncontrolled === 0 && r.outage_recovered, JSON.stringify(r));
  assert.match(out.summary, /; dependency down: 0\.0% unanswered, recovered$/);
  await assertCleanedUp(f);
});

test("a service whose writes hang while the dependency is down fails the outage phase", async () => {
  const f = await fixture("retry", OUTAGE);
  const out = await run(f);
  assert.match(out.findings.join("\n"), /got no answer \(timeout or reset\) while the dependency was down/);
  await assertCleanedUp(f);
});

test("a service that dies during the run is an app failure and leaves nothing behind", async () => {
  const f = await fixture("die");
  await assert.rejects(run(f), (e: Error) => e instanceof AppFailure && /exited during the load run/.test(e.message));
  await assertCleanedUp(f);
});

test("a service that never answers hits the timeout and leaves nothing behind", async () => {
  const f = await fixture("hang", { timeout_s: 1 });
  await assert.rejects(run(f), (e: Error) => e instanceof AppFailure && /did not answer/.test(e.message));
  await assertCleanedUp(f);
});

test("a base_url that already answers is refused", async () => {
  const f = await fixture("free");
  const squatter = (await import("node:http")).createServer((_, res) => res.end("x"));
  await new Promise<void>((ok) => squatter.listen(f.port, "127.0.0.1", ok));
  await assert.rejects(run(f), /already answers/);
  squatter.close();
  rmSync(f.dir, { recursive: true, force: true });
});

test("an optional runner replaces the driver and its JSON report is judged by the orchestrator", async () => {
  const f = await fixture("free");
  const script = join(f.dir, "runner.mjs");
  writeFileSync(script, `console.log("noise"); console.log(JSON.stringify({ requests: 100, errors: Number(process.env.ERRS ?? 0), p95_ms: 50 }));
    if (!process.env.ORCH_LOAD_TARGET || !process.env.ORCH_SLOW_DEP) process.exit(3);`);
  const out = await realLoad({ ...f.cfg, runner: `node ${script}` }, f.dir, { id: "T-1", sha: "abc" });
  assert.deepEqual(out.findings, []);
  assert.match(out.summary, /100 requests.*\(runner\)/);
  await assertCleanedUp(f);
});

test("a missing runner is an infrastructure problem, not a crash", async () => {
  const f = await fixture("free");
  await assert.rejects(
    realLoad({ ...f.cfg, runner: "definitely-not-a-real-command-xyz" }, f.dir, { id: "T-1", sha: "abc" }),
    (e: Error) => e instanceof InfraError && /cannot start/.test(e.message),
  );
  await assertCleanedUp(f);
});

const CFG = LoadConfig.parse({ serve: "node svc.js", base_url: "http://127.0.0.1:4000", writes: [{ method: "POST", path: "/w" }] });
const backend = () => (knobs.override.triage = () => ({ ...(defaults.triage!({} as Req<unknown>) as object), specialty: "backend" }));
const NOT_CALLED = async () => { throw new Error("the load stage must not run"); };

test("with no load block the stage is skipped, never spawns, adds no warning and the ticket reaches approval as before", async () => {
  setLoadRunner(NOT_CALLED);
  try {
    backend();
    const g = await start();
    assert.equal(paused(g.r)?.type, "approval");
    assert.equal(g.r.history.find((h: { node: string }) => h.node === "load")?.result, "skipped: not configured");
    assert.deepEqual(g.r.docs_warnings.filter((w: string) => /load/.test(w)), []);
    assert.equal(paused(g.r)?.load, undefined);
  } finally {
    setLoadRunner(realLoad);
  }
});

test("a configured load stage is skipped for a ticket that is not a service ticket", async () => {
  setLoadRunner(NOT_CALLED);
  try {
    const g = await start("T-1", new MemorySaver(), { load_cfg: CFG });
    assert.equal(paused(g.r)?.type, "approval");
    assert.equal(g.r.history.find((h: { node: string }) => h.node === "load")?.result, "skipped: not a service ticket");
  } finally {
    setLoadRunner(realLoad);
  }
});

test("a breach goes back to the dev as dev_failed, a pass shows its evidence to the reviewer and writes the report", async () => {
  let n = 0;
  setLoadRunner(async () => (n++ === 0
    ? { findings: ["fast_path p95 4200ms vs 310ms baseline while dependency slow: a request handler blocks on the dependency"], summary: "", report: { n } }
    : { findings: [], summary: "900 requests, error rate 0.1%, fast p95 12ms baseline vs 20ms with the dependency slowed", report: { n } }));
  try {
    backend();
    const g = await start("T-2", new MemorySaver(), { load_cfg: CFG });
    assert.equal(paused(g.r)?.type, "approval");
    assert.equal(g.r.revisions, 1);
    assert.match(g.r.rejections.join(), /load: fast_path p95 4200ms/);
    assert.equal(knobs.calls.filter((c) => c === "dev").length, 2);
    assert.match(String(paused(g.r)?.load), /^load passed: 900 requests/);
    assert.ok(existsSync(join(process.env.ORCH_HOME!, "load-T-2.json")));
  } finally {
    setLoadRunner(realLoad);
  }
});

test("an infrastructure problem skips the stage with a docs warning, an app failure goes to the dev, a crash escalates", async () => {
  const { InfraError } = await import("../src/webcheck.ts");
  try {
    backend();
    setLoadRunner(async () => { throw new InfraError("runner missing"); });
    const a = await start("T-3", new MemorySaver(), { load_cfg: CFG });
    assert.equal(paused(a.r)?.type, "approval");
    assert.match(a.r.docs_warnings.join(), /load skipped: runner missing/);
    setLoadRunner(async () => { throw new AppFailure("the service exited during the load run"); });
    const b = await start("T-4", new MemorySaver(), { load_cfg: CFG });
    assert.match(b.r.rejections.join(), /load: the service exited/);
    setLoadRunner(async () => { throw new Error("boom"); });
    const c = await start("T-5", new MemorySaver(), { load_cfg: CFG });
    assert.equal(paused(c.r)?.type, "escalation");
    assert.match(String(c.r.summary), /load: boom/);
  } finally {
    setLoadRunner(realLoad);
  }
});

test("the stage refuses to start the service when the external settings changed since the ticket began", async () => {
  setLoadRunner(NOT_CALLED);
  knobs.override.dev = (req) => {
    const f = join(process.env.ORCH_HOME!, "config.json");
    const c = JSON.parse(readFileSync(f, "utf8"));
    for (const k of Object.keys(c.repos)) c.repos[k].load.concurrency = 99;
    writeFileSync(f, JSON.stringify(c));
    return defaults.dev!(req);
  };
  try {
    backend();
    const g = await start("T-6", new MemorySaver(), { load_cfg: CFG });
    assert.equal(paused(g.r)?.type, "escalation");
    assert.match(String(g.r.summary), /load settings changed/);
  } finally {
    setLoadRunner(realLoad);
  }
});
