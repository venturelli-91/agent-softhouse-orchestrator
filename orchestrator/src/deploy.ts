import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkId } from "./ticket-store.ts";

export type DeployTarget = {
  sandbox: boolean;
  deploy(d: { id: string; sha: string }): string;
  rollback(d: { id: string; sha: string; previous: string }): string;
};
export type DeployRecord = { id: string; repo: string; sha: string; previous: string; target: string; sandbox: boolean };

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
