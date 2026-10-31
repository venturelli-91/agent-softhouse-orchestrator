---
description: Gera o Daily Delivery Report de fim de dia e aciona o Gestor de Conhecimento para registrar aprendizados novos.
---

Invoque o subagente `watchdog` para levantar o que mudou hoje (commits, PRs mergeados,
CI, custos) e monte o relatório abaixo. Depois, se houver aprendizado novo (uma falha
recorrente, uma decisão relevante, um padrão que valeu a pena), invoque
`gestor-conhecimento` para registrar em `playbooks/` antes de fechar o relatório.

```
# Daily Delivery Report
## Entregue
## Em andamento
## Bloqueado
## Bugs novos
## Qualidade e testes
## Mudanças em produção
## Custos e uso de IA
## Aprendizados adicionados aos playbooks
```
