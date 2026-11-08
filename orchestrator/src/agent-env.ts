// What a subprocess agent inherits: a whitelisted environment and a per-role git identity.
import { devNull } from "./git-safe.ts";

// On Windows the shell of claude -p is PowerShell; on POSIX, Bash.
export const SHELL = process.platform === "win32" ? "PowerShell" : "Bash";

export type Role = "triage" | "planner" | "dev" | "reviewer" | "design" | "qa" | "devops" | "watchdog" | "knowledge" | "docs";

export const ALLOWED_ENV = [
  "PATH", "PATHEXT", "SystemRoot", "windir", "COMSPEC", "USERPROFILE", "HOME", "HOMEDRIVE", "HOMEPATH",
  "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "TMPDIR", "LANG", "SystemDrive", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432",
  "CLAUDE_CODE_GIT_BASH_PATH",
];

// Whitelist: ANTHROPIC_*, tokens and any other variable stay out of the subprocess.
// Git gets a per-role identity (it becomes the verifiable author_id) and loses the credential helper.
export function minimalEnv(role: Role, src: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ALLOWED_ENV) if (src[k] !== undefined) env[k] = src[k];
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
    GIT_AUTHOR_NAME: `agent-${role}`,
    GIT_AUTHOR_EMAIL: `${role}@orchestrator.local`,
    GIT_COMMITTER_NAME: `agent-${role}`,
    GIT_COMMITTER_EMAIL: `${role}@orchestrator.local`,
  };
}

// MODEL, EFFORT, TURNS: <NAME>_<ROLE> overrides <NAME>_DEFAULT. Missing = failure (closed).
export function readEnv(name: "MODEL" | "EFFORT" | "TURNS", role: Role, src: NodeJS.ProcessEnv = process.env): string {
  const v = src[`${name}_${role.toUpperCase()}`] ?? src[`${name}_DEFAULT`];
  if (!v) throw new Error(`missing env: ${name}_${role.toUpperCase()} or ${name}_DEFAULT`);
  return v;
}
