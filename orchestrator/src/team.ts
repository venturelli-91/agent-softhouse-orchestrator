// The agents decide the team and the stack for a need; the CEO confirms before anything is written to the repo config.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";
import { safeGit } from "./guardrails.ts";
import { runAgent } from "./run-agent.ts";
import { SPECIALTIES } from "./specialties.ts";

export const TeamProposal = z.object({
  specialties: z.array(z.enum(SPECIALTIES)).min(1),
  stack: z.string().max(400),
  existing_stack: z.boolean(),
  test: z.string().regex(/^[\w ./:=@-]+$/).default("npm test"),
  rationale: z.string().max(600),
  // Roles or subagents the roster lacks. Only a proposal: a new agent needs a prompt and the CEO's approval, nothing runs it by itself.
  proposed_agents: z.array(z.object({ name: z.string().max(60), responsibility: z.string().max(200), why: z.string().max(200) })).max(5).default([]),
});
export type TeamProposal = z.infer<typeof TeamProposal>;

const RULES =
  `Decide the smallest team (from: ${SPECIALTIES.join(", ")}) and the most recommended stack for this need. ` +
  "Inspect the repo first (package.json, lockfiles, config, source layout). If it already has a stack, respect it: " +
  "existing_stack=true, `stack` describes what is there, and recommend nothing that replaces or adds a paid dependency. " +
  "If the repo is empty or has no stack, existing_stack=false and recommend one with the reason. " +
  "`test` is the plain command that verifies the project (no shell operators). Choose only the specialties the need really uses. " +
  "The roster is a starting point: if the need requires a role or subagent it lacks, or more agents than you would expect, " +
  "list it in `proposed_agents` (name, responsibility, why); leave it empty when the roster is enough.";

// The agent sees an export of the committed HEAD, never the live checkout (untracked and ignored files stay out). No commit yet = empty dir.
function snapshot(repo: string): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "team-"));
  const tar = `${dir}.tar`;
  try {
    safeGit(repo, "archive", "--format=tar", "-o", tar, "HEAD");
    // Relative names from tmpdir: GNU tar reads "C:\..." as a remote host.
    execFileSync("tar", ["-xf", basename(tar), "-C", basename(dir)], { cwd: tmpdir() });
  } catch {}
  return { dir, done: () => (rmSync(dir, { recursive: true, force: true }), rmSync(tar, { force: true })) };
}

export async function proposeTeam(repo: string, need: string): Promise<TeamProposal> {
  const snap = snapshot(repo);
  try {
    const { output } = await runAgent({
      role: "planner",
      files: ["tech-lead"],
      cwd: snap.dir,
      schema: TeamProposal,
      context: `Need: ${need}\n${RULES}`,
    });
    return output;
  } finally {
    snap.done();
  }
}

// Pretty JSON with short string arrays kept on one line, the way Biome/Prettier format them: the file is committed into repos that lint it.
export const configJson = (o: object): string =>
  `${JSON.stringify(o, null, 2).replace(/\[\s*("[^\]]*?")\s*\]/g, (_, items: string) => `[${items.split(/,\s*/).join(", ")}]`)}\n`;

// Merges into .orchestrator.json, keeping whatever else the CEO already set there.
export function applyTeam(repo: string, p: TeamProposal): string {
  const file = join(repo, ".orchestrator.json");
  const current = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { merge: "pr" };
  const next = { ...current, test: current.test ?? p.test, specialties: p.specialties, stack: p.stack,
    ...(p.proposed_agents.length ? { proposed_agents: p.proposed_agents } : {}) };
  writeFileSync(file, configJson(next));
  return file;
}
