import { readEnv, type Env, type Role } from "./agent-env.ts";
import { effectivePublisher } from "./publish.ts";
import { loadRepoConfig } from "./repo-config.ts";
import { NodeFailure } from "./run-agent.ts";

const GRAPH_ROLES: Role[] = ["triage", "planner", "dev", "reviewer", "design", "qa", "docs"];

export function preflight(repo: string, env: Env = process.env, home?: string): void {
  const config = loadRepoConfig(repo, "HEAD", home);
  if (!Number(env.TOKEN_BUDGET_TICKET)) throw new NodeFailure("missing env: TOKEN_BUDGET_TICKET");
  if ((env.EXECUTOR ?? "claude-subscription") === "claude-subscription")
    for (const role of GRAPH_ROLES) for (const name of ["MODEL", "EFFORT", "TURNS"] as const) readEnv(name, role, env);
  effectivePublisher(config.publisher ?? "", env.PUBLISHER);
}
