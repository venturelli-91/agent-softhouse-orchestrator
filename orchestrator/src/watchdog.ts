import { z } from "zod";
import { MAX_REVISIONS, tokens } from "./guardrails.ts";
import { runAgent } from "./run-agent.ts";
import type { Ticket } from "./graph.ts";

const WatchdogOutput = z.object({ alerts: z.array(z.string()), summary: z.string() });

// Off the main path, on demand. Read-only: receives just one line per ticket, derived from the state.
export async function watchdog(tickets: z.infer<typeof Ticket>[], cwd: string) {
  const lines = tickets.map((t) => {
    const tok = t.history.reduce((a, h) => a + (h.usage ? tokens(h.usage) : 0), 0);
    const last = t.history.at(-1);
    return `${t.id} [${t.priority}] status=${t.status} revisions=${t.revisions} tokens=${tok} last=${last?.node ?? "-"}:${last?.result ?? "-"}`;
  });
  const { output, usage } = await runAgent({
    role: "watchdog", files: ["watchdog"], cwd, schema: WatchdogOutput,
    context: `Tickets:\n${lines.join("\n")}\n\nRead-only. List alerts (blocked, review loop, abnormal cost, stalled P0). Answer in the structured format.`,
  });
  return { ...output, usage };
}

const DONE = new Set(["simulated_deploy", "aborted", "closed"]);
const used = (t: z.infer<typeof Ticket>) => t.history.reduce((a, h) => a + (h.usage ? tokens(h.usage) : 0), 0);

// Rule-based sweep, no model and no tokens. STALE_HOURS (default 24; P0 waits 1h) for a ticket that stopped moving.
export function alerts(tickets: z.infer<typeof Ticket>[], now = Date.now(), env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  const cap = Number(env.TOKEN_BUDGET_TICKET) || Infinity;
  for (const t of tickets) {
    if (DONE.has(t.status)) continue;
    const last = t.history.at(-1)?.time;
    const hours = last ? (now - Date.parse(last)) / 3_600_000 : 0;
    if (hours >= (t.priority === "P0" ? 1 : Number(env.STALE_HOURS) || 24)) out.push(`${t.id} [${t.priority}] ${t.status} for ${hours.toFixed(1)}h`);
    if (t.revisions >= MAX_REVISIONS - 1) out.push(`${t.id} review loop: ${t.revisions}/${MAX_REVISIONS} revisions`);
    if (used(t) >= cap * 0.8) out.push(`${t.id} token budget at ${Math.round((used(t) / cap) * 100)}%`);
    if (t.status === "escalated") out.push(`${t.id} escalated: ${t.summary.split("\n")[0]}`);
  }
  return out;
}
