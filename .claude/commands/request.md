---
description: Porta de entrada única para qualquer pedido do CEO — roda a Triagem e encaminha automaticamente para /ticket (direto) ou /demanda (precisa de escopo).
---

Pedido do CEO: $ARGUMENTS

1. Invoque o subagente `triagem` com o pedido acima.
2. Se a triagem concluir que o pedido **já está claro o suficiente para ticket direto**:
   invoque a skill `ticket` (`Skill(skill: "ticket")`) passando o ticket resumido que a
   triagem produziu, já indicando o agente/área sugerido.
3. Se a triagem concluir que **falta escopo** (objetivo, usuário, critérios de aceite):
   invoque a skill `demanda` (`Skill(skill: "demanda")`) passando o pedido original e o
   que a triagem identificou como faltante, para o Analista de Demanda não repetir
   trabalho já feito.
4. Se a triagem identificar **mais de uma área** no mesmo pedido, avise o CEO e sugira a
   quebra em tickets separados antes de prosseguir — não rode as duas cadeias ao mesmo
   tempo sem confirmação.

Use `/pedir` como padrão quando não tiver certeza se o pedido já é um ticket ou ainda
precisa de escopo. Se você (CEO) já sabe exatamente o que quer e qual área, pode ir
direto em `/ticket` ou `/demanda` e pular a triagem.
