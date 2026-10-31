// Secao 1 (regras de fluxo entre nos) entra na task 3. Aqui: Secao 2, defesa dentro de cada no.
import { devNull } from "node:os";

export type Papel = "triagem" | "dev" | "reviewer" | "qa";

export const TIMEOUT_POR_NO_MS = 600_000;

const LEITURA = ["Read", "Grep", "Glob"];
const SEGREDOS = [
  "Read(**/.env*)", "Edit(**/.env*)", "Write(**/.env*)",
  "Read(~/.ssh/**)", "Read(~/.claude/**)", "Read(~/.npmrc)", "Read(~/.git-credentials)", "Read(**/.git/config)",
];
// Hooks, filtros e fsmonitor do git executam codigo: o dev nao pode escrever neles.
const GIT_INTERNO = ["Write(**/.git/**)", "Edit(**/.git/**)", "Write(**/.gitattributes)", "Edit(**/.gitattributes)", "Write(**/.gitmodules)", "Edit(**/.gitmodules)"];

// tools = ferramentas built-in disponiveis; allow = auto-aprovadas; deny = sempre negadas.
// Bash com allowlist e fraco por natureza: a barreira real e worktree sem .env + env sem credenciais.
export const PERMISSOES: Record<Papel, { tools: string[]; allow: string[]; deny: string[] }> = {
  triagem: { tools: LEITURA, allow: LEITURA, deny: SEGREDOS },
  reviewer: { tools: LEITURA, allow: LEITURA, deny: SEGREDOS },
  qa: { tools: LEITURA, allow: LEITURA, deny: SEGREDOS },
  dev: {
    tools: [...LEITURA, "Write", "Edit", "Bash"],
    allow: [...LEITURA, "Write", "Edit", "Bash(git add *)", "Bash(git commit *)", "Bash(git status*)", "Bash(git diff*)", "Bash(npm test*)", "Bash(npm run typecheck*)"],
    deny: [...SEGREDOS, ...GIT_INTERNO, "Bash(npm exec*)", "Bash(npx*)", "Bash(npm config*)", "Bash(npm publish*)", "Bash(npm pkg*)", "Bash(git push*)", "Bash(rm -r*)", "Bash(rm -fr*)", "Bash(git remote*)", "Bash(git config*)"],
  },
};

const ENV_PERMITIDO = [
  "PATH", "PATHEXT", "SystemRoot", "windir", "COMSPEC", "USERPROFILE", "HOME", "HOMEDRIVE", "HOMEPATH",
  "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "TMPDIR", "LANG",
];

// Whitelist: ANTHROPIC_*, tokens e qualquer outra variavel nao entram no subprocesso.
// O git ganha identidade por papel (vira o autor_id verificavel) e perde credential helper.
export function envMinimo(papel: Papel, src: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ENV_PERMITIDO) if (src[k] !== undefined) env[k] = src[k];
  return {
    ...env,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: devNull,
    GIT_CONFIG_KEY_1: "core.fsmonitor",
    GIT_CONFIG_VALUE_1: "false",
    NPM_CONFIG_USERCONFIG: devNull,
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: `agente-${papel}`,
    GIT_AUTHOR_EMAIL: `${papel}@orchestrator.local`,
    GIT_COMMITTER_NAME: `agente-${papel}`,
    GIT_COMMITTER_EMAIL: `${papel}@orchestrator.local`,
  };
}

// MODEL, EFFORT, TURNOS: <NOME>_<PAPEL> sobrescreve <NOME>_DEFAULT. Ausente = falha (fechado).
export function lerEnv(nome: "MODEL" | "EFFORT" | "TURNOS", papel: Papel, src: NodeJS.ProcessEnv = process.env): string {
  const v = src[`${nome}_${papel.toUpperCase()}`] ?? src[`${nome}_DEFAULT`];
  if (!v) throw new Error(`env ausente: ${nome}_${papel.toUpperCase()} ou ${nome}_DEFAULT`);
  return v;
}

export function permissoesArgs(papel: Papel): string[] {
  const p = PERMISSOES[papel];
  return [
    "--permission-mode", "dontAsk",
    "--tools", p.tools.join(","),
    "--allowedTools", ...p.allow,
    "--disallowedTools", ...p.deny,
  ];
}
