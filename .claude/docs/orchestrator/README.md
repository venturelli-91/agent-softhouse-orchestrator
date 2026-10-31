# Orchestrator (LangGraph.js) — visão geral

Camada fina de orquestração sobre a softhouse. Mora em `orchestrator/` e **não altera**
`.claude/agents`, `.claude/commands` nem `CLAUDE.md`: o grafo só lê esses arquivos.
Apagar `orchestrator/` (e `.claude/docs/orchestrator/`) devolve o sistema ao estado anterior;
`/pedir`, `/ticket` e `/demanda` seguem funcionando.

Tese: **controle de fluxo em código, não em prompt.** O prompt do agente é a camada mais
fraca; as barreiras reais são código, permissões do CLI, worktree isolado e env mínimo.

## Índice

| Doc | Conteúdo |
|---|---|
| [01-executor.md](01-executor.md) | `run-agent.ts`, `guardrails.ts` (Seção 2), flags reais do `claude -p`, medições |
| [02-grafo-tracer-bullet.md](02-grafo-tracer-bullet.md) | `graph.ts`, estado, nós, arestas, tracer com modelo real, linha de base de consumo, bugs |
| [03-guardrails-de-fluxo.md](03-guardrails-de-fluxo.md) | `guardrails.ts` Seção 1, escalada ao CEO, testes com nós falsos, CI, regressão ao vivo |
| [04-planejador.md](04-planejador.md) | nó planejador, esclarecimento de escopo com o CEO |
| [05-publicar-devops-watchdog.md](05-publicar-devops-watchdog.md) | push/PR pelo código, devops pós-CEO, watchdog |
| [06-fase-3-e-relatorio-final.md](06-fase-3-e-relatorio-final.md) | publicação, regressão ao vivo, relatório final |

(Os próximos docs entram junto com cada task: publicação.)

## Decisões e achados (task 1)

- **Dependências de runtime:** `@langchain/langgraph` 1.6.0, `@langchain/core` 1.3.2 (peer
  *obrigatório* do langgraph; não é o pacote `langchain`) e `zod` 4. Dev: `typescript`,
  `@types/node`. Nada de vitest/tsx: o teste usa `node:test` e o Node 24 executa `.ts`.
  Árvore do LangGraph: `@langchain/langgraph-checkpoint`, `-sdk`, `protocol`, `standard-schema`.
- **Checkpointer:** `MemorySaver` na Fase 1 (aprovação do CEO respondida no mesmo processo).
  O SQLite oficial (`@langchain/langgraph-checkpoint-sqlite`) puxa `better-sqlite3` (módulo
  nativo) e fica para quando houver necessidade de aprovar de forma assíncrona.
- **Repositório de tickets:** não existe (`playbooks/` só tem `.gitkeep`, sem GitHub issues
  configuradas aqui). O estado do ticket é o do próprio grafo.
- **Git:** a pasta não era um repo. Foi feito `git init`, `origin` apontando para o GitHub
  (sem push). O `~/.config/git/ignore` global exclui `.claude/`; o `.gitignore` do repo
  nega isso (`!.claude/`) sem mexer na config global.
- **CEO** = o usuário humano (ver `CLAUDE.md`). O nó `aprovacao_ceo` é a pausa em que o
  grafo espera a decisão dele.
- **Commits:** atômicos, em inglês, sem prefixo de ticket (não há ticket), estilo
  `feat(orchestrator): ...`.
