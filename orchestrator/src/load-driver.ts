import type { DelayProxy } from "./load-proxy.ts";
import type { LoadConfig } from "./repo-config.ts";

export type LoadReport = {
  requests: number;
  errors: number;
  baseline_p95_ms: number;
  slowed_p95_ms?: number;
  recovered?: boolean;
  dep_connections?: number;
  outage_requests?: number;
  outage_uncontrolled?: number;
  outage_fast_p95_ms?: number;
  outage_recovered?: boolean;
};

const REQUEST_TIMEOUT_MS = 5000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const p95 = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1] : 0);

export function evaluateLoad(r: LoadReport, cfg: Pick<LoadConfig, "thresholds" | "slow_dependency">): string[] {
  const th = cfg.thresholds;
  const out: string[] = [];
  const rate = r.requests ? r.errors / r.requests : 0;
  if (rate > th.max_error_rate)
    out.push(`error rate ${(rate * 100).toFixed(1)}% over ${r.requests} requests while writers ran concurrently (max ${(th.max_error_rate * 100).toFixed(1)}%)`);
  if (cfg.slow_dependency && r.dep_connections === 0)
    out.push(`dependency not reached: the service never connected to the proxy given in ${cfg.slow_dependency.env}; it may hardcode the address`);
  if (r.slowed_p95_ms !== undefined && r.slowed_p95_ms > th.max_fast_p95_ms && r.slowed_p95_ms > th.max_fast_p95_ratio * r.baseline_p95_ms)
    out.push(`fast_path p95 ${Math.round(r.slowed_p95_ms)}ms vs ${Math.round(r.baseline_p95_ms)}ms baseline while dependency slow: a request handler blocks on the dependency (lock or pool held across the call)`);
  if (r.recovered === false) out.push(`service did not answer within ${th.recover_s}s after the dependency sped up again`);
  const lost = r.outage_requests ? r.outage_uncontrolled! / r.outage_requests : 0;
  if (lost > th.max_error_rate)
    out.push(`${(lost * 100).toFixed(1)}% of ${r.outage_requests} requests got no answer (timeout or reset) while the dependency was down (max ${(th.max_error_rate * 100).toFixed(1)}%): requests hang or drop when the dependency fails (no timeout or error handling on the dependency call)`);
  if (r.outage_fast_p95_ms !== undefined && r.outage_fast_p95_ms > th.max_fast_p95_ms && r.outage_fast_p95_ms > th.max_fast_p95_ratio * r.baseline_p95_ms)
    out.push(`fast_path p95 ${Math.round(r.outage_fast_p95_ms)}ms vs ${Math.round(r.baseline_p95_ms)}ms baseline while dependency down: a request handler blocks on the failing dependency (lock or pool held across the call)`);
  if (r.outage_recovered === false) out.push(`writes still fail ${th.recover_s}s after the dependency came back: the service does not reconnect to it`);
  return out;
}

// `answered`: the service sent an HTTP response (any status), as opposed to a timeout or a reset/refused connection.
type Fetched = { ms: number; ok: boolean; answered: boolean };
async function hit(url: string, init: RequestInit, signal: AbortSignal): Promise<Fetched> {
  const t0 = performance.now();
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) });
    // Drain and discard the body instead of buffering it: a huge response must not grow memory.
    if (r.body) {
      const reader = r.body.getReader();
      try {
        for (;;) {
          const { done } = await reader.read();
          if (done) break;
        }
      } catch {}
    }
    return { ms: performance.now() - t0, ok: r.status < 500, answered: true };
  } catch {
    return signal.aborted ? { ms: performance.now() - t0, ok: true, answered: false } : { ms: REQUEST_TIMEOUT_MS, ok: false, answered: false };
  }
}

const write = (cfg: LoadConfig, w: LoadConfig["writes"][number], signal: AbortSignal) =>
  hit(new URL(w.path, cfg.base_url).href, { method: w.method, body: w.body, headers: w.body ? { "content-type": "application/json" } : {} }, signal);

// `check` throws when the service died or the stage ran out of time. Writers start requests until `stop` aborts; `inflight` aborting
// cuts the running ones, which are then not counted.
function writers(cfg: LoadConfig, stop: AbortSignal, inflight: AbortSignal, count: (r: Fetched) => void, check: () => void): Promise<unknown> {
  const run = async (i: number) => {
    for (let n = i; !stop.aborted; n++) {
      check();
      const r = await write(cfg, cfg.writes[n % cfg.writes.length], inflight);
      if (inflight.aborted) return;
      count(r);
    }
  };
  return Promise.all(Array.from({ length: cfg.concurrency }, (_, i) => run(i)));
}

async function probe(cfg: LoadConfig, seconds: number, check: () => void): Promise<number[]> {
  const stop = AbortSignal.timeout(seconds * 1000);
  const ms: number[] = [];
  while (!stop.aborted) {
    check();
    ms.push((await hit(new URL(cfg.fast_path, cfg.base_url).href, {}, stop)).ms);
    await sleep(100);
  }
  return ms;
}

async function recovers(cfg: LoadConfig, attempt: () => Promise<Fetched>, check: () => void): Promise<boolean> {
  const until = Date.now() + cfg.thresholds.recover_s * 1000;
  while (Date.now() < until) {
    check();
    if ((await attempt()).ok) return true;
    await sleep(200);
  }
  return false;
}

export async function runDriver(cfg: LoadConfig, proxy: DelayProxy | null, check: () => void): Promise<LoadReport> {
  const tally = { requests: 0, errors: 0 };
  const main = (r: Fetched) => (tally.requests++, r.ok || tally.errors++);
  // `drain`: let the running requests end (answer or REQUEST_TIMEOUT_MS) instead of cutting them, so a hang is seen even in a short phase.
  const phase = async <R>(during: () => Promise<R>, count = main, drain = false): Promise<R> => {
    const ctl = new AbortController();
    const w = writers(cfg, ctl.signal, drain ? new AbortController().signal : ctl.signal, count, check);
    try {
      return (await Promise.race([during(), w])) as R;
    } finally {
      ctl.abort();
      await w.catch(() => {});
    }
  };
  const report: LoadReport = { requests: 0, errors: 0, baseline_p95_ms: p95(await probe(cfg, Math.min(3, cfg.duration_s), check)) };
  await phase(() => sleep(cfg.duration_s * 1000));
  if (proxy && cfg.slow_dependency) {
    proxy.delay_ms = cfg.slow_dependency.delay_ms;
    const before = proxy.connections;
    try {
      report.slowed_p95_ms = p95(await phase(() => probe(cfg, cfg.duration_s, check)));
    } finally {
      proxy.delay_ms = 0;
    }
    // Connections during the slowed phase only: the counter accumulates, so a re-run must not see the first run's.
    report.dep_connections = proxy.connections - before;
    report.recovered = await recovers(cfg, () => hit(new URL(cfg.health_path, cfg.base_url).href, {}, new AbortController().signal), check);
  }
  if (proxy && cfg.slow_dependency?.outage) {
    const o = { requests: 0, uncontrolled: 0 };
    proxy.down = true;
    try {
      const counted = (r: Fetched) => (o.requests++, r.answered || o.uncontrolled++);
      report.outage_fast_p95_ms = p95(await phase(() => probe(cfg, Math.min(cfg.duration_s, 10), check), counted, true));
    } finally {
      proxy.down = false;
    }
    report.outage_requests = o.requests;
    report.outage_uncontrolled = o.uncontrolled;
    report.outage_recovered = await recovers(cfg, () => write(cfg, cfg.writes[0], new AbortController().signal), check);
  }
  return { ...report, ...tally };
}
