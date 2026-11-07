// Flow rules between nodes: limits, token budget and the no-self-approval rule.
import type { Usage } from "./run-agent.ts";

export const MAX_REVISIONS = 3;
export const RECURSION_LIMIT = 40;
export const MAX_ACTIVE_TICKETS = 5;
export const NODE_TIMEOUT_MS = 600_000;

export const tokens = (c: Usage) => c.tokens_in + c.tokens_out + c.cache_read + c.cache_create;

// Per-ticket token budget (TOKEN_BUDGET_TICKET). Missing = fail closed.
// The budget is per atomic task, granted by progress the code verified (one more cap per committed and verified task),
// never by the number of tasks a model declared.
export function budgetExceeded(usages: (Usage | undefined)[], env: NodeJS.ProcessEnv = process.env, verifiedTasks = 0): string | null {
  const cap = Number(env.TOKEN_BUDGET_TICKET) * (1 + Math.min(Math.max(0, verifiedTasks), 7));
  if (!Number(env.TOKEN_BUDGET_TICKET)) throw new Error("missing env: TOKEN_BUDGET_TICKET");
  const used = usages.reduce((a, c) => a + (c ? tokens(c) : 0), 0);
  return used > cap ? `token budget exceeded (${used} > ${cap})` : null;
}

// Nobody approves their own delivery: whoever reviews/tests cannot be the commit author.
export function selfApproval(author: string | null, who: string): string | null {
  if (!author) return "commit author unknown";
  return author === who ? `${who} cannot approve its own delivery` : null;
}
