# Preparação para entrevista

Cada resposta abaixo aponta para o arquivo, a linha ou o comando que a sustenta. Se não consegue apontar a prova, não afirme.
Números medidos em 2026-11-08 (Windows 11, Node 24). Os caminhos são relativos à raiz do repositório.

## "Quanto disso é seu?"

Resposta-base (ajuste ao que for verdade para você; as frases sobre decisão de arquitetura e modelo de ameaças são suas para
confirmar, o repositório só prova o que está no código):

> Construí um orquestrador multiagente em que o fluxo é um grafo em código, não um prompt. Os guardrails, como orçamento de
> tokens, limite de revisões e a regra de que nenhum agente aprova a própria entrega, são verificados por código. Toda ação
> irreversível passa por aprovação humana. Usei IA para acelerar a implementação, mas a arquitetura, o modelo de ameaças e os
> trade-offs são decisões minhas, e estão documentados.

O que sustenta cada frase:

| Frase | Prova |
|---|---|
| fluxo é um grafo em código | `orchestrator/src/graph.ts` (nós e arestas); diagrama em `README.md` |
| orçamento de tokens | `src/flow-limits.ts` (`budgetExceeded`, falha fechado sem `TOKEN_BUDGET_TICKET`); `guarded` em `src/graph-kit.ts` |
| limite de revisões | `MAX_REVISIONS = 3` em `src/flow-limits.ts:4`; teste "the cap of 3 revisions escalates to the CEO" |
| ninguém aprova a própria entrega | `selfApproval` em `src/flow-limits.ts:22`, chamado em `src/review-nodes.ts` antes de reviewer, design e qa |
| ação irreversível passa por humano | `interrupt()` em `src/ceo-node.ts:19`; merge e deploy presos ao commit aprovado (`approved_sha`) |
| decisões documentadas | `docs/portfolio/` (especialmente `04-guardrails-and-security.md` e `07-lessons-and-limits.md`) |

Seja direto sobre o uso de IA: o histórico tem trailers `Co-Authored-By` nos commits feitos com assistência, e o repositório
tem mais de 200 commits em 8 dias de atividade (`git rev-list --count main`; datas em `docs/portfolio/VERIFIED.md`). Esconder
isso é pior do que contar. O que você precisa conseguir defender é cada decisão do `docs/portfolio/`, não a autoria de cada linha.

## "Por que LangGraph e não um loop simples?"

Três propriedades que um loop teria de reimplementar:

1. **Pausar e retomar depois de uma aprovação humana.** O nó do CEO chama `interrupt()` (`src/ceo-node.ts:19`) e a execução
   continua com `Command({ resume })` (`src/graph.ts:63`). Dá para aprovar horas depois, de outro processo: `orch approve <id>`.
2. **Estado que sobrevive ao processo.** `FileSaver` (`src/file-saver.ts`) estende o `MemorySaver` e grava o checkpoint em
   disco. Uma execução morta no meio é retomada de onde parou por `orch continue` (`scripts/orch/flow.ts:30`, `resumeRun`).
3. **Roteamento condicional explícito.** Falha de agente, estouro de orçamento e teto de revisões vão para o portão humano por
   arestas declaradas (`afterCeo` em `src/graph.ts:24`, `RETRYABLE` em `src/ceo-node.ts:59`), não por `if` espalhado.

Custo e limite honestos: são 3 dependências de runtime (`@langchain/core`, `@langchain/langgraph`, `zod`). O `FileSaver`
reescreve o arquivo inteiro a cada checkpoint, e o código diz isso (`src/file-saver.ts:11`: serve para poucos tickets locais,
trocar por SQLite se crescer).

## "Como você impede o agente de burlar os testes?"

A verificação não confia no que o agente diz. `verifyEvidence` (`src/evidence.ts`) roda em código, com custo zero de token:

- Só conta o que está **commitado**: recusa worktree sujo, arquivo escondido do git (`assume-unchanged`, `skip-worktree`) e
  arquivo executável ignorado (`package.json`, `.npmrc`, `conftest.py`, `Makefile`...).
- Com `install` ligado, limpa tudo fora do commit com `git clean -fdXq` (linha 25) e reconstrói `node_modules` do lockfile
  imediatamente antes do teste.
- Bloqueia caminhos que nenhum agente pode alterar: `.env`, `.github/`, `orchestrator/`, `.orchestrator.json`, credenciais.
  O comando de teste vem do `.orchestrator.json` do **commit base**, então o ticket não consegue editá-lo.
- Recusa diffs que tocam arquivos que rodam código no host; vão para revisão do CEO.
- Invalida a verificação se o `HEAD` mudar ou a árvore sujar durante o teste.
- Antes de qualquer agente rodar, testa a base: base vermelha é recusada sem gastar token (mensagem "base is red before any
  agent ran (no tokens spent)" em `scripts/orch/flow.ts:19-23`, coberta por `tests/cli.int.test.ts`).
- A aprovação do CEO é presa ao commit publicado: se o commit mudou, o merge é recusado (`src/ship-nodes.ts`, teste "the
  merge is bound to the commit that was published and approved" em `tests/graph.part2.int.test.ts`).

Limites a admitir: `docs/portfolio/07-lessons-and-limits.md` reúne as lições aprendidas e os limites conhecidos.

## "Quanto custa um ticket?"

Medido com um ticket real, rodado em um repositório descartável (`COST-1`: trocar o texto de um botão e atualizar o teste).
Gerado por `orch run`, `orch approve` e `orch clean`. O log da execução e a linha gravada em `metrics.jsonl` estão versionados
em `docs/evidence/cost-1/` (`run.log` e `metrics.jsonl`, sem edição); a tabela abaixo vem deles. A linha de métricas, abreviada
(o arquivo completo traz também `first`, `last` e o detalhe por nó):

```
{"id":"COST-1","status":"simulated_deploy","priority":"P2","specialty":"frontend","route":"clear","tasks":1,"revisions":0,"escalations":0,"ms":86147,"tokens":7853,"usd":0.2308}
```

| Nó | Execuções | Tokens totais (com contexto em cache) | US$ |
|---|---|---|---|
| docs | 3 | 33.365 | 0,089 |
| dev | 1 | 71.434 | 0,066 |
| triage | 1 | 9.945 | 0,026 |
| reviewer | 1 | 5.330 | 0,024 |
| design | 1 | 5.522 | 0,014 |
| qa | 1 | 5.282 | 0,013 |
| **Total** | | **130.878** | **0,2308** (soma dos valores exatos; as linhas arredondadas somam 0,232) |

Como falar disso: **US$ 0,23 e 86 segundos para um ticket trivial, 0 revisões, 0 escalações.** O agente de docs custou 38% e
o dev 29%. A leitura honesta é que o custo de um ticket não é dominado por escrever código.

Ressalvas que você deve dizer junto: é **uma** amostra de um ticket trivial, não uma média. O valor em dólar é a estimativa
do Claude CLI a preços de API; com a assinatura não é uma cobrança. O campo `tokens` do `metrics.jsonl` (7.853) soma tokens de
entrada (sem cache) e de saída (`src/metrics.ts:14`); os 130.878 incluem também o contexto em cache (leitura e criação). Para uma média real, rode mais tickets e leia
`orchestrator/.state/metrics.jsonl` (ou `ORCH_HOME/metrics.jsonl`). Os custos antigos do portfolio foram removidos por não
terem fonte (`docs/portfolio/VERIFIED.md`).

## "Os testes são lentos. O que você fez?"

- Separei a suíte: `npm run test:unit` roda os testes sem git nem worktree e leva cerca de 1,3 segundo; `npm run test:int` leva
  cerca de 5 minutos. `npm test` roda os dois.
- Tentei acelerar a de integração e não houve ganho seguro. Perfil de um teste de grafo: 144 processos criados, dos quais cerca
  de 39% do tempo são 8 execuções de `npm test` embutidas; cada `git` custa de 45 a 70 ms nesta máquina; não há esperas
  artificiais. O `node --test` já roda os arquivos em paralelo (soma isolada de cerca de 912 s contra cerca de 290 s de relógio),
  então o limite é a taxa de criação de processos. Dividir um arquivo ganhou de 2 a 6%, dentro do ruído, e foi descartado.
- O que sobra mudaria o desenho de segurança (rodar `verifyEvidence` menos vezes) ou a máquina (excluir a pasta temporária do
  antivírus). Os números do perfil (144 processos, 39%, 45 a 70 ms, 912 s contra 290 s) vêm do relato de uma medição pontual
  em 2026-11-08; a saída bruta não está versionada e não são reproduzíveis a partir do repositório, então apresente-os como
  medição pontual e não como dado do projeto.

## Como reproduzir os números

| Número | Comando |
|---|---|
| testes unitários e tempo | `cd orchestrator && npm run test:unit` |
| testes de integração | `npm run test:int` (cerca de 5 minutos) |
| custo de um ticket | `npm run orch -- run "<pedido>"`, `orch approve <id>`, `orch clean <id>`, depois `ORCH_HOME/metrics.jsonl` |
| commits e datas | `git rev-list --count main`, `git log --format=%ad --date=short \| sort -u` |
