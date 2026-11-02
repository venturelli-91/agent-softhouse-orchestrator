import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ALLOWED_ENV } from "./guardrails.ts";
import { checkId } from "./ticket-store.ts";

export type DeployTarget = {
  sandbox: boolean;
  deploy(d: { id: string; sha: string }): string;
  rollback(d: { id: string; sha: string; previous: string }): string;
};
export type CommandSettings = { rollback: string; health_url: string; env: string[]; timeout_s: number; max_latency_ms: number; environment: "staging" | "production" };
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

// A command never inherits the host env: the base set, the names the CEO listed and the ORCH_ variables only.
export function commandEnv(names: string[], ctx: Ctx, src: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of [...ALLOWED_ENV, ...names]) if (src[k] !== undefined) env[k] = src[k]!;
  return { ...env, ORCH_TICKET: ctx.id, ORCH_SHA: ctx.sha, ORCH_PREVIOUS: ctx.previous };
}

// Plain argv, no shell. Listed env values are masked in whatever comes back.
export function commandTarget(cfg: { command: string; rollback: string; env: string[]; timeout_s: number }, cwd: string, previous: string): DeployTarget {
  const run = (line: string, ctx: Ctx): string => {
    const [bin, ...args] = line.split(" ").filter(Boolean);
    const env = commandEnv(cfg.env, ctx);
    const mask = (s: string) => cfg.env.reduce((a, k) => (env[k] ? a.split(env[k]).join("***") : a), s).trim().slice(-300);
    try {
      return mask(execFileSync(bin, args, { cwd, env, timeout: cfg.timeout_s * 1000, encoding: "utf8", stdio: "pipe", windowsHide: true }));
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
