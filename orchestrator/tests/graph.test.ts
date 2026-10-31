// Guardrails de fluxo contra nos falsos: nenhum modelo, nenhuma credencial.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySaver } from "@langchain/langgraph";
import { criarFixture, git } from "../scripts/fixture.ts";
import { config, criarWorktree, montarGrafo, retomar } from "../src/graph.ts";
import { registrarPublicador } from "../src/publicar.ts";
import { FalhaDeNo, registrarExecutor, type Req } from "../src/run-agent.ts";
import { watchdog } from "../src/watchdog.ts";

type Comportamento = Partial<Record<string, (req: Req<unknown>) => unknown>>;
let ajuste: Comportamento = {};
let chamadas: string[] = [];
let tokensPorChamada = 10;
const raizes: string[] = [];

const FLAGS = { toca_seguranca: false, toca_performance: false, toca_ia: false, toca_schema: false, toca_api_publica: false, toca_permissoes: false, toca_integracao_externa: false, toca_custo: false };
const commitar = (cwd: string, autor: string, arquivo = "checkout.html", conteudo = "<button>Enviar pedido</button>\n") => {
  writeFileSync(join(cwd, arquivo), conteudo);
  git(cwd, "add", "-A");
  git(cwd, "-c", `user.name=${autor}`, "commit", "-q", "--allow-empty", "-m", "dev");
};
const padrao: Comportamento = {
  triagem: () => ({ titulo: "t", prioridade: "P2", especialidade: "frontend", claro: true, flags: FLAGS, criterios: ["botao diz Enviar pedido"], resumo: "ok" }),
  planejador: () => ({ ...(padrao.triagem!({} as Req<unknown>) as object), pergunta: "" }),
  dev: (req) => (commitar(req.cwd, "agente-dev"), { resumo: "ok" }),
  reviewer: () => ({ veredito: "aprovado", comentarios: "", resumo: "ok" }),
  qa: () => ({ veredito: "aprovado", comentarios: "", resumo: "ok" }),
  devops: () => ({ resumo: "deploy simulado" }),
  watchdog: () => ({ alertas: ["T-1 parado"], resumo: "ok" }),
};
let publicacoes: string[] = [];
registrarPublicador("fake", { publicar: (p) => (publicacoes.push(`${p.id}@${p.sha}`), "pr:https://exemplo/pull/1") });

registrarExecutor("fake", {
  async run<T>(req: Req<T>) {
    chamadas.push(req.papel);
    const bruto = (ajuste[req.papel] ?? padrao[req.papel]!)(req as Req<unknown>);
    const saida = req.schema.safeParse(bruto);
    if (!saida.success) throw new FalhaDeNo(`${req.papel}: saida invalida`);
    return { saida: saida.data, consumo: { tokens_in: tokensPorChamada, tokens_out: 0, cache_read: 0, cache_create: 0, custo_usd: 0, turnos: 1, ms: 1 } };
  },
});

beforeEach(() => {
  process.env.EXECUTOR = "fake";
  process.env.PUBLICADOR = "fake";
  publicacoes = [];
  process.env.TOKEN_BUDGET_TICKET = "100000";
  ajuste = {};
  chamadas = [];
  tokensPorChamada = 10;
});
afterEach(() => raizes.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));

async function iniciar(id = "T-1") {
  const raiz = mkdtempSync(join(tmpdir(), "gt-"));
  raizes.push(raiz);
  const repo = criarFixture(raiz);
  const grafo = montarGrafo(new MemorySaver());
  const cfg = config(id);
  const r = await grafo.invoke({ id, pedido: "p", ...criarWorktree(repo, id, join(raiz, "wt")) }, cfg);
  return { grafo, cfg, r, repo, raiz };
}
const pausa = (r: unknown) => (r as { __interrupt__?: { value: Record<string, unknown> }[] }).__interrupt__?.[0]?.value;
const ver = (g: Awaited<ReturnType<typeof iniciar>>, resposta: string) => g.grafo.invoke(retomar(resposta) as never, g.cfg);

test("deploy so acontece depois da aprovacao do CEO; rejeicao volta ao dev", async () => {
  const g = await iniciar();
  assert.equal(pausa(g.r)?.tipo, "aprovacao");
  assert.notEqual(g.r.status, "deploy_simulado");
  const rej = await ver(g, "nao gostei");
  assert.equal(pausa(rej)?.tipo, "aprovacao");
  assert.equal(rej.revisoes, 1);
  assert.notEqual(rej.status, "deploy_simulado");
  assert.equal((await ver(g, "aprovar")).status, "deploy_simulado");
});

test("flag de aprovacao chega ao CEO como flag ativa", async () => {
  ajuste.triagem = () => ({ ...(padrao.triagem!({} as Req<unknown>) as object), flags: { ...FLAGS, toca_schema: true } });
  const g = await iniciar();
  assert.deepEqual(pausa(g.r)?.flags_ativas, ["toca_schema"]);
});

test("autoaprovacao bloqueada: revisor igual ao autor nem executa", async () => {
  ajuste.dev = (req) => (commitar(req.cwd, "agente-reviewer"), { resumo: "ok" });
  const g = await iniciar();
  assert.equal(pausa(g.r)?.tipo, "escalada");
  assert.match(String(pausa(g.r)?.motivo), /propria entrega/);
  assert.ok(!chamadas.includes("reviewer"));
  assert.equal((await ver(g, "abortar")).status, "abortado");
});

test("teto de 3 revisoes escala ao CEO", async () => {
  ajuste.reviewer = () => ({ veredito: "reprovado", comentarios: "refaca", resumo: "x" });
  const g = await iniciar();
  assert.equal(chamadas.filter((c) => c === "dev").length, 3);
  assert.equal(pausa(g.r)?.tipo, "escalada");
  assert.match(String(pausa(g.r)?.motivo), /teto de 3/);
});

test("saida invalida do no e falha: escala e nao avanca", async () => {
  ajuste.triagem = () => ({ lixo: 1 });
  const g = await iniciar();
  assert.equal(pausa(g.r)?.tipo, "escalada");
  assert.ok(!chamadas.includes("dev"));
});

const ambiguo = () => ({ ...(padrao.triagem!({} as Req<unknown>) as object), claro: false, criterios: [] });

test("pedido ambiguo passa pelo planejador e segue ao dev quando ele fecha os criterios", async () => {
  ajuste.triagem = ambiguo;
  const g = await iniciar();
  assert.deepEqual(chamadas.slice(0, 2), ["triagem", "planejador"]);
  assert.equal(pausa(g.r)?.tipo, "aprovacao");
});

test("planejador sem criterios escala com a pergunta; resposta do CEO volta ao planejador", async () => {
  ajuste.triagem = ambiguo;
  let rodadas = 0;
  let pedidoVisto = "";
  ajuste.planejador = (req) => {
    pedidoVisto = req.contexto;
    return ++rodadas === 1
      ? { ...(ambiguo() as object), pergunta: "qual botao?", criterios: [] }
      : { ...(padrao.planejador!(req) as object) };
  };
  const g = await iniciar();
  assert.equal(pausa(g.r)?.tipo, "escalada");
  assert.match(String(pausa(g.r)?.motivo), /qual botao\?/);
  assert.ok(!chamadas.includes("dev"));
  const r2 = await ver(g, "o do checkout");
  assert.match(pedidoVisto, /Esclarecimento do CEO: o do checkout/);
  assert.equal(pausa(r2)?.tipo, "aprovacao");
});

test("CEO aborta quando o planejador pede esclarecimento", async () => {
  ajuste.triagem = ambiguo;
  ajuste.planejador = () => ({ ...(ambiguo() as object), pergunta: "?", criterios: [] });
  const g = await iniciar();
  assert.equal((await ver(g, "abortar")).status, "abortado");
  assert.ok(!chamadas.includes("dev"));
});

test("orcamento de tokens estourado interrompe o ticket", async () => {
  process.env.TOKEN_BUDGET_TICKET = "50";
  tokensPorChamada = 40;
  const g = await iniciar();
  assert.equal(pausa(g.r)?.tipo, "escalada");
  assert.match(String(pausa(g.r)?.motivo), /orcamento/);
  assert.ok(!chamadas.includes("reviewer"));
});

test("evidencia declarada pelo dev sem teste real passando e rejeitada", async () => {
  ajuste.dev = (req) => (commitar(req.cwd, "agente-dev", "outro.txt", "x"), { resumo: "pronto, testes passam" });
  const g = await iniciar();
  assert.ok(!chamadas.includes("reviewer"));
  assert.equal(pausa(g.r)?.tipo, "escalada");
  assert.match(String(pausa(g.r)?.motivo), /npm test falhou/);
});

test("limite de 5 tickets ativos", async () => {
  const raiz = mkdtempSync(join(tmpdir(), "gt-"));
  raizes.push(raiz);
  const repo = criarFixture(raiz);
  for (let i = 1; i <= 5; i++) criarWorktree(repo, `T-${i}`, join(raiz, `wt${i}`));
  assert.throws(() => criarWorktree(repo, "T-6", join(raiz, "wt6")), /limite de 5/);
});

test("push e PR saem do codigo do grafo, depois do QA e antes do CEO; devops so depois do CEO", async () => {
  const g = await iniciar();
  assert.equal(publicacoes.length, 1);
  assert.match(publicacoes[0], /^T-1@[0-9a-f]{40}$/);
  assert.ok((pausa(g.r)?.evidencias as string[]).includes("pr:https://exemplo/pull/1"));
  assert.ok(!chamadas.includes("devops"));
  const fim = await ver(g, "aprovar");
  assert.equal(fim.status, "deploy_simulado");
  assert.equal(chamadas.at(-1), "devops");
});

test("rejeicao do CEO nao aciona o devops", async () => {
  const g = await iniciar();
  await ver(g, "nao gostei");
  assert.ok(!chamadas.includes("devops"));
});

test("PUBLICADOR ausente escala ao CEO e nada e publicado", async () => {
  delete process.env.PUBLICADOR;
  const g = await iniciar();
  assert.equal(pausa(g.r)?.tipo, "escalada");
  assert.match(String(pausa(g.r)?.motivo), /PUBLICADOR/);
  assert.equal(publicacoes.length, 0);
});

test("publicador que falha escala ao CEO", async () => {
  process.env.PUBLICADOR = "quebrado";
  registrarPublicador("quebrado", { publicar: () => { throw new Error("push recusado"); } });
  const g = await iniciar();
  assert.equal(pausa(g.r)?.tipo, "escalada");
  assert.match(String(pausa(g.r)?.motivo), /push recusado/);
});

test("watchdog le o estado e devolve alertas sem escrever", async () => {
  const g = await iniciar();
  const r = await watchdog([g.r], g.raiz);
  assert.deepEqual(r.alertas, ["T-1 parado"]);
  assert.equal(chamadas.at(-1), "watchdog");
});
