// Manual tickets: a human runs the command over data no agent may see and attaches the evidence. They never enter the graph, so no
// agent runs on them; the orchestrator checks only what needs no look at the data (exit code, presence, size, format) and records
// metadata, never content (ORCH_HOME/manual/<id>.json).
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { checkId, ticketFile } from "./ticket-store.ts";

export type Manual = {
  id: string;
  title: string;
  command: string;
  criteria: string[];
  expect: string[];
  status: "open" | "closed";
  history: { time: string; result: string }[];
};

const dir = (home: string) => join(home, "manual");

export function manualFile(home: string, id: string): string {
  checkId(id);
  return join(dir(home), `${id}.json`);
}

export const isManual = (home: string, id: string) => existsSync(manualFile(home, id));
export const readManual = (home: string, id: string): Manual => JSON.parse(readFileSync(manualFile(home, id), "utf8"));
export const manualIds = (home: string) =>
  existsSync(dir(home)) ? readdirSync(dir(home)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort() : [];

export function createManual(home: string, m: Pick<Manual, "id" | "title" | "command" | "criteria" | "expect">, now = new Date()): Manual {
  if (existsSync(ticketFile(home, m.id))) throw new Error(`${m.id} is already a code ticket`);
  const ticket: Manual = { ...m, status: "open", history: [{ time: now.toISOString(), result: "created" }] };
  mkdirSync(dir(home), { recursive: true });
  try {
    writeFileSync(manualFile(home, m.id), `${JSON.stringify(ticket, null, 1)}\n`, { flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`manual ticket ${m.id} already exists`);
    throw e;
  }
  return ticket;
}

// Streamed so a large export is hashed without loading it whole.
function sha256(path: string): string {
  const hash = createHash("sha256");
  const buf = Buffer.alloc(1 << 20);
  const fd = openSync(path, "r");
  try {
    for (let n: number; (n = readSync(fd, buf, 0, buf.length, null)) > 0; ) hash.update(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

// JSON.parse's error quotes the input: only the verdict leaves this function.
function validJson(path: string): boolean {
  try {
    JSON.parse(readFileSync(path, "utf8"));
    return true;
  } catch {
    return false;
  }
}

export function checkEvidence(m: Pick<Manual, "expect">, files: string[], exit: number): { ok: boolean; result: string } {
  const problems: string[] = [];
  if (exit !== 0) problems.push(`exit code ${exit}`);
  const names = files.map((f) => basename(f));
  const missing = m.expect.filter((e) => !names.includes(e));
  if (missing.length) problems.push(`missing expected files: ${missing.join(", ")}`);
  const meta = files.map((f, i) => {
    const st = existsSync(f) ? statSync(f) : null;
    if (!st?.isFile()) {
      problems.push(`${names[i]}: not a file`);
      return `${names[i]} missing`;
    }
    if (!st.size) problems.push(`${names[i]}: empty`);
    else if (/\.json$/i.test(f) && !validJson(f)) problems.push(`${names[i]}: not valid JSON`);
    return `${names[i]} ${st.size} B sha256:${sha256(f)}`;
  });
  const result = [`exit ${exit}`, ...meta].join("; ");
  return problems.length ? { ok: false, result: `evidence rejected (${problems.join("; ")}): ${result}` } : { ok: true, result: `evidence: ${result}` };
}

// Every attempt goes into the history; a passing one closes the ticket.
export function recordEvidence(home: string, id: string, files: string[], exit: number, now = new Date()): { ok: boolean; result: string } {
  const m = readManual(home, id);
  if (m.status !== "open") return { ok: false, result: `${id} is already ${m.status}` };
  const verdict = checkEvidence(m, files, exit);
  const next: Manual = { ...m, status: verdict.ok ? "closed" : "open", history: [...m.history, { time: now.toISOString(), result: verdict.result }] };
  writeFileSync(manualFile(home, id), `${JSON.stringify(next, null, 1)}\n`);
  return verdict;
}
