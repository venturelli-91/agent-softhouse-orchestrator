---
description: Roda uma varredura ad-hoc do Watchdog a qualquer momento, sem esperar o ritual diário completo.
---

Invoque o subagente `watchdog` agora, fora do ritual diário, para checar: erros,
alertas, custos, PRs parados, falhas de CI, tickets bloqueados, degradação de IA e
backlog P0. Reporte no formato:

```
- top 3 problemas
- impacto
- status
- responsável sugerido
- próxima ação recomendada
```

$ARGUMENTS
