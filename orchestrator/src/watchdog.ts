import { z } from "zod";
import { tokens } from "./guardrails.ts";
import { runAgent } from "./run-agent.ts";
import type { Ticket } from "./graph.ts";

const WatchdogOutput = z.object({ alerts: z.array(z.string()), summary: z.string() });

// Off the main path, on demand. Read-only: receives just one line per ticket, derived from the state.
export async function watchdog(tickets: z.infer<typeof Ticket>[], cwd: string) {
  const lines = tickets.map((t) => {
    const tok = t.history.reduce((a, h) => a + (h.usage ? tokens(h.usage) : 0), 0);
    return `${t.id} [${t.priority}] status=${t.status} revisions=${t.revisions} tokens=${tok} last=${t.history.at(-1)?.node ?? "-"}:${t.history.at(-1)?.result ?? "-"}`;
  });
  const { output, usage } = await runAgent({
    role: "watchdog", files: ["watchdog"], cwd, schema: WatchdogOutput,
    context: `Tickets:\n${lines.join("\n")}\n\nRead-only. List alerts (blocked, review loop, abnormal cost, stalled P0). Answer in the structured format.`,
  });
  return { ...output, usage };
}
