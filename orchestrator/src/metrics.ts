import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

type Entry = { node: string; time: string; result: string; ms: number; usage?: { tokens_in: number; tokens_out: number; cost_usd: number } };
type Summarised = { id: string; status: string; priority: string; specialty: string; revisions: number; tasks: string[]; history: Entry[] };

// One line per ticket, written before `orch clean` deletes its state: numbers only, never agent text.
export function ticketMetrics(t: Summarised) {
  const nodes: Record<string, { runs: number; ms: number; tokens: number; usd: number }> = {};
  for (const h of t.history) {
    const n = (nodes[h.node] ??= { runs: 0, ms: 0, tokens: 0, usd: 0 });
    n.runs++;
    n.ms += h.ms;
    n.tokens += (h.usage?.tokens_in ?? 0) + (h.usage?.tokens_out ?? 0);
    n.usd += h.usage?.cost_usd ?? 0;
  }
  const sum = (k: "ms" | "tokens" | "usd") => Object.values(nodes).reduce((a, n) => a + n[k], 0);
  return {
    id: t.id, status: t.status, priority: t.priority, specialty: t.specialty,
    route: t.history.some((h) => h.node === "planner") ? "ambiguous" : "clear",
    tasks: t.tasks.length || 1, revisions: t.revisions,
    escalations: t.history.filter((h) => h.result.startsWith("escalated")).length,
    first: t.history[0]?.time ?? "", last: t.history.at(-1)?.time ?? "",
    ms: sum("ms"), tokens: sum("tokens"), usd: Number(sum("usd").toFixed(4)), nodes,
  };
}

export function recordMetrics(home: string, t: Summarised): void {
  mkdirSync(home, { recursive: true });
  appendFileSync(join(home, "metrics.jsonl"), `${JSON.stringify(ticketMetrics(t))}\n`);
}
