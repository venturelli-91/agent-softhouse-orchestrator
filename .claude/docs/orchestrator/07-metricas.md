# Métricas consolidadas

Tudo medido nesta sessão, por fase. Consumo = `claude -p` com o modelo padrão do projeto e esforço médio, login da
assinatura. "US$" é só o equivalente de API; o uso real é descontado do limite do plano. "Tokens" = entrada +
saída + cache criado + cache lido, somados em todos os turnos do nó (o contexto é relido a cada turno).

## 1. Consumo ao vivo

### Execuções medidas

| Marco | Escopo | Tokens | Turnos | Tempo | US$ |
|---|---|---|---|---|---|
| Task 1 (smoke) | só `triagem` | ~5.050 (cache criado 4.400 + saída 650) | 2 | 7,4 s | 0,024 |
| Task 2 (linha de base) | triagem, dev, reviewer, qa | 81.832 | 19 | 40,1 s | 0,071 |
| Task 3 (regressão) | mesmo caminho, com guardrails | 79.631 | n/d | 36,0 s | 0,063 |
| Fase 2 (final) | + `devops` | 85.246 | 18 | 46,4 s | 0,104 |

Task 3 só registrou o total, sem quebra por nó. Todas rodaram o mesmo ticket trivial (trocar o texto de um botão),
caminho claro, 0 revisões, aprovado pelo CEO simulado.

### Por nó

| Nó | Task 2: tokens / turnos / tempo / US$ | Final: tokens / turnos / tempo / US$ | Variação de tokens |
|---|---|---|---|
| triagem | 10.842 / 3 / 7,3 s / 0,011 | 15.994 / 4 / 8,9 s / 0,012 | +47% |
| dev | 41.421 / 6 / 12,1 s / 0,021 | 40.583 / 5 / 11,0 s / 0,023 | -2% |
| reviewer | 11.749 / 4 / 8,2 s / 0,016 | 11.513 / 3 / 8,7 s / 0,020 | -2% |
| qa | 17.820 / 6 / 12,4 s / 0,023 | 11.824 / 4 / 11,0 s / 0,023 | -34% |
| devops | n/a | 5.332 / 2 / 6,7 s / 0,025 | novo |
| **Total** | **81.832 / 19 / 40,1 s / 0,071** | **85.246 / 18 / 46,4 s / 0,104** | **+4%** |

Detalhe de contexto vs saída (Task 2): triagem ctx 10.117 + saída 725; dev 40.591 + 830; reviewer 10.947 + 802;
qa 16.466 + 1.354. Final: triagem 15.233 + 761; dev 39.914 + 669; reviewer 10.714 + 799; qa 10.641 + 1.183;
devops 4.722 + 610.

### Leitura

- O dev concentra ~48% dos tokens; a saída é <3% em todos os nós, então o custo é contexto relido por turno
  (3,4k a 6,7k tokens por turno). A alavanca é reduzir turnos e prompt de sistema, não a resposta.
- A triagem cresceu 47% sem mudar o prompt: variação entre execuções (4 turnos contra 3), não regressão de código.
- O total subiu 4% em tokens mas 46% em US$ (0,071 para 0,104): o `devops` custou 0,025 em apenas 5,3 mil tokens, e a
  soma por nó não é proporcional a tokens (mistura de cache criado e cache lido tem preços diferentes).
- Não foram medidos ao vivo: planejador (rota ambígua), `publicar` com `github`, `watchdog`. Os três têm teste com
  nó falso, sem custo de token.
- Piso do `claude -p` enxuto (Haiku, prompt vazio): ~1.900 tokens. O restante de cada nó é prompt do papel + schema
  + pedido.

## 2. Testes

| Marco | Testes | Observação |
|---|---|---|
| Task 1 | 6 (`run-agent`) | sem modelo nem credencial |
| Task 3 | 23, ~23 s | guardrails de fluxo com nós falsos |
| Task 4 | 26, ~29 s | + 3 do planejador |
| Fase 2 (publicar/devops/watchdog) | 31 | + 5 |
| Final (SHA fixado, HEAD movido) | 32 | + 1 em `evidencia.test.ts` |

Distribuição final: `graph.test.ts` 16, `evidencia.test.ts` 8, `run-agent.test.ts` 8. Nenhum teste usa rede, modelo ou
credencial. CI no GitHub Actions: verde no `main`.

## 3. Tamanho do código

- `orchestrator/src/`: 532 linhas (alvo do enunciado: núcleo em ~300; passou por guardrails, publicador e
  watchdog, que o enunciado não contava).
- `tests/` + `scripts/`: 448 linhas. `examples/agents/`: 18 prompts, ≤7 linhas cada (alvo: 8 prompts ≤15 linhas).
- Dependências de runtime: 3 (`@langchain/langgraph`, `@langchain/core`, `zod`); dev: 2 (`typescript`, `@types/node`).
- README: ~12 linhas de texto mais o diagrama gerado (alvo: ≤20 linhas de texto).

## 4. Processo

- 22 commits em `main`, 13 deles `feat`/`fix` do orchestrator; 100% atômicos, em inglês.
- Revisões automáticas de segurança por fase: 4 rodadas na Fase 1/Task 3 (sandbox, `npm test` no host, caminhos
  proibidos, renomeações), mais 2 achados em `publicar.ts` e 1 em `graph.ts` na Fase 2, todos corrigidos com teste.
- Histórico reescrito uma vez antes da publicação (caminhos pessoais) e novamente para tirar termos pessoais do
  `check-secrets.sh`; zero ocorrências na busca final em `main`.
- Limites e guardrails medidos em código: `MAX_REVISOES=3`, `MAX_TICKETS_ATIVOS=5`, `RECURSION_LIMIT=40`,
  `TIMEOUT_POR_NO=600 s`, orçamento padrão `TOKEN_BUDGET_TICKET=200000` (o ticket medido usa 43% disso).
