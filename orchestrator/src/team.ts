// The agents decide the team and the stack for a need; the CEO confirms before anything is written to the repo config.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { runAgent } from "./run-agent.ts";
import { SPECIALTIES } from "./specialties.ts";

export const TeamProposal = z.object({
  specialties: z.array(z.enum(SPECIALTIES)).min(1),
  stack: z.string().max(400),
  existing_stack: z.boolean(),
  test: z.string().regex(/^[\w ./:=@-]+$/).default("npm test"),
  rationale: z.string().max(600),
});
export type TeamProposal = z.infer<typeof TeamProposal>;

const RULES =
  `Decide the smallest team (from: ${SPECIALTIES.join(", ")}) and the most recommended stack for this need. ` +
  "Inspect the repo first (package.json, lockfiles, config, source layout). If it already has a stack, respect it: " +
  "existing_stack=true, `stack` describes what is there, and recommend nothing that replaces or adds a paid dependency. " +
  "If the repo is empty or has no stack, existing_stack=false and recommend one with the reason. " +
  "`test` is the plain command that verifies the project (no shell operators). Choose only the specialties the need really uses.";

export async function proposeTeam(repo: string, need: string): Promise<TeamProposal> {
  const { output } = await runAgent({
    role: "planner",
    files: ["tech-lead"],
    cwd: repo,
    schema: TeamProposal,
    context: `Need: ${need}\n${RULES}`,
  });
  return output;
}

// Merges into .orchestrator.json, keeping whatever else the CEO already set there.
export function applyTeam(repo: string, p: TeamProposal): string {
  const file = join(repo, ".orchestrator.json");
  const current = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { merge: "pr" };
  const next = { ...current, test: current.test ?? p.test, specialties: p.specialties, stack: p.stack };
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  return file;
}
