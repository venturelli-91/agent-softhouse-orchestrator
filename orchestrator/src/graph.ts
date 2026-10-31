import { Command, END, interrupt, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import { z } from "zod";
import { autoaprovacao, gitSeguro, MAX_REVISOES, MAX_TICKETS_ATIVOS, orcamentoEstourado, RECURSION_LIMIT, ticketsAtivos, tokens, verificarEvidencia } from "./guardrails.ts";
import { FalhaDeNo, runAgent, type Consumo } from "./run-agent.ts";

const ESPECIALIDADES = ["frontend", "backend", "fullstack", "mobile", "integracoes", "ia", "dados"] as const;
const ARQUIVO_DEV: Record<(typeof ESPECIALIDADES)[number], string> = {
  frontend: "dev-frontend", backend: "dev-backend", fullstack: "dev-fullstack", mobile: "dev-mobile",
  integracoes: "dev-integracoes", ia: "engenheiro-ia", dados: "engenheiro-dados",
};
const resumo = z.string().refine((s) => s.split("\n").length <= 10, "resumo acima de 10 linhas");
const FlagsSchema = z.object({
  toca_seguranca: z.boolean(), toca_performance: z.boolean(), toca_ia: z.boolean(), toca_schema: z.boolean(),
  toca_api_publica: z.boolean(), toca_permissoes: z.boolean(), toca_integracao_externa: z.boolean(), toca_custo: z.boolean(),
});
const FLAGS_VAZIAS = Object.fromEntries(Object.keys(FlagsSchema.shape).map((k) => [k, false])) as z.infer<typeof FlagsSchema>;

// Unico estado do grafo. `pedido`, `criterios`, `worktree` e `base` sao os extras minimos que o codigo precisa.
export const Ticket = z.object({
  id: z.string(),
  pedido: z.string(),
  worktree: z.string(),
  base: z.string(),
  titulo: z.string().default(""),
  prioridade: z.enum(["P0", "P1", "P2", "Bug"]).default("P2"),
  especialidade: z.enum(ESPECIALIDADES).default("fullstack"),
  flags: FlagsSchema.default(FLAGS_VAZIAS),
  criterios: z.array(z.string()).default([]),
  status: z.string().default("novo"),
  resumo: z.string().default(""),
  autor_id: z.string().nullable().default(null),
  revisor_id: z.string().nullable().default(null),
  qa_id: z.string().nullable().default(null),
  revisoes: z.number().default(0),
  evidencias: z.array(z.string()).default([]),
  historico: z.array(z.object({ no: z.string(), hora: z.string(), resultado: z.string(), ms: z.number(), consumo: z.custom<Consumo>().optional() })).default([]),
});
type T = z.infer<typeof Ticket>;

const SaidaTriagem = z.object({
  titulo: z.string(), prioridade: z.enum(["P0", "P1", "P2", "Bug"]), especialidade: z.enum(ESPECIALIDADES),
  claro: z.boolean(), flags: FlagsSchema, criterios: z.array(z.string()), resumo,
});
const SaidaDev = z.object({ resumo });
const SaidaRevisao = z.object({ veredito: z.enum(["aprovado", "reprovado"]), comentarios: z.string(), resumo });

const log = (t: T, no: string, resultado: string, consumo?: Consumo) =>
  [...t.historico, { no, hora: new Date().toISOString(), resultado, ms: consumo?.ms ?? 0, consumo }];

const sh = gitSeguro;

// Contexto minimo: so o que o papel precisa, nunca o historico de conversas.
const contexto = (...partes: string[]) =>
  [...partes, "Responda apenas no formato estruturado. `resumo`: ate 10 linhas, so o necessario para o proximo no."].join("\n\n");
const dadosTicket = (t: T) => `Ticket ${t.id}: ${t.titulo}\nCriterios de aceite:\n${t.criterios.map((c) => `- ${c}`).join("\n")}\nResumo atual:\n${t.resumo}`;
const diff = (t: T) => sh(t.worktree, "diff", "--no-ext-diff", "--no-textconv", t.base, "HEAD").slice(0, 20_000);

const escalar = (t: T, nome: string, motivo: string): Partial<T> =>
  ({ status: "escalado", resumo: `${nome}: ${motivo}`.split("\n").slice(0, 10).join("\n"), historico: log(t, nome, `escalado: ${motivo}`) });

// Falha do executor (erro, timeout, saida invalida) ou orcamento estourado nao quebra o grafo:
// o ticket para e vai ao CEO via aprovacao_ceo.
const protegido = (nome: string, fn: (t: T) => Promise<Partial<T>>) => async (t: T): Promise<Partial<T>> => {
  const estouro = orcamentoEstourado(t.historico.map((h) => h.consumo));
  if (estouro) return escalar(t, nome, estouro);
  try {
    return await fn(t);
  } catch (e) {
    if (!(e instanceof FalhaDeNo)) throw e;
    return escalar(t, nome, e.message);
  }
};

const triagem = protegido("triagem", async (t) => {
  const { saida, consumo } = await runAgent({ papel: "triagem", arquivos: ["triagem"], cwd: t.worktree, schema: SaidaTriagem, contexto: contexto(`Pedido do CEO: ${t.pedido}`) });
  const { claro, resumo, ...resto } = saida;
  return { ...resto, resumo, status: claro ? "dev" : "ambiguo", historico: log(t, "triagem", claro ? "claro" : "ambiguo", consumo) };
});

const dev = protegido("dev", async (t) => {
  const { saida, consumo } = await runAgent({
    papel: "dev", arquivos: [ARQUIVO_DEV[t.especialidade]], cwd: t.worktree, schema: SaidaDev,
    contexto: contexto(dadosTicket(t), "Implemente no worktree atual, rode npm test e faca commit (git add/git commit). Nao faca push."),
  });
  const v = verificarEvidencia(t.worktree, t.base);
  if (!v.ok) return { status: "dev_falhou", revisoes: t.revisoes + 1, resumo: `verificacao: ${v.motivo}`, historico: log(t, "dev", `verificacao falhou`, consumo) };
  return { status: "revisao", resumo: saida.resumo, autor_id: v.autor, evidencias: v.evidencias, historico: log(t, "dev", "commit verificado", consumo) };
});

function revisor(nome: "reviewer" | "qa", arquivos: (t: T) => string[], proximo: string) {
  return protegido(nome, async (t) => {
    // Regras de fluxo em codigo: independencia e evidencia verificada antes de gastar token.
    const quem = `agente-${nome}`;
    const bloqueio = autoaprovacao(t.autor_id, quem);
    if (bloqueio) throw new FalhaDeNo(bloqueio);
    const v = t.evidencias.length ? verificarEvidencia(t.worktree, t.base) : { ok: false as const, motivo: "sem evidencias" };
    if (!v.ok) throw new FalhaDeNo(`evidencia invalida: ${v.motivo}`);
    const { saida, consumo } = await runAgent({
      papel: nome, arquivos: arquivos(t), cwd: t.worktree, schema: SaidaRevisao,
      contexto: contexto(dadosTicket(t), `Diff:\n${diff(t)}`),
    });
    const id = nome === "reviewer" ? { revisor_id: `agente-${nome}` } : { qa_id: `agente-${nome}` };
    if (saida.veredito === "aprovado") return { ...id, status: proximo, resumo: saida.resumo, historico: log(t, nome, "aprovado", consumo) };
    return { status: "dev_falhou", revisoes: t.revisoes + 1, resumo: saida.comentarios.split("\n").slice(0, 10).join("\n"), historico: log(t, nome, "reprovado", consumo) };
  });
}
const reviewer = revisor("reviewer", (t) => [
  "code-reviewer",
  ...(t.flags.toca_seguranca ? ["seguranca"] : []),
  ...(t.flags.toca_performance ? ["performance"] : []),
  ...(t.flags.toca_ia ? ["engenheiro-evals"] : []),
], "qa");
const qa = revisor("qa", () => ["qa-automation"], "aprovacao");

// Unico ponto de merge/deploy e de escalada. Aprovacao so conta se a evidencia ainda se sustenta.
const aprovacaoCeo = async (t: T): Promise<Partial<T>> => {
  const v = t.status === "aprovacao" && t.evidencias.length ? verificarEvidencia(t.worktree, t.base) : null;
  const motivo = t.status === "aprovacao" ? (v?.ok ? null : `evidencia invalida: ${v ? v.motivo : "sem evidencias"}`)
    : t.status === "dev_falhou" ? `teto de ${MAX_REVISOES} revisoes atingido: ${t.resumo}` : `${t.status}: ${t.resumo}`;
  const r = interrupt({
    tipo: motivo ? "escalada" : "aprovacao", motivo, ticket: t.id, titulo: t.titulo, resumo: t.resumo, evidencias: t.evidencias,
    flags_ativas: Object.entries(t.flags).filter(([, ativa]) => ativa).map(([k]) => k),
  }) as string;
  const h = (res: string) => log(t, "aprovacao_ceo", res);
  if (!motivo) {
    if (r === "aprovar") return { status: "deploy_simulado", historico: h("aprovado") };
    return { status: "dev_falhou", revisoes: t.revisoes + 1, resumo: `CEO rejeitou: ${r}`.slice(0, 500), historico: h("rejeitado") };
  }
  // Escalada: o CEO manda abortar ou instrui o dev (so se a triagem ja produziu criterios).
  if (r === "abortar" || !t.criterios.length) return { status: "abortado", historico: h("abortado") };
  return { status: "dev_falhou", revisoes: 0, resumo: `CEO instruiu: ${r}`.slice(0, 500), historico: h("retomado") };
};

// Laco de revisao: acima do teto, ou em qualquer escalada/ambiguidade, o ticket vai ao CEO.
const rota = (ok: string, no: string) => (t: T) =>
  t.status === ok ? no : t.status === "dev_falhou" && t.revisoes < MAX_REVISOES ? "dev" : "aprovacao_ceo";
const aposCeo = (t: T) => (t.status === "dev_falhou" ? "dev" : END);

export function montarGrafo(checkpointer = new MemorySaver()) {
  return new StateGraph(Ticket)
    .addNode("triagem", triagem).addNode("dev", dev).addNode("reviewer", reviewer).addNode("qa", qa).addNode("aprovacao_ceo", aprovacaoCeo)
    .addEdge(START, "triagem")
    .addConditionalEdges("triagem", rota("dev", "dev"), ["dev", "aprovacao_ceo"])
    .addConditionalEdges("dev", rota("revisao", "reviewer"), ["reviewer", "dev", "aprovacao_ceo"])
    .addConditionalEdges("reviewer", rota("qa", "qa"), ["qa", "dev", "aprovacao_ceo"])
    .addConditionalEdges("qa", rota("aprovacao", "aprovacao_ceo"), ["aprovacao_ceo", "dev"])
    .addConditionalEdges("aprovacao_ceo", aposCeo, ["dev", END])
    .compile({ checkpointer });
}

export const config = (id: string) => ({ configurable: { thread_id: id }, recursionLimit: RECURSION_LIMIT });
export const retomar = (resposta: string) => new Command({ resume: resposta });

export function criarWorktree(repo: string, id: string, dir: string): { worktree: string; base: string } {
  if (ticketsAtivos(repo) >= MAX_TICKETS_ATIVOS) throw new Error(`limite de ${MAX_TICKETS_ATIVOS} tickets ativos atingido`);
  sh(repo, "worktree", "add", "-q", "-b", `ticket/${id}`, dir);
  return { worktree: dir, base: sh(repo, "rev-parse", "HEAD") };
}

export function relatorio(t: T): string {
  const linhas = t.historico.filter((h) => h.consumo).map((h) => {
    const c = h.consumo!;
    return `${h.no.padEnd(10)} tokens=${tokens(c)} (ctx ${c.cache_create + c.cache_read + c.tokens_in}, saida ${c.tokens_out}) turnos=${c.turnos} ${(c.ms / 1000).toFixed(1)}s US$${c.custo_usd.toFixed(3)}`;
  });
  const total = t.historico.reduce((a, h) => ({ tok: a.tok + (h.consumo ? tokens(h.consumo) : 0), usd: a.usd + (h.consumo?.custo_usd ?? 0), ms: a.ms + h.ms }), { tok: 0, usd: 0, ms: 0 });
  return [...linhas, `TOTAL ${t.id} status=${t.status} revisoes=${t.revisoes} tokens=${total.tok} ${(total.ms / 1000).toFixed(1)}s US$${total.usd.toFixed(3)}`].join("\n");
}
