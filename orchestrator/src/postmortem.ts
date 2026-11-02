import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Incident } from "./incidents.ts";
import { runAgent } from "./run-agent.ts";

const marker = (i: Incident) => `<!-- incident: ${i.id} -->`;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "incident";

// Left uncommitted on purpose: the CEO reads it before it becomes history.
export function writePostmortem(repo: string, incident: Incident, text: string, date = new Date()): string {
  const dir = join(repo, "playbooks");
  mkdirSync(dir, { recursive: true });
  const existing = readdirSync(dir).find((f) => f.endsWith(".md") && readFileSync(join(dir, f), "utf8").includes(marker(incident)));
  if (existing) return join(dir, existing);
  const path = join(dir, `${date.toISOString().slice(0, 10)}-${slug(incident.symptom)}.md`);
  if (existsSync(path)) throw new Error(`postmortem file already exists: ${path}`);
  writeFileSync(path, `${marker(incident)}\n# Postmortem ${incident.id}: ${incident.symptom}\n\n${text.trim()}\n`);
  return path;
}

export async function proposePostmortem(incident: Incident, ctx: string): Promise<string> {
  const { output } = await runAgent({
    role: "knowledge", files: ["knowledge-manager"], cwd: process.cwd(), schema: z.object({ text: z.string() }),
    context: `Incident ${incident.id} on ticket ${incident.ticket}: ${incident.symptom}\n\n${ctx}\n\nWrite the postmortem (what happened, impact, cause, fix, how to prevent it). Read-only. Answer in the structured format.`,
  });
  return output.text;
}
