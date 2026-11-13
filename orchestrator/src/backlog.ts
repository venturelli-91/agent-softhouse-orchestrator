// Non-blocking caveats from an approving reviewer, kept as backlog items with their origin ticket (ORCH_HOME/backlog.jsonl).
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { orchHome } from "./daily-cap.ts";

export type BacklogItem = { ticket: string; from: string; caveat: string; time: string; status: "open" | "reviewed" };

const file = (home: string) => join(home, "backlog.jsonl");

export const readBacklog = (home = orchHome()): BacklogItem[] =>
  existsSync(file(home)) ? readFileSync(file(home), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

// Each revision runs the reviewer again: the same caveat from the same reviewer on the same ticket is stored once.
export function addCaveats(ticket: string, from: string, caveats: string[], home = orchHome(), now = new Date()): number {
  const seen = new Set(readBacklog(home).map((i) => `${i.ticket}\0${i.from}\0${i.caveat}`));
  const fresh = [...new Set(caveats.map((c) => c.trim()).filter(Boolean))].filter((c) => !seen.has(`${ticket}\0${from}\0${c}`));
  if (!fresh.length) return 0;
  mkdirSync(home, { recursive: true });
  const time = now.toISOString();
  appendFileSync(file(home), fresh.map((caveat) => `${JSON.stringify({ ticket, from, caveat, time, status: "open" })}\n`).join(""));
  return fresh.length;
}
