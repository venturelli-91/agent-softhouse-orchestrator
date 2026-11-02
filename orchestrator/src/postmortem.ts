import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { z } from "zod";
import type { Incident } from "./incidents.ts";
import { runAgent } from "./run-agent.ts";

const marker = (i: Incident) => `<!-- incident: ${i.id} -->`;
// Neutralise HTML comment delimiters so agent text can neither forge the marker nor hide instructions from the CEO.
const plain = (s: string) => s.replace(/<!--/g, "&lt;!--").replace(/-->/g, "--&gt;");
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "incident";

// Left uncommitted on purpose: the CEO reads it before it becomes history.
// The repo is reachable by agents: playbooks must be a real directory inside it, and only the first line counts as the marker.
export function writePostmortem(repo: string, incident: Incident, text: string, date = new Date()): string {
  const dir = join(repo, "playbooks");
  mkdirSync(dir, { recursive: true });
  if (!lstatSync(dir).isDirectory() || !(realpathSync(dir) + sep).startsWith(realpathSync(repo) + sep)) throw new Error("playbooks must be a real directory inside the repo");
  const first = (f: string) => readFileSync(join(dir, f), "utf8").split(/\r?\n/, 1)[0];
  const existing = readdirSync(dir, { withFileTypes: true }).find((e) => e.isFile() && e.name.endsWith(".md") && first(e.name) === marker(incident));
  if (existing) return join(dir, existing.name);
  const path = join(dir, `${date.toISOString().slice(0, 10)}-${slug(incident.symptom)}.md`);
  const body = plain(text).trim();
  const heading = plain(incident.symptom).replace(/\s+/g, " ");
  writeFileSync(path, `${marker(incident)}\n# Postmortem ${incident.id}: ${heading}\n\n${body}\n`, { flag: "wx" });
  return path;
}

export async function proposePostmortem(incident: Incident, ctx: string): Promise<string> {
  const { output } = await runAgent({
    role: "knowledge", files: ["knowledge-manager"], cwd: process.cwd(), schema: z.object({ text: z.string() }),
    context: `Incident ${incident.id} on ticket ${incident.ticket}: ${incident.symptom}\n\n${ctx}\n\nWrite the postmortem (what happened, impact, cause, fix, how to prevent it). Read-only. Answer in the structured format.`,
  });
  return output.text;
}
