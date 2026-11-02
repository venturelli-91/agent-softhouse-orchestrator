import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Incident = { id: string; ticket: string; symptom: string; status: "open" | "waiting" | "closed"; hotfix: string; rollback: "none" | "proposed" | "done"; opened: string };
export const MAX_OPEN_INCIDENTS = 5;

const dir = (home: string) => join(home, "incidents");
const file = (home: string, id: string) => join(dir(home), `${id}.json`);
const read = (home: string, id: string): Incident => JSON.parse(readFileSync(file(home, id), "utf8"));
const write = (home: string, i: Incident) => (mkdirSync(dir(home), { recursive: true }), writeFileSync(file(home, i.id), JSON.stringify(i, null, 1)), i);

export const fingerprint = (ticket: string, symptom: string) => createHash("sha1").update(`${ticket}\n${symptom}`).digest("hex").slice(0, 12);

export function listIncidents(home: string): Incident[] {
  try {
    return readdirSync(dir(home)).filter((f) => f.endsWith(".json")).map((f) => read(home, f.slice(0, -5))).sort((a, b) => a.opened.localeCompare(b.opened));
  } catch {
    return [];
  }
}

export function updateIncident(home: string, id: string, patch: Partial<Incident>): Incident {
  return write(home, { ...read(home, id), ...patch, id });
}

export function openIncident(home: string, ticket: string, symptom: string): { incident: Incident; created: boolean } {
  const id = `inc-${fingerprint(ticket, symptom)}`;
  const all = listIncidents(home);
  const existing = all.find((i) => i.id === id && i.status !== "closed");
  if (existing) return { incident: existing, created: false };
  if (all.filter((i) => i.status !== "closed").length >= MAX_OPEN_INCIDENTS) throw new Error("open incident limit reached");
  return { incident: write(home, { id, ticket, symptom, status: "open", hotfix: "", rollback: "none", opened: new Date().toISOString() }), created: true };
}
