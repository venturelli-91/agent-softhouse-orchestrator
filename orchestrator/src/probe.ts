import { z } from "zod";
import { deployedIds, readCounters, readDeploy, recordCounters } from "./deploy.ts";

export type Probe = (home: string, id: string) => string | null | Promise<string | null>;

type ProbeOpts = { timeout_ms: number; max_latency_ms: number; method?: string; body?: string; expect_status?: number };

export async function httpProbe(url: string, opts: ProbeOpts): Promise<string | null> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: opts.method, redirect: "manual", signal: AbortSignal.timeout(opts.timeout_ms),
      ...(opts.body !== undefined && { body: opts.body, headers: { "content-type": "application/json" } }),
    });
    await res.arrayBuffer();
    const ms = Date.now() - t0;
    if (opts.expect_status === undefined ? !res.ok : res.status !== opts.expect_status) return `http ${res.status}`;
    return ms > opts.max_latency_ms ? `latency over ${opts.max_latency_ms}ms` : null;
  } catch (e) {
    const err = e as { name?: string; cause?: { code?: string } };
    if (err.name === "TimeoutError") return `timeout after ${opts.timeout_ms}ms`;
    return `unreachable: ${err.cause?.code ?? err.name ?? "error"}`;
  }
}

const Metrics = z.object({ requests: z.number().nonnegative(), errors_5xx: z.number().nonnegative() });

export async function errorRate(home: string, id: string, url: string, max: number): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
  } catch (e) {
    const err = e as { name?: string; cause?: { code?: string } };
    return `${err.name === "TimeoutError" ? "timeout after 10000ms" : `unreachable: ${err.cause?.code ?? err.name ?? "error"}`} on metrics`;
  }
  if (!res.ok) return `http ${res.status} on metrics`;
  let parsed;
  try {
    parsed = Metrics.safeParse(await res.json());
  } catch {
    return "metrics: invalid payload";
  }
  if (!parsed.success) return "metrics: invalid payload";
  const { requests, errors_5xx } = parsed.data;
  const prev = readCounters(home, id);
  recordCounters(home, id, { ts: new Date().toISOString(), requests, errors_5xx });
  // ponytail: rate over the gap between two watch runs, no windowing; keep a series of samples if the gap gets too coarse
  if (!prev) return null;
  const dr = requests - prev.requests, de = errors_5xx - prev.errors_5xx;
  if (dr < 0 || de < 0 || dr === 0) return null;
  const rate = de / dr;
  return rate > max ? `error rate ${(rate * 100).toFixed(1)}% over ${+(max * 100).toFixed(2)}%` : null;
}

export const defaultProbe: Probe = async (home, id) => {
  const cmd = readDeploy(home, id).cmd;
  if (!cmd?.health_url) return null;
  const opts = { timeout_ms: 10_000, max_latency_ms: cmd.max_latency_ms };
  const health = await httpProbe(cmd.health_url, opts);
  if (health) return health;
  const origin = new URL(cmd.health_url).origin;
  for (const c of cmd.checks ?? []) {
    const s = await httpProbe(new URL(c.path, origin).href, { ...opts, method: c.method, body: c.body, expect_status: c.expect_status });
    if (s) return `${s} on ${c.method} ${c.path}`;
  }
  return cmd.metrics_url ? errorRate(home, id, cmd.metrics_url, cmd.max_error_rate ?? 0.02) : null;
};

export const unmonitored = (home: string): string[] => deployedIds(home).filter((id) => !readDeploy(home, id).cmd?.health_url);
