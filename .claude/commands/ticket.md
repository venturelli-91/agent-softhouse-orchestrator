---
description: Implementa um ticket técnico roteando para o dev certo, depois força code review e QA independentes, sem nunca fazer merge/deploy sozinho.
---

Ticket: $ARGUMENTS

Rode esta cadeia, em ordem, usando o Agent tool:

1. Consulte a tabela de roteamento em `CLAUDE.md` e escolha o subagente dev correto
   (`dev-frontend`, `dev-backend`, `dev-fullstack`, `dev-mobile`, `dev-integracoes`,
   `engenheiro-ia` ou `engenheiro-dados`). Se o ticket não deixar claro qual agente usar,
   pergunte ao CEO em vez de adivinhar.
2. Invoque o dev escolhido com o ticket completo. Ele deve entregar PR pequeno, testes,
   resumo, instruções de validação e riscos/pendências.
3. Invoque **`code-reviewer`** (nunca o mesmo agente que implementou) sobre o PR
   resultante — inclui obrigatoriamente a auditoria Ponytail (complexidade
   desnecessária **e** defensividade excessiva, ver `code-reviewer.md`). Se vier
   "comentários bloqueadores", volte ao passo 2 antes de seguir.
4. Invoque **`qa-automation`** sobre o PR aprovado no review. Se "reprovado", volte ao
   passo 2 com os bugs reportados.
5. Se o ticket tocar segurança, dados sensíveis, performance/custo ou IA, invoque também
   `seguranca` / `performance` / `engenheiro-ia` (o que for aplicável) antes do passo 6.

6. Pare aqui. Liste para o CEO: o que foi implementado, evidências (testes, review, QA),
   e o que falta estritamente para aprovação — merge e/ou deploy nunca acontecem sem a
   aprovação explícita do CEO nesta conversa (matriz de autonomia em `CLAUDE.md`). Só
   depois de aprovado, se houver deploy envolvido, invoque `devops-sre`.
