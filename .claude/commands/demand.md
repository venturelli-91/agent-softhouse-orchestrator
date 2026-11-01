---
description: Transforma um pedido do CEO em briefing, PRD e tickets técnicos, parando para perguntar quando houver ambiguidade relevante.
---

Demanda do CEO: $ARGUMENTS

Rode esta cadeia, em ordem, usando o Agent tool para invocar cada subagente:

1. **`analista-demanda`** — produza o Briefing (template no arquivo do agente). Se
   objetivo, usuário afetado ou critérios de aceite não puderem ser preenchidos com
   confiança, pare aqui e pergunte ao CEO antes de continuar (não avance com suposições).
2. **`product-manager`** — a partir do briefing aprovado, produza PRD + histórias +
   critérios de aceite + backlog priorizado. Se alguma "decisão pendente" do briefing
   bloquear o escopo, pare e escale ao CEO.
3. **`tech-lead`** — a partir do PRD, produza arquitetura + tickets técnicos pequenos
   (máx. 5 ativos por vez, ver `CLAUDE.md`), cada um já roteado para o agente certo pela
   tabela de `CLAUDE.md`.

Ao final, apresente ao CEO:
- o briefing,
- o PRD resumido,
- a lista de tickets técnicos prontos, cada um com o agente responsável indicado,
- qualquer decisão pendente que ainda precise de aprovação antes de rodar `/ticket`.

Não implemente nada nesta etapa — o objetivo é sair com tickets prontos para
`/ticket <id-ou-descrição>`.
