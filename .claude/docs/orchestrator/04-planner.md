# Task 4 — Nó planejador

Rota ambígua do enunciado: `triagem -> planejador -> dev`, e `aprovacao_ceo -> planejador` quando falta informação.

## Comportamento

- Roda só quando a triagem devolve `claro=false` (`aposTriagem` em `graph.ts`). A triagem ambígua não passa mais
  critérios adiante (`criterios=[]`).
- **Uma chamada** com `analista-demanda` + `product-manager` + `tech-lead` concatenados como prompt de sistema
  (a "sequência" é a ordem dos arquivos). Três chamadas triplicariam o contexto; o enunciado prioriza tokens.
- Saída (`SaidaPlano`) = saída da triagem + `pergunta`. `claro=true` com critérios: preenche título, prioridade,
  especialidade, flags e critérios, e segue ao dev. Sem critérios fechados: `status=ambiguo`, `resumo=pergunta`.
- **Esclarecimento:** `status=ambiguo` vai ao `aprovacao_ceo` como escalada com a pergunta. Resposta diferente de
  `abortar` é anexada ao `pedido` (`Esclarecimento do CEO: ...`) e o ticket volta ao planejador; `abortar` encerra.
  Falhas de nó (erro, timeout, saída inválida) continuam só abortando enquanto não há critérios.
- Papel `planejador`: somente leitura (mesma tabela da triagem). Turnos em `TURNOS_PLANEJADOR`; modelo/esforço
  herdam `*_DEFAULT`.
- Sem teto próprio de rodadas de esclarecimento: cada volta exige resposta humana, e o orçamento de tokens e o
  `RECURSION_LIMIT` continuam valendo.

## Testes (nós falsos)

`pedido ambiguo passa pelo planejador...`, `planejador sem criterios escala com a pergunta...`,
`CEO aborta quando o planejador pede esclarecimento`. Total: 26 testes.

## Fora do escopo

devops, watchdog, push da branch e abertura do PR pelo código (próximas tasks da Fase 2).
