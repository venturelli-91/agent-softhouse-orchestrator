import { deployedIds, readDeploy } from "./deploy.ts";

export type Probe = (home: string, id: string) => string | null | Promise<string | null>;

export async function httpProbe(url: string, opts: { timeout_ms: number; max_latency_ms: number }): Promise<string | null> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(opts.timeout_ms) });
    await res.arrayBuffer();
    const ms = Date.now() - t0;
    if (!res.ok) return `http ${res.status}`;
    return ms > opts.max_latency_ms ? `latency over ${opts.max_latency_ms}ms` : null;
  } catch (e) {
    const err = e as { name?: string; cause?: { code?: string } };
    if (err.name === "TimeoutError") return `timeout after ${opts.timeout_ms}ms`;
    return `unreachable: ${err.cause?.code ?? err.name ?? "error"}`;
  }
}

export const defaultProbe: Probe = (home, id) => {
  const cmd = readDeploy(home, id).cmd;
  return cmd?.health_url ? httpProbe(cmd.health_url, { timeout_ms: 10_000, max_latency_ms: cmd.max_latency_ms }) : null;
};

export const unmonitored = (home: string): string[] => deployedIds(home).filter((id) => !readDeploy(home, id).cmd?.health_url);
