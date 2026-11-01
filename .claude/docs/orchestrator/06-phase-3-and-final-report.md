# Fase 3 e relatório final

## Fase 3 (publicação)

- `orchestrator/examples/agents/`: 18 prompts genéricos (≤7 linhas), um por arquivo que o código carrega
  (o enunciado dizia 8; o código referencia 18 nomes). `AGENTS_DIR=examples/agents` roda o projeto sozinho.
- `scripts/check-secrets.sh`: chaves/tokens e caminhos de máquina na árvore e no histórico; termos pessoais vêm de
  `TERMOS_PESSOAIS`, nunca do código público. `LICENSE` MIT, `README.md` com diagrama do LangGraph.
- Publicação: repo inteiro em `venturelli-91/venturelli-house` (público). Antes, `d:\...\skills` virou `$SKILLS_DIR`
  em todo o histórico (`git filter-branch`). CI movido para `.github/workflows/ci.yml` (raiz), verde.

## Regressão ao vivo (modelo padrão, esforço médio, todos os nós novos no caminho claro)

| Nó | Tokens | Turnos | Tempo | US$ |
|---|---|---|---|---|
| triagem | 15.994 | 4 | 8,9 s | 0,012 |
| dev | 40.583 | 5 | 11,0 s | 0,023 |
| reviewer | 11.513 | 3 | 8,7 s | 0,020 |
| qa | 11.824 | 4 | 11,0 s | 0,023 |
| devops | 5.332 | 2 | 6,7 s | 0,025 |
| **Total** | **85.246** | | **46,4 s** | **0,104** |

Task 3: 79.631 tokens / 36,0 s / US$ 0,063. A diferença é o `devops` (+5,3 mil tokens) e a triagem maior. Rota
ambígua (planejador) e publicador `github` não foram exercitados com modelo/remoto reais.

## O que reaproveitei

`.claude/agents/*.md` e `CLAUDE.md` como fonte dos papéis e das regras (valores dos guardrails espelham o
`CLAUDE.md`); login do Claude Code (sem chave); Mermaid do LangGraph; `node:test` e type stripping do Node 24
(sem vitest/tsx); estado de tickets ativos nos worktrees do próprio git (sem banco).

## O que deixei de fora de propósito

Executor DeepSeek e executor LangChain direto (só o encaixe `registrarExecutor`); script de benchmark;
checkpointer persistente; comando de linha do watchdog; deploy real; gestor de conhecimento como nó.

## O que não precisou ser feito

Banco ou repositório de tickets; abstração de executor além do registro; mocks de módulo (nó falso pelo
executor); alteração de `.claude/agents`, `.claude/commands` ou `CLAUDE.md` para o grafo funcionar.

## Limites conhecidos

Allowlist de `Bash` é fraca (barreira real: worktree sem segredos e env mínimo); `npm test` roda no host; MemorySaver
(aprovação só no mesmo processo); uso individual e local, não serviço para terceiros.
