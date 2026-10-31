# Task 1 — Executor (`run-agent.ts`) e defesas por nó (`guardrails.ts`, Seção 2)

## O que existe

- `orchestrator/src/guardrails.ts` — tabela de permissões por papel, env mínimo do
  subprocesso, leitura de modelo/esforço/turnos do ambiente.
- `orchestrator/src/run-agent.ts` — interface `Executor`, executor `claude-subscription`,
  `runAgent` (escolhe pelo `EXECUTOR`, padrão `claude-subscription`), `FalhaDeNo`.
- `orchestrator/tests/run-agent.test.ts` — 6 testes, sem modelo e sem credencial.
- `orchestrator/.env.example` — modelo, esforço, turnos, `AGENTS_DIR`, orçamento.

## Fluxo de uma chamada

1. O **nó** (task 2) monta `Req`: `papel`, `arquivos` (nomes de `AGENTS_DIR`, sem `.md`),
   `contexto` (texto mínimo montado pelo código), `schema` (zod) e `cwd` (worktree).
2. `carregarPrompt` lê os `.md`, remove o frontmatter (a linha `tools:` é do Claude Code,
   não do executor) e concatena. Nenhum prompt é duplicado.
3. `argsClaude` monta os argumentos do `claude -p`; o contexto vai por **stdin**.
4. O subprocesso roda com `envMinimo` e `AbortSignal.timeout(TIMEOUT_POR_NO_MS)`.
5. A saída `--output-format json` é lida; `structured_output` passa pelo zod.
6. Qualquer erro (exit ≠ 0, timeout, `is_error`, `error_max_turns`, JSON fora do schema)
   vira `FalhaDeNo`. O grafo trata isso como falha fechada e escala ao CEO.

## Flags usadas (confirmadas em `claude --help` 2.1.316 e na doc oficial CLI reference)

| Objetivo | Flag |
|---|---|
| Não interativo | `-p` |
| Modelo / esforço | `--model`, `--effort` (low, medium, high, xhigh, max) |
| Limite de turnos | `--max-turns N` (**documentado, mas ausente do `--help` local**) |
| Prompt do papel | `--system-prompt` (substitui o prompt padrão) |
| Saída | `--output-format json`, `--json-schema` |
| Permissões | `--permission-mode dontAsk`, `--tools`, `--allowedTools`, `--disallowedTools` |
| Enxugar contexto | `--setting-sources ""`, `--strict-mcp-config`, `--disable-slash-commands` |
| Sem disco | `--no-session-persistence` |

Descartadas de propósito:

- `--bare`: pula hooks e CLAUDE.md, mas **só aceita `ANTHROPIC_API_KEY`** (nunca lê OAuth
  nem keychain), o que quebra o objetivo de usar a assinatura.
- `--max-budget-usd`: orçamento em dólar; o orçamento do projeto é em tokens, medido pelo código.

## Pegadinhas encontradas

- `z.toJSONSchema` emite `$schema` draft 2020-12 e o CLI rejeita
  (`no schema with key or ref ...2020-12/schema`). O `$schema` é removido.
- O `--json-schema` consome 1 turno (tool `StructuredOutput`). Por isso
  `--max-turns = TURNOS_<PAPEL> + 1`.
- `ANTHROPIC_*` não é "removido": a env do subprocesso é uma **whitelist**
  (`PATH`, `USERPROFILE`, `APPDATA`, ...), então nada fora dela chega ao `claude`. O login da
  assinatura continua achável via `USERPROFILE`/`APPDATA`.

## Tabela de permissões

| Papel | Ferramentas | Observação |
|---|---|---|
| triagem, reviewer, qa | `Read, Grep, Glob` | somente leitura; reviewer/qa recebem o diff no contexto |
| dev | + `Write, Edit, Bash` | `Bash` só com `git add/commit/status/diff` e `npm *`; nega `git push`, `git remote`, `git config`, `rm -r`, leitura/edição de `.env*` |

**Limite conhecido:** allowlist/denylist de `Bash` é uma barreira fraca (comandos
alternativos podem contornar um padrão). As barreiras fortes são: worktree sem `.env` (arquivos
ignorados não existem no checkout), env sem credenciais e `GIT_CONFIG_GLOBAL`/`NOSYSTEM`
neutralizados (sem credential helper, então `git push` não autentica). O push e o PR são feitos
pelo código do grafo (Fase 2), nunca pelo agente.

O git do subprocesso recebe identidade `agente-<papel>`; isso vira o `autor_id` verificável
por código (task 3).

## Medição de referência (smoke real, papel `triagem`, pedido trivial)

| Métrica | Valor |
|---|---|
| Contexto criado (`cache_create`) | 4.400 tokens |
| Saída | 650 tokens |
| Turnos | 2 |
| Tempo | 7,4 s |
| Custo equivalente | US$ 0,024 |

Com Haiku e prompt vazio o piso do `claude -p` enxuto foi ~1.900 tokens, ou seja, o prompt do
papel, o schema e o pedido somam o restante. Isso é a linha de base da Fase 1.

## Variáveis de ambiente

`EXECUTOR`, `AGENTS_DIR`, `MODEL_DEFAULT`, `EFFORT_DEFAULT`, `TURNOS_DEFAULT`,
`TOKEN_BUDGET_TICKET`, e overrides `MODEL_<PAPEL>`, `EFFORT_<PAPEL>`, `TURNOS_<PAPEL>`.
Ausente = erro (falha fechada). Nenhum nome de modelo no código (um teste garante isso).
O `.env` real é ignorado pelo git.

## Como rodar

```
cd orchestrator
cp .env.example .env
npm run typecheck && npm test
```
