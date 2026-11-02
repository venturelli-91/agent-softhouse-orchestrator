import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readDeploy } from "./deploy.ts";

export const SCENARIOS: Record<string, string> = {
  "broken-build": "build failed after deploy",
  "missing-env": "required environment variable is missing",
  "failed-migration": "database migration failed",
  "http-500": "endpoints return HTTP 500",
  "latency-spike": "p95 latency is 10x the baseline",
  "memory-growth": "memory grows until the process is killed",
  "cert-expired": "TLS certificate expired",
  "api-down": "external API is unreachable",
  "api-timeout": "external API calls time out",
  "rate-limit": "external API answers 429 rate limited",
  "db-down": "database connection refused",
  regression: "a previously working flow now fails",
};

export type Probe = (home: string, id: string) => string | null;
const file = (home: string, id: string) => join(home, "chaos", `${id}.json`);

export function injectFailure(home: string, id: string, scenario: string): void {
  if (!Object.hasOwn(SCENARIOS, scenario)) throw new Error(`unknown scenario: ${scenario}`);
  if (!readDeploy(home, id).sandbox) throw new Error(`${id} was not deployed to a sandbox target: chaos refused`);
  mkdirSync(join(home, "chaos"), { recursive: true });
  writeFileSync(file(home, id), JSON.stringify({ scenario }));
}

export const clearFailure = (home: string, id: string): void => {
  if (existsSync(file(home, id))) unlinkSync(file(home, id));
};

export const simulatedProbe: Probe = (home, id) =>
  existsSync(file(home, id)) ? SCENARIOS[(JSON.parse(readFileSync(file(home, id), "utf8")) as { scenario: string }).scenario] ?? null : null;
