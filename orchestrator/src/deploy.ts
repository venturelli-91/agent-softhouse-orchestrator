import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { minimalEnv } from "./guardrails.ts";
import { checkId } from "./ticket-store.ts";

export type DeployTarget = {
  sandbox: boolean;
  deploy(d: { id: string; sha: string }): string;
  rollback(d: { id: string; sha: string; previous: string }): string;
};
export type CommandSettings = { rollback: string; health_url: string; env: string[]; timeout_s: number; max_latency_ms: number; environment: "staging" | "production"; git_config_hash: string };
export type DeployRecord = { id: string; repo: string; sha: string; previous: string; target: string; sandbox: boolean; cmd?: CommandSettings };

const targets = new Map<string, DeployTarget>([
  ["simulated", { sandbox: true, deploy: (d) => `simulated:deploy ${d.id}@${d.sha}`, rollback: (d) => `simulated:rollback ${d.id} to ${d.previous}` }],
]);

export const registerDeployTarget = (name: string, t: DeployTarget) => void targets.set(name, t);
export function getDeployTarget(name: string): DeployTarget {
  const t = targets.get(name);
  if (!t) throw new Error(`unknown deploy target: ${name}`);
  return t;
}

const dir = (home: string) => join(home, "deployed");
const file = (home: string, id: string) => (checkId(id), join(dir(home), `${id}.json`));

export function recordDeploy(home: string, r: DeployRecord): void {
  const f = file(home, r.id);
  mkdirSync(dir(home), { recursive: true });
  writeFileSync(f, JSON.stringify(r, null, 1));
}
export const readDeploy = (home: string, id: string): DeployRecord => JSON.parse(readFileSync(file(home, id), "utf8"));
export function deployedIds(home: string): string[] {
  try {
    return readdirSync(dir(home)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
  } catch {
    return [];
  }
}

type Ctx = { id: string; sha: string; previous: string };

// A command never inherits the host env: the hardened base set, the names the CEO listed and the ORCH_ variables only.
export function commandEnv(names: string[], ctx: Ctx, src: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env = minimalEnv("devops", src);
  for (const k of names) if (src[k] !== undefined) env[k] = src[k]!;
  return { ...env, NoDefaultCurrentDirectoryInExePath: "1", ORCH_TICKET: ctx.id, ORCH_SHA: ctx.sha, ORCH_PREVIOUS: ctx.previous };
}

// Every extension cmd.exe may resolve: the live PATHEXT plus the Windows defaults and .ps1.
const shadowExts = (): string[] => [...new Set([...(process.env.PATHEXT ?? "").split(";"), ".com", ".exe", ".bat", ".cmd", ".vbs", ".vbe", ".js", ".jse", ".wsf", ".wsh", ".msc", ".ps1"].map((e) => e.toLowerCase()).filter(Boolean))];

// Plain argv; on Windows the line goes through cmd.exe, which the regex makes safe. Listed env values are masked in whatever comes back.
export function commandTarget(cfg: { command: string; rollback: string; env: string[]; timeout_s: number }, cwd: string, previous: string): DeployTarget {
  const run = (line: string, ctx: Ctx): string => {
    if (!/^[\w ./:=@-]+$/.test(line)) throw new Error("command must be a plain command without shell operators");
    const [bin, ...args] = line.split(" ").filter(Boolean);
    const b = bin.toLowerCase();
    if (process.platform === "win32" && readdirSync(cwd).some((f) => [b, ...shadowExts().map((e) => b + e)].includes(f.toLowerCase()))) throw new Error(`${bin} exists in ${cwd}: refusing to run a binary the working tree could shadow`);
    const env = commandEnv(cfg.env, ctx);
    const mask = (s: string) => cfg.env.reduce((a, k) => (env[k] ? a.split(env[k]).join("***") : a), s).trim().slice(-300);
    try {
      const opts = { cwd, env, timeout: cfg.timeout_s * 1000, encoding: "utf8", stdio: "pipe", windowsHide: true, maxBuffer: 64 * 1024 * 1024 } as const;
      // npm-installed CLIs are .cmd shims on Windows and need a shell; the plain-command regex leaves no metacharacter to abuse.
      return mask(process.platform === "win32" ? execFileSync(line, { ...opts, shell: true }) : execFileSync(bin, args, opts));
    } catch (e) {
      const err = e as { code?: string; stdout?: string; stderr?: string; message: string };
      throw new Error(err.code === "ETIMEDOUT" ? `command timed out after ${cfg.timeout_s}s` : `command failed: ${mask(`${err.stderr ?? ""}${err.stdout ?? ""}` || err.message)}`);
    }
  };
  return {
    sandbox: false,
    deploy: (d) => run(cfg.command, { id: d.id, sha: d.sha, previous }),
    rollback: (d) => run(cfg.rollback, d),
  };
}
