# Task 3 — Guardrails de fluxo (Seção 1), testes com nós falsos e CI

Tudo em `orchestrator/src/guardrails.ts` (Seção 1) e aplicado em `graph.ts`. Os valores
espelham `CLAUDE.md`: 5 tickets ativos, aprovação do CEO para merge/deploy, ninguém aprova a
própria entrega.

## Regras e onde são aplicadas

| Regra | Implementação | Teste |
|---|---|---|
| `MAX_REVISOES=3` | `rota()` manda ao `aprovacao_ceo` quando `revisoes >= 3` | `teto de 3 revisoes` |
| `MAX_TICKETS_ATIVOS=5` | `ticketsAtivos(repo)` conta worktrees `ticket/*` do git (sem outro banco); `criarWorktree` recusa o 6º | `limite de 5 tickets ativos` |
| Autor ≠ revisor ≠ QA | `autoaprovacao(autor, quem)`, checada antes de gastar token no reviewer/qa; `autor_id` vem do autor do commit (identidade injetada no env) | `autoaprovacao bloqueada` |
| Evidência verificada por código | `verificarEvidencia`: commit novo, worktree limpo, sem arquivo executável ignorado, caminhos permitidos, `npm test` passa. Roda no dev, **de novo** no reviewer, no qa e antes de honrar a aprovação do CEO | `evidencia declarada ... rejeitada`, `commit sem teste real...`, `worktree com alteracao...` |
| Caminhos proibidos | `PROIBIDOS`: `.env*`, `.github/`, `orchestrator/`, chaves/credenciais; `package.json`/`.npmrc` exigem CEO (executam código no host). Regex com `/i` e `-z` (filesystem NTFS e nomes exóticos) | `diff que toca caminho proibido`, `diff que toca package.json` |
| Merge/deploy só com o CEO | `deploy_simulado` só é produzido por `aprovacao_ceo` após `interrupt()`; o nó revalida a evidência e a payload leva `flags_ativas` | `deploy so acontece depois da aprovacao...`, `flag de aprovacao...` |
| Escalada ao CEO | ambiguidade, falha de nó (erro, timeout, saída inválida, turnos), teto de revisões, orçamento e evidência inválida viram `interrupt({tipo:"escalada", motivo})` | `pedido ambiguo`, `saida invalida`, `orcamento` |
| Orçamento | `orcamentoEstourado` soma tokens do `historico` contra `TOKEN_BUDGET_TICKET` antes de cada nó (ausente = erro) | `orcamento de tokens estourado` |
| Turnos | `--max-turns` do CLI; `error_max_turns` é `FalhaDeNo` em `interpretar` | `saida invalida, limite de turnos, erro e lixo` |
| Modelo/esforço só do ambiente | `lerEnv`; teste varre `src/` atrás de nomes de modelo | `modelo, esforco e turnos...`, `nenhum nome de modelo...` |

## Decisões

- **Flags de aprovação e rota:** como todo merge/deploy já passa obrigatoriamente pelo CEO,
  as flags (`toca_schema`, `toca_api_publica`, `toca_permissoes`, `toca_integracao_externa`,
  `toca_custo`) não mudam o caminho; elas aparecem em `flags_ativas` para o CEO decidir com
  contexto. Se um dia houver deploy automático para algum caso, a flag passa a decidir.
- **Resposta do CEO a uma escalada:** `abortar` encerra (`status=abortado`); qualquer outro
  texto vira instrução e volta ao dev com `revisoes=0` — só se a triagem já produziu critérios.
  Escalada antes disso (triagem ambígua/falha) só pode abortar; o planejador (task 4) cobre
  o esclarecimento de escopo.
- **Rejeição do CEO** numa aprovação normal volta ao dev com `revisoes + 1`.
- **Executor falso:** `registrarExecutor("fake", ...)` + `EXECUTOR=fake`. É o mesmo encaixe
  que servirá a outros executores no futuro; não há mock de módulo.
- **Estado dos testes:** 23 testes, ~23 s, sem rede, modelo ou credencial. O dev falso faz
  commits reais num repo-fixture (`scripts/fixture.ts`, também usado pelo tracer).

## CI

`.github/workflows/ci.yml` (raiz, com `working-directory: orchestrator`): Node 24, `npm ci`, `npm run typecheck`, `npm test`,
`permissions: contents: read`, sem secrets, só dispara em mudanças de `orchestrator/`. (Antes ficava dentro de
`orchestrator/` e o GitHub não o executava; movido na publicação.)

## Segurança — rodada 4 (revisão automática)

- `npm test` só roda com worktree limpo e sem `package.json`/`.npmrc` alterados ou ignorados.
- Casamento de caminhos case-insensitive e com `-z`/`core.quotePath=false`.
- `git diff --no-renames`: renomear/mover arquivo proibido expõe também o caminho antigo.

## Regressão ao vivo

Tracer real reexecutado após a task: `status=deploy_simulado`, 79.631 tokens, 36,0 s,
US$ 0,063 (linha de base da task 2: 81.832 tokens, 40,1 s, US$ 0,071).
