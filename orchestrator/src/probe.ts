import { readDeploy } from "./deploy.ts";
import { type Probe, simulatedProbe } from "./chaos.ts";

export async function httpProbe(url: string, opts: { timeout_ms: number; max_latency_ms: number }): Promise<string | null> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(opts.timeout_ms) });
    await res.arrayBuffer();
    const ms = Date.now() - t0;
    if (!res.ok) return `http ${res.status}`;
    return ms > opts.max_latency_ms ? `latency ${ms}ms > ${opts.max_latency_ms}ms` : null;
  } catch (e) {
    const err = e as { name?: string; message: string; cause?: { code?: string } };
    if (err.name === "TimeoutError") return `timeout after ${opts.timeout_ms}ms`;
    return `unreachable: ${err.cause?.code ?? err.message}`;
  }
}

export const defaultProbe: Probe = (home, id) => {
  const cmd = readDeploy(home, id).cmd;
  return cmd?.health_url ? httpProbe(cmd.health_url, { timeout_ms: 10_000, max_latency_ms: cmd.max_latency_ms }) : simulatedProbe(home, id);
};
