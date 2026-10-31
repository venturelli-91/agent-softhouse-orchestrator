---
description: Gera o Daily CEO Brief do dia, usando o Watchdog para levantar o estado real do projeto.
---

Invoque o subagente `watchdog` para varrer o projeto atual (git, CI, PRs, tickets,
custos de IA quando houver como medir) e monte o brief abaixo. Se alguma fonte não
estiver disponível neste ambiente (ex.: sem `gh` configurado), diga isso em vez de
inventar dados.

```
# Daily CEO Brief
## P0
## Tickets ativos
## PRs aguardando revisão
## Falhas de CI e QA
## Alertas e incidentes
## Custos anormais
## Decisões pendentes do CEO
## Top 3 riscos
## Próximas ações recomendadas
```
