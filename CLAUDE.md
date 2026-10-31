# Softhouse de Agentes de IA — Framework

Este repositório é o **esqueleto reutilizável** da softhouse: papéis (`.claude/agents/`),
fluxos (`.claude/commands/`) e regras (este arquivo). Não tem código de produto.

**Como usar em um projeto real**: copie `.claude/` e este `CLAUDE.md` para a raiz do
repositório do projeto. Os comandos (`/demanda`, `/ticket`, `/daily-brief`,
`/daily-report`, `/watchdog-scan`) passam a rodar contra aquele código de verdade.

O CEO é o usuário humano. Ele define visão, prioridades, orçamento e aprovações
críticas. Cada agente abaixo organiza uma parte da entrega, mas nenhuma decisão da
"Matriz de autonomia" (seção abaixo) pode ser tomada sem ele.

## Princípios

1. Não comece a construir sem objetivo, usuário e critérios de aceite.
2. Quebre demandas grandes em tickets pequenos, independentes e verificáveis.
3. Nenhum agente revisa, testa ou aprova sua própria entrega.
4. Nunca faça deploy em produção, merge crítico, alteração destrutiva, pagamentos,
   alterações de permissões ou exposição de dados sem aprovação explícita do CEO.
5. Toda entrega deve ter evidência: PR, testes, relatório, screenshot, vídeo ou logs.
6. Se houver ambiguidade relevante, pare e escale a decisão ao CEO.
7. Mantenha no máximo 5 tickets ativos simultaneamente.
8. Prioridades:
   - **P0**: incidente, segurança, receita, cliente bloqueado ou prazo crítico
   - **P1**: importante nesta semana
   - **P2**: melhoria ou exploração
   - **Bugs**: regressões e falhas
9. O objetivo é valor validado, não volume de código.
10. Sempre registrar decisões, falhas recorrentes e melhorias nos playbooks (`playbooks/`).

## Fluxo obrigatório

```
Pedido do CEO → Triagem
             → [claro]    → Dev especializado → Code Review → QA Automation
             → [ambíguo]  → Analista de Demanda → Product Manager → Tech Lead
                           → Engenheiro de Prompt → Engenheiro de Evals
                           → Dev especializado → Code Review → QA Automation
        → Segurança / Performance / IA (quando aplicável)
        → Aprovação do CEO → DevOps / Deploy → Watchdog → Gestor de Conhecimento
```

`/pedir` roda a Triagem primeiro e decide sozinho entre as duas rotas. Se você já sabe
que o pedido é um ticket claro (ex.: "ajustar espaçamento do card X") ou já sabe que
precisa de escopo, pode chamar `/ticket` ou `/demanda` direto e pular a Triagem.

**Não force a cadeia inteira quando o pedido já é um ticket claro.** Um ticket só de
frontend, por exemplo, aciona apenas `dev-frontend` → `code-reviewer` →
`qa-automation`; `seguranca`/`performance`/`engenheiro-ia` só entram se o ticket
realmente tocar nessas áreas. `analista-demanda`/`product-manager`/`tech-lead` só
entram quando falta objetivo/escopo/critério de aceite — é a Triagem (ou você mesmo)
quem decide isso, não uma regra fixa de "sempre passar por todo mundo".
`code-reviewer` e `qa-automation` não são opcionais nem em tickets pequenos (princípio
3: ninguém aprova a própria entrega) — é o único custo fixo, e é baixo (2 agentes, não
os 19).

## Roteamento de tickets

| Tipo de trabalho | Agente |
|---|---|
| UI, telas, componentes, UX | `dev-frontend` |
| API, banco, regras e permissões | `dev-backend` |
| Mudança pequena ponta a ponta | `dev-fullstack` |
| Aplicativo mobile | `dev-mobile` |
| Integração externa, webhook, OAuth | `dev-integracoes` |
| LLM, agentes, tool calling, memória | `engenheiro-ia` |
| RAG, embeddings, dados e pipelines | `engenheiro-dados` |
| Segurança e dados sensíveis | `seguranca` |
| Latência, escala e custo | `performance` |
| Pipeline, deploy, logs e incidente | `devops-sre` |
| Testes e validação final | `qa-automation` |
| Todo PR | `code-reviewer` |
| Prompts e playbooks internos | `engenheiro-prompt` |
| Qualidade de prompts, agentes e workflows | `engenheiro-evals` |
| Revisão visual/UX e heurísticas de Nielsen | `dev-frontend` (build) + `qa-automation` (audit independente) |

## Skills e plugins

Cada agente lista no seu próprio arquivo (`.claude/agents/<papel>.md`) as skills e
plugins específicos do seu trabalho. Duas fontes ficam disponíveis para todos:

- **Skills já registradas nesta instância do Claude Code** (invocáveis com a tool
  `Skill`, pelo nome) — ex.: `frontend-design`, `impeccable`, `security-review`,
  `code-review`, `simplify`, `claude-api`, `superpowers:writing-skills`.
- **Biblioteca pessoal de skills em `$SKILLS_DIR`** — arquivos
  `SKILL.md` de referência que NÃO estão registrados como skills desta sessão (a tool
  `Skill` não os invoca pelo nome). Cada agente relevante aponta o caminho exato para
  ler com `Read` antes de executar o trabalho. Se essa pasta for movida, atualize os
  caminhos citados nos agentes.

**Plugins/MCP usados pela softhouse**:
- **Playwright MCP** (`mcp__plugin_playwright_playwright__*`) — abrir a aplicação
  rodando localmente e navegar/inspecionar de verdade, usado por `dev-frontend` e
  `qa-automation`.
- **Figma MCP** (`mcp__claude_ai_Figma__*`) — quando a demanda vier com link do Figma,
  usado por `dev-frontend` (design-to-code) e `product-manager`/`tech-lead` (design
  system).
- **context7** — documentação atualizada de bibliotecas/frameworks, usado por
  `tech-lead` e qualquer dev antes de usar uma API que não domina de cor.

## Matriz de autonomia

**Pode executar sem aprovação**: pesquisar código/documentação, criar branch,
implementar, rodar testes, abrir PR, criar documentação, gerar relatórios, analisar
logs autorizados.

**Deve pedir aprovação antes**: merge, deploy, alteração de schema, nova dependência
paga, mudança de API pública, permissões, integração externa, envio de comunicação
externa, alteração com impacto relevante em custo.

**Nunca executar sem instrução explícita**: produção direta, exclusão de dados,
pagamentos, contratos, exposição ou compartilhamento de dados sensíveis, rotação de
credenciais, ação legal, fiscal ou regulatória.

## Auditoria Ponytail (todo PR)

`code-reviewer` roda `ponytail:ponytail-review` em todo PR, sem exceção — cobre tanto
complexidade desnecessária (abstração especulativa, dependência supérflua) quanto
**defensividade excessiva** (validação/try-catch para estados que não podem ocorrer,
checagem repetida do mesmo invariante). A régua é a fronteira de confiança: validar
input do usuário, API externa e dado de rede continua obrigatório — o que é achado é
validar coisa que o próprio tipo/fluxo do código já garante. Para auditoria do
repositório inteiro (não só o diff de um PR), qualquer agente com `Read`/`Grep`/`Glob`
pode rodar `ponytail:ponytail-audit` sob demanda.

## Rituais do CEO

- `/daily-brief` — P0, tickets ativos, PRs aguardando revisão, falhas de CI/QA,
  alertas, custos anormais, decisões pendentes, top 3 riscos, próximas ações.
- `/daily-report` — entregue, em andamento, bloqueado, bugs novos, qualidade/testes,
  mudanças em produção, custos e uso de IA, aprendizados.
- `/watchdog-scan` — varredura ad-hoc a qualquer momento do dia.
- `/pedir` — porta de entrada única: roda a Triagem e encaminha para `/ticket` ou
  `/demanda` sozinho, quando você não quer decidir isso manualmente.
