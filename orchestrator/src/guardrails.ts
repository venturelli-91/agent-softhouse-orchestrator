// Secao 1: regras de fluxo entre nos (constantes + evidencia). Secao 2: defesa dentro de cada no.
import { execFileSync, execSync } from "node:child_process";
// No Windows, os.devNull (um caminho \\.\nul) nao e valido para o git; usa NUL.
const devNull = process.platform === "win32" ? "NUL" : "/dev/null";
// Neste Windows o shell do claude -p e o PowerShell; em POSIX, Bash.
export const SHELL = process.platform === "win32" ? "PowerShell" : "Bash";
const sh = (...padroes: string[]) => padroes.map((p) => `${SHELL}(${p})`);

export type Papel = "triagem" | "dev" | "reviewer" | "qa";

// ===== Secao 1: regras de fluxo =====
export const MAX_REVISOES = 3;
export const RECURSION_LIMIT = 40;
export const TIMEOUT_POR_NO_MS = 600_000;

// Evidencia verificada por codigo (custo zero de token): o que o agente declara nao conta.
export function verificarEvidencia(wt: string, base: string): { ok: true; autor: string; evidencias: string[] } | { ok: false; motivo: string } {
  const git = (...a: string[]) => execFileSync("git", a, { cwd: wt, encoding: "utf8" }).trim();
  if (Number(git("rev-list", "--count", `${base}..HEAD`)) === 0) return { ok: false, motivo: "nenhum commit novo no worktree" };
  try {
    // execSync (shell) porque npm e npm.cmd no Windows; o comando e fixo.
    execSync("npm test", { cwd: wt, env: envMinimo("dev"), stdio: "pipe" });
  } catch (e) {
    return { ok: false, motivo: `npm test falhou: ${String((e as { stdout?: Buffer }).stdout ?? "").slice(-400)}` };
  }
  return { ok: true, autor: git("log", "-1", "--format=%an"), evidencias: [`commit:${git("rev-parse", "--short", "HEAD")}`, "testes:npm test ok"] };
}

// ===== Secao 2: defesa dentro de cada no =====
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
    tools: [...LEITURA, "Write", "Edit", SHELL],
    allow: [...LEITURA, "Write(./**)", "Edit(./**)", ...sh("git add *", "git commit *", "git status*", "git diff*", "git log*", "npm test*", "npm run typecheck*")],
    deny: [...SEGREDOS, ...GIT_INTERNO, ...sh("npm exec*", "npx*", "npm config*", "npm publish*", "npm pkg*", "git push*", "git remote*", "git config*", "rm *", "Remove-Item*", "del *", "rmdir*")],
  },
};

const ENV_PERMITIDO = [
  "PATH", "PATHEXT", "SystemRoot", "windir", "COMSPEC", "USERPROFILE", "HOME", "HOMEDRIVE", "HOMEPATH",
  "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "TMPDIR", "LANG", "SystemDrive", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "CLAUDE_CODE_GIT_BASH_PATH",
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
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: devNull,
    GIT_CONFIG_KEY_1: "core.fsmonitor",
    GIT_CONFIG_VALUE_1: "false",
    GIT_CONFIG_KEY_2: "core.pager",
    GIT_CONFIG_VALUE_2: "cat",
    GIT_EXTERNAL_DIFF: "",
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
