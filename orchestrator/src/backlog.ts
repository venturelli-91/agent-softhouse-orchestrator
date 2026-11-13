// Non-blocking caveats from an approving reviewer, kept as backlog items with their origin ticket (ORCH_HOME/backlog.jsonl).
// Append-only, so a review never races a graph appending caveats: the last line per (ticket, reviewer, caveat) wins, and an item
// keeps the position of its first line, which is its number in `orch backlog`.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { orchHome } from "./daily-cap.ts";

export type BacklogItem = { ticket: string; from: string; caveat: string; time: string; status: "open" | "reviewed" };

const file = (home: string) => join(home, "backlog.jsonl");
const key = (i: Pick<BacklogItem, "ticket" | "from" | "caveat">) => `${i.ticket}\0${i.from}\0${i.caveat}`;

export function readBacklog(home = orchHome()): BacklogItem[] {
  if (!existsSync(file(home))) return [];
  const items = new Map<string, BacklogItem>();
  for (const l of readFileSync(file(home), "utf8").split("\n").filter(Boolean)) {
    const i = JSON.parse(l) as BacklogItem;
    items.set(key(i), i);
  }
  return [...items.values()];
}

const append = (home: string, items: BacklogItem[]) => {
  mkdirSync(home, { recursive: true });
  appendFileSync(file(home), items.map((i) => `${JSON.stringify(i)}\n`).join(""));
};

// Each revision runs the reviewer again: the same caveat from the same reviewer on the same ticket is stored once.
export function addCaveats(ticket: string, from: string, caveats: string[], home = orchHome(), now = new Date()): number {
  const seen = new Set(readBacklog(home).map(key));
  // Agent text printed to the CEO's terminal by `orch backlog`: no escape sequences.
  const fresh = [...new Set(caveats.map((c) => c.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim()).filter(Boolean))].filter((caveat) => !seen.has(key({ ticket, from, caveat })));
  if (!fresh.length) return 0;
  append(home, fresh.map((caveat) => ({ ticket, from, caveat, time: now.toISOString(), status: "open" })));
  return fresh.length;
}

// Numbers are 1-based positions in readBacklog; an unknown number throws before anything is written.
export function reviewBacklog(numbers: number[], home = orchHome(), now = new Date()): BacklogItem[] {
  const all = readBacklog(home);
  const bad = numbers.filter((n) => !all[n - 1]);
  if (bad.length) throw new Error(`no backlog item ${bad.join(", ")}`);
  const reviewed = numbers.map((n) => ({ ...all[n - 1], time: now.toISOString(), status: "reviewed" as const }));
  append(home, reviewed);
  return reviewed;
}
