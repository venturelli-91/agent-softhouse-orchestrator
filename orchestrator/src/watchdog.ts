import { z } from "zod";
import { tokens } from "./guardrails.ts";
import { runAgent } from "./run-agent.ts";
import type { Ticket } from "./graph.ts";

const SaidaWatchdog = z.object({ alertas: z.array(z.string()), resumo: z.string() });

// Fora do caminho principal, por comando. Somente leitura: recebe so uma linha por ticket, derivada do estado.
export async function watchdog(tickets: z.infer<typeof Ticket>[], cwd: string) {
  const linhas = tickets.map((t) => {
    const tok = t.historico.reduce((a, h) => a + (h.consumo ? tokens(h.consumo) : 0), 0);
    return `${t.id} [${t.prioridade}] status=${t.status} revisoes=${t.revisoes} tokens=${tok} ultimo=${t.historico.at(-1)?.no ?? "-"}:${t.historico.at(-1)?.resultado ?? "-"}`;
  });
  const { saida, consumo } = await runAgent({
    papel: "watchdog", arquivos: ["watchdog"], cwd, schema: SaidaWatchdog,
    contexto: `Tickets:\n${linhas.join("\n")}\n\nApenas leitura. Liste alertas (bloqueados, laco de revisao, custo anormal, P0 parado). Responda no formato estruturado.`,
  });
  return { ...saida, consumo };
}
