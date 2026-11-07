import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const orchHome = (env: NodeJS.ProcessEnv = process.env) => env.ORCH_HOME ?? join(import.meta.dirname, "..", ".state");
// Agent worktrees and deploy checkouts live outside the repo: a path inside it would let ../ reach the repo's .env and this folder's state.
export const workRoot = (env: NodeJS.ProcessEnv = process.env) => env.ORCH_WORK ?? join(homedir(), ".orchestrator", "work");
const ledger = (env: NodeJS.ProcessEnv) => join(orchHome(env), "usage.jsonl");
const DAY_MS = 86_400_000;

// TOKEN_CAP_DAILY is a rolling 24h cap over every agent call, across tickets and repos. Unset = no cap, no ledger.
// ponytail: failed calls and the call that crosses the cap are not counted/stopped; add a pre-estimate if that matters.
export function usedToday(env: NodeJS.ProcessEnv = process.env, now = Date.now()): number {
  if (!existsSync(ledger(env))) return 0;
  return readFileSync(ledger(env), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { t: number; n: number })
    .filter((e) => e.t > now - DAY_MS).reduce((a, e) => a + e.n, 0);
}

export function dailyCapReached(env: NodeJS.ProcessEnv = process.env, now = Date.now()): string | null {
  const cap = Number(env.TOKEN_CAP_DAILY);
  if (!cap) return null;
  const used = usedToday(env, now);
  return used >= cap ? `daily token cap reached (${used} >= ${cap} in the last 24h); try again later` : null;
}

export function recordUsage(n: number, env: NodeJS.ProcessEnv = process.env, now = Date.now()) {
  if (!env.TOKEN_CAP_DAILY) return;
  mkdirSync(orchHome(env), { recursive: true });
  appendFileSync(ledger(env), `${JSON.stringify({ t: now, n })}\n`);
}
