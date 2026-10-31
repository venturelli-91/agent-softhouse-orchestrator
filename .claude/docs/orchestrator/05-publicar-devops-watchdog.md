# Fase 2 (restante) — publicar, devops e watchdog

## Fluxo

`qa -> publicar -> aprovacao_ceo -> (aprovado) devops -> END`. Rejeição volta ao dev; `devops` só é alcançável
com `status=aprovado`, que só `aprovacao_ceo` produz após `interrupt()`.

## publicar (código, sem agente) — `src/publicar.ts`

- Reverifica a evidência (commit, worktree limpo, caminhos permitidos, `npm test`), faz `git push --set-upstream
  origin ticket/<id>` e abre PR **rascunho** com `gh pr create --draft`; se o PR já existe (ciclo de revisão),
  só atualiza a branch. Merge continua sendo do CEO.
- A URL entra em `evidencias` (`pr:<url>`) e aparece na payload da aprovação.
- `PUBLICADOR` (env): `github` | `nenhum`. Ausente ou desconhecido = `FalhaDeNo` (escala ao CEO, nada é enviado).
  `.env.example` traz `nenhum`; troque para `github` só ao usar um repo-alvo real com `origin` e `gh` autenticado.
  Mesmo encaixe do executor (`registrarPublicador`), usado pelos testes.
- O push roda no host com as credenciais do usuário (`gitSeguro`, hooks desligados, `--no-verify`) e envia exatamente o SHA verificado para `refs/heads/ticket/<id>`, nunca o HEAD atual; o agente dev continua sem `git push`.

## devops

`devops-sre.md`, papel somente leitura. Simulação: o agente descreve status, rollback e observabilidade; não
executa deploy nem merge. Falha do nó termina em `status=escalado` (sem nova pausa).

## watchdog — `src/watchdog.ts`

`watchdog(tickets, cwd)`: fora do grafo, por chamada. Recebe uma linha por ticket (id, prioridade, status, revisões,
tokens, último nó), papel somente leitura, devolve `{alertas, resumo}`. Não há script/CLI: o estado vive no
checkpointer em memória; o comando entra quando houver checkpointer persistente.

## Testes (nós e publicador falsos)

push/PR antes do CEO e devops só depois; rejeição não aciona devops; `PUBLICADOR` ausente escala sem publicar;
publicador que falha escala; watchdog devolve alertas. Total: 31 testes.

## Não validado

O publicador `github` real (push + `gh pr create`) não foi exercitado contra um remoto: depende de `origin` e `gh`.
